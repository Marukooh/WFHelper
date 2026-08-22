import { test, expect } from "@playwright/test";

import {
  closeElectronTestHarness,
  launchElectronTestHarness,
  type ElectronTestHarness,
} from "./electronTestHarness";

const ACCELERATED_ISOTOPE = "/Lotus/Upgrades/Mods/Pistol/DualStat/RadiationFireratePistolMod";
const ARCANE_BELLICOSE = "/Lotus/Upgrades/CosmeticEnhancers/Offensive/AbilityStrengthForMaxHealth";
// Ranked rows only get a slug from the live WFM catalogue; a tradable part
// generates one locally, so the order-book panel works with no network.
const BRATON_PRIME_BARREL = "/Lotus/Types/Recipes/Weapons/WeaponParts/BratonPrimeBarrel";

function inventory() {
  return {
    Suits: [],
    RawUpgrades: [{ ItemType: ACCELERATED_ISOTOPE, ItemCount: 23 }],
    Arcanes: [{ ItemType: ARCANE_BELLICOSE, ItemCount: 1 }],
    MiscItems: [{ ItemType: BRATON_PRIME_BARREL, ItemCount: 2 }],
  };
}

async function visibleNames(page: ElectronTestHarness["page"]): Promise<string[]> {
  return page
    .locator(".item-name")
    .evaluateAll((els) => els.map((el) => el.textContent?.trim() ?? ""));
}

test.describe("Inventory Everything tab", () => {
  test.setTimeout(180_000);

  let harness: ElectronTestHarness | undefined;

  test.beforeAll(async () => {
    harness = await launchElectronTestHarness("wfh-everything-", { inventory: inventory() });
    await harness.page.locator('#sidebar [data-view="inventory"]').click();
    await harness.page.locator('[data-tour-tab="everything"]').click();
    await expect(harness.page.locator(".item-name").first()).toBeVisible({ timeout: 15_000 });
  });

  test.afterAll(async () => {
    await closeElectronTestHarness(harness);
  });

  test("lists every category at once so one search covers the inventory", async () => {
    const page = harness!.page;
    const names = await visibleNames(page);

    expect(names.some((name) => name.includes("Accelerated Isotope"))).toBe(true);
    expect(names.some((name) => name.includes("Bellicose"))).toBe(true);
  });

  test("source chips drop a category from the list and put it back", async () => {
    const page = harness!.page;
    const modsChip = page.locator('[data-chip="mods"]');
    await expect(modsChip).toHaveAttribute("aria-pressed", "true");

    await modsChip.click();
    await expect(modsChip).toHaveAttribute("aria-pressed", "false");
    await expect
      .poll(async () => (await visibleNames(page)).some((n) => n.includes("Accelerated Isotope")))
      .toBe(false);
    // Turning one source off must not take the rest of the tab with it.
    expect((await visibleNames(page)).some((name) => name.includes("Bellicose"))).toBe(true);

    await modsChip.click();
    await expect(modsChip).toHaveAttribute("aria-pressed", "true");
    await expect
      .poll(async () => (await visibleNames(page)).some((n) => n.includes("Accelerated Isotope")))
      .toBe(true);
  });

  test("the source choice survives a reload", async () => {
    const page = harness!.page;
    await page.locator('[data-chip="arcanes"]').click();
    await page.reload();
    await expect(page.locator("#sidebar")).toBeVisible({ timeout: 90_000 });
    await page.locator('#sidebar [data-view="inventory"]').click();

    await expect(page.locator('[data-chip="arcanes"]')).toHaveAttribute("aria-pressed", "false");
    await page.locator('[data-chip="arcanes"]').click();
  });

  test("the order book panel opens warframe.market statistics in a modal", async () => {
    const page = harness!.page;
    await page.locator(".item-card").filter({ hasText: "Braton Prime Barrel" }).first().click();

    const statsButton = page.locator("[data-orderbook-stats]");
    await expect(statsButton).toBeVisible({ timeout: 15_000 });
    await statsButton.click();

    await expect(page.locator("[data-market-stats-modal]")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator("[data-market-stats-modal]")).toHaveCount(0);
  });
});
