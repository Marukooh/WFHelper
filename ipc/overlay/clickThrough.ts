/** Window input-shape helpers shared by the overlay controllers and the toast. */

interface ShapeableWindow {
  isDestroyed: () => boolean;
  setIgnoreMouseEvents: (ignore: boolean) => void;
}

// Two passes: one right after the map, one late enough for a slow compositor.
export const CLICK_THROUGH_REASSERT_DELAYS_MS = [250, 1_500];

/** Turning click-through on drops the region first: re-setting an identical X11
 *  input shape tells the compositor nothing, and that transition is what F7
 *  makes by hand. */
export function setClickThrough(
  win: ShapeableWindow,
  ignoreMouse: boolean,
  platform: NodeJS.Platform = process.platform,
): void {
  if (ignoreMouse && platform === "linux") win.setIgnoreMouseEvents(false);
  // Never {forward:true}: on Windows it installs a global WH_MOUSE_LL hook that
  // taxes every mouse event system-wide - it lagged the game's input.
  win.setIgnoreMouseEvents(ignoreMouse);
}

/** Runs `apply` on the post-map delays, because a shape set in the same breath
 *  as the show lands before the window is mapped and is lost. Returns the pass
 *  so a caller can run it on did-finish-load as well. */
export function scheduleClickThroughReassert(
  win: Pick<ShapeableWindow, "isDestroyed">,
  apply: () => void,
  options: { skip?: () => boolean; onFirstPass?: () => void } = {},
): () => void {
  let applied = false;
  const pass = (): void => {
    if (win.isDestroyed() || options.skip?.()) return;
    apply();
    if (applied) return;
    applied = true;
    options.onFirstPass?.();
  };
  for (const delay of CLICK_THROUGH_REASSERT_DELAYS_MS) setTimeout(pass, delay);
  return pass;
}
