import { test, expect } from "@playwright/test";

import {
  closeElectronTestHarness,
  launchElectronTestHarness,
  type ElectronTestHarness,
} from "./electronTestHarness";

// A blueprint whose ingredients are nowhere near owned, so it is never ready.
function inventory() {
  return {
    Suits: [],
    Recipes: [{ ItemType: "/Lotus/Types/Recipes/Weapons/BoltorBlueprint", ItemCount: 1 }],
    MiscItems: [{ ItemType: "/Lotus/Types/Items/MiscItems/Neurode", ItemCount: 42 }],
  };
}

test.describe("Foundry buildable-set filter", () => {
  test.setTimeout(180_000);

  let harness: ElectronTestHarness | undefined;

  test.beforeAll(async () => {
    harness = await launchElectronTestHarness("wfh-foundry-", { inventory: inventory() });
    await harness.page.locator('#sidebar [data-view="foundry"]').click();
    await expect(harness.page.locator("[data-foundry-state]")).toBeVisible({ timeout: 30_000 });
    // Startup awaits the snapshot fetch (20s cap) before the item database, so
    // the rows arrive well after their filter bar and an empty list is not "no
    // matches" yet. Gate on a row, at the harness boot timeout.
    await expect(harness.page.locator(".resource-card").first()).toBeVisible({ timeout: 90_000 });
  });

  test.afterAll(async () => {
    await closeElectronTestHarness(harness);
  });

  test("readiness is no longer one of the mutually exclusive tabs", async () => {
    const page = harness!.page;
    const tabKeys = await page
      .locator("[data-tour-tab]")
      .evaluateAll((els) => els.map((el) => el.getAttribute("data-tour-tab")));

    expect(tabKeys).toContain("all");
    expect(tabKeys).toContain("cat:Warframe");
    expect(tabKeys).not.toContain("status:ready");
  });

  test("the full-set option lives in the claim filter, not beside it", async () => {
    const page = harness!.page;
    const values = await page
      .locator("[data-foundry-state] option")
      .evaluateAll((els) => els.map((el) => (el as HTMLOptionElement).value));

    expect(values).toEqual(["all", "claimable", "not_ready", "buildable", "buildable_sets"]);
    expect(await page.locator("[data-foundry-ready-only]").count()).toBe(0);
  });

  test("it hides anything that is not a full set ready to build", async () => {
    const page = harness!.page;
    const claim = page.locator("[data-foundry-state]");
    await expect(claim).toHaveValue("all");
    await expect
      .poll(() => page.locator(".resource-card").count(), { timeout: 30_000 })
      .toBeGreaterThan(0);

    await claim.selectOption("buildable_sets");
    // The fixture's only blueprint is missing parts, so nothing survives.
    await expect.poll(() => page.locator(".resource-card").count()).toBe(0);

    await claim.selectOption("all");
    await expect.poll(() => page.locator(".resource-card").count()).toBeGreaterThan(0);
  });

  test("a category tab still narrows the list on its own", async () => {
    const page = harness!.page;
    await page.locator('[data-tour-tab="cat:Warframe"]').click();
    await expect.poll(() => page.locator(".resource-card").count()).toBe(0);

    await page.locator('[data-tour-tab="all"]').click();
    await expect.poll(() => page.locator(".resource-card").count()).toBeGreaterThan(0);
  });

  // Shared filters are session state, like every other control in this bar, so
  // leaving the tab must keep the choice even though a reload clears it.
  test("the choice survives leaving the tab", async () => {
    const page = harness!.page;
    await page.locator("[data-foundry-state]").selectOption("buildable_sets");
    await page.locator('#sidebar [data-view="inventory"]').click();
    await page.locator('#sidebar [data-view="foundry"]').click();

    await expect(page.locator("[data-foundry-state]")).toHaveValue("buildable_sets", {
      timeout: 30_000,
    });
    await page.locator("[data-foundry-state]").selectOption("all");
  });
});
