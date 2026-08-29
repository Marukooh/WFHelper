// Keep one stream because per-scan capture reopens the Wayland portal picker.

import type { BrowserWindow as BrowserWindowType, NativeImage } from "electron";
import path from "node:path";

import { withScope } from "./logger";
import { hardenBrowserWindowNavigation } from "./windowSecurity";
import { normalizeErrorMessage } from "../config/shared/errors";

const log = withScope("linuxStreamCapture");

// After a decline, don't re-prompt on every scan retry.
const DECLINE_COOLDOWN_MS = 60_000;
// A failed source lookup is a hiccup, not a refusal, and one of them can cost a
// minute of scanning. There is no prompt to spare here, so retry sooner.
const SOURCE_ERROR_COOLDOWN_MS = 5_000;
// The portal picker is interactive; give the user time to answer.
const STREAM_START_TIMEOUT_MS = 120_000;
const GRAB_TIMEOUT_MS = 5_000;
// Windows GDI does this in ~30ms; anything past this is worth a line.
const SLOW_GRAB_LOG_MS = 250;

let _win: BrowserWindowType | null = null;
// Bumped per installed window so a slow grab can tell whether the stream it
// judged is still the one a teardown would destroy.
let _streamGeneration = 0;
let _starting: Promise<boolean> | null = null;
let _handlerInstalled = false;
let _cooldownUntil = 0;
let _sourceLookupFailed = false;

function _now(): number {
  return Date.now();
}

// The reward layout is measured against the game's own frame, so a whole-desktop
// capture breaks every crop while Warframe runs windowed - prefer its window.
function pickCaptureSource<T extends { id: string; name: string }>(
  sources: readonly T[],
): T | null {
  const game = sources.find((source) => /(^|\W)warframe(\W|$)/i.test(source.name || ""));
  if (game) return game;
  return sources.find((source) => source.id.startsWith("screen:")) ?? sources[0] ?? null;
}

async function _installDisplayMediaHandler(win: BrowserWindowType): Promise<void> {
  if (_handlerInstalled) return;
  const { desktopCapturer } = await import("electron");
  // Routes the page's getDisplayMedia; getSources() opens the Wayland picker.
  win.webContents.session.setDisplayMediaRequestHandler(
    (_request, callback) => {
      desktopCapturer
        .getSources({ types: ["window", "screen"], thumbnailSize: { width: 0, height: 0 } })
        .then((sources) => {
          const source = pickCaptureSource(sources);
          if (!source) {
            _sourceLookupFailed = true;
            log.warn("[LinuxCapture] no capture source offered by the compositor");
            callback({} as never);
            return;
          }
          _sourceLookupFailed = false;
          log.info("[LinuxCapture] capturing source:", source.name || source.id);
          callback({ video: source });
        })
        .catch((err) => {
          _sourceLookupFailed = true;
          log.warn("[LinuxCapture] getSources failed:", normalizeErrorMessage(err));
          callback({} as never);
        });
    },
    { useSystemPicker: true },
  );
  _handlerInstalled = true;
}

async function _createWindow(): Promise<BrowserWindowType | null> {
  _resetBlankTracking();
  try {
    const { app, BrowserWindow } = await import("electron");
    // getAppPath() is the asar root; __dirname is .electron-build, which has no renderer/.
    const captureWindowFile = path.join(app.getAppPath(), "renderer", "linux-capture.html");
    const win = new BrowserWindow({
      show: false,
      width: 320,
      height: 180,
      skipTaskbar: true,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false, // keep the <video> element decoding while hidden
      },
    });
    hardenBrowserWindowNavigation(win, {
      label: "linux-capture",
      allowedFilePaths: [captureWindowFile],
      log,
    });
    await _installDisplayMediaHandler(win);
    win.on("closed", () => {
      if (_win === win) _win = null;
    });
    await win.loadFile(captureWindowFile);
    // _exec passes userGesture=true; getDisplayMedia needs a user activation.
    await _exec(win, "window.__startCapture && window.__startCapture()");
    return win;
  } catch (err) {
    log.warn("[LinuxCapture] window creation failed:", normalizeErrorMessage(err));
    return null;
  }
}

async function _exec<T>(win: BrowserWindowType, script: string): Promise<T | null> {
  try {
    return (await win.webContents.executeJavaScript(script, true)) as T;
  } catch (err) {
    log.warn("[LinuxCapture] executeJavaScript failed:", normalizeErrorMessage(err));
    return null;
  }
}

