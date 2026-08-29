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

  it("tells same-name twins apart by mastery requirement", () => {
    const listing = contract({ masteryLevel: 12, modRank: 0 });
    const twins = [
      riven({ currentRank: 0, masteryReq: 16 }),
      riven({ currentRank: 8, masteryReq: 12 }),
    ];
    expect(contractInventoryMatch(listing, twins)).toEqual({
      state: "rank-mismatch",
      ownedRank: 8,
    });
  });

  it("keeps the name set when no twin answers the stated reroll count", () => {
    const listing = contract({ rerolls: 12 });
    expect(contractInventoryMatch(listing, [riven({ rerolls: 3 })])).toEqual({ state: "match" });
  });

  it("keeps the name set when no twin answers the stated mastery requirement", () => {
    const listing = contract({ masteryLevel: 12 });
    expect(contractInventoryMatch(listing, [riven({ masteryReq: 16 })])).toEqual({
      state: "match",
    });
  });

  it("accepts the family slug WFM lists rivens under", () => {
    const owned = riven({ weaponName: "Rubico Prime", rivenName: "Rubico Prime Visi-critacan" });
    expect(contractInventoryMatch(contract(), [owned])).toEqual({ state: "match" });
  });

  // WFM strips the variant prefix as well: rivens for Kuva, Tenet, MK1 and
  // Prisma weapons are all listed under the base weapon's slug.
  it("accepts a family slug the variant prefix was stripped from", () => {
    const cases: Array<[string, string]> = [
      ["karak", "Kuva Karak"],
      ["envoy", "Tenet Envoy"],
      ["braton", "MK1-Braton"],
      ["obex", "Prisma Obex"],
      ["grakata", "Prisma Grakata"],
      ["gorgon", "Prisma Gorgon"],
    ];
    for (const [slug, weaponName] of cases) {
      const owned = riven({ weaponName, rivenName: `${weaponName} Visi-critacan` });
      expect(contractInventoryMatch(contract({ weaponUrlName: slug }), [owned])).toEqual({
        state: "match",
      });
    }
  });

  // A weapon whose base form was never made is its own WFM family, so the
  // unstripped slug has to keep matching.
  it("accepts a variant weapon that has no base form", () => {
    const owned = riven({ weaponName: "Kuva Bramma", rivenName: "Kuva Bramma Visi-critacan" });
    expect(contractInventoryMatch(contract({ weaponUrlName: "kuva_bramma" }), [owned])).toEqual({
      state: "match",
    });
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

  it("tolerates padding around the owned riven name", () => {
    expect(
      contractInventoryMatch(contract(), [riven({ rivenName: "  Rubico   Visi-critacan " })]),
    ).toEqual({ state: "match" });
  });
});

type Auction = Parameters<typeof matchRivenListings>[1][number] & { id: string };
type OwnedRiven = Parameters<typeof matchRivenListings>[0][number];

function statAttr(urlName: string, label = "", value = 100) {
  return { urlName, label, value, positive: true };
}

