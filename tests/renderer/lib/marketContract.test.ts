import { describe, expect, it } from "vitest";

import { contractInventoryMatch, matchRivenListings } from "../../../src/lib/marketContract.js";

function contract(overrides: Partial<Parameters<typeof contractInventoryMatch>[0]> = {}) {
  return {
    weaponUrlName: "rubico",
    rivenSuffix: "visi-critacan",
    modRank: 8,
    rerolls: null,
    masteryLevel: null,
    ...overrides,
  } as Parameters<typeof contractInventoryMatch>[0];
}

function riven(overrides: Partial<Parameters<typeof contractInventoryMatch>[1][number]> = {}) {
  return {
    weaponName: "Rubico",
    rivenName: "Rubico Visi-critacan",
    currentRank: 8,
    maxRank: 8,
    rerolls: 0,
    masteryReq: 16,
    ...overrides,
  } as Parameters<typeof contractInventoryMatch>[1][number];
}

describe("contractInventoryMatch", () => {
  it("matches a listing backed by the same riven at the same rank", () => {
    expect(contractInventoryMatch(contract(), [riven()])).toEqual({ state: "match" });
  });

  it("flags a listing whose riven is gone", () => {
    expect(
      contractInventoryMatch(contract(), [riven({ rivenName: "Rubico Croni-ampitis" })]),
    ).toEqual({ state: "missing" });
  });

  it("separates a levelled riven from a missing one", () => {
    expect(contractInventoryMatch(contract({ modRank: 5 }), [riven({ currentRank: 0 })])).toEqual({
      state: "rank-mismatch",
      ownedRank: 0,
    });
  });

  // The riven modal offers listing an unlevelled riven at its max rank, so the
  // rank it sends is the max, not the copy's own.
  it("accepts an unlevelled riven listed at its max rank", () => {
    expect(contractInventoryMatch(contract(), [riven({ currentRank: 0 })])).toEqual({
      state: "match",
    });
  });

  // The suffix comes from the buff tags, so one weapon can carry two rolls of
  // the same stats under one name.
  it("tells same-name twins apart by reroll count", () => {
    const listing = contract({ rerolls: 12, modRank: 0 });
    const twins = [riven({ currentRank: 0, rerolls: 0 }), riven({ currentRank: 8, rerolls: 12 })];
    expect(contractInventoryMatch(listing, twins)).toEqual({
      state: "rank-mismatch",
      ownedRank: 8,
    });
  });

  it("keeps the name set when no twin answers the stated reroll count", () => {
    const listing = contract({ rerolls: 12 });
    expect(contractInventoryMatch(listing, [riven({ rerolls: 3 })])).toEqual({ state: "match" });
  });

  it("accepts the family slug WFM lists rivens under", () => {
    const owned = riven({ weaponName: "Rubico Prime", rivenName: "Rubico Prime Visi-critacan" });
    expect(contractInventoryMatch(contract(), [owned])).toEqual({ state: "match" });
  });

  it("does not match the same suffix on another weapon", () => {
    const owned = riven({ weaponName: "Braton", rivenName: "Braton Visi-critacan" });
    expect(contractInventoryMatch(contract(), [owned])).toEqual({ state: "missing" });
  });

  it("ignores rank when the listing does not state one", () => {
    expect(
      contractInventoryMatch(contract({ modRank: null }), [riven({ currentRank: 3 })]),
    ).toEqual({ state: "match" });
  });

  it("stays silent when the listing carries no riven identity", () => {
    expect(contractInventoryMatch(contract({ rivenSuffix: null }), [])).toEqual({ state: "match" });
    expect(contractInventoryMatch(contract({ weaponUrlName: null }), [])).toEqual({
      state: "match",
    });
  });

  it("prefers any same-rank copy when duplicates are owned", () => {
    const rivens = [riven({ currentRank: 0 }), riven({ currentRank: 8 })];
    expect(contractInventoryMatch(contract(), rivens)).toEqual({ state: "match" });
  });

  // warframe.market slugs "Silva & Aegis" as silva_and_aegis, so an owned name
  // folded straight to underscores never met the listing it belongs to.
  it("matches a weapon warframe.market spells with 'and'", () => {
    const listing = contract({ weaponUrlName: "silva_and_aegis" });
    const owned = riven({
      weaponName: "Silva & Aegis",
      rivenName: "Silva & Aegis Visi-critacan",
    });
    expect(contractInventoryMatch(listing, [owned])).toEqual({ state: "match" });
  });

  it("matches an ampersand weapon through its family slug", () => {
    const listing = contract({ weaponUrlName: "silva_and_aegis" });
    const owned = riven({
      weaponName: "Silva & Aegis Prime",
      rivenName: "Silva & Aegis Prime Visi-critacan",
    });
    expect(contractInventoryMatch(listing, [owned])).toEqual({ state: "match" });
  });

  it("normalises the listing slug before comparing it", () => {
    const listing = contract({ weaponUrlName: "  Rubico  " });
    expect(contractInventoryMatch(listing, [riven()])).toEqual({ state: "match" });
  });
});

