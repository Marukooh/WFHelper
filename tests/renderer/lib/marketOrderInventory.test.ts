import { describe, expect, it } from "vitest";

import { ownedCountForMarketOrder } from "../../../src/lib/marketOrderInventory.js";
import { applySharedFiltersAndSort } from "../../../src/lib/filters.js";
import type { SharedFiltersState } from "../../../src/types/filters.js";
import type { ParsedItem } from "../../../src/types/inventory.js";
import type { WfmOrder } from "../../../src/types/market.js";

const BASE_FILTERS: SharedFiltersState = {
  search: "",
  primeMode: "all",
  masteredMode: "all",
  sortBy: "name",
  sortDirection: "asc",
  orderPlaced: "all",
  mastered: "all",
  spares: "all",
  vaulted: "all",
  partType: "all",
  favorite: "all",
  minimumPlatinum: 0,
  minimumAmount: 0,
  equipped: "all",
  leveledUp: "all",
  subsumed: "all",
  foundryState: "all",
};

function order(overrides: Partial<WfmOrder>): WfmOrder {
  return {
    id: "0".repeat(24),
    orderType: "sell",
    platinum: 10,
    quantity: 1,
    visible: true,
    modRank: null,
    itemId: null,
    itemName: "Trinity Prime Chassis",
    itemUrlName: "trinity_prime_chassis",
    itemThumb: null,
    ...overrides,
  };
}

function parsedItem(overrides: Partial<ParsedItem>): ParsedItem {
  return {
    name: "Trinity Prime Chassis",
    amount: 3,
    ...overrides,
  } as ParsedItem;
}

describe("ownedCountForMarketOrder", () => {
  it("returns the inventory amount for a name match", () => {
    expect(ownedCountForMarketOrder(order({}), [parsedItem({})])).toBe(3);
  });

  it("falls back to the slug when display names differ", () => {
    const inventory = [parsedItem({ name: "Trinity Prime Chassis Blueprint" })];
    expect(ownedCountForMarketOrder(order({ itemName: "Chassis" }), inventory)).toBe(0);
    expect(
      ownedCountForMarketOrder(
        order({ itemUrlName: "trinity_prime_chassis_blueprint" }),
        inventory,
      ),
    ).toBe(3);
  });

  it("joins a renamed listing to the inventory through its game reference", () => {
    const gameRef = "/Lotus/Types/Keys/InfestedAladVQuest/AssassinateInfestedAladVKey";
    const wfmItems = {
      "mutalist alad v assassinate (key)": {
        url_name: "mutalist_alad_v_assassinate_key",
        gameRef,
      },
    };
    const inventory = [
      parsedItem({ name: "Mutalist Alad V Assassinate", internalName: gameRef, amount: 8 }),
    ];
    const listing = order({
      itemName: "Mutalist Alad V Assassinate (Key)",
      itemUrlName: "mutalist_alad_v_assassinate_key",
    });
    expect(ownedCountForMarketOrder(listing, inventory)).toBe(0);
    expect(ownedCountForMarketOrder(listing, inventory, wfmItems)).toBe(8);
  });

  it("returns 0 for items missing from the inventory", () => {
    expect(ownedCountForMarketOrder(order({ itemName: "Ash Prime Systems" }), [])).toBe(0);
  });

  it("counts flag-only ownership as 1", () => {
    const inventory = [
      parsedItem({ amount: undefined as unknown as number, currentlyOwned: true }),
    ];
    expect(ownedCountForMarketOrder(order({}), inventory)).toBe(1);
  });
});

describe("market order Owned sort", () => {
  it("ascending count surfaces owned-0 rows first and hides none", () => {
    const rows = [
      { name: "A", amount: 2, count: 5 },
      { name: "B", amount: 9, count: 0 },
      { name: "C", amount: 1, count: 2 },
    ];
    const sorted = applySharedFiltersAndSort(rows, {
      ...BASE_FILTERS,
      sortBy: "count",
      sortDirection: "asc",
    });
    expect(sorted.map((row) => row.name)).toEqual(["B", "C", "A"]);
  });
});
