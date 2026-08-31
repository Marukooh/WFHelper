import { describe, expect, it, vi } from "vitest";

import { createLayerPresentation } from "../../ipc/overlay/layerPresentation";

/** Frame size defaults match the 4x1 surface the painting tests attach. */
function fakeSurface(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    commit: vi.fn(() => true),
    isClosed: vi.fn(() => false),
    destroy: vi.fn(),
    scale: 1,
    frameWidth: 4,
    frameHeight: 1,
    ...overrides,
  };
}

type PaintListener = (event: unknown, dirty: unknown, image: { toBitmap: () => Buffer }) => void;

function fakeWindow() {
  const handlers: Record<string, PaintListener> = {};
  return {
    setSize: vi.fn(),
    webContents: {
      setFrameRate: vi.fn(),
      setZoomFactor: vi.fn(),
      on: vi.fn((event: "paint", listener: PaintListener) => {
        handlers[event] = listener;
      }),
    },
    paint(bitmap: Buffer) {
      handlers.paint?.(null, null, { toBitmap: () => bitmap });
    },
  };
}

function build(overrides: Partial<Parameters<typeof createLayerPresentation>[0]> = {}) {
  const surface = fakeSurface();
  const createSurface = vi.fn(() => surface as never);
  const resolveOutput = vi.fn(async () => "DP-1");
  const presentation = createLayerPresentation({
    label: "test",
    anchor: "top-left",
    createSurface,
    resolveOutput,
    ...overrides,
  });
  return { presentation, surface, createSurface, resolveOutput };
}

