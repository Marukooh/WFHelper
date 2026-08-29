import { describe, expect, it } from "vitest";

import {
  computeInventoryValueTotals,
  isCountedForValue,
  selectValueStripRows,
  type InventoryValueTotals,
} from "../../../../src/lib/inventory/valueTotals.js";
import type { InventoryViewItem } from "../../../../src/lib/inventoryMarket.js";

type Row = Parameters<typeof isCountedForValue>[0];

function row(overrides: Partial<Row> = {}): Row {
  return {
    inventoryGroup: "all_parts",
    partType: "prime",
    isPrime: true,
    tradable: true,
    amount: 1,
    marketSlug: "mesa_prime_systems",
    platinum: 10,
    ducats: 45,
    ...overrides,
  };
}

describe("computeInventoryValueTotals", () => {
  it("multiplies the median and the ducat value by the stack size", () => {
    const totals = computeInventoryValueTotals([row({ amount: 3 })], "prime");
    expect(totals.platinum).toBe(30);
    expect(totals.ducats).toBe(135);
    expect(totals.counted).toBe(1);
    expect(totals.platinumUnpriced).toBe(0);
    expect(totals.ducatsUnpriced).toBe(0);
  });

  it("treats a missing amount as one copy", () => {
    const totals = computeInventoryValueTotals([row({ amount: null })], "prime");
    expect(totals.platinum).toBe(10);
    expect(totals.counted).toBe(1);
  });

  it("ignores zero and negative stacks entirely", () => {
    const totals = computeInventoryValueTotals(
      [row({ amount: 0 }), row({ amount: -4 }), row({ amount: Number.NaN })],
      "prime",
    );
    expect(totals).toEqual({
      platinum: 0,
      ducats: 0,
      platinumUnpriced: 0,
      ducatsUnpriced: 0,
      unpriced: 0,
      counted: 0,
    });
  });

  it("counts a fractional amount as one copy instead of dropping the row", () => {
    const totals = computeInventoryValueTotals([row({ amount: 0.5 })], "prime");
    expect(totals.counted).toBe(1);
    expect(totals.platinum).toBe(10);
    expect(totals.ducats).toBe(45);
  });

  it("still reports an unpriced fractional row as a hole", () => {
    const totals = computeInventoryValueTotals(
      [row({ amount: 0.5, platinum: null, ducats: null })],
      "prime",
    );
    expect(totals.counted).toBe(1);
    expect(totals.platinumUnpriced).toBe(1);
    expect(totals.unpriced).toBe(1);
  });

  it("counts holes instead of guessing a price", () => {
    const totals = computeInventoryValueTotals(
      [
        row({ amount: 2 }),
        row({ marketSlug: "volt_prime_chassis", platinum: null, ducats: null, amount: 5 }),
        row({ marketSlug: "ash_prime_blueprint", platinum: 0, ducats: 0 }),
      ],
      "prime",
    );
    expect(totals.platinum).toBe(20);
    expect(totals.ducats).toBe(90);
    expect(totals.platinumUnpriced).toBe(2);
    expect(totals.ducatsUnpriced).toBe(2);
    // Both holes sit on the same two rows, so the strip hints "2", not "4".
    expect(totals.unpriced).toBe(2);
    expect(totals.counted).toBe(3);
  });

  it("counts a row once when only one of its two prices is missing", () => {
    const totals = computeInventoryValueTotals(
      [row({ platinum: null }), row({ marketSlug: "volt_prime_chassis", ducats: null })],
      "prime",
    );
    expect(totals.platinumUnpriced).toBe(1);
    expect(totals.ducatsUnpriced).toBe(1);
    expect(totals.unpriced).toBe(2);
  });

  it("skips slugs with no warframe.market listing", () => {
    const totals = computeInventoryValueTotals(
      [
        row({
          inventoryGroup: "misc",
          partType: "normal",
          isPrime: false,
          marketSlug: "vendor_relic",
        }),
        row({
          inventoryGroup: "misc",
          partType: "normal",
          isPrime: false,
          marketSlug: "corpus_hangar_scene",
        }),
      ],
      "tradable",
    );
    expect(totals.counted).toBe(0);
    expect(totals.platinum).toBe(0);
  });

  it("skips rows with no slug and rows flagged non-tradable", () => {
    const totals = computeInventoryValueTotals(
      [row({ marketSlug: null }), row({ marketSlug: "" }), row({ tradable: false })],
      "tradable",
    );
    expect(totals.counted).toBe(0);
  });

  it("never counts set rows, which aggregate parts already counted", () => {
    const totals = computeInventoryValueTotals(
      [
        row({ inventoryGroup: "full_sets", marketSlug: "mesa_prime_set", platinum: 300 }),
        row({ inventoryGroup: "incomplete_sets", marketSlug: "volt_prime_set", platinum: 120 }),
      ],
      "tradable",
    );
    expect(totals.counted).toBe(0);
    expect(totals.platinum).toBe(0);
  });

  it("keeps non-prime rows out of the default scope", () => {
    const mod = row({
      inventoryGroup: "mods",
      partType: "normal",
      isPrime: false,
      marketSlug: "serration",
      platinum: 12,
      ducats: null,
      amount: 2,
    });
    expect(computeInventoryValueTotals([mod], "prime").counted).toBe(0);

    const wide = computeInventoryValueTotals([mod], "tradable");
    expect(wide.platinum).toBe(24);
    expect(wide.counted).toBe(1);
    // A mod has no ducat value, so its null is not a hole.
    expect(wide.ducatsUnpriced).toBe(0);
  });

  it("keeps prime gear out of the default scope but sums it when widened", () => {
    const gear = row({ inventoryGroup: "equipment", marketSlug: "mesa_prime", platinum: 40 });
    expect(computeInventoryValueTotals([gear], "prime").counted).toBe(0);
    expect(computeInventoryValueTotals([gear], "tradable").platinum).toBe(40);
  });

  it("accepts a real inventory view item shape", () => {
    const item = {
      inventoryGroup: "all_parts",
      partType: "prime",
      isPrime: true,
      tradable: true,
      amount: 2,
      marketSlug: "mesa_prime_systems",
      platinum: 15,
      ducats: 45,
    } satisfies Partial<InventoryViewItem>;
    expect(computeInventoryValueTotals([item], "prime").platinum).toBe(30);
  });
});

