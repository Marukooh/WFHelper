import { test, expect, type Page } from "@playwright/test";

import {
  closeElectronTestHarness,
  launchElectronTestHarness,
  writeHarnessInventory,
  type ElectronTestHarness,
} from "./electronTestHarness";

// Each test is self-contained: a failed test restarts the worker, which re-runs
// beforeAll with a fresh sandbox and empty localStorage.
test.describe("World dailies tracker", () => {
  test.setTimeout(180_000);

  let harness: ElectronTestHarness;
  let page: Page;

  test.beforeAll(async () => {
    harness = await launchElectronTestHarness("wfh-dailies-e2e-");
    page = harness.page;
  });

  test.afterAll(async () => {
    await closeElectronTestHarness(harness);
  });

  // Sidebar labels are translated, so navigate by data-view.
  async function openView(view: string): Promise<void> {
    await page.locator(`#sidebar [data-view="${view}"]`).click();
    await page.waitForTimeout(300);
  }

  async function openDailies(): Promise<void> {
    await openView("world");
    await page.locator('[data-tour-tab="dailies"]').click();
    await expect(page.locator('[data-task-meta="daily"]')).toBeVisible();
  }

  function task(id: string) {
    return page.locator(`[data-task="${id}"]`);
  }

  function taskRow(id: string) {
    return page.locator(`[data-task="${id}"]`).locator("xpath=ancestor::div[1]");
  }

  // Edit mode lives in component state, which survives a sub-tab switch, so
  // toggling blind would flip it the wrong way after an earlier test left it on.
  async function setEditing(on: boolean): Promise<void> {
    const toggle = page.locator("[data-tracker-edit]");
    if ((await toggle.getAttribute("aria-pressed")) !== String(on)) await toggle.click();
  }

  test("the World tab offers the tracker as its own sub-tab", async () => {
    await openView("world");
    await expect(page.locator('[data-tour-tab="dailies"]')).toBeVisible();
  });

  test("ticks a task and keeps it across view switches", async () => {
    await openDailies();

    await expect(task("clem")).not.toBeChecked();
    await task("clem").check();
    await expect(task("clem")).toBeChecked();

    await openView("settings");
    await openDailies();
    await expect(task("clem")).toBeChecked();
  });

  test("counts a multi-run task up to its target", async () => {
    await openDailies();
    const row = taskRow("netracells");

    await row.locator("[data-task-inc]").click();
    await expect(row).toContainText("1/5");
    await expect(task("netracells")).not.toBeChecked();

    await row.locator("[data-task-dec]").click();
    await expect(row).toContainText("0/5");

    await task("netracells").check();
    await expect(row).toContainText("5/5");
  });

  test("clears progress recorded in an earlier period", async () => {
    await openDailies();
    await task("deepArchimedea").check();
    await expect(task("deepArchimedea")).toBeChecked();

    // Rewrite the stored period key to a window that has already passed.
    await page.evaluate(() => {
      const raw = localStorage.getItem("world-dailies");
      if (!raw) throw new Error("tracker state was never persisted");
      const state = JSON.parse(raw) as {
        progress: Record<string, { key: string; count: number }>;
      };
      state.progress.deepArchimedea.key = "weekly:2020-01-06T00:00:00.000Z";
      localStorage.setItem("world-dailies", JSON.stringify(state));
    });

    await page.reload();
    await openDailies();
    await expect(task("deepArchimedea")).not.toBeChecked();
  });

  test("adds and removes a custom task", async () => {
    await openDailies();
    await setEditing(true);

    await page.locator("[data-task-name]").fill("Kuva farm");
    await page.locator("[data-task-add]").click();

    const custom = page.locator('[data-task^="custom:"]');
    await expect(custom).toHaveCount(1);
    await expect(custom.locator("xpath=ancestor::div[1]")).toContainText("Kuva farm");

    await custom.locator("xpath=ancestor::div[1]").locator("[data-task-remove]").click();
    await expect(custom).toHaveCount(0);
  });

  test("hides a built-in task from the list", async () => {
    await openDailies();
    await setEditing(true);

    await taskRow("clem").locator("[data-task-hide]").click();
    await setEditing(false);

    await expect(task("clem")).toHaveCount(0);
    await expect(task("netracells")).toHaveCount(1);
  });

  test("syncs completion from the inventory", async () => {
    const weekAhead = String(Date.now() + 7 * 86_400_000);
    writeHarnessInventory(harness, {
      Suits: [],
      DailyAffiliation: 0,
      DailyFocus: 125_000,
      EntratiVaultCountLastPeriod: 2,
      EntratiVaultCountResetDate: { $date: { $numberLong: weekAhead } },
      PeriodicMissionCompletions: [
        { date: { $date: { $numberLong: weekAhead } }, tag: "TreasureHuntD" },
      ],
    });

    await openDailies();
    // Capped standing ticks itself and turns the checkbox read-only.
    await expect(task("syndicateStanding")).toBeChecked({ timeout: 30_000 });
    await expect(task("syndicateStanding")).toBeDisabled();
    // The weekly Ayatan hunt completion arrives via PeriodicMissionCompletions.
    await expect(task("ayatanHunt")).toBeChecked();
    await expect(task("ayatanHunt")).toBeDisabled();
    // Focus is not capped: stays open and surfaces the remaining pool.
    await expect(task("dailyFocus")).not.toBeChecked();
    await expect(taskRow("dailyFocus")).toContainText(/125[.,\s]000/);

    // Synced netracell runs are a floor the manual counter cannot go below.
    if (await task("netracells").isChecked()) await task("netracells").uncheck();
    const row = taskRow("netracells");
    await expect(row).toContainText("2/5");
    await expect(row.locator("[data-task-dec]")).toBeDisabled();
  });
});
