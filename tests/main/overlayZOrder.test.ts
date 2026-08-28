import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { once: vi.fn() },
  BrowserWindow: class {},
}));
vi.mock("../../services/warframeStatus", () => ({
  getStatus: vi.fn(),
  isWindowTopmost: vi.fn(() => null),
}));
// hoisted: vi.mock factories run before top-level consts are initialised.
const { logInfo } = vi.hoisted(() => ({ logInfo: vi.fn() }));
vi.mock("../../services/logger", () => ({
  withScope: () => ({
    info: (...args: unknown[]) => logInfo(...args),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    time: vi.fn(),
    timeEnd: vi.fn(),
  }),
}));

import { applyOverlayZOrder, syncOverlayWindowZOrder } from "../../ipc/overlay/zOrder";
import * as warframeStatus from "../../services/warframeStatus";

beforeEach(() => {
  vi.mocked(warframeStatus.isWindowTopmost).mockReset().mockReturnValue(null);
  logInfo.mockClear();
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
    isDestroyed: vi.fn(() => false),
    getNativeWindowHandle: vi.fn(() => Buffer.alloc(8)),
  };
  return win;
}

// A compositor with no _NET_WM_STATE_ABOVE support never reports the band back,
// so setAlwaysOnTop(true) leaves isAlwaysOnTop() false forever.
function fakeWindowWithoutAboveSupport() {
  const win = fakeWindow();
  win.setAlwaysOnTop.mockImplementation((value: boolean) => {
    if (!value) win.alwaysOnTop = false;
  });
  return win;
}

type FakeWindow = ReturnType<typeof fakeWindow>;
const asWindow = (win: FakeWindow) => win as unknown as Parameters<typeof applyOverlayZOrder>[0];
const apply = (win: FakeWindow, focused: boolean, platform?: typeof process.platform) =>
  applyOverlayZOrder(asWindow(win), focused, platform);

function fakeController(visible = true, hideDueIn: number | null = null) {
  return {
    isOverlayWindowVisible: vi.fn(() => visible),
    overlayHideDueIn: vi.fn(() => hideDueIn),
    setVisible: (next: boolean) => {
      visible = next;
    },
  };
}

const sync = (
  controller: ReturnType<typeof fakeController>,
  win: FakeWindow,
  focused: boolean,
  platform: typeof process.platform,
) => syncOverlayWindowZOrder(controller, asWindow(win), focused, platform);

// Pinned to win32: the suite runs on ubuntu in CI, where an unpinned call would
// silently take the linux branch and stop testing the WS_EX_TOPMOST gate.
describe("applyOverlayZOrder on Windows", () => {
  it("raises a window that is not already on top", () => {
    const win = fakeWindow();

    apply(win, true, "win32");

    expect(win.setAlwaysOnTop).toHaveBeenCalledWith(true, "screen-saver");
    expect(win.moveTop).toHaveBeenCalledTimes(1);
  });

  // Re-applying the taskbar flag is what re-activated the window and stole focus
  // from the game, so no branch may touch it.
  it("never touches the taskbar flag on any branch", () => {
    for (const platform of ["win32", "linux"] as Array<typeof process.platform>) {
      for (const [alreadyOnTop, focused] of [
        [false, true],
        [true, true],
        [false, false],
        [true, false],
      ] as Array<[boolean, boolean]>) {
        const win = fakeWindow(alreadyOnTop);
        apply(win, focused, platform);
        expect(win.setSkipTaskbar).not.toHaveBeenCalled();
      }
    }
  });

  // moveTop() on an already-raised window pulls it into the foreground, which
  // unfocuses the game and flips the next poll - the loop that fed itself.
  it("does not re-raise on every poll while the game stays focused", () => {
    const win = fakeWindow();

    apply(win, true, "win32");
    apply(win, true, "win32");
    apply(win, true, "win32");

    expect(win.moveTop).toHaveBeenCalledTimes(1);
  });

  it("drops always-on-top once the game loses focus", () => {
    const win = fakeWindow();

    apply(win, true, "win32");
    apply(win, false, "win32");

    expect(win.setAlwaysOnTop).toHaveBeenLastCalledWith(false);
    expect(win.setVisibleOnAllWorkspaces).toHaveBeenLastCalledWith(false);
  });

  // Overlays are raised outside this module too (the unlock hotkey re-asserts
  // always-on-top). A remembered state missed those and skipped the drop,
  // stranding the overlay above every other app until the game refocused.
  it("still drops a window raised by someone else", () => {
    const win = fakeWindow();

    apply(win, true, "win32");
    apply(win, false, "win32");
    win.alwaysOnTop = true; // keepOverlayAboveGame, outside this module
    apply(win, false, "win32");

    expect(win.isAlwaysOnTop()).toBe(false);
  });

  it("leaves an unfocused window that is already down alone", () => {
    const win = fakeWindow();

    apply(win, false, "win32");

    expect(win.setAlwaysOnTop).not.toHaveBeenCalled();
  });

  it("raises when the OS says the band is gone though the cache disagrees", () => {
    vi.mocked(warframeStatus.isWindowTopmost).mockReturnValue(false);
    const win = fakeWindow(true);

    apply(win, true, "win32");

    expect(win.setAlwaysOnTop).toHaveBeenCalledWith(true, "screen-saver");
    expect(win.moveTop).toHaveBeenCalledTimes(1);
  });

  it("skips the raise while the OS confirms the window is topmost", () => {
    vi.mocked(warframeStatus.isWindowTopmost).mockReturnValue(true);
    const win = fakeWindow(false);

    apply(win, true, "win32");

    expect(win.moveTop).not.toHaveBeenCalled();
  });

  // The remembered raise is linux-only; Windows keeps re-asserting whenever the
  // live ex-style says the window fell out of the topmost band.
  it("keeps re-raising every poll while the live style says not topmost", () => {
    vi.mocked(warframeStatus.isWindowTopmost).mockReturnValue(false);
    const win = fakeWindow();

    apply(win, true, "win32");
    apply(win, true, "win32");
    apply(win, true, "win32");

    expect(win.moveTop).toHaveBeenCalledTimes(3);
    expect(win.setVisibleOnAllWorkspaces).toHaveBeenCalledTimes(3);
  });
});

