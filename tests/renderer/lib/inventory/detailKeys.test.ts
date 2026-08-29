import { describe, expect, it } from "vitest";

import { parseInventory } from "../../../../src/lib/inventory.js";
import { buildBaseInventoryItems } from "../../../../src/lib/inventoryMarket.js";
import type { ItemDbEntry, ParsedItem, RawInventoryData } from "../../../../src/types/inventory.js";

const HOUND_BASE = "/Lotus/Types/Friendly/Pets/ZanukaPets/ZanukaPetPowerSuit";
const HOUND_HEAD = "/Lotus/Types/Friendly/Pets/ZanukaPets/ZanukaPetParts/ZanukaPetPartHeadA";
const MOA_BASE = "/Lotus/Types/Friendly/Pets/MoaPets/MoaPetPowerSuit";
const MOA_HEAD = "/Lotus/Types/Friendly/Pets/MoaPets/MoaPetParts/MoaPetHeadLambeo";
const MOD = "/Lotus/Upgrades/Mods/Bite";
const FRAME = "/Lotus/Types/Player/VoltPrime";

const DB: Record<string, ItemDbEntry> = {
  [HOUND_BASE]: { name: "Hound", productCategory: "MoaPets" },
  [HOUND_HEAD]: { name: "Bhaira", productCategory: "Pistols" },
  [MOA_BASE]: { name: "Moa", productCategory: "MoaPets" },
  [MOA_HEAD]: { name: "Lambeo Moa", productCategory: "Pistols" },
  [MOD]: { name: "Bite", category: "Mods" },
  [FRAME]: { name: "Volt Prime", isPrime: true, tradable: true },
};

/** The set InventoryView feeds InventoryGrid, before the fix. */
function detailKeysBefore(parsed: ParsedItem[]): Set<string> {
  return new Set(
    parsed.flatMap((entry) =>
      entry.modularParts && typeof entry.inventoryKey === "string"
        ? [entry.internalName, entry.inventoryKey]
        : [entry.internalName],
    ),
  );
}

/** The same set as InventoryView builds it now. */
function detailKeysAfter(parsed: ParsedItem[]): Set<string> {
  return new Set(
    parsed.flatMap((entry) =>
      typeof entry.inventoryKey === "string" && entry.inventoryKey !== entry.internalName
        ? [entry.internalName, entry.inventoryKey]
        : [entry.internalName],
    ),
  );
}

/** The card id InventoryGrid checks against detailKeys. */
function cardIds(parsed: ParsedItem[]): string[] {
  return buildBaseInventoryItems(parsed, "everything", {}, {}, {}).map((item) => item.internalName);
}

describe("detailKeys covers every card id", () => {
  it("expands a Hound build that carries no fitted parts", () => {
    const data: RawInventoryData = {
      MoaPets: [{ ItemType: HOUND_BASE, ItemId: "h1" }],
    };

    const parsed = parseInventory(data, DB);
    const hound = parsed.find((item) => item.internalName === HOUND_BASE);
    // The row is a build, but with no parts there is no modularParts marker.
    expect(hound?.modularParts).toBeUndefined();
    expect(hound?.inventoryKey).toBe(`${HOUND_BASE}#bh1`);

    const [cardId] = cardIds(parsed);
    expect(cardId).toBe(`${HOUND_BASE}#bh1`);
    expect(detailKeysBefore(parsed).has(cardId!)).toBe(false);
    expect(detailKeysAfter(parsed).has(cardId!)).toBe(true);
  });

  it("keeps expanding a Moa build that does carry parts", () => {
    const data: RawInventoryData = {
      MoaPets: [{ ItemType: MOA_BASE, ItemId: "m1", ModularParts: [MOA_HEAD] }],
    };

    const parsed = parseInventory(data, DB);
    const [cardId] = cardIds(parsed);
    expect(detailKeysAfter(parsed).has(cardId!)).toBe(true);
  });

  it("expands a rank-keyed mod row, which the modularParts gate also missed", () => {
    const data: RawInventoryData = {
      Upgrades: [{ ItemType: MOD, ItemCount: 1, UpgradeData: { CurrentRank: 3, MaxRank: 5 } }],
    };

    const parsed = parseInventory(data, DB);
    const [cardId] = cardIds(parsed);
    expect(cardId).toBe(`${MOD}#r3m5`);
    expect(detailKeysBefore(parsed).has(cardId!)).toBe(false);
    expect(detailKeysAfter(parsed).has(cardId!)).toBe(true);
  });

  it("leaves a plain row keyed by its own uniqueName", () => {
    const data: RawInventoryData = {
      Suits: [{ ItemType: FRAME, ItemCount: 1 }],
    };

    const parsed = parseInventory(data, DB);
    expect(detailKeysAfter(parsed)).toEqual(new Set([FRAME]));
  });

  it("still hides the button on a row with no parsed backing", () => {
    const parsed = parseInventory({ Suits: [{ ItemType: FRAME, ItemCount: 1 }] }, DB);
    expect(detailKeysAfter(parsed).has("/Lotus/Generated/VoltPrimeSet")).toBe(false);
  });
});