describe("view scoping", () => {
  const PRIME_PART = row({ marketSlug: "mesa_prime_systems", platinum: 20, ducats: 45, amount: 2 });
  const RELIC = row({
    inventoryGroup: "relics",
    partType: "normal",
    isPrime: false,
    marketSlug: "meso_n11_relic",
    platinum: 5,
    ducats: null,
    amount: 3,
  });
  const MOD = row({
    inventoryGroup: "mods",
    partType: "normal",
    isPrime: false,
    marketSlug: "serration",
    platinum: 30,
    ducats: null,
  });
  const ARCANE = row({
    inventoryGroup: "arcanes",
    partType: "normal",
    isPrime: false,
    marketSlug: "arcane_energize",
    platinum: 100,
    ducats: null,
  });
  const EVERYTHING = [PRIME_PART, RELIC, MOD, ARCANE];

  /** Mirrors the tab and Everything-chip gate the view applies before the totals. */
  function inView(groups: readonly string[]): Row[] {
    return EVERYTHING.filter((entry) => groups.includes(entry.inventoryGroup ?? ""));
  }

  it("values one tab at a time", () => {
    expect(computeInventoryValueTotals(inView(["mods"]), "tradable").platinum).toBe(30);
    expect(computeInventoryValueTotals(inView(["relics"]), "tradable").platinum).toBe(15);
    expect(computeInventoryValueTotals(inView(["all_parts"]), "tradable").platinum).toBe(40);
  });

  it("drops a source the Everything chips turned off", () => {
    const all = computeInventoryValueTotals(EVERYTHING, "tradable");
    expect(all.platinum).toBe(185);
    expect(all.counted).toBe(4);

    const withoutArcanes = computeInventoryValueTotals(
      inView(["all_parts", "relics", "mods"]),
      "tradable",
    );
    expect(withoutArcanes.platinum).toBe(85);
    expect(withoutArcanes.counted).toBe(3);
  });

  it("counts nothing on a tab the prime scope excludes", () => {
    expect(computeInventoryValueTotals(inView(["mods"]), "prime").counted).toBe(0);
    expect(computeInventoryValueTotals(inView(["all_parts"]), "prime").platinum).toBe(40);
  });

  it("keeps ducats to the prime parts even when the whole tab is valued", () => {
    const all = computeInventoryValueTotals(EVERYTHING, "tradable");
    expect(all.ducats).toBe(90);
    expect(all.ducatsUnpriced).toBe(0);
  });
});

