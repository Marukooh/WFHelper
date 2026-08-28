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

// On X11 isAlwaysOnTop() reports _NET_WM_STATE, so a compositor that ignores
// _NET_WM_STATE_ABOVE never reports it back and the raise gate below never
// closes. Remembering what was applied is what stops the poll from restacking
// over the fullscreen game every tick. Off linux the live style is authority.
const linuxRaiseApplied = new WeakMap<OverlayWindow, boolean>();
let loggedLinuxRaise = false;

/** Raised as far as this platform can tell: WM state, or what we last applied. */
function isRaised(win: OverlayWindow, platform: NodeJS.Platform): boolean {
  if (platform !== "linux") return win.isAlwaysOnTop();
  return win.isAlwaysOnTop() || linuxRaiseApplied.get(win) === true;
}

// isAlwaysOnTop() is a cache; Windows strips WS_EX_TOPMOST from a clicked
// overlay. Gate on the live style; a raised window gates out next tick.
export function applyOverlayZOrder(
  win: OverlayWindow,
  warframeFocused: boolean,
  platform: NodeJS.Platform = process.platform,
): void {
  const linux = platform === "linux";
  if (warframeFocused) {
    if (linux) {
      if (isRaised(win, platform)) return;
    } else if (warframeStatus.isWindowTopmost(win.getNativeWindowHandle()) ?? win.isAlwaysOnTop()) {
      return;
    }
    // Taskbar state is set when the window is shown and survives a focus flip.
    // Every window call on this path is another chance for an injected hook to
    // be on the stack, so it re-asserts stacking only and nothing else.
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    win.setAlwaysOnTop(true, "screen-saver");
    win.moveTop();
    if (!linux) return;
    linuxRaiseApplied.set(win, true);
    // Named once so a support log shows the raise ran and then went quiet.
    if (loggedLinuxRaise) return;
    loggedLinuxRaise = true;
    log.info("[ZOrder] linux raise applied; re-asserted on show and drift only");
  } else if (isRaised(win, platform)) {
    win.setAlwaysOnTop(false);
    win.setVisibleOnAllWorkspaces(false);
    if (linux) linuxRaiseApplied.set(win, false);
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
  platform: NodeJS.Platform = process.platform,
): void {
  if (!win || win.isDestroyed()) return;
  if (!controller.isOverlayWindowVisible()) {
    // A hide costs the window its stacking, so the remembered raise must not
    // outlive it or the next show would never be re-asserted on linux.
    linuxRaiseApplied.delete(win);
    return;
  }
  // A released hold-open schedules its hide 2.5s out, and re-stacking a window
  // already being torn down is what crashed under an injected hook.
  const hideDueIn = controller.overlayHideDueIn();
  if (hideDueIn !== null && hideDueIn <= HIDE_IMMINENT_MS) return;
  applyOverlayZOrder(win, warframeFocused, platform);
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
  loggedLinuxRaise = false;
});
