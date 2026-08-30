import { test, expect } from "@playwright/test";

import { baseZoomForDisplay } from "../config/runtime/uiScale";
import {
  closeElectronTestHarness,
  evaluateInMain,
  launchElectronTestHarness,
  overlayWindow,
  type ElectronTestHarness,
} from "./electronTestHarness";

// Only the real window catches this: resizable:false pins the minimum size to the
// constructed size, and Windows then trims the frame insets on every setBounds.
async function rivenBounds(harness: ElectronTestHarness): Promise<{ size: string; pos: string }[]> {
  return evaluateInMain(harness.app, ({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .filter((win) => win.webContents.getURL().includes("riven-overlay"))
      .sort((a, b) => a.getBounds().x - b.getBounds().x)
      .map((win) => {
        const bounds = win.getBounds();
        return { size: `${bounds.width}x${bounds.height}`, pos: `${bounds.x},${bounds.y}` };
      }),
  );
}

test("dragging the riven overlay never changes its size", async () => {
  test.setTimeout(180_000);
  let harness: ElectronTestHarness | undefined;
  try {
    harness = await launchElectronTestHarness("wfh-drag-size-");
    await evaluateInMain(harness.app, ({ app }) => {
      const main = process.mainModule as unknown as {
        require: (id: string) => Record<string, () => void>;
      };
      main.require(`${app.getAppPath()}/.electron-build/ipc/rivenOverlayIpc`).onRivenSessionOpen();
    });
    const overlay = await overlayWindow(harness, "riven-overlay");
    await overlay.waitForTimeout(1_000);

    // Main drops drag deltas unless the overlay is interactive, so without this
    // the window never moves and the assertion below passes for the wrong reason.
    await evaluateInMain(harness.app, ({ app }) => {
      const main = process.mainModule as unknown as {
        require: (id: string) => { setRivenInteractiveMode: (next: boolean) => void };
      };
      main
        .require(`${app.getAppPath()}/.electron-build/ipc/rivenOverlayIpc`)
        .setRivenInteractiveMode(true);
    });

    const before = await rivenBounds(harness);
    expect(before.length).toBeGreaterThan(0);

    for (let tick = 0; tick < 40; tick += 1) {
      await overlay.evaluate(() =>
        (
          window as unknown as { rivenOverlay: { moveBy: (dx: number, dy: number) => void } }
        ).rivenOverlay.moveBy(2, 1),
      );
    }
    await overlay.waitForTimeout(500);

    const after = await rivenBounds(harness);

    expect(after.map((entry) => entry.size)).toEqual(before.map((entry) => entry.size));
    // Proves the drag actually landed, so the size check above means something.
    expect(after.map((entry) => entry.pos)).not.toEqual(before.map((entry) => entry.pos));
  } finally {
    await closeElectronTestHarness(harness);
  }
});

async function leftRivenSize(
  harness: ElectronTestHarness,
): Promise<{ w: number; h: number; zoom: number; workArea: { width: number; height: number } }> {
  return evaluateInMain(harness.app, ({ BrowserWindow, screen }) => {
    const win = BrowserWindow.getAllWindows().find((candidate) =>
      candidate.webContents.getURL().includes("side=left"),
    );
    const bounds = win ? win.getBounds() : { width: 0, height: 0, x: 0, y: 0 };
    const workArea = screen.getDisplayMatching(bounds).workArea;
    return {
      w: bounds.width,
      h: bounds.height,
      zoom: win ? win.webContents.getZoomFactor() : 0,
      workArea: { width: workArea.width, height: workArea.height },
    };
  });
}

test("a resized riven overlay reopens at the size it was left at", async () => {
  test.setTimeout(180_000);
  let harness: ElectronTestHarness | undefined;
  try {
    harness = await launchElectronTestHarness("wfh-resize-scale-");
    await evaluateInMain(harness.app, ({ app }) => {
      const main = process.mainModule as unknown as {
        require: (id: string) => Record<string, () => void>;
      };
      main.require(`${app.getAppPath()}/.electron-build/ipc/rivenOverlayIpc`).onRivenSessionOpen();
    });
    const overlay = await overlayWindow(harness, "riven-overlay");
    await overlay.waitForTimeout(1_000);

    await evaluateInMain(harness.app, ({ app }) => {
      const main = process.mainModule as unknown as {
        require: (id: string) => { setRivenInteractiveMode: (next: boolean) => void };
      };
      main
        .require(`${app.getAppPath()}/.electron-build/ipc/rivenOverlayIpc`)
        .setRivenInteractiveMode(true);
    });

    // The base zoom lands after the renderer signals ready. On a hosted runner
    // with a small display (base 0.8) an early read still sees Chromium's
    // pristine 1.0 and inflates the before ratio to 1.25, failing the compare.
    const zoomHarness = harness;
    await expect
      .poll(
        async () => {
          const now = await leftRivenSize(zoomHarness);
          return now.zoom > 0 && Math.abs(now.zoom - baseZoomForDisplay(now.workArea)) < 0.011;
        },
        { timeout: 15_000 },
      )
      .toBe(true);
    const before = await leftRivenSize(harness);
    expect(before.w).toBeGreaterThan(0);

    // What a drag on the window edge does, minus the mouse.
    const target = { w: Math.round(before.w * 1.2), h: Math.round(before.h * 1.2) };
    await evaluateInMain(
      harness.app,
      ({ BrowserWindow }, size) => {
        const win = BrowserWindow.getAllWindows().find((candidate) =>
          candidate.webContents.getURL().includes("side=left"),
        );
        const bounds = win?.getBounds();
        if (win && bounds) win.setBounds({ ...bounds, width: size.w, height: size.h });
      },
      target,
    );
    // The save is debounced and the main process is mid-resize, so poll for it
    // rather than reading once behind a fixed wait.
    const scaleHarness = harness;
    await expect
      .poll(
        async () =>
          evaluateInMain(scaleHarness.app, ({ app }) => {
            const main = process.mainModule as unknown as {
              require: (id: string) => { default: { overlaySettings: Record<string, unknown> } };
            };
            const settings = main.require(`${app.getAppPath()}/.electron-build/ipc/context`).default
              .overlaySettings;
            return (settings.overlayWindowScales as Record<string, number>)?.rivenLeft ?? 0;
          }),
        { timeout: 15_000 },
      )
      .toBeGreaterThan(1);

    // Reopening recomputes the bounds from the saved settings, which is the one
    // path that can throw the resized size away.
    await evaluateInMain(harness.app, ({ app }) => {
      const main = process.mainModule as unknown as {
        require: (id: string) => Record<string, () => void>;
      };
      const riven = main.require(`${app.getAppPath()}/.electron-build/ipc/rivenOverlayIpc`);
      riven.onRivenSessionClose();
      riven.onRivenSessionOpen();
    });
    const reopenedHarness = harness;
    await expect
      .poll(async () => (await leftRivenSize(reopenedHarness)).w, { timeout: 15_000 })
      .toBeGreaterThan(0);

    const after = await leftRivenSize(harness);
    expect(Math.abs(after.w - target.w)).toBeLessThanOrEqual(3);

    // The frame alone proves nothing: the content has to have grown with it.
    // Zoom is the saved scale times a display-derived base, and a hosted runner
    // steps that base between the two reads, so compare the scale, not the zoom.
    expect(after.zoom / baseZoomForDisplay(after.workArea)).toBeGreaterThan(
      before.zoom / baseZoomForDisplay(before.workArea),
    );
  } finally {
    await closeElectronTestHarness(harness);
  }
});
