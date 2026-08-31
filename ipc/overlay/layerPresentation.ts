// Presents a passive overlay as a Wayland layer surface instead of a window.
// It is the only way to pick the monitor and sit above a fullscreen game; both
// are impossible for an ordinary window on native Wayland.

import {
  createLayerSurface,
  type LayerAnchor,
  type LayerPointerEvent,
  type LayerSurface,
} from "../../services/layerShell";
import { resolveGameOutput } from "../../services/waylandCompositor";

interface PaintImage {
  toBitmap: () => Buffer;
}

// Narrowed to the one overload we use, so an Electron BrowserWindow satisfies it
// without dragging the whole WebContents event map in.
interface InputEvent {
  type: "mouseEnter" | "mouseLeave" | "mouseMove" | "mouseDown" | "mouseUp" | "mouseWheel";
  x: number;
  y: number;
  button?: "left" | "middle" | "right";
  clickCount?: number;
  deltaX?: number;
  deltaY?: number;
}

interface OffscreenWindow {
  setSize?: (width: number, height: number) => void;
  webContents: {
    setFrameRate: (fps: number) => void;
    setZoomFactor?: (factor: number) => void;
    sendInputEvent?: (event: InputEvent) => void;
    on: (
      event: "paint",
      listener: (event: unknown, dirty: unknown, image: PaintImage) => void,
    ) => unknown;
  };
}

interface LayerPresentationOptions {
  label: string;
  anchor: LayerAnchor;
  frameRate?: number;
  log?: { info?: (...args: unknown[]) => void; warn?: (...args: unknown[]) => void };
  createSurface?: typeof createLayerSurface;
  resolveOutput?: typeof resolveGameOutput;
}

const DEFAULT_FRAME_RATE = 30;

export function createLayerPresentation(options: LayerPresentationOptions) {
  const {
    label,
    anchor,
    frameRate = DEFAULT_FRAME_RATE,
    log,
    createSurface = createLayerSurface,
    resolveOutput = resolveGameOutput,
  } = options;

  let surface: LayerSurface | null = null;
  let attached: OffscreenWindow | null = null;
  let width = 0;
  let height = 0;
  let appliedScale = 1;
  let interactive = false;
  // Bumped on every hide so a slow output lookup cannot map a surface for a
  // show the user already dismissed.
  let generation = 0;
  let warnedCommit = false;
  // A show already waiting on the compositor. Two callers drive one trigger (the
  // route creates the window, then the feature controller shows it), and without
  // this both would see no surface and allocate one; the addon has eight slots.
  let pending: Promise<boolean> | null = null;

  /** Grow the offscreen window to the surface's pixel size and zoom the page to
   *  match, so a HiDPI output gets a sharp frame instead of an upscaled one. */
  function applyScale(scale: number): void {
    if (scale === appliedScale || !attached) return;
    appliedScale = scale;
    try {
      attached.setSize?.(width * scale, height * scale);
      attached.webContents.setZoomFactor?.(scale);
    } catch (err) {
      log?.warn?.(`[${label}] could not scale to ${scale}x: ${(err as Error)?.message}`);
    }
  }

  const BUTTONS: Array<"left" | "middle" | "right"> = ["left", "middle", "right"];

  /** One wayland axis notch is 15 units; chromium counts a notch as 120. */
  const WHEEL_PER_AXIS_UNIT = 8;

  function toInputEvent(event: LayerPointerEvent, scale: number): InputEvent | null {
    // Surface-local logical pixels to window pixels. The window is sized in
    // buffer pixels and the page is zoomed by the same factor.
    const x = Math.round(event.x * scale);
    const y = Math.round(event.y * scale);
    switch (event.kind) {
      case "enter":
        return { type: "mouseEnter", x, y };
      case "leave":
        return { type: "mouseLeave", x, y };
      case "motion":
        return { type: "mouseMove", x, y };
      case "button":
        return {
          type: event.pressed ? "mouseDown" : "mouseUp",
          x,
          y,
          button: BUTTONS[event.button] ?? "left",
          clickCount: 1,
        };
      case "axis":
        return {
          type: "mouseWheel",
          x,
          y,
          deltaX: -event.deltaX * WHEEL_PER_AXIS_UNIT,
          deltaY: -event.deltaY * WHEEL_PER_AXIS_UNIT,
        };
      default:
        return null;
    }
  }

  function forwardEvent(event: LayerPointerEvent): void {
    if (!attached || !surface) return;
    const input = toInputEvent(event, surface.scale);
    if (!input) return;
    try {
      attached.webContents.sendInputEvent?.(input);
    } catch {
      // A destroyed webContents throws; the next show rebuilds the wiring.
    }
  }

  function commitFrame(image: PaintImage): void {
    if (!surface) return;
    let frame: Buffer;
    try {
      frame = image.toBitmap();
    } catch {
      return;
    }
    // A resize takes a frame or two to land, and those carry the old size.
    if (frame.length !== surface.frameWidth * surface.frameHeight * 4) return;
    if (surface.commit(frame)) return;
    if (surface.isClosed()) {
      // The compositor took the surface away; drop it so the next show remakes it.
      surface.destroy();
      surface = null;
      log?.info?.(`[${label}] layer surface closed by the compositor`);
      return;
    }
    if (!warnedCommit) {
      warnedCommit = true;
      log?.warn?.(`[${label}] layer frame refused; further refusals are not logged`);
    }
  }

  return {
    /** Wire an offscreen window's paints to whatever surface is up at the time. */
    attach(window: OffscreenWindow, frameWidth: number, frameHeight: number): void {
      attached = window;
      width = frameWidth;
      height = frameHeight;
      window.webContents.setFrameRate(frameRate);
      window.webContents.on("paint", (_event, _dirty, image) => {
        if (image && typeof image.toBitmap === "function") commitFrame(image);
      });
    },

    /** Map the surface on the output the game is on. Async because only the
     *  compositor knows which that is; frames before it lands are dropped. */
    show(): Promise<boolean> {
      if (surface && !surface.isClosed()) return Promise.resolve(true);
      if (pending) return pending;
      const token = generation;
      const attempt = (async () => {
        const output = await resolveOutput();
        if (token !== generation) return false;
        surface = createSurface({ output, width, height, anchor });
        if (!surface) {
          log?.warn?.(`[${label}] layer surface unavailable; using a window instead`);
          return false;
        }
        warnedCommit = false;
        applyScale(surface.scale);
        if (interactive) surface.setInteractive(true, forwardEvent);
        log?.info?.(
          `[${label}] layer surface up on ${output ?? "compositor choice"} at ${surface.scale}x`,
        );
        return true;
      })();
      pending = attempt;
      return attempt.finally(() => {
        if (pending === attempt) pending = null;
      });
    },

    hide(): void {
      generation++;
      // Drop the in-flight show too, or the next show would return its promise
      // and resolve false against the generation this hide just bumped.
      pending = null;
      if (!surface) return;
      surface.destroy();
      surface = null;
    },

    isShowing(): boolean {
      return surface !== null && !surface.isClosed();
    },

    /** Accept clicks, or let them fall through to the game. Sticky across shows,
     *  because the surface is remade on every show and starts click-through. */
    setInteractive(next: boolean): void {
      interactive = next;
      surface?.setInteractive(next, forwardEvent);
    },
  };
}
