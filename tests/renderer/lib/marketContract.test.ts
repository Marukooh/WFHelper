import { describe, expect, it } from "vitest";

import { contractInventoryMatch } from "../../../src/lib/marketContract.js";

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
