import ctx from "./context";
import { registerTransientHotkey, unregisterTransientHotkey } from "./hotkeyRegistry";
import { assertTradeNotificationSender, onAuthorized } from "./ipcSecurity";
import { withScope } from "../services/logger";
import { hardenBrowserWindowNavigation } from "../services/windowSecurity";
import * as wfmReviews from "../services/wfmReviews";
import {
  TRADE_NOTIFICATION_SHOW,
  TRADE_NOTIFICATION_DISMISS,
  TRADE_NOTIFICATION_REP_RESULT,
  OVERLAY_CONTENT_VISIBLE,
} from "../config/shared/ipcChannels";
import { createKeepMappedMode } from "./overlay/keepMapped";
import { resolveRepOffer } from "../config/shared/tradeMatch";
import type {
  TradeMatchPayload,
  TradeNotificationStatus,
  TradeRepOffer,
} from "../config/shared/tradeMatch";

const log = withScope("tradeNotificationIpc");

import path from "node:path";
import { app, BrowserWindow, screen } from "electron";

const SCALE = 1.5;
const WIN_W = 370 * SCALE;
const WIN_H = 104 * SCALE;
const MARGIN = 16;
const NOTIFICATION_FILE = path.join(app.getAppPath(), "renderer", "trade-notification.html");

const RENDERER_VISIBLE_MS = 5_000;
// Allows time to reach the keybind while returning to the mission.
const REP_VISIBLE_MS = 12_000;
const REP_RESULT_VISIBLE_MS = 4_000;
const RENDERER_FADE_MS = 400;
const MAIN_HIDE_BUFFER_MS = 600;
const CLICK_THROUGH_REASSERT_DELAYS_MS = [250, 1_500];

export interface TradeNotificationShowPayload {
  match: TradeMatchPayload;
  status: TradeNotificationStatus;
  rep: TradeRepOffer | null;
  timing: {
    visibleMs: number;
    fadeMs: number;
  };
}

export interface TradeRepResultPayload {
  result: wfmReviews.SendRepResult;
  partner: string;
  timing: {
    visibleMs: number;
    fadeMs: number;
  };
}

let _hideTimer: ReturnType<typeof setTimeout> | null = null;
let _rendererReady = false;
let _notificationRevision = 0;
// The toast is transparent and always click-through, so it can use the same
// blank-the-DOM hide the overlay controllers use on native Wayland.
const _keepMapped = createKeepMappedMode({ label: "TradeNotification", transparent: true, log });

function _setContentVisible(win: InstanceType<typeof BrowserWindow>): (visible: boolean) => void {
  return (visible) => win.webContents.send(OVERLAY_CONTENT_VISIBLE, visible);
}

// Wayland drops a window's input shape when it maps one, and a keep-mapped hide
// leaves the blanked toast mapped, so the shape has to be re-set on both edges or
// an invisible toast swallows clicks meant for the game.
function _applyClickThrough(win: InstanceType<typeof BrowserWindow>): void {
  // Re-setting an identical shape tells the compositor nothing; drop it first.
  if (process.platform === "linux") win.setIgnoreMouseEvents(false);
  win.setIgnoreMouseEvents(true);
}

// A shape set in the same breath as the show lands before the window is mapped
// and is lost, exactly as it is for the overlays, so it is re-asserted after.
function _reassertClickThrough(win: InstanceType<typeof BrowserWindow>): void {
  if (process.platform !== "linux") return;
  for (const delay of CLICK_THROUGH_REASSERT_DELAYS_MS) {
    setTimeout(() => {
      if (!win.isDestroyed()) _applyClickThrough(win);
    }, delay);
  }
}

function _presentWindow(win: InstanceType<typeof BrowserWindow>): void {
  if (_keepMapped.isActive()) {
    _keepMapped.present(win, _setContentVisible(win));
  } else {
    win.showInactive();
    win.moveTop();
  }
  _applyClickThrough(win);
  _reassertClickThrough(win);
}

function _hideWindow(win: InstanceType<typeof BrowserWindow>): void {
  if (_keepMapped.hide(win, _setContentVisible(win))) {
    _applyClickThrough(win);
    return;
  }
  win.hide();
}

interface PendingTradeNotification {
  match: TradeMatchPayload;
  status: TradeNotificationStatus;
  revision: number;
}

let _pendingNotification: PendingTradeNotification | null = null;

interface ArmedRep {
  accelerator: string;
  partner: string;
  revision: number;
}

let _armedRep: ArmedRep | null = null;
let _repBusy = false;

function _disarmRep(): void {
  if (!_armedRep) return;
  unregisterTransientHotkey(_armedRep.accelerator);
  _armedRep = null;
}

function _clearHideTimer(): void {
  if (!_hideTimer) return;
  clearTimeout(_hideTimer);
  _hideTimer = null;
}

function _invalidateNotification(): void {
  _notificationRevision += 1;
  _pendingNotification = null;
  _disarmRep();
  _clearHideTimer();
}

function _armRepOffer(offer: TradeRepOffer, revision: number): boolean {
  if (_repBusy || revision !== _notificationRevision) return false;
  _disarmRep();
  const armed: ArmedRep = {
    accelerator: offer.hotkey,
    partner: offer.partner,
    revision,
  };
  const ok = registerTransientHotkey(armed.accelerator, () => void _onRepHotkey(armed));
  if (!ok) {
    log.warn(`[TradeRep] could not bind ${armed.accelerator}; offering no rep prompt`);
    return false;
  }
  _armedRep = armed;
  return true;
}

