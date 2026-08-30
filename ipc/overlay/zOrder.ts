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
// A compositor that does answer _NET_WM_STATE can also say the band was taken
// away, and linux isFocused is only "warframe is running", so that answer is
// the one signal that a raised overlay was buried. Once it has confirmed a
// raise its live state outranks the remembered flag.
const linuxWmReportsBand = new WeakSet<OverlayWindow>();
// A wm that keeps dropping the band the poll just re-asserted is flapping, not
// reporting burials, and answering it every tick is the restack that cost
// frames here. Its answer is ignored once this many re-raises went nowhere.
const LINUX_MAX_DRIFT_RERAISES = 3;
const linuxDriftReraises = new WeakMap<OverlayWindow, number>();
let loggedLinuxRaise = false;

function isRaised(win: OverlayWindow, platform: NodeJS.Platform): boolean {
  const onTop = win.isAlwaysOnTop();
  if (platform !== "linux") return onTop;
  if (onTop) {
    linuxWmReportsBand.add(win);
    // The band outlived a poll interval, so the last raise held.
    linuxDriftReraises.delete(win);
    return true;
  }
  return linuxWmReportsBand.has(win) ? false : linuxRaiseApplied.get(win) === true;
}

// The band can be gone while the raise is not: a reporting wm answering false
// still leaves the workspace flag and the remembered raise behind, and both
// belong to the game, so an unfocus has to undo them.
function needsUnraise(win: OverlayWindow, platform: NodeJS.Platform): boolean {
  if (win.isAlwaysOnTop()) return true;
  return platform === "linux" && linuxRaiseApplied.get(win) === true;
}

/** Whether a raise the wm asked for by dropping the band is still worth sending. */
function allowLinuxDriftRaise(win: OverlayWindow): boolean {
  if (linuxRaiseApplied.get(win) !== true || !linuxWmReportsBand.has(win)) return true;
  const used = (linuxDriftReraises.get(win) ?? 0) + 1;
  linuxDriftReraises.set(win, used);
  if (used <= LINUX_MAX_DRIFT_RERAISES) return true;
  linuxWmReportsBand.delete(win);
  log.info("[ZOrder] linux wm keeps dropping the band; falling back to the applied state");
  return false;
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
      if (!allowLinuxDriftRaise(win)) return;
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
    // An echoing wm answers right here, a poll tick earlier than isRaised would.
    if (win.isAlwaysOnTop()) linuxWmReportsBand.add(win);
    // Named once so a support log shows the raise ran and then went quiet.
    if (loggedLinuxRaise) return;
    loggedLinuxRaise = true;
    log.info("[ZOrder] linux raise applied; re-asserted on re-show and when the wm drops the band");
  } else if (needsUnraise(win, platform)) {
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
    // A hide costs the window its stacking, so neither the remembered raise nor
    // the drift budget may outlive it. The next show starts unstacked and needs
    // both a fresh re-assert and its full re-raise allowance.
    linuxRaiseApplied.delete(win);
    linuxDriftReraises.delete(win);
    return;
  }
  // A released hold-open schedules its hide 2.5s out, and re-stacking a window
  // already being torn down crashes under an injected hook.
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
    // Only isFocused is read here, and resolving the game geometry costs an X
    // tree walk on linux, so this poll asks for the bounds-free status.
    const status = await warframeStatus.getStatus({ needBounds: false });
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
