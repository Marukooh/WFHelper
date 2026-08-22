import fs from "node:fs";
import path from "node:path";

import { test, expect } from "@playwright/test";

import {
  closeElectronTestHarness,
  launchElectronTestHarness,
  type ElectronTestHarness,
} from "./electronTestHarness";

/** Rewrites the harness inventory with whole prime sets from the shipped item database. */
async function seedCompleteSets(harness: ElectronTestHarness): Promise<void> {
  const parts = await harness.page.evaluate(async () => {
    const db = (await window.api.getItemDatabase()) as unknown as Record<
      string,
      { name?: string; components?: Array<{ uniqueName?: string; itemCount?: number }> }
    >;
    const wanted = new Set(["Braton Prime", "Mag Prime", "Lex Prime", "Ankyros Prime"]);
    const seeded: Array<{ ItemType: string; ItemCount: number }> = [];
    for (const entry of Object.values(db)) {
      if (!entry?.name || !wanted.has(entry.name)) continue;
      for (const component of entry.components ?? []) {
        if (typeof component.uniqueName !== "string") continue;
        seeded.push({ ItemType: component.uniqueName, ItemCount: (component.itemCount ?? 1) + 1 });
      }
    }
    return seeded;
  });

  expect(parts.length).toBeGreaterThan(0);
  // A changed file re-triggers the watcher, which is what refills the stores.
  fs.writeFileSync(
    path.join(harness.helperDir, "inventory.json"),
    JSON.stringify({ Suits: [], MiscItems: parts }),
  );
}

test.describe("Inventory Full Sets category chips", () => {
  test.setTimeout(180_000);

  let harness: ElectronTestHarness | undefined;

  test.beforeAll(async () => {
    harness = await launchElectronTestHarness("wfh-fullsets-", { inventory: { Suits: [] } });
    await harness.page.locator('#sidebar [data-view="inventory"]').click();
    await seedCompleteSets(harness);
    await harness.page.locator('[data-tour-tab="full_sets"]').click();
    await expect(harness.page.locator('[data-chip-row="full-set-categories"]')).toBeVisible({
      timeout: 30_000,
    });
  });

  test.afterAll(async () => {
    await closeElectronTestHarness(harness);
  });

  test("buckets sets by equipment category in canonical order", async () => {
    const chips = await harness!.page
      .locator('[data-chip-row="full-set-categories"] [data-chip]')
      .evaluateAll((els) => els.map((el) => el.getAttribute("data-chip")));

    expect(chips).toEqual(["Warframe", "Primary", "Secondary", "Melee"]);
  });

  test("switching a category off drops only that category's sets", async () => {
    const page = harness!.page;
    const before = await page.locator(".item-card").count();
    expect(before).toBeGreaterThan(1);

    await page.locator('[data-chip="Warframe"]').click();
    await expect(page.locator('[data-chip="Warframe"]')).toHaveAttribute("aria-pressed", "false");
    await expect.poll(() => page.locator(".item-card").count()).toBe(before - 1);

    await page.locator('[data-chip="Warframe"]').click();
    await expect.poll(() => page.locator(".item-card").count()).toBe(before);
  });
});
