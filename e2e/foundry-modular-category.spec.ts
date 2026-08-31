import { test, expect } from "@playwright/test";

import {
  closeElectronTestHarness,
  launchElectronTestHarness,
  type ElectronTestHarness,
} from "./electronTestHarness";

// Every modular part exports with productCategory "Pistols", so a category
// read off that field files them all under Secondary.
const AMP_GRIP_BP =
  "/Lotus/Weapons/Sentients/OperatorAmplifiers/Set1/Grip/SentAmpSet1GripPartABlueprint";
const KITGUN_HANDLE_BP =
  "/Lotus/Weapons/SolarisUnited/Secondary/SUModularSecondarySet1/Handle/SUModularSecondaryHandleCPartBlueprint";
const ZAW_TIP_BP = "/Lotus/Weapons/Ostron/Melee/ModularMeleeInfested/Tips/InfestedTipOneBlueprint";
const KDRIVE_DECK_BP =
  "/Lotus/Types/Vehicles/Hoverboard/HoverboardParts/PartComponents/HoverboardCorpusA/HoverboardCorpusADeckBlueprint";

function inventory() {
  return {
    Suits: [],
    Recipes: [
      { ItemType: AMP_GRIP_BP, ItemCount: 1 },
      { ItemType: KITGUN_HANDLE_BP, ItemCount: 1 },
      { ItemType: ZAW_TIP_BP, ItemCount: 1 },
      { ItemType: KDRIVE_DECK_BP, ItemCount: 1 },
    ],
    MiscItems: [{ ItemType: "/Lotus/Types/Items/MiscItems/Neurode", ItemCount: 42 }],
  };
}

async function visibleCardCount(harness: ElectronTestHarness): Promise<number> {
  return harness.page.locator(".resource-card").count();
}

test.describe("Foundry modular category", () => {
  test.setTimeout(180_000);

  let harness: ElectronTestHarness | undefined;

  test.beforeAll(async () => {
    harness = await launchElectronTestHarness("wfh-foundry-modular-", { inventory: inventory() });
    await harness.page.locator('#sidebar [data-view="foundry"]').click();
    await expect(harness.page.locator("[data-foundry-state]")).toBeVisible({ timeout: 30_000 });
    await expect(harness.page.locator(".resource-card").first()).toBeVisible({ timeout: 90_000 });
  });

  test.afterAll(async () => {
    await closeElectronTestHarness(harness);
  });

  test("amp, kitgun, zaw and K-Drive blueprints all sit under Modular", async () => {
    const page = harness!.page;
    await page.locator('[data-tour-tab="cat:Modular"]').click();
    await expect(page.locator(".resource-card").first()).toBeVisible({ timeout: 15_000 });

    expect(await visibleCardCount(harness!)).toBe(4);
  });

  test("none of them leak into the Secondary tab", async () => {
    const page = harness!.page;
    await page.locator('[data-tour-tab="cat:Secondary"]').click();
    await page.waitForTimeout(400);

    expect(await visibleCardCount(harness!)).toBe(0);
  });
});
