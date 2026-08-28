import { describe, expect, it } from "vitest";

import {
  classifyForFoundry,
  parseFoundry,
} from "../../../../src/lib/inventory/foundryResources.js";
import type { ItemDbEntry, RawInventoryData } from "../../../../src/types/inventory.js";

// Paths and productCategory values below are copied from DE's PublicExport.
// Every modular and pet part ships as productCategory "Pistols", so a bucket
// that trusts productCategory files amps, kitguns and zaws under Secondary.
function part(name: string, productCategory = "Pistols"): ItemDbEntry {
  return { name, productCategory };
}

function classify(productUn: string, entry: ItemDbEntry, blueprintSuffix = "Blueprint"): string {
  return classifyForFoundry(productUn, `${productUn}${blueprintSuffix}`, { [productUn]: entry });
}

const AMP_PRISM = "/Lotus/Weapons/Corpus/OperatorAmplifiers/Set1/Barrel/CorpAmpSet1BarrelPartC";
const AMP_SCAFFOLD =
  "/Lotus/Weapons/Corpus/OperatorAmplifiers/Set1/Chassis/CorpAmpSet1ChassisPartC";
const AMP_GRIP = "/Lotus/Weapons/Corpus/OperatorAmplifiers/Set1/Grip/CorpAmpSet1GripPartC";
const AMP_TRAINING =
  "/Lotus/Weapons/Sentients/OperatorAmplifiers/SentTrainingAmplifier/SentAmpTrainingBarrel";
const KDRIVE_DECK =
  "/Lotus/Types/Vehicles/Hoverboard/HoverboardParts/PartComponents/HoverboardSolarisA/HoverboardSolarisADeck";
const KITGUN_CHAMBER =
  "/Lotus/Weapons/SolarisUnited/Secondary/SUModularSecondarySet1/Barrel/SUModularSecondaryBarrelAPart";
const KITGUN_HANDLE =
  "/Lotus/Weapons/SolarisUnited/Primary/SUModularPrimarySet1/Handles/SUModularPrimaryHandleAPart";
const INF_KITGUN_BARREL =
  "/Lotus/Weapons/Infested/Pistols/InfKitGun/Barrels/InfBarrelBeam/InfModularBarrelBeamPart";
const ZAW_TIP = "/Lotus/Weapons/Ostron/Melee/ModularMelee01/Tip/TipFour";
const ZAW_GRIP = "/Lotus/Weapons/Ostron/Melee/ModularMelee01/Handle/HandleAttackSpeedI";
const MOA_ENGINE = "/Lotus/Types/Friendly/Pets/MoaPets/MoaPetParts/MoaPetEngineArcotek";

describe("classifyForFoundry modular gear", () => {
  it("buckets amp prisms, scaffolds and grips as Modular", () => {
    expect(classify(AMP_PRISM, part("Klamora Prism"))).toBe("Modular");
    expect(classify(AMP_SCAFFOLD, part("Propa Scaffold"))).toBe("Modular");
    expect(classify(AMP_GRIP, part("Certus Brace"))).toBe("Modular");
  });

  it("buckets a training amp part as Modular", () => {
    expect(classify(AMP_TRAINING, part("Mote Prism"))).toBe("Modular");
  });

  it("buckets an amp blueprint with no mapped product as Modular", () => {
    expect(classifyForFoundry(null, `${AMP_PRISM}Blueprint`, {})).toBe("Modular");
  });

  it("buckets K-Drive parts as Modular", () => {
    expect(classify(KDRIVE_DECK, part("Bad Baby"))).toBe("Modular");
  });

  it("buckets kitgun parts as Modular", () => {
    expect(classify(KITGUN_CHAMBER, part("Catchmoon"))).toBe("Modular");
    expect(classify(KITGUN_HANDLE, part("Brash"))).toBe("Modular");
    expect(classify(INF_KITGUN_BARREL, part("Sporelacer"))).toBe("Modular");
  });

  it("buckets zaw parts as Modular", () => {
    expect(classify(ZAW_TIP, part("Dokrahm"))).toBe("Modular");
    expect(classify(ZAW_GRIP, part("Peye"))).toBe("Modular");
  });

  it("buckets moa parts as Modular", () => {
    expect(
      classifyForFoundry(
        MOA_ENGINE,
        "/Lotus/Types/Recipes/MoaPetParts/MoaPetEngineArcotekBlueprint",
        {
          [MOA_ENGINE]: part("Arcotek Core"),
        },
      ),
    ).toBe("Modular");
  });
});

