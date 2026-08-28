import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

const probe = vi.hoisted(() => ({ nativeBounds: null as unknown }));

vi.mock("../../services/x11WindowQuery", () => ({
  findWindowBoundsByTitle: vi.fn(() => probe.nativeBounds),
  isWindowFocusedByTitle: vi.fn(() => true),
}));

vi.mock("node:fs", () => {
  const fs = {
    readdirSync: vi.fn(() => ["1"]),
    readFileSync: vi.fn(() => "Warframe.x64.exe"),
  };
  return { ...fs, default: fs };
});

vi.mock("electron", () => ({
  screen: { getDisplayMatching: vi.fn(() => ({ id: 7 })) },
  app: { once: vi.fn(), getPath: vi.fn(() => "/tmp") },
}));

const realPlatform = process.platform;
const realDisplay = process.env.DISPLAY;
const NATIVE_BOUNDS: Bounds = { x: 0, y: 0, width: 1920, height: 1080 };

function setPlatform(value: string): void {
  Object.defineProperty(process, "platform", { value, configurable: true });
}

// The probe is async and returns whatever the X query handed back, so a
// thenable lets a test hold the bounds request open while its peers finish.
function heldBounds(value: Bounds): { thenable: unknown; release: () => void } {
  let open = (): void => {};
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return {
    thenable: {
      ...value,
      then: (onFulfilled: (bounds: Bounds) => void) => {
        void opened.then(() => onFulfilled(value));
      },
    },
    release: () => open(),
  };
}

describe("getStatus bounds skipping on linux", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    probe.nativeBounds = { ...NATIVE_BOUNDS };
    setPlatform("linux");
    process.env.DISPLAY = ":0";
  });

  afterEach(() => {
    vi.useRealTimers();
    Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
    if (realDisplay === undefined) delete process.env.DISPLAY;
    else process.env.DISPLAY = realDisplay;
  });

  it("skips the X tree walk when the caller only needs focus", async () => {
    const { findWindowBoundsByTitle } = await import("../../services/x11WindowQuery");
    const warframeStatus = await import("../../services/warframeStatus");

    const status = await warframeStatus.getStatus({ needBounds: false });

    expect(status.isFocused).toBe(true);
    expect(findWindowBoundsByTitle).not.toHaveBeenCalled();
  });

  it("still resolves geometry for callers that anchor to the game display", async () => {
    const { findWindowBoundsByTitle } = await import("../../services/x11WindowQuery");
    const warframeStatus = await import("../../services/warframeStatus");

    const status = await warframeStatus.getStatus();

    expect(findWindowBoundsByTitle).toHaveBeenCalled();
    expect(status.focusedWindowBounds).toEqual(NATIVE_BOUNDS);
  });

  it("never serves a bounds-free cache entry to a caller that needs bounds", async () => {
    const { findWindowBoundsByTitle } = await import("../../services/x11WindowQuery");
    const warframeStatus = await import("../../services/warframeStatus");

    await warframeStatus.getStatus({ needBounds: false });
    // Inside the 2s TTL: the cheap entry must not satisfy this one.
    const full = await warframeStatus.getStatus();

    expect(findWindowBoundsByTitle).toHaveBeenCalledTimes(1);
    expect(full.focusedWindowBounds).not.toBeNull();
  });

  it("reuses a bounds-complete cache entry for a cheap caller", async () => {
    const { findWindowBoundsByTitle } = await import("../../services/x11WindowQuery");
    const warframeStatus = await import("../../services/warframeStatus");

    await warframeStatus.getStatus();
    await warframeStatus.getStatus({ needBounds: false });

    expect(findWindowBoundsByTitle).toHaveBeenCalledTimes(1);
  });

  it("keeps the bounds request in flight when its bounds-free peer settles first", async () => {
    const held = heldBounds(NATIVE_BOUNDS);
    probe.nativeBounds = held.thenable;
    const { findWindowBoundsByTitle } = await import("../../services/x11WindowQuery");
    const warframeStatus = await import("../../services/warframeStatus");

    const cheap = warframeStatus.getStatus({ needBounds: false });
    const full = warframeStatus.getStatus();
    const cheapStatus = await cheap;

    // The bounds walk is still running, so a caller that bypasses the cache
    // has to join it instead of starting a second one.
    const joined = warframeStatus.getStatus({ force: true });
    held.release();
    const [fullStatus, joinedStatus] = await Promise.all([full, joined]);

    expect(findWindowBoundsByTitle).toHaveBeenCalledTimes(1);
    expect(cheapStatus.focusedWindowBounds).toBeNull();
    expect(fullStatus.focusedWindowBounds).toEqual(NATIVE_BOUNDS);
    expect(joinedStatus.focusedWindowBounds).toEqual(NATIVE_BOUNDS);
  });

  it("keeps cached geometry when a bounds-free probe observes the same instant", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { findWindowBoundsByTitle } = await import("../../services/x11WindowQuery");
    const warframeStatus = await import("../../services/warframeStatus");

    await warframeStatus.getStatus();
    await warframeStatus.getStatus({ force: true, needBounds: false });
    const cached = await warframeStatus.getStatus();

    expect(findWindowBoundsByTitle).toHaveBeenCalledTimes(1);
    expect(cached.focusedWindowBounds).toEqual(NATIVE_BOUNDS);
  });
});
