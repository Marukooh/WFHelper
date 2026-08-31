// Presents a passive overlay as a Wayland layer surface instead of a window.
// It is the only way to pick the monitor and sit above a fullscreen game; both
// are impossible for an ordinary window on native Wayland.

import {
  createLayerSurface,
  layerOutputRects,
  type LayerAnchor,
  type LayerPointerEvent,
  type LayerSurface,
} from "../../services/layerShell";
import { getWarframeWindowBoundsLinux } from "../../services/warframeStatus";
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

/** Where an overlay wants to sit and how large it wants to be, in logical
 *  pixels. x and y are measured from the top-left corner of the output it lands
 *  on, because a layer surface is placed by margins and never by screen
 *  coordinates. zoomFactor is the page zoom that makes the layout fill it. */
export interface LayerGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
  zoomFactor: number;
}

interface LayerPresentationOptions {
  label: string;
  anchor: LayerAnchor;
  frameRate?: number;
  log?: { info?: (...args: unknown[]) => void; warn?: (...args: unknown[]) => void };
  createSurface?: typeof createLayerSurface;
  resolveOutput?: () => Promise<string | null>;
  /** Read on every show and on every applyGeometry, so a saved spot and a live
   *  drag both land. Absent for overlays that take whatever the anchor gives. */
  resolveGeometry?: () => LayerGeometry | null;
  /** Distance to hold off the anchored edges when there is no geometry, so a
   *  corner overlay is not flush against the screen edge. */
  inset?: number;
}

const DEFAULT_FRAME_RATE = 30;

/** Which monitor holds the game, by matching its window against the compositor's
 *  logical layout. XWayland reports geometry in that same space, so this works on
 *  any compositor, unlike the ipc lookup that only niri, sway and Hyprland answer. */
async function outputFromGameBounds(): Promise<string | null> {
  const rects = layerOutputRects().filter((rect) => rect.placed && rect.width > 0);
  // One monitor cannot be the wrong monitor.
  if (rects.length < 2) return null;
  const bounds = await getWarframeWindowBoundsLinux();
  if (!bounds) return null;
  const x = bounds.x + bounds.width / 2;
  const y = bounds.y + bounds.height / 2;
  const hit = rects.find(
    (rect) => x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height,
  );
  return hit?.name ?? null;
}

/** The compositor knows best, so it is asked first. Only three answer, and the
 *  rest used to land the overlay on whichever monitor the compositor preferred. */
async function resolveOutputForGame(): Promise<string | null> {
  const fromCompositor = await resolveGameOutput();
  if (fromCompositor) return fromCompositor;
  return outputFromGameBounds();
}

export function createLayerPresentation(options: LayerPresentationOptions) {
  const {
    label,
    anchor,
    frameRate = DEFAULT_FRAME_RATE,
    log,
    createSurface = createLayerSurface,
    resolveOutput = resolveOutputForGame,
    resolveGeometry,
    inset = 0,
  } = options;

  let surface: LayerSurface | null = null;
  let attached: OffscreenWindow | null = null;
  let width = 0;
  let height = 0;
  // Page zoom the layout needs at the current size. 1 for a fixed-size overlay
  // like the trade toast, which never reports a geometry.
  let zoom = 1;
  let currentOutput: string | null = null;
  let interactive = false;
  // Bumped on every hide so a slow output lookup cannot map a surface for a
  // show the user already dismissed.
  let generation = 0;
  let warnedCommit = false;
  // A show already waiting on the compositor. Two callers drive one trigger (the
  // route creates the window, then the feature controller shows it), and without
  // this both would see no surface and allocate one; the addon has eight slots.
  let pending: Promise<boolean> | null = null;

  /** Size the offscreen window to the surface's pixel size and zoom the page to
   *  match, so a HiDPI output gets a sharp frame instead of an upscaled one.
   *  The zoom carries the overlay's own scale too, or the layout would render
   *  at 1x inside a viewport the scale had already made larger. */
  function applyWindowSize(scale: number): void {
    if (!attached) return;
    try {
      attached.setSize?.(width * scale, height * scale);
      attached.webContents.setZoomFactor?.(Number((zoom * scale).toFixed(3)));
    } catch (err) {
      log?.warn?.(
        `[${label}] could not size to ${width}x${height} at ${scale}x: ${(err as Error)?.message}`,
      );
    }
  }

  /** The wanted spot as margins from the output's top-left corner, kept inside
   *  the output: the saved spot may come from a monitor of a different size. */
  function marginsFor(
    geometry: LayerGeometry,
    output: string | null,
  ): { top: number; left: number } {
    const rect = output ? layerOutputRects().find((entry) => entry.name === output) : undefined;
    const left = Math.max(0, Math.round(geometry.x));
    const top = Math.max(0, Math.round(geometry.y));
    return {
      left:
        rect && rect.width > 0 ? Math.min(left, Math.max(0, rect.width - geometry.width)) : left,
      top:
        rect && rect.height > 0 ? Math.min(top, Math.max(0, rect.height - geometry.height)) : top,
    };
  }

  /** How the surface is placed. A geometry pins it to the output's top-left and
   *  positions it by margins; without one it keeps its anchor and the inset
   *  only holds it off the edges it is anchored to. */
  function placementFor(geometry: LayerGeometry | null, output: string | null) {
    if (geometry) {
      const margins = marginsFor(geometry, output);
      return {
        anchor: "top-left" as LayerAnchor,
        marginTop: margins.top,
        marginLeft: margins.left,
      };
    }
    if (!inset || anchor === "center") return { anchor };
    return {
      anchor,
      marginTop: inset,
      marginLeft: anchor === "top-left" ? inset : 0,
      marginRight: anchor === "top-right" ? inset : 0,
    };
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
        const geometry = resolveGeometry?.() ?? null;
        if (geometry) {
          width = geometry.width;
          height = geometry.height;
          zoom = geometry.zoomFactor;
        }
        currentOutput = output;
        surface = createSurface({ output, width, height, ...placementFor(geometry, output) });
        if (!surface) {
          log?.warn?.(`[${label}] layer surface unavailable; using a window instead`);
          return false;
        }
        warnedCommit = false;
        applyWindowSize(surface.scale);
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

    /** Push the current spot to a surface that is already up, which is how a
     *  drag moves one. A hidden overlay picks it up on its next show instead. */
    applyGeometry(): void {
      if (!surface || surface.isClosed()) return;
      const geometry = resolveGeometry?.();
      if (!geometry) return;
      zoom = geometry.zoomFactor;
      const margins = marginsFor(geometry, currentOutput);
      surface.setMargin(margins.top, 0, 0, margins.left);
      applyWindowSize(surface.scale);
    },

    /** Accept clicks, or let them fall through to the game. Sticky across shows,
     *  because the surface is remade on every show and starts click-through. */
    setInteractive(next: boolean): void {
      interactive = next;
      surface?.setInteractive(next, forwardEvent);
    },
  };
}