/** Owned stats carry the game's own label, so the tag is the only join key. */
function ownedStat(tag: string, name: string, displayValue = 100, maxRankValue = displayValue) {
  return {
    tag,
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
    stats: [
      ownedStat("WeaponCritChanceMod", "Critical Chance"),
      ownedStat("WeaponFactionDamageCorpus", "Damage to Corpus"),
    ],
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

  it("survives a variant prefix the WFM slug strips", () => {
    const cases: Array<[string, string]> = [
      ["karak", "Kuva Karak"],
      ["envoy", "Tenet Envoy"],
      ["braton", "MK1-Braton"],
      ["obex", "Prisma Obex"],
    ];
    for (const [slug, weaponName] of cases) {
      const mine = owned({ weaponName, rivenName: `${weaponName} Visi-critacan` });
      const listing = auction({ weaponUrlName: slug });
      expect(matchRivenListings([mine], [listing]).get("riven-1")?.id).toBe("auction-1");
    }
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

  // WFM's attribute slugs and the game's stat labels share no wording for the
  // elements, the factions or the two split stats, so the join runs on the
  // upgrade tag both sides carry.
  it("joins WFM attribute slugs to the labels the game shows", () => {
    const cases: Array<[string, string, string]> = [
      ["cold_damage", "WeaponFreezeDamageMod", "Cold"],
      ["heat_damage", "WeaponFireDamageMod", "Heat"],
      ["electric_damage", "WeaponElectricityDamageMod", "Electricity"],
      ["toxin_damage", "WeaponToxinDamageMod", "Toxin"],
      ["damage_vs_corpus", "WeaponFactionDamageCorpus", "Damage to Corpus"],
      ["damage_vs_grineer", "WeaponMeleeFactionDamageGrineer", "Damage to Grineer"],
      ["fire_rate_/_attack_speed", "WeaponFireRateMod", "Attack Speed"],
      ["base_damage_/_melee_damage", "WeaponMeleeDamageMod", "Melee Damage"],
      ["critical_chance_on_slide_attack", "SlideAttackCritChanceMod", "Slide Attack"],
      ["channeling_efficiency", "WeaponMeleeComboEfficiencyMod", "Heavy Attack Efficiency"],
    ];
    for (const [urlName, tag, label] of cases) {
      const listing = auction({ rivenSuffix: null, stats: [statAttr(urlName)] });
      const mine = owned({ rivenName: "Rubico", stats: [ownedStat(tag, label)] });
      expect(matchRivenListings([mine], [listing]).get("riven-1")?.id).toBe("auction-1");
    }
  });

  it("rejects the fallback when the stat sets differ", () => {
    const listing = auction({ rivenSuffix: null, stats: [statAttr("critical_chance")] });
    const mine = owned({ rivenName: "Rubico" });
    expect(matchRivenListings([mine], [listing]).size).toBe(0);
  });

  // "damage" is a substring of half the stat names, so a contained-in test would
  // pair "Damage to Corpus" with the plain damage slug.
  it("does not pair stats by substring", () => {
    const listing = auction({ rivenSuffix: null, stats: [statAttr("damage_vs_corpus")] });
    const mine = owned({
      rivenName: "Rubico",
      stats: [ownedStat("WeaponDamageAmountMod", "Damage")],
    });
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

  it("prefers the twin whose mastery requirement the auction states", () => {
    const twins = [owned({ masteryReq: 16 }), owned({ itemId: "riven-2", masteryReq: 12 })];
    const matched = matchRivenListings(twins, [auction({ masteryLevel: 12 })]);
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

  it("separates twins by a polarity only the shared table knows", () => {
    const twins = [
      owned({ polarity: "AP_POWER" }),
      owned({ itemId: "riven-2", polarity: "AP_WARD" }),
    ];
    const listings = [
      auction({ polarity: "unairu" }),
      auction({ id: "auction-2", polarity: "zenurik" }),
    ];
    const matched = matchRivenListings(twins, listings);
    expect(matched.get("riven-1")?.id).toBe("auction-2");
    expect(matched.get("riven-2")?.id).toBe("auction-1");
  });

  it("gives each twin the auction carrying its own stat rolls", () => {
    const twins = [
      owned({
        stats: [
          ownedStat("WeaponCritChanceMod", "Critical Chance", 120),
          ownedStat("WeaponFactionDamageCorpus", "Damage to Corpus", 90),
        ],
      }),
      owned({
        itemId: "riven-2",
        stats: [
          ownedStat("WeaponCritChanceMod", "Critical Chance", 150),
          ownedStat("WeaponFactionDamageCorpus", "Damage to Corpus", 90),
        ],
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
      owned({
        currentRank: 0,
        stats: [ownedStat("WeaponCritChanceMod", "Critical Chance", 40, 120)],
      }),
      owned({
        itemId: "riven-2",
        currentRank: 0,
        stats: [ownedStat("WeaponCritChanceMod", "Critical Chance", 50, 150)],
      }),
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
      owned({ stats: [ownedStat("WeaponCritChanceMod", "Critical Chance", 120)] }),
      owned({
        itemId: "riven-2",
        stats: [ownedStat("WeaponCritChanceMod", "Critical Chance", 120)],
      }),
    ];
    const listing = auction({ stats: [statAttr("critical_chance", "", 120)] });
    expect(matchRivenListings(twins, [listing]).size).toBe(0);
  });

  // More auctions than twins still proves each twin is listed; the surplus
  // auction belongs to a riven the candidate filter no longer reaches.
  it("marks every twin when the auctions outnumber them", () => {
    const twins = [owned(), owned({ itemId: "riven-2" })];
    const listings = [auction(), auction({ id: "auction-2" }), auction({ id: "auction-3" })];
    const matched = matchRivenListings(twins, listings);
    expect(new Set(matched.keys())).toEqual(new Set(["riven-1", "riven-2"]));
  });

  it("marks nothing when the twins outnumber the auctions", () => {
    const twins = [owned(), owned({ itemId: "riven-2" }), owned({ itemId: "riven-3" })];
    const listings = [auction(), auction({ id: "auction-2" })];
    expect(matchRivenListings(twins, listings).size).toBe(0);
  });

  it("marks the same rivens whichever order the auctions arrive in", () => {
    const twins = [owned(), owned({ itemId: "riven-2" })];
    const listings = [auction(), auction({ id: "auction-2" }), auction({ id: "auction-3" })];
    const forward = matchRivenListings(twins, listings);
    const reversed = matchRivenListings(twins, [...listings].reverse());
    expect(new Set(reversed.keys())).toEqual(new Set(forward.keys()));
  });

  // Number(null) is 0, so an attribute WFM sent without a value must not demand a
  // zero roll and throw away the pairing the polarity had already settled.
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