type Auction = Parameters<typeof matchRivenListings>[1][number] & { id: string };
type OwnedRiven = Parameters<typeof matchRivenListings>[0][number];

function statAttr(urlName: string, label = "", value = 100) {
  return { urlName, label, value, positive: true };
}

function ownedStat(name: string, displayValue = 100, maxRankValue = displayValue) {
  return {
    tag: name,
    name,
    displayValue,
    maxRankValue,
    rollFloat: 1,
    grade: "A",
    positive: true,
    multiplier: false,
  };
}

function auction(overrides: Partial<Auction> = {}): Auction {
  return {
    id: "auction-1",
    weaponUrlName: "rubico",
    rivenSuffix: "visi-critacan",
    modRank: 8,
    rerolls: null,
    masteryLevel: null,
    polarity: null,
    stats: [statAttr("critical_chance"), statAttr("damage_vs_corpus")],
    ...overrides,
  } as Auction;
}

function owned(overrides: Partial<OwnedRiven> = {}): OwnedRiven {
  return {
    itemId: "riven-1",
    weaponName: "Rubico",
    rivenName: "Rubico Visi-critacan",
    currentRank: 8,
    maxRank: 8,
    rerolls: 0,
    masteryReq: 16,
    polarity: "",
    stats: [ownedStat("Critical Chance"), ownedStat("Damage vs Corpus")],
    ...overrides,
  } as OwnedRiven;
}

