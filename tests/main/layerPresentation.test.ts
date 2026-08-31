import { beforeEach, describe, expect, it, vi } from "vitest";

import { createLayerPresentation } from "../../ipc/overlay/layerPresentation";

const deps = vi.hoisted(() => ({
  compositorOutput: null as string | null,
  gameBounds: null as { x: number; y: number; width: number; height: number } | null,
  rects: [] as Array<Record<string, unknown>>,
}));

vi.mock("../../services/waylandCompositor", () => ({
  resolveGameOutput: vi.fn(async () => deps.compositorOutput),
}));

vi.mock("../../services/warframeStatus", () => ({
  getWarframeWindowBoundsLinux: vi.fn(async () => deps.gameBounds),
}));

vi.mock("../../services/layerShell", () => ({
  createLayerSurface: vi.fn(() => null),
  layerOutputRects: vi.fn(() => deps.rects),
}));

beforeEach(() => {
  deps.compositorOutput = null;
  deps.gameBounds = null;
  deps.rects = [];
});

/** Frame size defaults match the 4x1 surface the painting tests attach. */
function fakeSurface(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    commit: vi.fn(() => true),
    isClosed: vi.fn(() => false),
    destroy: vi.fn(),
    scale: 1,
    frameWidth: 4,
    frameHeight: 1,
    setInteractive: vi.fn(),
    setMargin: vi.fn(() => true),
    resize: vi.fn(() => true),
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
      sendInputEvent: vi.fn(),
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

  it("keeps the window at its attached size on a 1x screen", async () => {
    const { presentation } = build();
    const window = fakeWindow();
    presentation.attach(window, 4, 1);

    await presentation.show();

    expect(window.setSize).toHaveBeenCalledWith(4, 1);
    expect(window.webContents.setZoomFactor).toHaveBeenCalledWith(1);
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

  describe("placement", () => {
    /** A 1920x1080 output at the origin, which is what the geometries below sit in. */
    function singleOutput() {
      deps.rects = [
        { name: "DP-1", x: 0, y: 0, width: 1920, height: 1080, scale: 1, placed: true },
      ];
    }

    it("puts the surface at the saved spot inside its output", async () => {
      singleOutput();
      const { presentation, createSurface } = build({
        anchor: "center",
        resolveGeometry: () => ({ x: 470, y: 604, width: 980, height: 140, zoomFactor: 1 }),
      });
      presentation.attach(fakeWindow(), 980, 140);

      await presentation.show();

      expect(createSurface).toHaveBeenCalledWith({
        output: "DP-1",
        width: 980,
        height: 140,
        // Margins only apply to anchored edges, so a placed surface leaves the
        // centred anchor behind.
        anchor: "top-left",
        marginTop: 604,
        marginLeft: 470,
      });
    });

    it("keeps a spot saved on a larger monitor inside the output", async () => {
      deps.rects = [{ name: "DP-1", x: 0, y: 0, width: 1280, height: 720, scale: 1, placed: true }];
      const { presentation, createSurface } = build({
        resolveGeometry: () => ({ x: 2400, y: 900, width: 980, height: 140, zoomFactor: 1 }),
      });
      presentation.attach(fakeWindow(), 980, 140);

      await presentation.show();

      expect(createSurface).toHaveBeenCalledWith(
        expect.objectContaining({ marginLeft: 300, marginTop: 580 }),
      );
    });

    it("holds a corner overlay off the edges it is anchored to", async () => {
      singleOutput();
      const { presentation, createSurface } = build({ anchor: "top-right", inset: 16 });
      presentation.attach(fakeWindow(), 460, 236);

      await presentation.show();

      expect(createSurface).toHaveBeenCalledWith(
        expect.objectContaining({ anchor: "top-right", marginTop: 16, marginRight: 16 }),
      );
    });

    it("zooms by the overlay scale as well as the output density", async () => {
      singleOutput();
      const scaled = fakeSurface({ scale: 2, frameWidth: 1960, frameHeight: 280 });
      const { presentation } = build({
        createSurface: vi.fn(() => scaled as never),
        resolveGeometry: () => ({ x: 0, y: 0, width: 980, height: 140, zoomFactor: 1.15 }),
      });
      const window = fakeWindow();
      presentation.attach(window, 980, 140);

      await presentation.show();

      expect(window.setSize).toHaveBeenCalledWith(1960, 280);
      // Without the overlay scale in the zoom the layout renders at 1x inside a
      // viewport the scale already made larger.
      expect(window.webContents.setZoomFactor).toHaveBeenCalledWith(2.3);
    });
  });

  describe("applyGeometry", () => {
    function withGeometry(geometry: { x: number; y: number; width: number; height: number }) {
      deps.rects = [
        { name: "DP-1", x: 0, y: 0, width: 1920, height: 1080, scale: 1, placed: true },
      ];
      let current = { ...geometry, zoomFactor: 1 };
      const built = build({ resolveGeometry: () => current });
      return {
        ...built,
        move(next: Partial<typeof current>) {
          current = { ...current, ...next };
        },
      };
    }

    it("moves a live surface to the spot a drag wrote", async () => {
      const probe = withGeometry({ x: 100, y: 200, width: 980, height: 140 });
      probe.presentation.attach(fakeWindow(), 980, 140);
      await probe.presentation.show();

      probe.move({ x: 140, y: 260 });
      probe.presentation.applyGeometry();

      expect(probe.surface.setMargin).toHaveBeenCalledWith(260, 0, 0, 140);
    });

    it("resizes a live surface when the scale setting changes", async () => {
      const probe = withGeometry({ x: 100, y: 200, width: 980, height: 140 });
      const window = fakeWindow();
      probe.presentation.attach(window, 980, 140);
      await probe.presentation.show();
      window.setSize.mockClear();

      probe.move({ width: 1127, height: 161 });
      probe.presentation.applyGeometry();

      expect(probe.surface.resize).toHaveBeenCalledWith(1127, 161);
      expect(window.setSize).toHaveBeenCalledWith(1127, 161);
    });

    it("leaves the surface size alone for a move", async () => {
      const probe = withGeometry({ x: 100, y: 200, width: 980, height: 140 });
      probe.presentation.attach(fakeWindow(), 980, 140);
      await probe.presentation.show();

      probe.move({ x: 140 });
      probe.presentation.applyGeometry();

      expect(probe.surface.resize).not.toHaveBeenCalled();
    });

    it("drops a surface that cannot take the new size", async () => {
      const probe = withGeometry({ x: 0, y: 0, width: 980, height: 140 });
      probe.surface.resize.mockReturnValue(false);
      probe.presentation.attach(fakeWindow(), 980, 140);
      await probe.presentation.show();

      probe.move({ width: 1127 });
      probe.presentation.applyGeometry();

      expect(probe.surface.destroy).toHaveBeenCalled();
      expect(probe.presentation.isShowing()).toBe(false);
    });

    it("does nothing while the overlay is hidden", async () => {
      const probe = withGeometry({ x: 0, y: 0, width: 980, height: 140 });
      probe.presentation.attach(fakeWindow(), 980, 140);
      await probe.presentation.show();
      probe.presentation.hide();

      probe.move({ x: 40 });
      probe.presentation.applyGeometry();

      expect(probe.surface.setMargin).not.toHaveBeenCalled();
    });
  });

  describe("interactive mode", () => {
    /** Captures the sink the presentation hands to setInteractive. */
    function interactiveBuild(scale = 1) {
      let sink: ((event: unknown) => void) | undefined;
      const surface = fakeSurface({
        scale,
        frameWidth: 4 * scale,
        frameHeight: scale,
        setInteractive: vi.fn((_on: boolean, onEvent?: (event: unknown) => void) => {
          sink = onEvent;
          return true;
        }),
      });
      const { presentation } = build({ createSurface: vi.fn(() => surface as never) });
      const window = fakeWindow();
      presentation.attach(window, 4, 1);
      return { presentation, surface, window, emit: (e: unknown) => sink?.(e) };
    }

    function event(overrides: Record<string, unknown>) {
      return {
        kind: "motion",
        x: 0,
        y: 0,
        button: 0,
        pressed: false,
        deltaX: 0,
        deltaY: 0,
        ...overrides,
      };
    }

    it("asks the surface for input only once interactive mode is on", async () => {
      const { presentation, surface } = interactiveBuild();
      await presentation.show();
      expect(surface.setInteractive).not.toHaveBeenCalled();

      presentation.setInteractive(true);

      expect(surface.setInteractive).toHaveBeenCalledWith(true, expect.any(Function));
    });

    // The surface is remade on every show and starts click-through.
    it("re-applies interactive mode to a surface made by a later show", async () => {
      const { presentation, surface } = interactiveBuild();
      presentation.setInteractive(true);
      await presentation.show();

      expect(surface.setInteractive).toHaveBeenCalledWith(true, expect.any(Function));
    });

    it("turns a click into a down and an up on the offscreen window", async () => {
      const { presentation, window, emit } = interactiveBuild();
      await presentation.show();
      presentation.setInteractive(true);

      emit(event({ kind: "button", x: 3, y: 1, button: 0, pressed: true }));
      emit(event({ kind: "button", x: 3, y: 1, button: 0, pressed: false }));

      expect(window.webContents.sendInputEvent).toHaveBeenNthCalledWith(1, {
        type: "mouseDown",
        x: 3,
        y: 1,
        globalX: 3,
        globalY: 1,
        // The button being pressed counts as held, the way the DOM reports it.
        modifiers: ["leftbuttondown"],
        button: "left",
        clickCount: 1,
      });
      expect(window.webContents.sendInputEvent).toHaveBeenNthCalledWith(2, {
        type: "mouseUp",
        x: 3,
        y: 1,
        globalX: 3,
        globalY: 1,
        modifiers: [],
        button: "left",
        clickCount: 1,
      });
    });

    it("maps the remaining pointer events onto their input events", async () => {
      const { presentation, window, emit } = interactiveBuild();
      await presentation.show();
      presentation.setInteractive(true);

      emit(event({ kind: "enter", x: 1, y: 1 }));
      emit(event({ kind: "motion", x: 2, y: 1 }));
      emit(event({ kind: "leave", x: 2, y: 1 }));
      emit(event({ kind: "button", x: 2, y: 1, button: 2, pressed: true }));

      const types = window.webContents.sendInputEvent.mock.calls.map(([e]) => e.type);
      expect(types).toEqual(["mouseEnter", "mouseMove", "mouseLeave", "mouseDown"]);
      expect(window.webContents.sendInputEvent.mock.calls[3][0].button).toBe("right");
    });

    // Surface coordinates are logical; the window is sized in buffer pixels.
    it("scales pointer coordinates to the window on a HiDPI output", async () => {
      const { presentation, window, emit } = interactiveBuild(2);
      await presentation.show();
      presentation.setInteractive(true);

      emit(event({ kind: "motion", x: 10, y: 20 }));

      expect(window.webContents.sendInputEvent).toHaveBeenCalledWith({
        type: "mouseMove",
        x: 20,
        y: 40,
        // Screen coordinates stay logical; only widget coordinates take the scale.
        globalX: 10,
        globalY: 20,
        modifiers: [],
      });
    });

    // Both halves of this are what overlay-drag.js reads: it stops on the first
    // motion with no buttons, and it measures its deltas in screen coordinates.
    it("keeps a held button set while dragging", async () => {
      const { presentation, window, emit } = interactiveBuild();
      await presentation.show();
      presentation.setInteractive(true);

      emit(event({ kind: "button", x: 2, y: 1, button: 0, pressed: true }));
      emit(event({ kind: "motion", x: 3, y: 1 }));

      expect(window.webContents.sendInputEvent).toHaveBeenLastCalledWith(
        expect.objectContaining({ type: "mouseMove", modifiers: ["leftbuttondown"] }),
      );
    });

    it("reports the pointer in screen coordinates as the surface moves", async () => {
      deps.rects = [
        { name: "DP-1", x: 1920, y: 0, width: 1920, height: 1080, scale: 1, placed: true },
      ];
      let spot = { x: 100, y: 200, width: 4, height: 1, zoomFactor: 1 };
      let sink: ((event: unknown) => void) | undefined;
      const surface = fakeSurface({
        setInteractive: vi.fn((_on: boolean, onEvent?: (event: unknown) => void) => {
          sink = onEvent;
          return true;
        }),
      });
      const { presentation } = build({
        createSurface: vi.fn(() => surface as never),
        resolveGeometry: () => spot,
      });
      const window = fakeWindow();
      presentation.attach(window, 4, 1);
      await presentation.show();
      presentation.setInteractive(true);

      // Output origin 1920 plus the 100 margin plus 3 into the surface.
      sink?.(event({ kind: "motion", x: 3, y: 1 }));
      expect(window.webContents.sendInputEvent).toHaveBeenLastCalledWith(
        expect.objectContaining({ globalX: 2023, globalY: 201 }),
      );

      // A drag moved the surface 40 right; the same spot under the pointer is
      // now 40 further along the screen.
      spot = { ...spot, x: 140 };
      presentation.applyGeometry();
      sink?.(event({ kind: "motion", x: 3, y: 1 }));

      expect(window.webContents.sendInputEvent).toHaveBeenLastCalledWith(
        expect.objectContaining({ globalX: 2063 }),
      );
    });

    it("survives a webContents that is already gone", async () => {
      const { presentation, window, emit } = interactiveBuild();
      await presentation.show();
      presentation.setInteractive(true);
      window.webContents.sendInputEvent.mockImplementation(() => {
        throw new Error("destroyed");
      });

      expect(() => emit(event({ kind: "motion", x: 1, y: 1 }))).not.toThrow();
    });
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

// Asking for no output lets the compositor pick the monitor, so the overlay
// can land on the wrong screen unless the game's output is named.
describe("choosing the monitor the game is on", () => {
  /** An ultrawide left of a 1080p. */
  function twoMonitors() {
    deps.rects = [
      { name: "DP-3", x: 0, y: 0, width: 3440, height: 1440, scale: 1, placed: true },
      { name: "DP-2", x: 3440, y: 0, width: 1920, height: 1080, scale: 1, placed: true },
    ];
  }

  function build() {
    const createSurface = vi.fn((_options: { output: string | null }) => null);
    const presentation = createLayerPresentation({
      label: "test",
      anchor: "center",
      createSurface: createSurface as never,
    });
    presentation.attach({ webContents: { setFrameRate: vi.fn(), on: vi.fn() } }, 100, 100);
    return { presentation, createSurface };
  }

  async function chosenOutput() {
    const { presentation, createSurface } = build();
    await presentation.show();
    return createSurface.mock.calls[0]?.[0]?.output ?? null;
  }

  it("puts the overlay on the monitor holding the game window", async () => {
    twoMonitors();
    deps.gameBounds = { x: 3440, y: 0, width: 1920, height: 1080 };

    expect(await chosenOutput()).toBe("DP-2");
  });

  it("reads the reported ultrawide layout as the left monitor", async () => {
    twoMonitors();
    deps.gameBounds = { x: 0, y: 0, width: 3440, height: 1440 };

    expect(await chosenOutput()).toBe("DP-3");
  });

  it("takes the compositor's answer over the geometry match", async () => {
    twoMonitors();
    deps.compositorOutput = "DP-2";
    deps.gameBounds = { x: 0, y: 0, width: 3440, height: 1440 };

    expect(await chosenOutput()).toBe("DP-2");
  });

  it("leaves the choice to the compositor when the game cannot be located", async () => {
    twoMonitors();

    expect(await chosenOutput()).toBeNull();
  });

  it("leaves the choice to the compositor on a single monitor", async () => {
    deps.rects = [{ name: "DP-3", x: 0, y: 0, width: 3440, height: 1440, scale: 1, placed: true }];
    deps.gameBounds = { x: 0, y: 0, width: 3440, height: 1440 };

    expect(await chosenOutput()).toBeNull();
  });

  // No xdg-output means no trustworthy position, so a guess would be a coin flip.
  it("ignores outputs the compositor never placed", async () => {
    deps.rects = [
      { name: "DP-3", x: 0, y: 0, width: 3440, height: 1440, scale: 1, placed: false },
      { name: "DP-2", x: 0, y: 0, width: 1920, height: 1080, scale: 1, placed: false },
    ];
    deps.gameBounds = { x: 0, y: 0, width: 3440, height: 1440 };

    expect(await chosenOutput()).toBeNull();
  });
});
