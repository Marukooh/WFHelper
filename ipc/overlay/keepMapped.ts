import {
  isNativeWayland as linuxIsNativeWayland,
  isTilingCompositor as linuxIsTilingCompositor,
} from "../../services/linuxDisplayBackend";

interface KeepMappedWindow {
  isVisible: () => boolean;
  showInactive: () => void;
  moveTop: () => void;
}

interface KeepMappedOptions {
  /** Log prefix, e.g. "OverlayWindow reward" or "TradeNotification". */
  label: string;
  /** Blanking an opaque window still leaves a visible box, so only transparent
   *  windows can be hidden this way. */
  transparent: boolean;
  platform?: NodeJS.Platform;
  isNativeWayland?: () => boolean;
  isTilingCompositor?: () => boolean;
  log?: { info?: (...args: unknown[]) => void };
}

/** Native-Wayland maps always activate the window, so a mapped overlay would
 *  blink the game out of focus on every show. Instead it is mapped once and
 *  "hidden" by blanking its DOM, which costs no map and no focus change. */
export function createKeepMappedMode(options: KeepMappedOptions) {
  const {
    label,
    transparent,
    platform = process.platform,
    isNativeWayland = linuxIsNativeWayland,
    isTilingCompositor = linuxIsTilingCompositor,
    log,
  } = options;
  let logged = false;

  // Tiling compositors are excluded: click-through does not take effect there, so
  // a blanked window stays on screen and still takes the clicks meant for the game.
  // Whether the empty input region is never applied or applied and then ignored is
  // unknown. Unmapping for real is the lesser evil either way.
  function isActive(): boolean {
    return platform === "linux" && transparent && isNativeWayland() && !isTilingCompositor();
  }

  function logOnce(): void {
    if (logged) return;
    logged = true;
    log?.info?.(`[${label}] keep-mapped mode active (native Wayland)`);
  }

  return {
    isActive,
    /** Show content in an already-mapped window; maps it on the very first call. */
    present(win: KeepMappedWindow, setContentVisible: (visible: boolean) => void): void {
      logOnce();
      setContentVisible(true);
      if (!win.isVisible()) win.showInactive();
      win.moveTop();
    },
    /** Blank the content instead of unmapping. False when the caller should hide
     *  the window the normal way (mode inactive, or never mapped in the first place). */
    hide(win: KeepMappedWindow, setContentVisible: (visible: boolean) => void): boolean {
      if (!isActive() || !win.isVisible()) return false;
      setContentVisible(false);
      return true;
    },
  };
}