describe("minimum platinum floor", () => {
  const CHEAP_MOD = row({
    inventoryGroup: "mods",
    partType: "normal",
    isPrime: false,
    marketSlug: "quickdraw",
    platinum: 4,
    ducats: null,
    amount: 4263,
  });
  const PRICEY_PART = row({ marketSlug: "mesa_prime_systems", platinum: 40, ducats: 45 });

  it("matches today's behaviour at a floor of zero", () => {
    const entries = [CHEAP_MOD, PRICEY_PART];
    expect(computeInventoryValueTotals(entries, "tradable", 0)).toEqual(
      computeInventoryValueTotals(entries, "tradable"),
    );
  });

  it("drops a row whose per-unit median is below the floor", () => {
    const totals = computeInventoryValueTotals([CHEAP_MOD, PRICEY_PART], "tradable", 5);
    expect(totals.platinum).toBe(40);
    expect(totals.counted).toBe(1);
  });

  it("keeps a row at or above the floor", () => {
    expect(computeInventoryValueTotals([PRICEY_PART], "tradable", 40).counted).toBe(1);
    expect(computeInventoryValueTotals([PRICEY_PART], "tradable", 41).counted).toBe(0);
  });

  it("compares the per-unit median, not the stack total", () => {
    // 4,263 x 4p is 17,052p of stock that nobody buys; the floor still drops it.
    expect(computeInventoryValueTotals([CHEAP_MOD], "tradable").platinum).toBe(17_052);
    expect(computeInventoryValueTotals([CHEAP_MOD], "tradable", 5).platinum).toBe(0);
    expect(computeInventoryValueTotals([CHEAP_MOD], "tradable", 5).counted).toBe(0);
  });

  it("keeps unpriced rows so the floor never hides the hint", () => {
    const unpriced = row({ marketSlug: "volt_prime_chassis", platinum: null, ducats: 15 });
    const zeroPriced = row({ marketSlug: "ash_prime_blueprint", platinum: 0, ducats: 15 });
    const totals = computeInventoryValueTotals(
      [CHEAP_MOD, unpriced, zeroPriced, PRICEY_PART],
      "tradable",
      15,
    );
    expect(totals.counted).toBe(3);
    expect(totals.platinumUnpriced).toBe(2);
    expect(totals.unpriced).toBe(2);
    expect(totals.platinum).toBe(40);
  });

  it("drops the ducats of an excluded row along with its platinum", () => {
    const cheapPart = row({ marketSlug: "volt_prime_chassis", platinum: 2, ducats: 15 });
    const kept = computeInventoryValueTotals([cheapPart, PRICEY_PART], "prime");
    expect(kept.ducats).toBe(60);

    const floored = computeInventoryValueTotals([cheapPart, PRICEY_PART], "prime", 5);
    expect(floored.ducats).toBe(45);
    expect(floored.ducatsUnpriced).toBe(0);
  });

  it("applies to both scopes the same way", () => {
    const entries = [CHEAP_MOD, PRICEY_PART];
    expect(computeInventoryValueTotals(entries, "prime", 5).counted).toBe(1);
    expect(computeInventoryValueTotals(entries, "tradable", 5).counted).toBe(1);
  });
});

describe("selectValueStripRows", () => {
  function totals(counted: number): InventoryValueTotals {
    return {
      platinum: counted * 10,
      ducats: 0,
      platinumUnpriced: 0,
      ducatsUnpriced: 0,
      unpriced: 0,
      counted,
    };
  }

  it("shows one figure when the view covers the whole inventory", () => {
    expect(selectValueStripRows(totals(12), totals(12))).toEqual(["inView"]);
  });

  it("adds the inventory figure when filters narrow the view", () => {
    expect(selectValueStripRows(totals(3), totals(12))).toEqual(["inView", "inventory"]);
  });

  it("falls back to the inventory figure instead of printing zeros", () => {
    expect(selectValueStripRows(totals(0), totals(12))).toEqual(["inventory"]);
  });

  it("shows nothing when there is no sellable stock at all", () => {
    expect(selectValueStripRows(totals(0), totals(0))).toEqual([]);
  });
});

describe("isCountedForValue", () => {
  it("gates the same way the totals do, so callers can prefilter", () => {
    expect(isCountedForValue(row(), "prime")).toBe(true);
    expect(isCountedForValue(row({ isPrime: false, partType: "normal" }), "prime")).toBe(false);
    expect(isCountedForValue(row({ isPrime: false, partType: "normal" }), "tradable")).toBe(true);
    expect(isCountedForValue(row({ inventoryGroup: "full_sets" }), "tradable")).toBe(false);
  });
});
