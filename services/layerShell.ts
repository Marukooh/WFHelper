// Optional Wayland layer-shell addon. Absent on every platform but Linux, and
// absent on Linux too unless it compiled, so nothing here may throw: a failure
// means the caller keeps its ordinary overlay window.

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { withScope } from "./logger";

const log = withScope("layerShell");

interface LayerShellAddon {
  available(): boolean;
  outputs(): string[];
  create(
    output: string | null,
    width: number,
    height: number,
    anchor: number,
    marginTop: number,
    marginRight: number,
    marginBottom: number,
    marginLeft: number,
  ): number;
  commit(handle: number, frame: Buffer): boolean;
  destroy(handle: number): void;
  isClosed(handle: number): boolean;
  scaleOf?(handle: number): number;
}

interface LayerShellProbe {
  available: boolean;
  /** Connector names, e.g. DP-1, matching what the compositor ipc reports. */
  outputs: string[];
}

/** Matches the `placement` values overlay windows already use. */
export type LayerAnchor = "center" | "top-left" | "top-right";

export interface LayerSurfaceOptions {
  /** Connector name from probeLayerShell(), or null to let the compositor pick. */
  output: string | null;
  width: number;
  height: number;
  anchor: LayerAnchor;
  marginTop?: number;
  marginRight?: number;
  marginBottom?: number;
  marginLeft?: number;
}

export interface LayerSurface {
  /** BGRA, at least frameWidth * frameHeight * 4 bytes. False means dropped. */
  commit(frame: Buffer): boolean;
  isClosed(): boolean;
  destroy(): void;
  /** Buffer pixels per logical pixel on the output the surface landed on. */
  scale: number;
  /** Pixel size a frame must have, which is the logical size times the scale. */
  frameWidth: number;
  frameHeight: number;
}

const ANCHOR_TOP = 1;
const ANCHOR_LEFT = 4;
const ANCHOR_RIGHT = 8;

// No anchor bit at all is how the protocol asks the compositor to centre a surface.
const ANCHOR_BITS: Record<LayerAnchor, number> = {
  center: 0,
  "top-left": ANCHOR_TOP | ANCHOR_LEFT,
  "top-right": ANCHOR_TOP | ANCHOR_RIGHT,
};

const ADDON_RELATIVE = path.join("native", "layer-shell", "build", "layershell.node");

function candidatePaths(): string[] {
  const candidates: string[] = [];
  // asarUnpack puts it here in a packaged build; __dirname is inside the asar.
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, "app.asar.unpacked", ADDON_RELATIVE));
  }
  // Unpackaged, this file runs from .electron-build/services, so the repo root
  // is two levels up. One level up is kept for a flatter layout.
  candidates.push(path.join(__dirname, "..", "..", ADDON_RELATIVE));
  candidates.push(path.join(__dirname, "..", ADDON_RELATIVE));
  return candidates;
}

let cached: LayerShellAddon | null | undefined;

function loadAddon(): LayerShellAddon | null {
  if (cached !== undefined) return cached;
  cached = null;
  if (process.platform !== "linux") return cached;
  for (const candidate of candidatePaths()) {
    if (!fs.existsSync(candidate)) continue;
    try {
      // Late require on purpose: a native module that fails to link must not
      // take the import graph down with it.
      const addon = createRequire(__filename)(candidate) as LayerShellAddon;
      if (typeof addon?.available === "function") {
        cached = addon;
        return cached;
      }
      log.warn(`[LayerShell] ${candidate} loaded but exports no available()`);
    } catch (err) {
      log.warn(`[LayerShell] ${candidate} failed to load:`, (err as Error)?.message);
    }
  }
  return cached;
}

/** What the running compositor offers. Null when the addon is not there at all,
 *  which is every Windows and macOS run and any Linux build without it. */
export function probeLayerShell(): LayerShellProbe | null {
  const addon = loadAddon();
  if (!addon) return null;
  try {
    const available = addon.available() === true;
    return { available, outputs: available ? addon.outputs() : [] };
  } catch (err) {
    log.warn("[LayerShell] probe failed:", (err as Error)?.message);
    return null;
  }
}

function makeSurface(
  addon: LayerShellAddon,
  handle: number,
  width: number,
  height: number,
  scale: number,
): LayerSurface {
  const frameWidth = width * scale;
  const frameHeight = height * scale;
  const frameBytes = frameWidth * frameHeight * 4;
  let destroyed = false;
  // One latch for every per-frame failure. A surface that fails once fails on
  // every following frame, so an unlatched warning would flood the log.
  let warned = false;

  const warnOnce = (message: string): void => {
    if (warned) return;
    warned = true;
    log.warn(message);
  };

  return {
    scale,
    frameWidth,
    frameHeight,
    commit(frame: Buffer): boolean {
      if (destroyed) return false;
      // A short frame would be read past the end of the shm mapping in C.
      if (!Buffer.isBuffer(frame) || frame.length < frameBytes) {
        const got = Buffer.isBuffer(frame) ? `${frame.length} bytes` : "a non-buffer frame";
        warnOnce(
          `[LayerShell] rejected ${got} for a ${frameWidth}x${frameHeight} surface, ` +
            `need ${frameBytes}`,
        );
        return false;
      }
      try {
        return addon.commit(handle, frame) === true;
      } catch (err) {
        warnOnce(`[LayerShell] commit failed: ${(err as Error)?.message}`);
        return false;
      }
    },
    isClosed(): boolean {
      if (destroyed) return true;
      try {
        return addon.isClosed(handle) === true;
      } catch (err) {
        // Polled alongside commit, so it shares the latch.
        warnOnce(`[LayerShell] isClosed failed: ${(err as Error)?.message}`);
        return true;
      }
    },
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      try {
        addon.destroy(handle);
      } catch (err) {
        log.warn("[LayerShell] destroy failed:", (err as Error)?.message);
      }
    },
  };
}

/** A layer-shell surface, or null when one cannot be had. Null is the caller's
 *  only signal, and it means: open an ordinary overlay window instead. */
export function createLayerSurface(options: LayerSurfaceOptions): LayerSurface | null {
  const width = Math.floor(options.width);
  const height = Math.floor(options.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    log.warn(`[LayerShell] refusing a ${options.width}x${options.height} surface`);
    return null;
  }

  const addon = loadAddon();
  if (!addon) return null;

  let handle: number;
  try {
    if (addon.available() !== true) return null;
    handle = addon.create(
      options.output ? options.output : null,
      width,
      height,
      ANCHOR_BITS[options.anchor] ?? 0,
      options.marginTop ?? 0,
      options.marginRight ?? 0,
      options.marginBottom ?? 0,
      options.marginLeft ?? 0,
    );
  } catch (err) {
    log.warn("[LayerShell] create failed:", (err as Error)?.message);
    return null;
  }

  if (!Number.isInteger(handle) || handle < 0) {
    log.warn(`[LayerShell] compositor refused a surface on ${options.output ?? "any output"}`);
    return null;
  }
  // An addon built before scaleOf existed reports nothing, which is 1x.
  let scale = 1;
  try {
    const reported = addon.scaleOf?.(handle);
    if (typeof reported === "number" && Number.isInteger(reported) && reported > 0) {
      scale = reported;
    }
  } catch {
    scale = 1;
  }
  return makeSurface(addon, handle, width, height, scale);
}