async function _onRepHotkey(armed: ArmedRep): Promise<void> {
  if (_armedRep !== armed || armed.revision !== _notificationRevision) return;
  _disarmRep();
  _repBusy = true;
  try {
    const result = await wfmReviews.sendPlusRep(armed.partner);
    if (armed.revision !== _notificationRevision) return;
    _pushRepResult({
      result,
      partner: armed.partner,
      timing: { visibleMs: REP_RESULT_VISIBLE_MS, fadeMs: RENDERER_FADE_MS },
    });
  } finally {
    _repBusy = false;
  }
}

function _pushRepResult(payload: TradeRepResultPayload): void {
  const win = ctx.tradeNotificationWindow;
  if (!win || win.isDestroyed()) return;
  win.webContents.send(TRADE_NOTIFICATION_REP_RESULT, payload);
  _presentWindow(win);
  _scheduleHide(win, payload.timing.visibleMs + payload.timing.fadeMs + MAIN_HIDE_BUFFER_MS);
}

function _scheduleHide(win: InstanceType<typeof BrowserWindow>, delayMs: number): void {
  _clearHideTimer();
  _hideTimer = setTimeout(() => {
    _hideTimer = null;
    _disarmRep();
    if (!win.isDestroyed()) _hideWindow(win);
  }, delayMs);
}

function _displayNotification(
  win: InstanceType<typeof BrowserWindow>,
  pending: PendingTradeNotification,
): void {
  if (pending.revision !== _notificationRevision) return;
  const offer = resolveRepOffer(pending.match, pending.status, {
    enabled: !!ctx.overlaySettings.tradeRepHotkeyEnabled,
    hotkey: String(ctx.overlaySettings.tradeRepHotkey || ""),
  });
  const rep = offer && _armRepOffer(offer, pending.revision) ? offer : null;
  const payload: TradeNotificationShowPayload = {
    match: pending.match,
    status: pending.status,
    rep,
    timing: { visibleMs: rep ? REP_VISIBLE_MS : RENDERER_VISIBLE_MS, fadeMs: RENDERER_FADE_MS },
  };
  win.webContents.send(TRADE_NOTIFICATION_SHOW, payload);
  _presentWindow(win);

  _scheduleHide(win, payload.timing.visibleMs + payload.timing.fadeMs + MAIN_HIDE_BUFFER_MS);

  log.info(
    `[TradeNotification] Showing (${pending.status}): ${pending.match.type} ` +
      `${pending.match.itemName} ${pending.match.platinum}p with ${pending.match.partner}` +
      `${rep ? ` (+rep armed on ${rep.hotkey})` : ""}`,
  );
}

function _getOrCreateWindow(): InstanceType<typeof BrowserWindow> {
  const existing = ctx.tradeNotificationWindow;
  if (existing && !existing.isDestroyed()) return existing;

  const preloadPath = path.join(
    app.getAppPath(),
    ".electron-build",
    "preload-trade-notification.js",
  );

  const primaryDisplay = screen.getPrimaryDisplay();
  const { x: dX, y: dY, width: dW } = primaryDisplay.workArea;

  const win = new BrowserWindow({
    // Notification windows prevent Linux focus-on-map for non-interactive toasts.
    ...(process.platform === "linux" ? { type: "notification" } : {}),
    width: WIN_W,
    height: WIN_H,
    x: dX + dW - WIN_W - MARGIN,
    y: dY + MARGIN,
    show: false,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    focusable: false,
    hasShadow: false,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  hardenBrowserWindowNavigation(win, {
    label: "trade notification window",
    allowedFilePaths: [NOTIFICATION_FILE],
    log,
  });

  _rendererReady = false;
  void win.loadFile(NOTIFICATION_FILE).catch((error: unknown) => {
    log.warn("[TradeNotification] Failed to load renderer:", error);
  });
  win.webContents.once("did-finish-load", () => {
    _rendererReady = true;
    if (_pendingNotification) {
      const pending = _pendingNotification;
      _pendingNotification = null;
      _displayNotification(win, pending);
    }
  });
  win.setAlwaysOnTop(true, "screen-saver");
  win.setIgnoreMouseEvents(true);
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  win.on("closed", () => {
    ctx.tradeNotificationWindow = null;
    _rendererReady = false;
    _invalidateNotification();
  });

  ctx.tradeNotificationWindow = win;
  return win;
}

export function showTradeNotification(
  match: TradeNotificationShowPayload["match"],
  status: TradeNotificationStatus,
): void {
  _notificationRevision += 1;
  _pendingNotification = null;
  _disarmRep();
  _clearHideTimer();

  const pending: PendingTradeNotification = {
    match,
    status,
    revision: _notificationRevision,
  };
  const win = _getOrCreateWindow();
  if (_rendererReady) _displayNotification(win, pending);
  else _pendingNotification = pending;
}

export function hideTradeNotification(): void {
  _invalidateNotification();
  const win = ctx.tradeNotificationWindow;
  if (win && !win.isDestroyed()) _hideWindow(win);
}

export function register(): void {
  onAuthorized(TRADE_NOTIFICATION_DISMISS, assertTradeNotificationSender, () => {
    const win = ctx.tradeNotificationWindow;
    if (win && !win.isDestroyed()) _hideWindow(win);
    _disarmRep();
    _clearHideTimer();
  });
}
