import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { once: vi.fn() },
  BrowserWindow: class {},
}));
vi.mock("../../services/warframeStatus", () => ({
  getStatus: vi.fn(),
  isWindowTopmost: vi.fn(() => null),
}));

import { applyOverlayZOrder } from "../../ipc/overlay/zOrder";
import * as warframeStatus from "../../services/warframeStatus";

beforeEach(() => {
  vi.mocked(warframeStatus.isWindowTopmost).mockReturnValue(null);
});

function fakeWindow(alwaysOnTop = false) {
  const win = {
    alwaysOnTop,
    setSkipTaskbar: vi.fn(),
    setVisibleOnAllWorkspaces: vi.fn(),
    setAlwaysOnTop: vi.fn((value: boolean) => {
      win.alwaysOnTop = value;
    }),
    moveTop: vi.fn(),
    isAlwaysOnTop: vi.fn(() => win.alwaysOnTop),
    getNativeWindowHandle: vi.fn(() => Buffer.alloc(8)),
  };
  return win;
}

type FakeWindow = ReturnType<typeof fakeWindow>;
const apply = (win: FakeWindow, focused: boolean) =>
  applyOverlayZOrder(win as unknown as Parameters<typeof applyOverlayZOrder>[0], focused);

describe("applyOverlayZOrder", () => {
  it("raises a window that is not already on top", () => {
    const win = fakeWindow();

    apply(win, true);

    expect(win.setAlwaysOnTop).toHaveBeenCalledWith(true, "screen-saver");
    expect(win.moveTop).toHaveBeenCalledTimes(1);
  });

  // Re-applying the taskbar flag is what re-activated the window and stole focus
  // from the game, so no branch may touch it.
  it("never touches the taskbar flag on any branch", () => {
    for (const [alreadyOnTop, focused] of [
      [false, true],
      [true, true],
      [false, false],
      [true, false],
    ] as Array<[boolean, boolean]>) {
      const win = fakeWindow(alreadyOnTop);
      apply(win, focused);
      expect(win.setSkipTaskbar).not.toHaveBeenCalled();
    }
  });

  // moveTop() on an already-raised window pulls it into the foreground, which
  // unfocuses the game and flips the next poll - the loop that fed itself.
  it("does not re-raise on every poll while the game stays focused", () => {
    const win = fakeWindow();

    apply(win, true);
    apply(win, true);
    apply(win, true);

    expect(win.moveTop).toHaveBeenCalledTimes(1);
  });

  it("drops always-on-top once the game loses focus", () => {
    const win = fakeWindow();

    apply(win, true);
    apply(win, false);

    expect(win.setAlwaysOnTop).toHaveBeenLastCalledWith(false);
    expect(win.setVisibleOnAllWorkspaces).toHaveBeenLastCalledWith(false);
  });

  // Overlays are raised outside this module too (the unlock hotkey re-asserts
  // always-on-top). A remembered state missed those and skipped the drop,
  // stranding the overlay above every other app until the game refocused.
  it("still drops a window raised by someone else", () => {
    const win = fakeWindow();

    apply(win, true);
    apply(win, false);
    win.alwaysOnTop = true; // keepOverlayAboveGame, outside this module
    apply(win, false);

    expect(win.isAlwaysOnTop()).toBe(false);
  });

  it("leaves an unfocused window that is already down alone", () => {
    const win = fakeWindow();

    apply(win, false);

    expect(win.setAlwaysOnTop).not.toHaveBeenCalled();
  });

  it("raises when the OS says the band is gone though the cache disagrees", () => {
    vi.mocked(warframeStatus.isWindowTopmost).mockReturnValue(false);
    const win = fakeWindow(true);

    apply(win, true);

    expect(win.setAlwaysOnTop).toHaveBeenCalledWith(true, "screen-saver");
    expect(win.moveTop).toHaveBeenCalledTimes(1);
  });

  it("skips the raise while the OS confirms the window is topmost", () => {
    vi.mocked(warframeStatus.isWindowTopmost).mockReturnValue(true);
    const win = fakeWindow(false);

    apply(win, true);

    expect(win.moveTop).not.toHaveBeenCalled();
  });
});
