import path from "node:path";
import { clampNumber } from "../../config/shared/numeric";
import { baseZoomForDisplay } from "../../config/runtime/uiScale";
import { OVERLAY_CONTENT_VISIBLE } from "../../config/shared/ipcChannels";
import { isNativeWayland as linuxIsNativeWayland } from "../../services/linuxDisplayBackend";
import { createKeepMappedMode } from "./keepMapped";
import type {
  OverlaySavedWindowBounds,
  OverlayWindowKey,
} from "../../config/runtime/overlaySettings";

// Two passes: one right after the map, one late enough for a slow compositor.
const CLICK_THROUGH_REASSERT_DELAYS_MS = [250, 1_500];

const OVERLAY_WINDOW_BOUNDS = Object.freeze({
  width: 980,
  height: 140,
  horizontalMargin: 16,
  bottomMargin: 18,
  topMargin: 8,
  defaultYRatio: 0.56,
  anchorGapRatio: 0.04,
  anchorMinRatio: 0.32,
  anchorMaxRatio: 0.82,
});

type OverlayAnchorMeta = {
  sourceDisplayId?: string | null;
  bandTopRatio?: number | null;
  bandBottomRatio?: number | null;
};

type OverlayContext = {
  overlayWindow: import("electron").BrowserWindow | null;
  overlaySettings: import("../../config/runtime/overlaySettings").OverlaySettings;
  overlayInteractiveMode: boolean;
};

type OverlaySettingsPersistenceOptions = {
  ctx: Pick<OverlayContext, "overlaySettings">;
  save: () => void;
};

type OverlayWindowsControllerOptions = {
  app: typeof import("electron").app;
  BrowserWindow: typeof import("electron").BrowserWindow;
  screen: typeof import("electron").screen;
  ctx: OverlayContext;
  getOverlayWindow?: () => import("electron").BrowserWindow | null;
  setOverlayWindow?: (window: import("electron").BrowserWindow | null) => void;
  getOverlayInteractiveMode?: () => boolean;
  setOverlayInteractiveModeState?: (enabled: boolean) => void;
  log: { warn: (...args: unknown[]) => void; info?: (...args: unknown[]) => void };
  hardenBrowserWindowNavigation: (
    browserWindow: import("electron").BrowserWindow,
    options: {
      label: string;
      allowedFilePaths: string[];
      log: { warn: (...args: unknown[]) => void };
    },
  ) => void;
  overlayWindowFile: string;
  windowLabel?: string;
  preloadFileName?: string;
  fileSearch?: string;
  placement?: "center" | "top-left" | "top-right";
  displayMode?: "cursor" | "primary";
  topOffset?: number;
  windowWidth?: number;
  windowHeight?: number;
  minWindowWidth?: number;
  minWindowHeight?: number;
  hasShadow?: boolean;
  /** When false the window gets a solid background (default: true = transparent). */
  transparent?: boolean;
  /** Background colour used when transparent=false (default: '#060a12'). */
  backgroundColor?: string;
  windowStateKey?: OverlayWindowKey;
  onWindowBoundsChanged?: (
    key: OverlayWindowKey,
    bounds: OverlaySavedWindowBounds,
    scale?: number,
  ) => void;
  /** Persist moves even in passive mode (arbi summary drags without the unlock hotkey). */
  persistBoundsWhenPassive?: boolean;
  /** Skip click-through entirely for windows that are meant to stay clickable. */
  neverClickThrough?: boolean;
  /** Restore content the controller does not send itself after a rebuild. */
  onWindowCreated?: (window: import("electron").BrowserWindow) => void;
  platform?: NodeJS.Platform;
  isNativeWayland?: () => boolean;
};

interface MovableWindow {
  getBounds(): { x: number; y: number };
  setPosition(x: number, y: number, animate?: boolean): void;
}

// setPosition, never setBounds: a move has no business writing the size, and
// writing it is what let the window drift when Windows adjusted the frame.
export function moveWindowBy(win: MovableWindow, dx: number, dy: number): void {
  const { x, y } = win.getBounds();
  win.setPosition(x + dx, y + dy, false);
}