describe("createLayerPresentation", () => {
  it("maps the surface on the output the game is on", async () => {
    const { presentation, createSurface, resolveOutput } = build();
    presentation.attach(fakeWindow(), 460, 236);

    expect(await presentation.show()).toBe(true);

    expect(resolveOutput).toHaveBeenCalled();
    expect(createSurface).toHaveBeenCalledWith({
      output: "DP-1",
      width: 460,
      height: 236,
      anchor: "top-left",
    });
  });

  it("caps the frame rate rather than painting as fast as it can", () => {
    const { presentation } = build({ frameRate: 24 });
    const window = fakeWindow();

    presentation.attach(window, 100, 100);

    expect(window.webContents.setFrameRate).toHaveBeenCalledWith(24);
  });

  it("commits paints once a surface is up and drops them before that", async () => {
    const { presentation, surface } = build();
    const window = fakeWindow();
    presentation.attach(window, 4, 1);

    window.paint(Buffer.alloc(16));
    expect(surface.commit).not.toHaveBeenCalled();

    await presentation.show();
    window.paint(Buffer.alloc(16));

    expect(surface.commit).toHaveBeenCalledTimes(1);
  });

  it("reports unavailable rather than throwing when there is no layer shell", async () => {
    const { presentation } = build({ createSurface: vi.fn(() => null) });
    presentation.attach(fakeWindow(), 100, 100);

    expect(await presentation.show()).toBe(false);
    expect(presentation.isShowing()).toBe(false);
  });

  it("destroys the surface on hide so the overlay really leaves the screen", async () => {
    const { presentation, surface } = build();
    presentation.attach(fakeWindow(), 100, 100);
    await presentation.show();

    presentation.hide();

    expect(surface.destroy).toHaveBeenCalledTimes(1);
    expect(presentation.isShowing()).toBe(false);
  });

  // The output lookup is a compositor round trip, so a hide can land first.
  it("does not map a surface for a show that was already hidden", async () => {
    let release: (value: string) => void = () => {};
    const resolveOutput = vi.fn(() => new Promise<string>((r) => (release = r)));
    const { presentation, createSurface } = build({ resolveOutput: resolveOutput as never });
    presentation.attach(fakeWindow(), 100, 100);

    const pending = presentation.show();
    presentation.hide();
    release("DP-1");

    expect(await pending).toBe(false);
    expect(createSurface).not.toHaveBeenCalled();
  });

  // rewardOverlayIpc and relicSelection both show in one synchronous flow.
  it("allocates one surface when two callers show in the same tick", async () => {
    const { presentation, createSurface } = build();
    presentation.attach(fakeWindow(), 100, 100);

    const results = await Promise.all([presentation.show(), presentation.show()]);

    expect(results).toEqual([true, true]);
    expect(createSurface).toHaveBeenCalledTimes(1);
  });

  it("starts a fresh attempt when a hide cancelled the show in flight", async () => {
    let release: (value: string) => void = () => {};
    const resolveOutput = vi.fn(() => new Promise<string>((resolve) => (release = resolve)));
    const { presentation, createSurface } = build({ resolveOutput: resolveOutput as never });
    presentation.attach(fakeWindow(), 100, 100);

    const cancelled = presentation.show();
    presentation.hide();
    release("DP-1");
    expect(await cancelled).toBe(false);

    const retry = presentation.show();
    release("DP-1");

    expect(await retry).toBe(true);
    expect(createSurface).toHaveBeenCalledTimes(1);
  });

  it("drops a surface the compositor closed so the next show remakes it", async () => {
    const closed = fakeSurface({ commit: vi.fn(() => false), isClosed: vi.fn(() => true) });
    const createSurface = vi.fn(() => closed as never);
    const { presentation } = build({ createSurface });
    const window = fakeWindow();
    presentation.attach(window, 4, 1);
    await presentation.show();

    window.paint(Buffer.alloc(16));

    expect(closed.destroy).toHaveBeenCalledTimes(1);
    expect(presentation.isShowing()).toBe(false);
  });

  it("logs a refused frame once instead of every frame", async () => {
    const refusing = fakeSurface({ commit: vi.fn(() => false), isClosed: vi.fn(() => false) });
    const warn = vi.fn();
    const { presentation } = build({
      createSurface: vi.fn(() => refusing as never),
      log: { warn, info: vi.fn() },
    });
    const window = fakeWindow();
    presentation.attach(window, 4, 1);
    await presentation.show();

    for (let i = 0; i < 5; i++) window.paint(Buffer.alloc(16));

    expect(refusing.commit).toHaveBeenCalledTimes(5);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("renders at the output's pixel density on a HiDPI screen", async () => {
    const scaled = fakeSurface({ scale: 2, frameWidth: 200, frameHeight: 100 });
    const { presentation } = build({ createSurface: vi.fn(() => scaled as never) });
    const window = fakeWindow();
    presentation.attach(window, 100, 50);

    await presentation.show();

    expect(window.setSize).toHaveBeenCalledWith(200, 100);
    expect(window.webContents.setZoomFactor).toHaveBeenCalledWith(2);
    window.paint(Buffer.alloc(200 * 100 * 4));
    expect(scaled.commit).toHaveBeenCalledTimes(1);
  });

  it("leaves the window alone on a 1x screen", async () => {
    const { presentation } = build();
    const window = fakeWindow();
    presentation.attach(window, 4, 1);

    await presentation.show();

    expect(window.setSize).not.toHaveBeenCalled();
    expect(window.webContents.setZoomFactor).not.toHaveBeenCalled();
  });

  // A resize lands a frame or two later, so the stale-sized ones must not reach C.
  it("drops frames that do not match the surface pixel size", async () => {
    const scaled = fakeSurface({ scale: 2, frameWidth: 200, frameHeight: 100 });
    const { presentation } = build({ createSurface: vi.fn(() => scaled as never) });
    const window = fakeWindow();
    presentation.attach(window, 100, 50);
    await presentation.show();

    window.paint(Buffer.alloc(100 * 50 * 4));

    expect(scaled.commit).not.toHaveBeenCalled();
  });

  it("survives a paint whose bitmap cannot be read", async () => {
    const { presentation, surface } = build();
    const handlers: Record<string, PaintListener> = {};
    const window = {
      webContents: {
        setFrameRate: vi.fn(),
        on: vi.fn((event: "paint", listener: PaintListener) => {
          handlers[event] = listener;
        }),
      },
    };
    presentation.attach(window, 4, 1);
    await presentation.show();

    expect(() =>
      handlers.paint?.(null, null, {
        toBitmap: () => {
          throw new Error("gone");
        },
      }),
    ).not.toThrow();
    expect(surface.commit).not.toHaveBeenCalled();
  });
});