describe("applyOverlayZOrder on linux", () => {
  // niri via xwayland-satellite never reports _NET_WM_STATE_ABOVE back, so the
  // isAlwaysOnTop() gate never closed and the poll restacked the overlay over
  // the fullscreen game every 2s. That is the frame drop and the focus churn.
  it("stops re-raising even when the wm never reports always-on-top", () => {
    const win = fakeWindowWithoutAboveSupport();

    apply(win, true, "linux");
    apply(win, true, "linux");
    apply(win, true, "linux");

    expect(win.isAlwaysOnTop()).toBe(false);
    expect(win.moveTop).toHaveBeenCalledTimes(1);
    expect(win.setVisibleOnAllWorkspaces).toHaveBeenCalledTimes(1);
    expect(win.setAlwaysOnTop).toHaveBeenCalledTimes(1);
  });

  it("does not read the win32 topmost style", () => {
    const win = fakeWindowWithoutAboveSupport();

    apply(win, true, "linux");
    apply(win, true, "linux");

    expect(win.getNativeWindowHandle).not.toHaveBeenCalled();
    expect(warframeStatus.isWindowTopmost).not.toHaveBeenCalled();
  });

  // One support line per process, not one per raise: the log is there to say the
  // linux path ran, and a per-tick line would be the noise it replaced.
  it("names the linux raise once per process", () => {
    apply(fakeWindowWithoutAboveSupport(), true, "linux");
    logInfo.mockClear();
    const later = fakeWindowWithoutAboveSupport();

    apply(later, true, "linux");
    apply(later, true, "linux");

    expect(logInfo).not.toHaveBeenCalled();
  });

  it("drops the band on unfocus though the wm never confirmed it", () => {
    const win = fakeWindowWithoutAboveSupport();

    apply(win, true, "linux");
    apply(win, false, "linux");

    expect(win.setAlwaysOnTop).toHaveBeenLastCalledWith(false);
    expect(win.setVisibleOnAllWorkspaces).toHaveBeenLastCalledWith(false);
  });

  it("re-applies once the desired state drifts back", () => {
    const win = fakeWindowWithoutAboveSupport();

    apply(win, true, "linux");
    apply(win, false, "linux");
    apply(win, true, "linux");

    expect(win.moveTop).toHaveBeenCalledTimes(2);
  });

  it("leaves an unfocused window that was never raised alone", () => {
    const win = fakeWindowWithoutAboveSupport();

    apply(win, false, "linux");

    expect(win.setAlwaysOnTop).not.toHaveBeenCalled();
    expect(win.setVisibleOnAllWorkspaces).not.toHaveBeenCalled();
  });
});

describe("syncOverlayWindowZOrder", () => {
  it("skips a hidden overlay entirely", () => {
    const win = fakeWindowWithoutAboveSupport();
    const controller = fakeController(false);

    sync(controller, win, true, "linux");

    expect(win.moveTop).not.toHaveBeenCalled();
    expect(win.setAlwaysOnTop).not.toHaveBeenCalled();
  });

  it("skips a window whose hide is imminent", () => {
    const win = fakeWindowWithoutAboveSupport();
    const controller = fakeController(true, 1_000);

    sync(controller, win, true, "linux");

    expect(win.moveTop).not.toHaveBeenCalled();
  });

  // The unfocus-hide unmaps the panels; the next map starts unstacked, so the
  // remembered raise has to be dropped with the window or it never comes back.
  it("forgets the remembered raise across a hide so the re-show raises again", () => {
    const win = fakeWindowWithoutAboveSupport();
    const controller = fakeController(true);

    sync(controller, win, true, "linux");
    sync(controller, win, true, "linux");
    expect(win.moveTop).toHaveBeenCalledTimes(1);

    controller.setVisible(false);
    sync(controller, win, true, "linux");
    controller.setVisible(true);
    sync(controller, win, true, "linux");
    sync(controller, win, true, "linux");

    expect(win.moveTop).toHaveBeenCalledTimes(2);
  });

  it("keeps the Windows poll re-asserting on every visible tick", () => {
    vi.mocked(warframeStatus.isWindowTopmost).mockReturnValue(false);
    const win = fakeWindow();
    const controller = fakeController(true);

    sync(controller, win, true, "win32");
    sync(controller, win, true, "win32");

    expect(win.moveTop).toHaveBeenCalledTimes(2);
  });
});