export function createOverlayWindowBoundsChangeHandler(
  options: OverlaySettingsPersistenceOptions,
): (key: OverlayWindowKey, bounds: OverlaySavedWindowBounds, scale?: number) => void {
  return (key, bounds, scale) => {
    options.ctx.overlaySettings = {
      ...options.ctx.overlaySettings,
      // live drag = mechanic learned, retire the hint; arbi drags don't count (no hotkey needed there)
      ...(key === "arbiSummary" ? {} : { overlayDragHintDismissed: true }),
      overlayWindowBounds: {
        ...(options.ctx.overlaySettings.overlayWindowBounds || {}),
        [key]: bounds,
      },
      // A resized window writes the scale slider it is now equivalent to, so the
      // size survives the next open and Settings shows what the drag chose.
      ...(scale != null
        ? {
            overlayWindowScales: {
              ...(options.ctx.overlaySettings.overlayWindowScales || {}),
              [key]: scale,
            },
          }
        : {}),
    };
    options.save();
  };
}

export function createOverlayWindowsController(options: OverlayWindowsControllerOptions) {
  const {
    app,
    BrowserWindow,
    screen,
    ctx,
    getOverlayWindow,
    setOverlayWindow,
    getOverlayInteractiveMode,
    setOverlayInteractiveModeState,
    log,
    hardenBrowserWindowNavigation,
    overlayWindowFile,
    windowLabel = "overlay window",
    preloadFileName = "preload-overlay.js",
    fileSearch,
    placement = "center",
    displayMode = "cursor",
    topOffset = OVERLAY_WINDOW_BOUNDS.topMargin,
    windowWidth = OVERLAY_WINDOW_BOUNDS.width,
    windowHeight = OVERLAY_WINDOW_BOUNDS.height,
    minWindowWidth = 760,
    minWindowHeight = 160,
    hasShadow,
    transparent = true,
    backgroundColor = "#060a12",
    windowStateKey,
    onWindowBoundsChanged,
    persistBoundsWhenPassive = false,
    neverClickThrough = false,
    onWindowCreated,
    platform = process.platform,
    isNativeWayland = linuxIsNativeWayland,
  } = options;

  let lastOverlayAnchorMeta: OverlayAnchorMeta | null = null;
  let overlayAutoHideTimer: ReturnType<typeof setTimeout> | null = null;
  let overlayAutoHideAt = 0;
  let suppressMoveSave = false;
  // Windows delivers resize events after setBounds returns, so a timer-based
  // suppression races them. Remember the size we asked for instead.
  let selfRequestedSize: { width: number; height: number } | null = null;
  let moveSaveTimer: ReturnType<typeof setTimeout> | null = null;
  let resizeSaveTimer: ReturnType<typeof setTimeout> | null = null;
  let rendererReady = false;
  let logicalVisible = false;
  let lastAppliedInteractive: boolean | null = null;
  let clickThroughApplied = false;
  let lastAutoHideDelayMs = 0;
  const lastOverlayEvents = new Map<string, unknown>();
  const pendingOverlayEvents: Array<{ channel: string; payload?: unknown }> = [];
  let raiseReassertTimers: Array<ReturnType<typeof setTimeout>> = [];
  const keepMapped = createKeepMappedMode({
    label: `OverlayWindow ${windowLabel}`,
    transparent,
    platform,
    isNativeWayland,
    log,
  });

  const readOverlayWindow =
    getOverlayWindow ||
    (() => {
      return ctx.overlayWindow;
    });

  const writeOverlayWindow =
    setOverlayWindow ||
    ((window: import("electron").BrowserWindow | null) => {
      ctx.overlayWindow = window;
    });

  const readInteractiveMode =
    getOverlayInteractiveMode ||
    (() => {
      return ctx.overlayInteractiveMode;
    });

  const writeInteractiveMode =
    setOverlayInteractiveModeState ||
    ((enabled: boolean) => {
      ctx.overlayInteractiveMode = !!enabled;
    });

  function getElectronBuildFile(fileName: string): string {
    return path.join(app.getAppPath(), ".electron-build", fileName);
  }

  function findDisplayById(displayId: unknown): import("electron").Display | null {
    if (!displayId) return null;
    const wanted = String(displayId);
    return screen.getAllDisplays().find((display) => String(display.id) === wanted) || null;
  }

  function readSavedBounds(): OverlaySavedWindowBounds | null {
    if (!windowStateKey) return null;
    const saved = ctx.overlaySettings?.overlayWindowBounds?.[windowStateKey];
    if (!saved || typeof saved !== "object") return null;
    if (!Number.isFinite(saved.x) || !Number.isFinite(saved.y)) return null;
    return saved;
  }

  function getDisplayForOverlay(anchorMeta: OverlayAnchorMeta | null): import("electron").Display {
    if (displayMode === "primary") {
      return screen.getPrimaryDisplay();
    }

    const metaDisplayId =
      anchorMeta && typeof anchorMeta === "object" ? anchorMeta.sourceDisplayId : null;

    const byMeta = findDisplayById(metaDisplayId);
    if (byMeta) return byMeta;

    try {
      const point = screen.getCursorScreenPoint();
      return screen.getDisplayNearestPoint(point);
    } catch {
      // Cursor position unavailable (e.g. headless/locked session) - fall back to primary.
      return screen.getPrimaryDisplay();
    }
  }

  function getAnchorRatio(anchorMeta: OverlayAnchorMeta | null): number {
    if (!anchorMeta || typeof anchorMeta !== "object") {
      return OVERLAY_WINDOW_BOUNDS.defaultYRatio;
    }

    const bandBottom =
      typeof anchorMeta.bandBottomRatio === "number" && Number.isFinite(anchorMeta.bandBottomRatio)
        ? anchorMeta.bandBottomRatio
        : null;
    if (bandBottom != null) {
      const anchoredRatio = bandBottom + OVERLAY_WINDOW_BOUNDS.anchorGapRatio;
      return clampNumber(
        anchoredRatio,
        OVERLAY_WINDOW_BOUNDS.anchorMinRatio,
        OVERLAY_WINDOW_BOUNDS.anchorMaxRatio,
        OVERLAY_WINDOW_BOUNDS.defaultYRatio,
      );
    }

    const bandTop =
      typeof anchorMeta.bandTopRatio === "number" && Number.isFinite(anchorMeta.bandTopRatio)
        ? anchorMeta.bandTopRatio
        : null;
    if (bandTop == null) {
      return OVERLAY_WINDOW_BOUNDS.defaultYRatio;
    }

    return clampNumber(
      bandTop + OVERLAY_WINDOW_BOUNDS.anchorGapRatio,
      OVERLAY_WINDOW_BOUNDS.anchorMinRatio,
      OVERLAY_WINDOW_BOUNDS.anchorMaxRatio,
      OVERLAY_WINDOW_BOUNDS.defaultYRatio,
    );
  }

  function readUserScale(): number {
    const perWindow = windowStateKey
      ? (ctx.overlaySettings?.overlayWindowScales || {})[windowStateKey]
      : undefined;
    return clampNumber(perWindow ?? ctx.overlaySettings?.overlayScale, 0.75, 1.5, 1);
  }

  function computeOverlayZoomFactor(display: import("electron").Display): number {
    return Number((baseZoomForDisplay(display.workArea) * readUserScale()).toFixed(3));
  }

  // The layout is fixed and only the zoom factor makes it fill the frame, so a
  // dragged edge is a scale change. The axis that moved furthest names it, which
  // keeps a one-sided drag working where the aspect lock is only advisory.
  function scaleFromWindowSize(
    size: { width: number; height: number },
    display: import("electron").Display,
  ): number {
    const base = baseZoomForDisplay(display.workArea);
    const current = readUserScale();
    const byWidth = size.width / Math.max(1, windowWidth * base);
    const byHeight = size.height / Math.max(1, windowHeight * base);
    const dragged =
      Math.abs(byWidth - current) >= Math.abs(byHeight - current) ? byWidth : byHeight;
    return Number(clampNumber(dragged, 0.75, 1.5, current).toFixed(2));
  }

  function getOverlayBoundsForActiveDisplay(
    anchorMeta: OverlayAnchorMeta | null = lastOverlayAnchorMeta,
  ) {
    const savedBounds = readSavedBounds();
    const display =
      (savedBounds ? findDisplayById(savedBounds.displayId) : null) ||
      getDisplayForOverlay(anchorMeta);
    const zoomFactor = computeOverlayZoomFactor(display);
    const scaledWidth = Math.round(windowWidth * zoomFactor);
    const scaledHeight = Math.round(windowHeight * zoomFactor);
    const area = display?.workArea || {
      x: 0,
      y: 0,
      width: scaledWidth,
      height: scaledHeight,
    };

    const maxAllowedWidth = Math.max(
      minWindowWidth,
      area.width - OVERLAY_WINDOW_BOUNDS.horizontalMargin * 2,
    );
    const width = Math.min(scaledWidth, maxAllowedWidth);
    const height = Math.min(scaledHeight, Math.max(minWindowHeight, area.height - 20));

    const minX = area.x + OVERLAY_WINDOW_BOUNDS.horizontalMargin;
    const maxX = area.x + area.width - width - OVERLAY_WINDOW_BOUNDS.horizontalMargin;
    const minY = area.y + OVERLAY_WINDOW_BOUNDS.topMargin;
    const maxY = area.y + area.height - height - OVERLAY_WINDOW_BOUNDS.bottomMargin;

    let x = Math.round(area.x + (area.width - width) / 2);
    let y = Math.round(area.y + area.height * getAnchorRatio(anchorMeta));

    if (savedBounds) {
      x = savedBounds.x;
      y = savedBounds.y;
    } else if (placement === "top-left") {
      x = minX;
      y = area.y + Math.max(0, topOffset);
    } else if (placement === "top-right") {
      x = maxX;
      y = area.y + Math.max(0, topOffset);
    }

    x = Math.max(minX, Math.min(maxX, x));
    y = Math.max(minY, Math.min(maxY, y));

    return { x, y, width, height, zoomFactor };
  }

  function positionOverlayWindow(
    anchorMeta: OverlayAnchorMeta | null = lastOverlayAnchorMeta,
  ): void {
    const overlayWindow = readOverlayWindow();
    if (!overlayWindow || overlayWindow.isDestroyed()) return;
    const { zoomFactor, ...rect } = getOverlayBoundsForActiveDisplay(anchorMeta);
    suppressMoveSave = true;
    selfRequestedSize = { width: rect.width, height: rect.height };
    overlayWindow.setBounds(rect, false);
    overlayWindow.webContents.setZoomFactor(zoomFactor);
    setTimeout(() => {
      suppressMoveSave = false;
    }, 0);
  }

  function displayMatchingBounds(bounds: {
    x: number;
    y: number;
    width: number;
    height: number;
  }): import("electron").Display | null {
    try {
      return screen.getDisplayMatching(bounds) || null;
    } catch {
      // No display matched the bounds.
      return null;
    }
  }

  function saveCurrentWindowBounds(
    overlayWindow: import("electron").BrowserWindow,
    scale?: number,
  ): void {
    if (!windowStateKey || !onWindowBoundsChanged) return;
    if (suppressMoveSave || overlayWindow.isDestroyed()) return;
    if (!readInteractiveMode() && !persistBoundsWhenPassive) return;
    const bounds = overlayWindow.getBounds();
    const display = displayMatchingBounds(bounds);
    const displayId = display ? String(display.id) : null;
    onWindowBoundsChanged(
      windowStateKey,
      {
        x: bounds.x,
        y: bounds.y,
        ...(displayId ? { displayId } : {}),
      },
      scale,
    );
  }

  /** Windows trims a pixel or two off a frame it grants, so never compare exactly. */
  function sizeMatches(
    a: { width: number; height: number },
    b: { width: number; height: number } | null,
  ): boolean {
    if (!b) return false;
    return Math.abs(a.width - b.width) <= 2 && Math.abs(a.height - b.height) <= 2;
  }

  // Zoom follows the frame while the drag is live, so the content the user is
  // sizing is the content they end up with.
  function applyZoomForCurrentSize(overlayWindow: import("electron").BrowserWindow): void {
    const bounds = overlayWindow.getBounds();
    const display = displayMatchingBounds(bounds) || getDisplayForOverlay(lastOverlayAnchorMeta);
    const zoomFactor = baseZoomForDisplay(display.workArea) * scaleFromWindowSize(bounds, display);
    overlayWindow.webContents.setZoomFactor(Number(zoomFactor.toFixed(3)));
  }

  function saveResizedScale(overlayWindow: import("electron").BrowserWindow): void {
    if (overlayWindow.isDestroyed()) return;
    const bounds = overlayWindow.getBounds();
    // Our own sizing lands here too. Only a size we never asked for came from the
    // user, and a size clamped to the work area must not rewrite their scale.
    if (sizeMatches(bounds, selfRequestedSize)) return;
    if (sizeMatches(bounds, getOverlayBoundsForActiveDisplay())) return;
    const display = displayMatchingBounds(bounds) || getDisplayForOverlay(lastOverlayAnchorMeta);
    saveCurrentWindowBounds(overlayWindow, scaleFromWindowSize(bounds, display));
    // Settle on the size the saved scale spells out, so a drag past either end
    // of the slider springs back instead of clipping the content until restart.
    positionOverlayWindow();
  }

  function attachBoundsPersistence(overlayWindow: import("electron").BrowserWindow): void {
    if (!windowStateKey || !onWindowBoundsChanged) return;
    overlayWindow.on("move", () => {
      if (moveSaveTimer) clearTimeout(moveSaveTimer);
      moveSaveTimer = setTimeout(() => {
        moveSaveTimer = null;
        saveCurrentWindowBounds(overlayWindow);
      }, 250);
    });
    overlayWindow.on("resize", () => {
      if (suppressMoveSave || overlayWindow.isDestroyed()) return;
      if (!readInteractiveMode() && !persistBoundsWhenPassive) return;
      // The frame we just asked for is not a drag, whenever the event lands.
      if (sizeMatches(overlayWindow.getBounds(), selfRequestedSize)) return;
      selfRequestedSize = null;
      applyZoomForCurrentSize(overlayWindow);
      if (resizeSaveTimer) clearTimeout(resizeSaveTimer);
      resizeSaveTimer = setTimeout(() => {
        resizeSaveTimer = null;
        saveResizedScale(overlayWindow);
      }, 250);
    });
  }

  function keepOverlayAboveGame(overlayWindow: import("electron").BrowserWindow): void {
    overlayWindow.setSkipTaskbar(true);
    overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    overlayWindow.setAlwaysOnTop(true, "screen-saver");
  }

  function isKeepMappedActive(): boolean {
    return keepMapped.isActive();
  }

  function applyClickThrough(overlayWindow: import("electron").BrowserWindow): void {
    if (neverClickThrough) return;
    clickThroughApplied = true;
    // Re-setting an identical X11 input shape tells the compositor nothing, so the
    // region is dropped first - that is the transition F7 makes by hand.
    if (platform === "linux") overlayWindow.setIgnoreMouseEvents(false);
    // Never {forward:true}: on Windows it installs a global WH_MOUSE_LL hook
    // that taxes every mouse event system-wide - it lagged the game's input.
    overlayWindow.setIgnoreMouseEvents(true);
  }

  // X11 never hands input back after click-through: setIgnoreMouseEvents(false)
  // leaves the empty input shape, so the window must be rebuilt to take clicks.
  function needsRebuildForInteractive(): boolean {
    return platform === "linux" && clickThroughApplied && !isKeepMappedActive();
  }

  function rebuildForInteractive(): void {
    const staleWindow = readOverlayWindow();
    if (!staleWindow || staleWindow.isDestroyed()) return;

    const replay = [...lastOverlayEvents];
    const bounds = staleWindow.getBounds();
    // Destroying clears the auto-hide timer, so a pending one is re-armed below
    // and the overlay cannot end up staying on screen forever.
    const autoHideWasPending = overlayAutoHideTimer !== null;
    log.warn(`[OverlayWindow] rebuilding ${windowLabel} for interactive mode`);
    staleWindow.destroy();

    createOverlayWindow({ show: true });
    const freshWindow = readOverlayWindow();
    if (!freshWindow || freshWindow.isDestroyed()) return;
    suppressMoveSave = true;
    freshWindow.setBounds(bounds, false);
    setTimeout(() => {
      suppressMoveSave = false;
    }, 0);
    for (const [channel, payload] of replay) sendOverlayEvent(channel, payload);
    if (autoHideWasPending) scheduleOverlayAutoHide(lastAutoHideDelayMs);
  }

  // An immediate raise can lose the race against the map, and the z-order poll
  // no longer rescues buried windows. Pending timers are replaced, so stacked
  // triggers raise once.
  function scheduleRaiseReassert(overlayWindow: import("electron").BrowserWindow): void {
    for (const timer of raiseReassertTimers) clearTimeout(timer);
    raiseReassertTimers = CLICK_THROUGH_REASSERT_DELAYS_MS.map((delay) =>
      setTimeout(() => {
        if (overlayWindow.isDestroyed() || !isOverlayWindowVisible()) return;
        keepOverlayAboveGame(overlayWindow);
        overlayWindow.moveTop();
      }, delay),
    );
  }

  // Click-through set in the same breath as the first show lands before X maps
  // the window and is lost, so passive mode is re-asserted once it is up.
  function scheduleClickThroughReassert(overlayWindow: import("electron").BrowserWindow): void {
    let reassertLogged = false;
    const reassert = (): void => {
      if (overlayWindow.isDestroyed() || readInteractiveMode()) return;
      applyClickThrough(overlayWindow);
      if (reassertLogged) return;
      reassertLogged = true;
      log.info?.(`[OverlayWindow] ${windowLabel} click-through re-asserted after map`);
    };
    overlayWindow.webContents.once("did-finish-load", reassert);
    for (const delay of CLICK_THROUGH_REASSERT_DELAYS_MS) setTimeout(reassert, delay);
  }

  function setKeepMappedContentVisible(visible: boolean): void {
    logicalVisible = visible;
    sendOverlayEvent(OVERLAY_CONTENT_VISIBLE, visible);
  }

  function showKeepMapped(overlayWindow: import("electron").BrowserWindow): void {
    keepMapped.present(overlayWindow, setKeepMappedContentVisible);
    keepOverlayAboveGame(overlayWindow);
  }

  function isWebContentsCrashed(webContents: import("electron").WebContents): boolean {
    return webContents.isCrashed();
  }

  function destroyIfRendererCrashed(
    overlayWindow: import("electron").BrowserWindow | null,
  ): boolean {
    if (!overlayWindow || overlayWindow.isDestroyed()) return false;
    if (!isWebContentsCrashed(overlayWindow.webContents)) return false;
    log.warn(`[OverlayWindow] rebuilding ${windowLabel}; renderer process was crashed`);
    overlayWindow.destroy();
    rendererReady = false;
    pendingOverlayEvents.length = 0;
    return true;
  }

  function attachRendererDiagnostics(overlayWindow: import("electron").BrowserWindow): void {
    overlayWindow.webContents.on("did-fail-load", (_event, code, description, url) => {
      log.warn(`[OverlayWindow] ${windowLabel} failed to load ${url}: ${code} ${description}`);
    });
    overlayWindow.webContents.on("render-process-gone", (_event, details) => {
      rendererReady = false;
      pendingOverlayEvents.length = 0;
      log.warn(
        `[OverlayWindow] ${windowLabel} renderer gone reason=${details.reason} exitCode=${details.exitCode}`,
      );
      if (!overlayWindow.isDestroyed()) {
        overlayWindow.destroy();
      }
    });
    overlayWindow.webContents.on("console-message", (event) => {
      if (event.level !== "warning" && event.level !== "error") return;
      log.warn(`[OverlayWindow] ${windowLabel} console: ${event.message}`);
    });
  }

  function createOverlayWindow(options: { show?: boolean } = {}): void {
    const shouldShow = options.show !== false;
    let existingWindow = readOverlayWindow();
    if (destroyIfRendererCrashed(existingWindow)) {
      existingWindow = null;
    }
    // transparent windows re-show as a black box on Windows, so rebuild those; opaque ones are reused
    // (keep-mapped never unmaps, so the black-box path cannot occur there)
    if (
      !isKeepMappedActive() &&
      transparent &&
      shouldShow &&
      existingWindow &&
      !existingWindow.isDestroyed() &&
      !existingWindow.isVisible()
    ) {
      existingWindow.destroy();
      existingWindow = null;
      rendererReady = false;
      pendingOverlayEvents.length = 0;
    }

    if (existingWindow && !existingWindow.isDestroyed()) {
      positionOverlayWindow(lastOverlayAnchorMeta);
      keepOverlayAboveGame(existingWindow);
      if (shouldShow) {
        if (isKeepMappedActive()) {
          showKeepMapped(existingWindow);
        } else {
          existingWindow.showInactive();
          // moveTop + alwaysOnTop confirmed AFTER showInactive so the window
          // is definitely in the visible stack before we raise it.
          existingWindow.moveTop();
          keepOverlayAboveGame(existingWindow);
          const bounds = existingWindow.getBounds();
          const visible = existingWindow.isVisible();
          log.warn(
            `[OverlayWindow] shown existing window visible=${visible} bounds=${JSON.stringify(bounds)}`,
          );
          scheduleRaiseReassert(existingWindow);
        }
      }
      setOverlayInteractiveMode(readInteractiveMode());
      return;
    }

    const initialBounds = getOverlayBoundsForActiveDisplay(lastOverlayAnchorMeta);

    const createdWindow = new BrowserWindow({
      // Toolbar windows avoid Linux focus-on-map while still allowing explicit focus.
      // WFHELPER_NO_TOOLBAR_TYPE=1 drops it when a compositor eats overlay clicks.
      ...(platform === "linux" && process.env.WFHELPER_NO_TOOLBAR_TYPE !== "1"
        ? { type: "toolbar" }
        : {}),
      width: initialBounds.width,
      height: initialBounds.height,
      x: initialBounds.x,
      y: initialBounds.y,
      show: false,
      transparent,
      backgroundColor: transparent ? undefined : backgroundColor,
      frame: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      // resizable:false pins min size to the constructed size, and Windows then
      // subtracts the frame insets on every setBounds, so each drag shrank the
      // window by 16x8. Frameless windows have no resize grips to worry about.
      resizable: true,
      // Non-focusable so showing can never activate the overlay and unfocus
      // the game; interactive mode (F7) flips focusability on temporarily.
      focusable: false,
      hasShadow,
      webPreferences: {
        preload: getElectronBuildFile(preloadFileName),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    // Edge drags stay proportional, so any edge scales the overlay uniformly
    // instead of stretching a layout that only the zoom factor can resize.
    createdWindow.setAspectRatio(windowWidth / windowHeight);

    rendererReady = false;
    logicalVisible = false;
    lastAppliedInteractive = null;
    clickThroughApplied = false;
    lastOverlayEvents.clear();
    pendingOverlayEvents.length = 0;
    writeOverlayWindow(createdWindow);
    attachRendererDiagnostics(createdWindow);

    hardenBrowserWindowNavigation(createdWindow, {
      label: windowLabel,
      allowedFilePaths: [overlayWindowFile],
      log,
    });

    void createdWindow.loadFile(overlayWindowFile, fileSearch ? { search: fileSearch } : undefined);
    positionOverlayWindow(lastOverlayAnchorMeta);
    // z-order calls un-hide a hidden window on Windows - only touch it when showing
    if (shouldShow) {
      // showInactive() first, or moveTop becomes what reveals the window - without
      // the inactive part, so it took focus off the game on every riven open.
      createdWindow.showInactive();
      keepOverlayAboveGame(createdWindow);
      createdWindow.moveTop();
      keepOverlayAboveGame(createdWindow);
      if (isKeepMappedActive()) keepMapped.present(createdWindow, setKeepMappedContentVisible);
      setOverlayInteractiveMode(readInteractiveMode());
      scheduleClickThroughReassert(createdWindow);
      if (!isKeepMappedActive()) scheduleRaiseReassert(createdWindow);
    }
    createdWindow.on("closed", () => {
      // The interactive rebuild destroys and recreates within one tick. If this
      // event lands late it would tear down the replacement, so only the window
      // still registered gets to reset the controller.
      if (readOverlayWindow() !== createdWindow) return;
      clearOverlayAutoHideTimer();
      if (moveSaveTimer) {
        clearTimeout(moveSaveTimer);
        moveSaveTimer = null;
      }
      if (resizeSaveTimer) {
        clearTimeout(resizeSaveTimer);
        resizeSaveTimer = null;
      }
      writeOverlayWindow(null);
      rendererReady = false;
      logicalVisible = false;
      pendingOverlayEvents.length = 0;
    });
    attachBoundsPersistence(createdWindow);
    // The window that just lost focus is the one the OS may have de-banded;
    // this closes the z-order poll's 2s rescue gap to one reassert delay.
    createdWindow.on("blur", () => {
      if (createdWindow.isDestroyed() || readOverlayWindow() !== createdWindow) return;
      if (isOverlayWindowVisible() && !isKeepMappedActive()) scheduleRaiseReassert(createdWindow);
    });
    // Events sent while the page is still loading reach a renderer with no
    // listeners and are lost; the owner replays them once the load finishes.
    onWindowCreated?.(createdWindow);
  }

  /** Milliseconds until the queued hide, null when none is queued. Callers mean
   *  "about to vanish": the planner arms its hide two minutes ahead and needs
   *  its stacking maintained for all of it. */
  function overlayHideDueIn(): number | null {
    if (overlayAutoHideTimer === null) return null;
    return Math.max(0, overlayAutoHideAt - Date.now());
  }

  function clearOverlayAutoHideTimer(): void {
    if (!overlayAutoHideTimer) return;
    clearTimeout(overlayAutoHideTimer);
    overlayAutoHideTimer = null;
  }

  function scheduleOverlayAutoHide(delayMs: number): void {
    clearOverlayAutoHideTimer();

    const delay = Math.max(250, Math.floor(Number(delayMs) || 0));
    lastAutoHideDelayMs = delay;
    const overlayWindow = readOverlayWindow();
    if (!overlayWindow || overlayWindow.isDestroyed()) return;

    overlayAutoHideAt = Date.now() + delay;
    overlayAutoHideTimer = setTimeout(() => {
      overlayAutoHideTimer = null;
      if (isOverlayWindowVisible()) {
        hideOverlayWindow();
      }
    }, delay);
  }

  function isOverlayWindowVisible(): boolean {
    const overlayWindow = readOverlayWindow();
    if (!overlayWindow || overlayWindow.isDestroyed()) return false;
    if (!overlayWindow.isVisible()) return false;
    // Keep-mapped windows are always OS-visible; the logical flag is the truth.
    return isKeepMappedActive() ? logicalVisible : true;
  }

  function hideOverlayWindow(): void {
    const overlayWindow = readOverlayWindow();
    if (!overlayWindow || overlayWindow.isDestroyed()) return;
    if (keepMapped.hide(overlayWindow, setKeepMappedContentVisible)) {
      applyClickThrough(overlayWindow);
      // Still mapped, so an interactive window would hold focus away from the game.
      overlayWindow.blur();
      overlayWindow.setFocusable(false);
      return;
    }
    overlayWindow.hide();
  }

  function showOverlayWindowInactive(): void {
    const overlayWindow = readOverlayWindow();
    if (!overlayWindow || overlayWindow.isDestroyed()) return;
    if (isKeepMappedActive()) {
      showKeepMapped(overlayWindow);
    } else {
      overlayWindow.showInactive();
      scheduleRaiseReassert(overlayWindow);
    }
    // A window shown after a mode change carries the old input state; re-assert it.
    setOverlayInteractiveMode(readInteractiveMode());
  }

  function sendOverlayEvent(channel: string, payload?: unknown): void {
    // Remembered in send order so a rebuilt window can be brought back to the
    // same content; re-inserting keeps the newest payload last.
    lastOverlayEvents.delete(channel);
    lastOverlayEvents.set(channel, payload);

    const targetWindow = readOverlayWindow();
    if (!targetWindow || targetWindow.isDestroyed()) return;
    const sendNow = () => {
      if (!targetWindow || targetWindow.isDestroyed()) return;
      targetWindow.webContents.send(channel, payload);
    };

    if (targetWindow.webContents.isLoadingMainFrame() || !rendererReady) {
      pendingOverlayEvents.push({ channel, payload });
      return;
    }

    sendNow();
  }

  function markRendererReady(senderId: number): boolean {
    const targetWindow = readOverlayWindow();
    if (!targetWindow || targetWindow.isDestroyed()) return false;
    if (targetWindow.webContents.id !== senderId) return false;

    rendererReady = true;
    const pending = pendingOverlayEvents.splice(0);
    for (const event of pending) {
      targetWindow.webContents.send(event.channel, event.payload);
    }
    return true;
  }

  function setAnchorMeta(anchorMeta: OverlayAnchorMeta | null): void {
    lastOverlayAnchorMeta = anchorMeta || null;
  }

  function getAnchorMeta(): OverlayAnchorMeta | null {
    return lastOverlayAnchorMeta;
  }

  function setOverlayInteractiveMode(enabled: boolean): void {
    writeInteractiveMode(!!enabled);
    const overlayWindow = readOverlayWindow();
    if (!overlayWindow || overlayWindow.isDestroyed()) return;

    const interactive = readInteractiveMode();
    const visible = isOverlayWindowVisible();

    if (interactive && visible && needsRebuildForInteractive()) {
      // The rebuilt window is created interactive, so it applies the mode itself.
      rebuildForInteractive();
      return;
    }

    // Input flags apply even while hidden. Skipping them desynced the window from
    // the mode, so a hotkey press during a scan left the overlay click-through.
    if (interactive) {
      overlayWindow.setIgnoreMouseEvents(false);
      overlayWindow.setFocusable(true);
    } else {
      applyClickThrough(overlayWindow);
      if (visible) overlayWindow.blur();
      overlayWindow.setFocusable(false);
    }

    if (lastAppliedInteractive !== interactive) {
      lastAppliedInteractive = interactive;
      log.info?.(
        `[OverlayWindow] ${windowLabel} mode=${interactive ? "interactive" : "passive"} visible=${visible}`,
      );
    }

    // Stacking and focus only mean something for a window that is on screen.
    if (!visible) return;

    keepOverlayAboveGame(overlayWindow);
    overlayWindow.moveTop();
    if (interactive) {
      overlayWindow.focus();
    } else if (!isKeepMappedActive()) {
      // Keep-mapped: the window never unmapped, so there is nothing to re-show.
      overlayWindow.showInactive();
    }
    // Either direction of the focusable flip can drop the window out of the
    // topmost band mid-raise, and focus() only rescues the last-focused window.
    if (!isKeepMappedActive()) scheduleRaiseReassert(overlayWindow);
  }

  return {
    getOverlayBoundsForActiveDisplay,
    positionOverlayWindow,
    createOverlayWindow,
    clearOverlayAutoHideTimer,
    scheduleOverlayAutoHide,
    overlayHideDueIn,
    sendOverlayEvent,
    markRendererReady,
    setAnchorMeta,
    getAnchorMeta,
    setOverlayInteractiveMode,
    isOverlayWindowVisible,
    hideOverlayWindow,
    showOverlayWindowInactive,
  };
}