describe("matchRivenListings", () => {
  it("marks the riven an auction lists", () => {
    const matched = matchRivenListings([owned()], [auction()]);
    expect(matched.get("riven-1")?.id).toBe("auction-1");
  });

  it("leaves an unlisted riven unmarked", () => {
    const matched = matchRivenListings([owned({ rivenName: "Rubico Croni-ampitis" })], [auction()]);
    expect(matched.size).toBe(0);
  });

  // WFM lists the whole family under the base slug, so the variant name has to
  // survive the join or a Prime copy would read as unlisted.
  it("survives a variant weapon name renamed on the WFM side", () => {
    const prime = owned({
      weaponName: "Rubico Prime",
      rivenName: "Rubico Prime Visi-critacan",
    });
    expect(matchRivenListings([prime], [auction()]).get("riven-1")?.id).toBe("auction-1");
  });

  it("matches a weapon warframe.market spells with 'and'", () => {
    const listing = auction({ weaponUrlName: "silva_and_aegis" });
    const mine = owned({
      weaponName: "Silva & Aegis",
      rivenName: "Silva & Aegis Visi-critacan",
    });
    expect(matchRivenListings([mine], [listing]).get("riven-1")?.id).toBe("auction-1");
  });

  it("does not cross weapons that share a suffix", () => {
    const mine = owned({ weaponName: "Braton", rivenName: "Braton Visi-critacan" });
    expect(matchRivenListings([mine], [auction()]).size).toBe(0);
  });

  it("ignores case and accents in the riven name", () => {
    const listing = auction({ rivenSuffix: "VISI-CRÍTACAN" });
    const mine = owned({ rivenName: "Rubico Visi-crítacan" });
    expect(matchRivenListings([mine], [listing]).get("riven-1")?.id).toBe("auction-1");
  });

  it("tolerates padding around the owned riven name", () => {
    const mine = owned({ rivenName: "  Rubico   Visi-critacan " });
    expect(matchRivenListings([mine], [auction()]).get("riven-1")?.id).toBe("auction-1");
  });

  it("falls back to the stat set when the auction lost its riven name", () => {
    const listing = auction({ rivenSuffix: null });
    expect(matchRivenListings([owned()], [listing]).get("riven-1")?.id).toBe("auction-1");
  });

  it("falls back to the stat set when the owned riven has no generated name", () => {
    const mine = owned({ rivenName: "Rubico" });
    expect(matchRivenListings([mine], [auction()]).get("riven-1")?.id).toBe("auction-1");
  });

  // The overlay alias table is the only bridge between "Attack Speed" on a melee
  // riven and the "fire rate" slug warframe.market stores.
  it("resolves aliased stat names in the fallback", () => {
    const listing = auction({
      rivenSuffix: null,
      stats: [statAttr("attack_speed"), statAttr("melee_damage")],
    });
    const mine = owned({
      rivenName: "Rubico",
      stats: [ownedStat("Fire Rate"), ownedStat("Damage")],
    });
    expect(matchRivenListings([mine], [listing]).get("riven-1")?.id).toBe("auction-1");
  });

  it("rejects the fallback when the stat sets differ", () => {
    const listing = auction({ rivenSuffix: null, stats: [statAttr("critical_chance")] });
    const mine = owned({ rivenName: "Rubico" });
    expect(matchRivenListings([mine], [listing]).size).toBe(0);
  });

  // "damage" is a substring of half the stat names, so a contained-in test would
  // pair "Damage vs Corpus" with the plain damage slug.
  it("does not pair stats by substring", () => {
    const listing = auction({ rivenSuffix: null, stats: [statAttr("damage_vs_corpus")] });
    const mine = owned({ rivenName: "Rubico", stats: [ownedStat("Damage")] });
    expect(matchRivenListings([mine], [listing]).size).toBe(0);
  });

  it("gives each auction its own riven when twins share a name", () => {
    const twins = [owned(), owned({ itemId: "riven-2" })];
    const listings = [auction(), auction({ id: "auction-2" })];
    const matched = matchRivenListings(twins, listings);
    expect(matched.get("riven-1")?.id).toBe("auction-1");
    expect(matched.get("riven-2")?.id).toBe("auction-2");
  });

  it("prefers the twin whose reroll count the auction states", () => {
    const twins = [owned({ rerolls: 0 }), owned({ itemId: "riven-2", rerolls: 12 })];
    const matched = matchRivenListings(twins, [auction({ rerolls: 12 })]);
    expect(matched.has("riven-1")).toBe(false);
    expect(matched.get("riven-2")?.id).toBe("auction-1");
  });

  // A riven rerolled after it was listed still carries the auction, so the
  // numeric hints must not be able to cancel a name match on their own.
  it("keeps the name match when no riven answers the stated reroll count", () => {
    const matched = matchRivenListings([owned({ rerolls: 3 })], [auction({ rerolls: 12 })]);
    expect(matched.get("riven-1")?.id).toBe("auction-1");
  });

  it("skips an auction with no weapon slug", () => {
    expect(matchRivenListings([owned()], [auction({ weaponUrlName: null })]).size).toBe(0);
  });

  // The suffix comes from the buff tags alone, so two rolls of the same stats
  // share a name and only the polarity or the numbers can separate them.
  it("gives each twin the auction carrying its own polarity", () => {
    const twins = [
      owned({ polarity: "AP_ATTACK" }),
      owned({ itemId: "riven-2", polarity: "AP_TACTIC" }),
    ];
    const listings = [
      auction({ polarity: "naramon" }),
      auction({ id: "auction-2", polarity: "madurai" }),
    ];
    const matched = matchRivenListings(twins, listings);
    expect(matched.get("riven-1")?.id).toBe("auction-2");
    expect(matched.get("riven-2")?.id).toBe("auction-1");
  });

  it("gives each twin the auction carrying its own stat rolls", () => {
    const twins = [
      owned({ stats: [ownedStat("Critical Chance", 120), ownedStat("Damage vs Corpus", 90)] }),
      owned({
        itemId: "riven-2",
        stats: [ownedStat("Critical Chance", 150), ownedStat("Damage vs Corpus", 90)],
      }),
    ];
    const listings = [
      auction({
        stats: [statAttr("critical_chance", "", 150), statAttr("damage_vs_corpus", "", 90)],
      }),
      auction({
        id: "auction-2",
        stats: [statAttr("critical_chance", "", 120), statAttr("damage_vs_corpus", "", 90)],
      }),
    ];
    const matched = matchRivenListings(twins, listings);
    expect(matched.get("riven-1")?.id).toBe("auction-2");
    expect(matched.get("riven-2")?.id).toBe("auction-1");
  });

  // The riven modal offers listing an unranked riven at max rank, so the auction
  // carries the rank-8 roll while the copy still shows its own.
  it("separates twins by the max-rank roll the auction was listed with", () => {
    const twins = [
      owned({ currentRank: 0, stats: [ownedStat("Critical Chance", 40, 120)] }),
      owned({ itemId: "riven-2", currentRank: 0, stats: [ownedStat("Critical Chance", 50, 150)] }),
    ];
    const listing = auction({ stats: [statAttr("critical_chance", "", 150)] });
    const matched = matchRivenListings(twins, [listing]);
    expect(matched.get("riven-2")?.id).toBe("auction-1");
    expect(matched.has("riven-1")).toBe(false);
  });

  // A riven left unmarked costs a badge, while marking the wrong twin can send
  // the user to remove the listing of the riven they meant to keep.
  it("marks neither twin when one auction cannot tell them apart", () => {
    const twins = [owned(), owned({ itemId: "riven-2" })];
    expect(matchRivenListings(twins, [auction()]).size).toBe(0);
  });

  it("marks neither twin when only the polarity is unknown on both sides", () => {
    const twins = [
      owned({ stats: [ownedStat("Critical Chance", 120)] }),
      owned({ itemId: "riven-2", stats: [ownedStat("Critical Chance", 120)] }),
    ];
    const listing = auction({ stats: [statAttr("critical_chance", "", 120)] });
    expect(matchRivenListings(twins, [listing]).size).toBe(0);
  });

  // Number(null) is 0, so an attribute WFM sent without a value used to demand a
  // zero roll and threw away the pairing the polarity had already settled.
  it("ignores an auction attribute that carries no value", () => {
    const twins = [
      owned({ polarity: "AP_ATTACK" }),
      owned({ itemId: "riven-2", polarity: "AP_TACTIC" }),
    ];
    const listing = auction({
      polarity: "madurai",
      stats: [{ urlName: "critical_chance", label: "", value: null, positive: true }],
    });
    expect(matchRivenListings(twins, [listing]).get("riven-1")?.id).toBe("auction-1");
  });

  // A single candidate is never rejected by a hint, the same way a stale reroll
  // count does not cancel a name match.
  it("keeps a lone name match the auction polarity disagrees with", () => {
    const mine = owned({ polarity: "AP_ATTACK" });
    const matched = matchRivenListings([mine], [auction({ polarity: "naramon" })]);
    expect(matched.get("riven-1")?.id).toBe("auction-1");
  });
});
