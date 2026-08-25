import { test, expect, type Page } from "@playwright/test";

import {
  closeElectronTestHarness,
  launchElectronTestHarness,
  type ElectronTestHarness,
} from "./electronTestHarness";

test.describe("Mastery subsumed filter", () => {
  test.setTimeout(180_000);

  let harness: ElectronTestHarness;
  let page: Page;

  test.beforeAll(async () => {
    harness = await launchElectronTestHarness("wfh-mastery-subsumed-e2e-", {
      inventory: {
        Suits: [{ ItemType: "/Lotus/Powersuits/Rhino/Rhino", ItemId: { $oid: "a1" }, XP: 1000000 }],
        InfestedFoundry: { ConsumedSuits: [{ s: "/Lotus/Powersuits/Ninja/Ninja" }] },
      },
    });
    page = harness.page;
    await page.locator('#sidebar [data-view="mastery"]').click();
  });

  test.afterAll(async () => {
    await closeElectronTestHarness(harness);
  });

  test("tri-state drops everything that can never be subsumed", async () => {
    const select = page.locator("#content .view.active select[data-subsumed]");
    await expect(select).toBeVisible({ timeout: 60_000 });
    const names = page.locator("#content .view.active .item-grid .item-name");
    const allCount = await names.count();
    expect(allCount).toBeGreaterThan(100);

    await select.selectOption("yes");
    await expect(names).toHaveText(["Ash"]);

    // Only base warframes survive "no": primes and non-frames have no flag.
    await select.selectOption("no");
    const noCount = await names.count();
    expect(noCount).toBeGreaterThan(30);
    expect(noCount).toBeLessThan(allCount / 2);
    await expect(names.filter({ hasText: /Prime/ })).toHaveCount(0);
    await expect(names.filter({ hasText: "Ash" })).toHaveCount(0);
  });

  test("summary strip stays compact at full width", async () => {
    await page.locator("#content .view.active select[data-subsumed]").selectOption("all");
    const row = page.locator("#content .view.active [data-mastery-summary]");
    await expect(row).toBeVisible();
    const ring = row.locator('svg[viewBox="0 0 120 120"]');
    await expect(ring).toBeVisible();

    // The ring drives the row height, so an oversized ring shows up as a taller row.
    const box = await row.boundingBox();
    expect(box?.height ?? 0).toBeLessThan(130);
    expect(box?.width ?? 0).toBeGreaterThan(600);

    // Panel starts right of the ring and stops short of the grid edge: fit-content.
    const ringBox = await ring.boundingBox();
    const panelBox = await row.locator(":scope > div").nth(1).boundingBox();
    const gridBox = await page.locator("#content .view.active .item-grid").boundingBox();
    expect(panelBox?.x ?? 0).toBeGreaterThanOrEqual((ringBox?.x ?? 0) + (ringBox?.width ?? 0));
    const panelRight = (panelBox?.x ?? 0) + (panelBox?.width ?? 0);
    const gridRight = (gridBox?.x ?? 0) + (gridBox?.width ?? 0);
    expect(gridRight - panelRight).toBeGreaterThanOrEqual(40);
  });
});
