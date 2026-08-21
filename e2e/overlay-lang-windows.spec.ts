import { test, expect } from "@playwright/test";

import type { ArbiRunRecord } from "../config/shared/arbiTypes";

import {
  closeElectronTestHarness,
  evaluateInMain,
  launchElectronTestHarness,
  overlayWindow,
  setDisplayLanguage,
  type ElectronTestHarness,
} from "./electronTestHarness";

// overlay-lang.spec covers the reward overlay. These are the other three windows,
// and they are driven through main directly because no game is running.
test.describe("Riven, arbitration and trade windows follow the language", () => {
  test.setTimeout(240_000);

  let harness: ElectronTestHarness;

  test.beforeAll(async () => {
    harness = await launchElectronTestHarness("wfh-overlay-windows-e2e-", {
      storage: { "app-language": "de" },
    });
  });

  test.afterAll(async () => {
    await closeElectronTestHarness(harness);
  });

  async function callMain(moduleName: string, fn: string, ...args: unknown[]): Promise<void> {
    await evaluateInMain(
      harness.app,
      async ({ app }, { moduleName: name, fn: method, args: payload }) => {
        const moduleApi = process.getBuiltinModule("module") as {
          createRequire: (filename: string) => (id: string) => Record<string, unknown>;
        };
        const load = moduleApi.createRequire(`${app.getAppPath()}/.electron-build/main.js`);
        const loaded = load(`./ipc/${name}.js`);
        const target = loaded[method];
        if (typeof target !== "function") throw new Error(`missing main export ${name}.${method}`);
        target(...payload);
      },
      { moduleName, fn, args },
    );
  }

  async function switchTo(code: "de" | "en"): Promise<void> {
    await setDisplayLanguage(harness.page, code);
  }

  test("the riven overlay opens in German and follows a live switch", async () => {
    await callMain("rivenOverlayIpc", "onRivenSessionOpen");
    const left = await overlayWindow(harness, "side=left");
    const right = await overlayWindow(harness, "side=right");

    await expect(left.locator("#panel-label")).toHaveText("Aktuell", { timeout: 30_000 });
    await expect(right.locator("#panel-label")).toHaveText("Neuer Wurf");
    await expect(left.locator("#stats-container")).toHaveClass(/is-hidden/);
    await expect(left.locator("#scanning-text")).toHaveText("Scanne aktuelle Werte...");
    await expect(right.locator("#stats-list")).toHaveText("Warte auf Wurf...");
    await expect(left.locator("#btn-rescan")).toHaveAttribute(
      "title",
      "Karte und verknüpfte Waffe neu scannen",
    );
    expect(await left.title()).toBe("Riven-Overlay");

    await switchTo("en");

    await expect(left.locator("#panel-label")).toHaveText("Current", { timeout: 30_000 });
    await expect(right.locator("#panel-label")).toHaveText("New roll");
    await expect(left.locator("#btn-rescan")).toHaveAttribute(
      "title",
      "Rescan card and linked weapon",
    );
    expect(await left.title()).toBe("Riven overlay");

    await switchTo("de");
  });

  test("the arbitration summary opens in German and follows a live switch", async () => {
    await callMain("arbiOverlayIpc", "maybeShowArbiSummary", {
      id: "2026-08-20_12-00-00",
      startedAt: 1_760_000_000_000,
      endedAt: 1_760_000_180_000,
      missionName: "Arbitration: Casta Defense (Ceres)",
      node: "Casta (Ceres)",
      missionType: "defense",
      missionTypeRaw: "MT_DEFENSE",
      solNode: "SolNode167",
      durationSec: 1800,
      rotations: 6,
      drones: 12,
      totalEnemies: 12_345,
      vitusActual: null,
      logFile: null,
      logSizeBytes: 0,
      endReason: "mission-end",
      source: "live",
      stats: {
        killsPerDrone: 75,
        avgDroneIntervalSec: 150,
        expectedVitusMean: 14.2,
        expectedVitusStd: 3.1,
        vitusPerMin: 0.47,
        wavesPerRotation: 5,
        droneTimestamps: [],
        rewardTimestamps: [],
        preciseStartSec: 0,
        lastActivitySec: 1800,
        saturationBuckets: [{ minCount: 15, label: "15+", seconds: 765, pct: 42.5 }],
        waves: null,
      },
    } satisfies ArbiRunRecord);

    const arbi = await overlayWindow(harness, "arbi-overlay.html");

    await expect(arbi.locator('[data-i18n="overlay.arbi.complete"]')).toHaveText(
      "Arbitration abgeschlossen",
      { timeout: 30_000 },
    );
    await expect(arbi.locator('[data-i18n="overlay.arbi.expectedVitus"]')).toHaveText(
      "Vitus erwartet",
    );
    await expect(arbi.locator('[data-i18n="overlay.arbi.saturation"]')).toHaveText(
      "Zeit bei 15+ Gegnern",
    );
    await expect(arbi.locator("#kpi-vitus")).toHaveText("14,2 ±3,1");
    await expect(arbi.locator("#kpi-kills")).toHaveText("12.345");

    await switchTo("en");

    await expect(arbi.locator('[data-i18n="overlay.arbi.complete"]')).toHaveText(
      "Arbitration Complete",
      { timeout: 30_000 },
    );
    await expect(arbi.locator('[data-i18n="overlay.arbi.saturation"]')).toHaveText(
      "Time at 15+ Enemies",
    );
    await expect(arbi.locator("#kpi-vitus")).toHaveText("14.2 ±3.1");
    await expect(arbi.locator("#kpi-kills")).toHaveText("12,345");

    await switchTo("de");
  });

  test("the trade toast opens in German and follows a live switch", async () => {
    await callMain(
      "tradeNotificationIpc",
      "showTradeNotification",
      {
        kind: "order",
        orderId: "test-order",
        itemName: "Braton Prime Receiver",
        itemUrlName: "braton_prime_receiver",
        itemThumb: null,
        quantity: 1,
        platinum: 42,
        partner: "Tenno",
        type: "sale",
      },
      "closed",
    );

    const toast = await overlayWindow(harness, "trade-notification.html");

    await expect(toast.locator("#trade-label")).toHaveText("Angebot geschlossen", {
      timeout: 30_000,
    });
    await expect(toast.locator("#trade-badge")).toHaveText("Verkauf");
    expect(await toast.title()).toBe("Handelsbenachrichtigung");

    await switchTo("en");
    await expect(toast.locator("#trade-label")).toHaveText("Listing Closed", { timeout: 30_000 });
    await expect(toast.locator("#trade-badge")).toHaveText("Sale");
    expect(await toast.title()).toBe("Trade Notification");
  });
});
