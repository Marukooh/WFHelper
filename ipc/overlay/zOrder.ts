import { app, type BrowserWindow } from "electron";
import { withScope } from "../../services/logger";
import * as warframeStatus from "../../services/warframeStatus";
import { HIDE_IMMINENT_MS } from "./windows";

const log = withScope("overlayZOrder");

type OverlayWindow = InstanceType<typeof BrowserWindow>;

interface ZOrderSubscriber {
  isActive: () => boolean;
  sync: (warframeFocused: boolean) => void;
}

const subscribers = new Set<ZOrderSubscriber>();
let interval: ReturnType<typeof setInterval> | null = null;
let polling = false;
let lastFocused: boolean | null = null;

// isAlwaysOnTop() is a cache; Windows strips WS_EX_TOPMOST from a clicked
// overlay. Gate on the live style; a raised window gates out next tick.
export function applyOverlayZOrder(win: OverlayWindow, warframeFocused: boolean): void {
  if (warframeFocused) {
    if (warframeStatus.isWindowTopmost(win.getNativeWindowHandle()) ?? win.isAlwaysOnTop()) return;
    // Taskbar state is set when the window is shown and survives a focus flip.
    // Every window call on this path is another chance for an injected hook to
    // be on the stack, so it re-asserts stacking only and nothing else.
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    win.setAlwaysOnTop(true, "screen-saver");
    win.moveTop();
  } else if (win.isAlwaysOnTop()) {
    win.setAlwaysOnTop(false);
    win.setVisibleOnAllWorkspaces(false);
  }
}

interface ZOrderWindowsController {
  isOverlayWindowVisible: () => boolean;
  overlayHideDueIn: () => number | null;
}

/** Poll-driven stacking for one overlay window, guards included. */
export function syncOverlayWindowZOrder(
  controller: ZOrderWindowsController,
  win: OverlayWindow | null,
  warframeFocused: boolean,
): void {
  if (!win || win.isDestroyed() || !controller.isOverlayWindowVisible()) return;
  // The refocus that releases a held-open overlay schedules its hide 2.5s out,
  // and re-stacking a window that is already being torn down is what crashed
  // under an injected hook. Only the last seconds are skipped.
  const hideDueIn = controller.overlayHideDueIn();
  if (hideDueIn !== null && hideDueIn <= HIDE_IMMINENT_MS) return;
  applyOverlayZOrder(win, warframeFocused);
}

async function poll(): Promise<void> {
  if (polling) return;
  const active = [...subscribers].filter((subscriber) => subscriber.isActive());
  if (active.length === 0) return;

  polling = true;
  try {
    const status = await warframeStatus.getStatus();
    // Named on change only: flipping every poll with WFHelper in the foreground
    // means the overlay is stealing focus, not that the user alt-tabbed away.
    if (lastFocused !== status.isFocused) {
      lastFocused = status.isFocused;
      log.info(
        `[ZOrder] warframe focused=${status.isFocused} foreground="${status.focusedProcessName ?? "?"}"`,
      );
    }
    for (const subscriber of active) subscriber.sync(status.isFocused);
  } catch {
    // status polling is best effort
  } finally {
    polling = false;
  }
}

function ensureInterval(): void {
  if (interval) return;
  interval = setInterval(() => void poll(), 2000);
}

export function registerZOrderSubscriber(subscriber: ZOrderSubscriber): void {
  subscribers.add(subscriber);
  ensureInterval();
}

app.once("before-quit", () => {
  if (interval) clearInterval(interval);
  interval = null;
  subscribers.clear();
  lastFocused = null;
});
