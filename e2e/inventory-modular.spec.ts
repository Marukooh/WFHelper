import { test, expect } from "@playwright/test";

import {
  closeElectronTestHarness,
  launchElectronTestHarness,
  type ElectronTestHarness,
} from "./electronTestHarness";

// Real uniqueNames from a live account: DE stores a build under a generic
// ItemType the export does not carry, so every name comes from ModularParts.
const KITGUN_BASE = "/Lotus/Weapons/SolarisUnited/Primary/LotusModularPrimaryShotgun";
const KITGUN_CHAMBER =
  "/Lotus/Weapons/SolarisUnited/Secondary/SUModularSecondarySet1/Barrel/SUModularSecondaryBarrelAPart";
const KITGUN_GRIP =
  "/Lotus/Weapons/SolarisUnited/Primary/SUModularPrimarySet1/Handles/SUModularPrimaryHandleBPart";
const ZAW_BASE = "/Lotus/Weapons/Ostron/Melee/LotusModularWeapon";
const ZAW_TIP = "/Lotus/Weapons/Ostron/Melee/ModularMelee02/Tip/TipEleven";
const ZAW_HANDLE = "/Lotus/Weapons/Ostron/Melee/ModularMelee01/Handle/HandleFour";
const AMP_BASE = "/Lotus/Weapons/Sentients/OperatorAmplifiers/OperatorAmpWeapon";
const AMP_PRISM = "/Lotus/Weapons/Sentients/OperatorAmplifiers/Set1/Barrel/SentAmpSet1BarrelPartA";
const KDRIVE_BASE = "/Lotus/Types/Vehicles/Hoverboard/HoverboardSuit";
const KDRIVE_DECK =
  "/Lotus/Types/Vehicles/Hoverboard/HoverboardParts/PartComponents/HoverboardSolarisA/HoverboardSolarisADeck";
const MOA_BASE = "/Lotus/Types/Friendly/Pets/MoaPets/MoaPetPowerSuit";
const MOA_HEAD = "/Lotus/Types/Friendly/Pets/MoaPets/MoaPetParts/MoaPetHeadLambeo";
const VULPAPHYLA_BASE =
  "/Lotus/Types/Friendly/Pets/CreaturePets/ArmoredInfestedCatbrowPetPowerSuit";
const VULPAPHYLA_MUTAGEN =
  "/Lotus/Types/Friendly/Pets/CreaturePets/CreaturePetParts/Deimos/InfestedCritterMutagenA";

function inventory() {
  return {
    Suits: [],
    LongGuns: [
      {
        ItemType: KITGUN_BASE,
        ItemId: { $oid: "aaa" },
        ModularParts: [KITGUN_CHAMBER, KITGUN_GRIP],
      },
    ],
    Melee: [{ ItemType: ZAW_BASE, ItemId: { $oid: "bbb" }, ModularParts: [ZAW_TIP, ZAW_HANDLE] }],
    OperatorAmps: [{ ItemType: AMP_BASE, ItemId: { $oid: "ccc" }, ModularParts: [AMP_PRISM] }],
    Hoverboards: [{ ItemType: KDRIVE_BASE, ItemId: { $oid: "ddd" }, ModularParts: [KDRIVE_DECK] }],
    MoaPets: [{ ItemType: MOA_BASE, ItemId: { $oid: "eee" }, ModularParts: [MOA_HEAD] }],
    KubrowPets: [
      { ItemType: VULPAPHYLA_BASE, ItemId: { $oid: "fff" }, ModularParts: [VULPAPHYLA_MUTAGEN] },
    ],
    // The loose deck is the issue-27 case: exported as productCategory Pistols.
    MiscItems: [{ ItemType: KDRIVE_DECK, ItemCount: 2 }],
  };
}

test.describe("built modular gear", () => {
  test.setTimeout(180_000);

  let harness: ElectronTestHarness | undefined;

  test.beforeAll(async () => {
    harness = await launchElectronTestHarness("wfh-modular-", { inventory: inventory() });
    await harness.page.locator('#sidebar [data-view="inventory"]').click();
    await harness.page.locator('[data-tour-tab="equipment"]').click();
    await expect(harness.page.locator(".item-card").first()).toBeVisible({ timeout: 20_000 });
  });

  test.afterAll(async () => {
    await closeElectronTestHarness(harness);
  });

  test("names every build after the part that defines it", async () => {
    const page = harness!.page;

    for (const name of ["Catchmoon", "Dokrahm", "Raplak Prism", "Lambeo Moa"]) {
      await expect(page.locator(".item-card").filter({ hasText: name }).first()).toBeVisible({
        timeout: 15_000,
      });
    }
  });

  test("labels a build by its kit instead of a weapon slot", async () => {
    const page = harness!.page;
    const kitgun = page.locator(".item-card").filter({ hasText: "Catchmoon" }).first();
    await expect(kitgun.locator(".item-type")).toContainText("Kitgun");

    const zaw = page.locator(".item-card").filter({ hasText: "Dokrahm" }).first();
    await expect(zaw.locator(".item-type")).toContainText("Zaw");
  });

  test("lists the fitted parts in the detail modal", async () => {
    const page = harness!.page;
    const kitgun = page.locator(".item-card").filter({ hasText: "Catchmoon" }).first();
    await kitgun.hover();
    await kitgun.locator(".expand-link").click();

    const modal = page.locator(".detail-panel").first();
    await expect(modal).toBeVisible({ timeout: 15_000 });
    await expect(modal).toContainText("Catchmoon");
    // The grip only appears if the fitted-parts list rendered.
    await expect(modal).toContainText("Shrewd");
    await page.keyboard.press("Escape");
  });

  test("keeps a loose K-Drive part out of the secondary bucket", async () => {
    const page = harness!.page;
    await page.locator('[data-tour-tab="misc"]').click();

    const deck = page.locator(".item-card").filter({ hasText: "Bad Baby" }).first();
    await expect(deck).toBeVisible({ timeout: 15_000 });
    await expect(deck.locator(".item-type")).not.toContainText("Secondary");
  });
});
