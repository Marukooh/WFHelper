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
    const ring = page.locator('#content .view.active svg[viewBox="0 0 120 120"]').first();
    await expect(ring).toBeVisible();
    // The ring lives inside the strip panel, so an oversized ring or cell font
    // shows up here as a taller row.
    const box = await ring.locator("xpath=ancestor::div[2]").boundingBox();
    expect(box?.height ?? 0).toBeLessThan(130);
    expect(box?.width ?? 0).toBeGreaterThan(600);
  });
});