async function _waitForLiveStream(win: BrowserWindowType): Promise<boolean> {
  const deadline = _now() + STREAM_START_TIMEOUT_MS;
  for (;;) {
    const state = await _exec<string>(win, "window.__captureState && window.__captureState()");
    if (state === "live") return true;
    if (state === "dead" || state === null) return false;
    if (_now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/** Ensure the hidden window exists and its stream is live. One prompt max. */
async function _ensureStream(): Promise<boolean> {
  if (_win && !_win.isDestroyed()) {
    const state = await _exec<string>(_win, "window.__captureState && window.__captureState()");
    if (state === "live") return true;
    if (state === "starting") return _waitForLiveStream(_win);
    // dead: tear down and maybe recreate below
    _win.destroy();
    _win = null;
  }

  if (_now() < _cooldownUntil) return false;

  if (!_starting) {
    _starting = (async () => {
      _sourceLookupFailed = false;
      const win = await _createWindow();
      if (!win) return false;
      _win = win;
      _streamGeneration += 1;
      const live = await _waitForLiveStream(win);
      if (!live) {
        const cooldownMs = _sourceLookupFailed ? SOURCE_ERROR_COOLDOWN_MS : DECLINE_COOLDOWN_MS;
        _cooldownUntil = _now() + cooldownMs;
        const reason = _sourceLookupFailed ? "no capture source" : "portal declined/failed";
        log.warn(
          `[LinuxCapture] stream not acquired (${reason}) - cooling down ${Math.round(cooldownMs / 1000)}s`,
        );
        win.destroy();
        _win = null;
      } else {
        log.info("[LinuxCapture] persistent capture stream acquired");
      }
      return live;
    })().finally(() => {
      _starting = null;
    });
  }
  return _starting;
}

interface RawFrame {
  width: number;
  height: number;
  pixels: Uint8ClampedArray;
  drawMs?: number;
  readMs?: number;
  swapMs?: number;
}

function isUsableFrame(frame: RawFrame | null): frame is RawFrame {
  if (!frame || typeof frame !== "object") return false;
  const { width, height, pixels } = frame;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    return false;
  }
  return !!pixels && pixels.byteLength === width * height * 4;
}

// A portal grant can go stale without the track ending (restore-token grant to a
// gone source): the stream stays "live" but every frame is a featureless field.
const BLANK_LUM_RANGE = 8;
const BLANK_FRAMES_BEFORE_RESET = 3;
let _blankStreak = 0;
let _sawContent = false;

// Only a stream blank since its first frame is a stale grant. Loading screens
// are blank too, and re-requesting reopens the portal picker this file avoids.
function shouldDropBlankStream(blankStreak: number, sawContent: boolean): boolean {
  return !sawContent && blankStreak >= BLANK_FRAMES_BEFORE_RESET;
}

function _resetBlankTracking(): void {
  _blankStreak = 0;
  _sawContent = false;
}

function isBlankFrame(frame: RawFrame): boolean {
  const { pixels } = frame;
  const samples = Math.min(2048, frame.width * frame.height);
  const step = Math.max(4, Math.floor(pixels.length / samples / 4) * 4);
  let min = 255;
  let max = 0;
  for (let i = 0; i + 2 < pixels.length; i += step) {
    const lum = 0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2];
    if (lum < min) min = lum;
    if (lum > max) max = lum;
    if (max - min >= BLANK_LUM_RANGE) return false;
  }
  return true;
}

export async function captureLinuxStreamFrame(): Promise<NativeImage | null> {
  const startedAt = _now();
  const live = await _ensureStream();
  if (!live || !_win || _win.isDestroyed()) return null;

  const streamReadyAt = _now();
  const generation = _streamGeneration;
  const grab = _exec<RawFrame | null>(_win, "window.__grabFrame && window.__grabFrame()");
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), GRAB_TIMEOUT_MS));
  const frame = await Promise.race([grab, timeout]);
  const grabbedAt = _now();
  if (!isUsableFrame(frame)) return null;
  // A grab can outlive its stream; a replacement must not inherit this frame's
  // blank verdict, nor be the window the teardown below destroys.
  if (generation !== _streamGeneration) return null;

  if (isBlankFrame(frame)) {
    _blankStreak += 1;
    if (shouldDropBlankStream(_blankStreak, _sawContent) && _win && !_win.isDestroyed()) {
      log.warn("[LinuxCapture] stream blank since it started - dropping it to re-request");
      _win.destroy();
      _win = null;
      _cooldownUntil = _now() + SOURCE_ERROR_COOLDOWN_MS;
      _resetBlankTracking();
    }
    return null;
  }
  _blankStreak = 0;
  _sawContent = true;

  // Named only when it hurts, so a healthy session stays quiet. Splits the cost
  // into stream wait, renderer work, and the transfer of the pixels themselves.
  if (grabbedAt - startedAt >= SLOW_GRAB_LOG_MS) {
    const renderer = (frame.drawMs ?? 0) + (frame.readMs ?? 0) + (frame.swapMs ?? 0);
    log.info(
      `[LinuxCapture] slow grab ${grabbedAt - startedAt}ms ${frame.width}x${frame.height}: ` +
        `stream=${streamReadyAt - startedAt}ms renderer=${renderer}ms ` +
        `(draw=${frame.drawMs} read=${frame.readMs} swap=${frame.swapMs}) ` +
        `transfer=${grabbedAt - streamReadyAt - renderer}ms`,
    );
  }

  try {
    const { nativeImage } = await import("electron");
    // View, not copy - createFromBitmap takes its own copy of the pixels.
    const bitmap = Buffer.from(
      frame.pixels.buffer,
      frame.pixels.byteOffset,
      frame.pixels.byteLength,
    );
    const img = nativeImage.createFromBitmap(bitmap, {
      width: frame.width,
      height: frame.height,
    });
    if (!img || img.isEmpty()) return null;
    return img;
  } catch (err) {
    log.warn("[LinuxCapture] frame decode failed:", normalizeErrorMessage(err));
    return null;
  }
}

/** Close the hidden capture window (app shutdown). */
export function disposeLinuxStreamCapture(): void {
  if (_win && !_win.isDestroyed()) _win.destroy();
  _win = null;
  _resetBlankTracking();
}

export const __test__ = { pickCaptureSource, isUsableFrame, isBlankFrame, shouldDropBlankStream };
