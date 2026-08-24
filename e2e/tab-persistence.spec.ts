import { test, expect, type Page } from "@playwright/test";

import {
  closeElectronTestHarness,
  launchElectronTestHarness,
  writeHarnessInventory,
  type ElectronTestHarness,
} from "./electronTestHarness";

const ACCELTRA = "/Lotus/Weapons/Tenno/LongGuns/PrimeAcceltra/PrimeAcceltraWeapon";

// Each test is self-contained: a failed test restarts the worker, which re-runs
// beforeAll with a fresh sandbox and empty localStorage.
test.describe("Horizontal tab persistence", () => {
  test.setTimeout(180_000);

  let harness: ElectronTestHarness;
  let page: Page;

  test.beforeAll(async () => {
    harness = await launchElectronTestHarness("wfh-tab-persist-e2e-");
    page = harness.page;
    writeHarnessInventory(harness, {
      Suits: [],
      LongGuns: [{ ItemType: ACCELTRA, XP: 450_000 }],
      XPInfo: [{ ItemType: ACCELTRA, XP: 450_000 }],
    });
  });

  test.afterAll(async () => {
    await closeElectronTestHarness(harness);
  });

  // Sidebar labels and tab labels are translated, so both are located by their
  // stable keys instead: data-view for views, data-tour-tab for tab rows.
  async function openView(view: string): Promise<void> {
    await page.locator(`#sidebar [data-view="${view}"]`).click();
    await page.waitForTimeout(300);
  }

  function tab(key: string) {
    return page.locator("#content .view.active").locator(`[data-tour-tab="${key}"]`);
  }

  test("Inventory keeps its filter tab across view switches", async () => {
    await openView("inventory");
    await tab("full_sets").click();
    await expect(tab("full_sets")).toHaveAttribute("data-active", "true");

    await openView("settings");
    await openView("inventory");
    await expect(tab("full_sets")).toHaveAttribute("data-active", "true");
  });

  test("Foundry keeps its category tab across view switches", async () => {
    await openView("foundry");
    await tab("cat:Primary").click();
    await expect(tab("cat:Primary")).toHaveAttribute("data-active", "true");

    await openView("inventory");
    await openView("foundry");
    await expect(tab("cat:Primary")).toHaveAttribute("data-active", "true");
  });

  test("Mastery keeps its category and status tabs across view switches", async () => {
    await openView("mastery");
    await expect(tab("Primary")).toBeVisible({ timeout: 30_000 });
    await tab("Primary").click();
    await tab("mastered").click();

    await openView("settings");
    await openView("mastery");
    await expect(tab("Primary")).toHaveAttribute("data-active", "true");
    await expect(tab("mastered")).toHaveAttribute("data-active", "true");
  });

  test("Mastery keeps its Roadmap sub-tab across view switches", async () => {
    await openView("mastery");
    await tab("roadmap").click();
    await tab("relics").click();
    await expect(tab("roadmap")).toHaveAttribute("data-active", "true");
    await expect(tab("relics")).toHaveAttribute("data-active", "true");

    await openView("settings");
    await openView("mastery");
    await expect(tab("roadmap")).toHaveAttribute("data-active", "true");
    await expect(tab("relics")).toHaveAttribute("data-active", "true");
  });

  test("Rivens keeps its view tab across view switches", async () => {
    await openView("rivens");
    await tab("veiled").click();
    await expect(tab("veiled")).toHaveAttribute("data-active", "true");

    await openView("settings");
    await openView("rivens");
    await expect(tab("veiled")).toHaveAttribute("data-active", "true");
  });

  test("World keeps its view tab across view switches", async () => {
    await openView("world");
    await tab("arbis").click();
    await expect(tab("arbis")).toHaveAttribute("data-active", "true");

    await openView("inventory");
    await openView("world");
    await expect(tab("arbis")).toHaveAttribute("data-active", "true");
  });

  test("Relics keeps its tier tab across view switches", async () => {
    await openView("relics");
    await tab("Axi").click();
    await expect(tab("Axi")).toHaveAttribute("data-active", "true");

    await openView("inventory");
    await openView("relics");
    await expect(tab("Axi")).toHaveAttribute("data-active", "true");
  });

  test("Market keeps its order tab across view switches", async () => {
    await openView("market");
    await tab("browse").click();
    await expect(tab("browse")).toHaveAttribute("data-active", "true");

    await openView("inventory");
    await openView("market");
    await expect(tab("browse")).toHaveAttribute("data-active", "true");
  });

  test("Settings intentionally returns to General", async () => {
    await openView("settings");
    await tab("appearance").click();
    await expect(tab("appearance")).toHaveClass(/active/);

    await openView("inventory");
    await openView("settings");
    await expect(tab("general")).toHaveClass(/active/);
  });

  test("Every non-Settings tab survives a renderer reload", async () => {
    await openView("inventory");
    await tab("full_sets").click();
    await openView("foundry");
    await tab("cat:Primary").click();
    await openView("mastery");
    await tab("roadmap").click();
    await tab("relics").click();
    await openView("world");
    await tab("arbis").click();
    await openView("relics");
    await tab("Axi").click();
    await openView("market");
    await tab("browse").click();
    await openView("rivens");
    await tab("veiled").click();

    await page.reload();
    await expect(page.locator("#sidebar")).toBeVisible({ timeout: 90_000 });

    await openView("inventory");
    await expect(tab("full_sets")).toHaveAttribute("data-active", "true");
    await openView("foundry");
    await expect(tab("cat:Primary")).toHaveAttribute("data-active", "true");
    await openView("mastery");
    await expect(tab("roadmap")).toHaveAttribute("data-active", "true");
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem("wf_mastery_roadmap_tab")))
      .toBe("relics");
    await openView("world");
    await expect(tab("arbis")).toHaveAttribute("data-active", "true");
    await openView("relics");
    await expect(tab("Axi")).toHaveAttribute("data-active", "true");
    await openView("market");
    await expect(tab("browse")).toHaveAttribute("data-active", "true");
    await openView("rivens");
    await expect(tab("veiled")).toHaveAttribute("data-active", "true");
    await openView("settings");
    await expect(tab("general")).toHaveClass(/active/);
  });
});