describe("parseFoundry rows carry the modular bucket", () => {
  it("tags owned amp and kitgun blueprints Modular on the row FoundryView reads", () => {
    const ampBlueprint = `${AMP_PRISM}Blueprint`;
    const kitgunBlueprint = `${KITGUN_CHAMBER}Blueprint`;
    const recipeFor = (blueprintUniqueName: string): NonNullable<ItemDbEntry["recipe"]> => ({
      blueprintUniqueName,
      ingredients: [],
      buildPrice: 0,
      buildTime: 0,
      num: 1,
    });
    const itemDb: Record<string, ItemDbEntry> = {
      [AMP_PRISM]: { ...part("Klamora Prism"), recipe: recipeFor(ampBlueprint) },
      [KITGUN_CHAMBER]: { ...part("Catchmoon"), recipe: recipeFor(kitgunBlueprint) },
    };
    const raw: RawInventoryData = {
      Recipes: [
        { ItemType: ampBlueprint, ItemCount: 1 },
        { ItemType: kitgunBlueprint, ItemCount: 2 },
      ],
    };

    const categories = parseFoundry(raw, itemDb).recipes.map((row) => row.category);
    expect(categories).toEqual(["Modular", "Modular"]);
  });
});

describe("classifyForFoundry keeps real gear in its own slot", () => {
  it("keeps Tenno weapons in their weapon slots", () => {
    expect(
      classify(
        "/Lotus/Weapons/Tenno/Pistols/TnWraitheSidearm/TnWraitheSidearmWeapon",
        part("Laetum"),
      ),
    ).toBe("Secondary");
    expect(
      classify(
        "/Lotus/Weapons/Tenno/Rifle/VandalSniperRifle",
        part("Snipetron Vandal", "LongGuns"),
      ),
    ).toBe("Primary");
    expect(
      classify("/Lotus/Weapons/Tenno/Melee/Warfan/WarfanWeapon", part("Gunsen", "Melee")),
    ).toBe("Melee");
  });

  it("keeps a prime pistol component blueprint in Secondary", () => {
    const parent = "/Lotus/Weapons/Tenno/Akimbo/AkLexPrimePistols";
    const component = "/Lotus/Types/Recipes/Weapons/WeaponParts/AkLexPrimeBarrel";
    expect(
      classifyForFoundry(component, `${component}Blueprint`, {
        [component]: { name: "Aklex Prime Barrel", componentOf: parent },
        [parent]: { name: "Aklex Prime", productCategory: "Pistols" },
      }),
    ).toBe("Secondary");
  });

  it("keeps sentinel and pet parts in Companion", () => {
    expect(
      classify(
        "/Lotus/Types/Sentinels/SentinelPowersuits/CarrierPowerSuit",
        part("Carrier", "Sentinels"),
      ),
    ).toBe("Companion");
    // Infested critter parts are the other real "Pistols" mislabel the guard covers.
    const critter =
      "/Lotus/Types/Friendly/Pets/CreaturePets/CreaturePetParts/Deimos/InfestedCritterMutagenA";
    expect(
      classifyForFoundry(
        critter,
        "/Lotus/Types/Recipes/DeimosRecipes/Pets/InfestedCritterMutagenABlueprint",
        { [critter]: part("Mutagen Vome") },
      ),
    ).toBe("Companion");
  });
});
