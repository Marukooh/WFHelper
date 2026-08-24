import { test, expect } from "@playwright/test";

import {
  closeElectronTestHarness,
  launchElectronTestHarness,
  type ElectronTestHarness,
} from "./electronTestHarness";

const ACCELERATED_ISOTOPE = "/Lotus/Upgrades/Mods/Pistol/DualStat/RadiationFireratePistolMod";
const ARCANE_BELLICOSE = "/Lotus/Upgrades/CosmeticEnhancers/Offensive/AbilityStrengthForMaxHealth";

function inventory() {
  return {
    Suits: [],
    RawUpgrades: [{ ItemType: ACCELERATED_ISOTOPE, ItemCount: 23 }],
    Arcanes: [{ ItemType: ARCANE_BELLICOSE, ItemCount: 1 }],
  };
}

// Tab labels are translated; data-tour-tab carries the stable filter key.
async function tabImages(page: ElectronTestHarness["page"], tab: string): Promise<string[]> {
  await page.locator(`[data-tour="inventory-tabs"] [data-tour-tab="${tab}"]`).click();
  await expect(page.locator(".item-name").first()).toBeVisible({ timeout: 15_000 });
  return page
    .locator(".item-img")
    .evaluateAll((els) => els.map((el) => (el as HTMLImageElement).src));
}

test("mods and arcanes render the framed wiki card, not the market thumbnail", async () => {
  test.setTimeout(180_000);
  let harness: ElectronTestHarness | undefined;
  try {
    harness = await launchElectronTestHarness("wfh-cardart-", { inventory: inventory() });
    const { page } = harness;
    await page.locator('#sidebar [data-view="inventory"]').click();

    // The WFM thumb used to win for ranked listings, which is every mod and arcane.
    const mods = await tabImages(page, "mods");
    expect(mods.some((src) => src.includes("/mod-art/AcceleratedIsotopeMod.webp"))).toBe(true);
    expect(mods.some((src) => src.includes("/wfm/"))).toBe(false);

    const arcanes = await tabImages(page, "arcanes");
    expect(arcanes.some((src) => src.includes("/mod-art/ArcaneBellicose.webp"))).toBe(true);
    expect(arcanes.some((src) => src.includes("/wfm/"))).toBe(false);
  } finally {
    await closeElectronTestHarness(harness);
  }
});
