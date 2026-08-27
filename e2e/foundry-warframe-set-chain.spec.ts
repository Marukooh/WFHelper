import fs from "node:fs";
import path from "node:path";

import { test, expect } from "@playwright/test";

import {
  closeElectronTestHarness,
  launchElectronTestHarness,
  type ElectronTestHarness,
} from "./electronTestHarness";

interface ChainSeed {
  mainBp: string;
  partBps: string[];
  misc: Array<{ ItemType: string; ItemCount: number }>;
}

// Warframes gate "Can build (full set)" behind their crafting chain: the main
// blueprint only turns buildable after the parts are BUILT, so the filter must
// count a frame whose parts are all still craftable from owned blueprints.
test.describe("Foundry buildable-set chain", () => {
  test.setTimeout(180_000);

  let harness: ElectronTestHarness | undefined;

  test.beforeAll(async () => {
    harness = await launchElectronTestHarness("wfh-wf-chain-", { inventory: { Suits: [] } });
    await harness.page.locator('#sidebar [data-view="foundry"]').click();
    await expect(harness.page.locator("[data-foundry-state]")).toBeVisible({ timeout: 90_000 });
  });

  test.afterAll(async () => {
    await closeElectronTestHarness(harness);
  });

  test("a frame with craftable parts counts as a buildable set", async () => {
    const page = harness!.page;

    // Pull Yareli's real chain from the shipped item DB: main BP, the part
    // blueprints, and enough raw resources for every part build.
    const seed = (await page.evaluate(async () => {
      const db = (await window.api.getItemDatabase()) as unknown as Record<
        string,
        {
          name?: string;
          recipe?: {
            blueprintUniqueName?: string;
            ingredients?: Array<{ uniqueName: string; count: number }>;
          };
        }
      >;
      const frame = Object.values(db).find((entry) => entry?.name === "Yareli");
      if (!frame?.recipe?.blueprintUniqueName) return null;
      const partBps: string[] = [];
      const misc: Array<{ ItemType: string; ItemCount: number }> = [];
      for (const ing of frame.recipe.ingredients ?? []) {
        const part = db[ing.uniqueName];
        if (part?.recipe?.blueprintUniqueName) {
          partBps.push(part.recipe.blueprintUniqueName);
          for (const sub of part.recipe.ingredients ?? []) {
            misc.push({ ItemType: sub.uniqueName, ItemCount: sub.count * ing.count });
          }
        } else {
          misc.push({ ItemType: ing.uniqueName, ItemCount: ing.count });
        }
      }
      return { mainBp: frame.recipe.blueprintUniqueName, partBps, misc };
    })) as ChainSeed | null;

    expect(seed).not.toBeNull();
    expect(seed!.partBps.length).toBeGreaterThan(0);

    const write = (recipes: string[]) => {
      // A changed file re-triggers the watcher, which is what refills the stores.
      fs.writeFileSync(
        path.join(harness!.helperDir, "inventory.json"),
        JSON.stringify({
          Suits: [],
          Recipes: recipes.map((ItemType) => ({ ItemType, ItemCount: 1 })),
          MiscItems: seed!.misc,
        }),
      );
    };

    write([seed!.mainBp, ...seed!.partBps]);
    await expect
      .poll(() => page.locator(".resource-card").count(), { timeout: 60_000 })
      .toBeGreaterThan(0);

    await page.locator('[data-tour-tab="cat:Warframe"]').click();
    await page.locator("[data-foundry-state]").selectOption("buildable_sets");
    await expect.poll(() => page.locator(".resource-card").count()).toBe(1);
    await expect(page.locator(".resource-card")).toContainText("Yareli");

    // Dropping one part blueprint breaks the chain, so the frame disappears.
    write([seed!.mainBp, ...seed!.partBps.slice(1)]);
    await expect.poll(() => page.locator(".resource-card").count(), { timeout: 60_000 }).toBe(0);

    await page.locator("[data-foundry-state]").selectOption("all");
    await page.locator('[data-tour-tab="all"]').click();
  });
});
