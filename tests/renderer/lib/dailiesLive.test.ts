import { describe, expect, it } from "vitest";

import type { Translator } from "../../../src/lib/i18n.js";
import { trackerExpiries, trackerLive } from "../../../src/lib/world/dailiesLive.js";
import type { WorldState } from "../../../src/types/world.js";

const NOW = Date.parse("2026-08-24T12:00:00Z");

// Echoes the key and its params so assertions pin structure, not English copy.
const t: Translator = (key, params) =>
  params
    ? `${key}(${Object.entries(params)
        .map(([name, value]) => `${name}=${String(value)}`)
        .join(",")})`
    : key;

function world(overrides: Partial<WorldState>): WorldState {
  return overrides as WorldState;
}

describe("trackerExpiries", () => {
  it("maps each expiry-driven period to its world-state window", () => {
    const wd = world({
      sortie: { expiry: "2026-08-24T16:00:00Z" },
      archonHunt: {
        activation: "2026-08-17T00:00:00Z",
        expiry: "2026-08-31T00:00:00Z",
        boss: "Nira",
        missions: [],
      },
      steelPath: {
        currentReward: { name: "Umbra Forma", cost: 150 },
        expiry: "2026-08-30T00:00:00Z",
        rotation: [],
        evergreens: [],
      },
      voidTrader: { activation: "2026-08-28T14:00:00Z", expiry: "2026-08-30T14:00:00Z" },
      vaultTrader: { activation: "2026-08-01T00:00:00Z", expiry: "2026-09-01T00:00:00Z" },
      dailyDeals: [{ expiry: "2026-08-24T20:00:00Z" }],
    });

    expect(trackerExpiries(wd)).toEqual({
      sortie: "2026-08-24T16:00:00Z",
      archon: "2026-08-31T00:00:00Z",
      steelPath: "2026-08-30T00:00:00Z",
      baro: "2026-08-28T14:00:00Z",
      darvo: "2026-08-24T20:00:00Z",
      varzia: "2026-08-01T00:00:00Z",
    });
  });

  it("returns nulls when the world state is missing", () => {
    expect(trackerExpiries(null)).toEqual({
      sortie: null,
      archon: null,
      steelPath: null,
      baro: null,
      darvo: null,
      varzia: null,
    });
  });
});

describe("trackerLive", () => {
  it("returns nothing without world data", () => {
    expect(trackerLive("sortie", null, t, NOW)).toEqual({});
  });

  it("returns nothing for an id it does not decorate", () => {
    expect(trackerLive("netracells", world({}), t, NOW)).toEqual({});
  });

  it("lists the sortie boss and its three missions", () => {
    const wd = world({
      sortie: {
        expiry: "2026-08-24T16:00:00Z",
        boss: "Lephantis",
        missions: [
          { node: "Pacific (Earth)", mission: "Survival", modifier: "Augmented Enemy Armor" },
          { node: "Baal (Europa)", mission: "Mobile Defense", modifier: "Viral Enhancement" },
          { node: "Hepit (Void)", mission: "Assassination", modifier: "Pistol Only" },
        ],
      },
    });

    const live = trackerLive("sortie", wd, t, NOW);

    expect(live.detail).toBe("dailies.boss(name=Lephantis)");
    expect(live.lines).toEqual([
      "Survival - Pacific (Earth) - Augmented Enemy Armor",
      "Mobile Defense - Baal (Europa) - Viral Enhancement",
      "Assassination - Hepit (Void) - Pistol Only",
    ]);
    expect(live.expiry).toBe("2026-08-24T16:00:00Z");
  });

  it("falls back to an empty archon hunt when the game has none", () => {
    expect(trackerLive("archonHunt", world({ archonHunt: null }), t, NOW)).toEqual({});
  });

  it("lists archon hunt missions without a modifier column", () => {
    const wd = world({
      archonHunt: {
        activation: "2026-08-17T00:00:00Z",
        expiry: "2026-08-31T00:00:00Z",
        boss: "Nira",
        missions: [
          { node: "Arval (Mars)", mission: "Extermination" },
          { node: "War (Mars)", mission: "Assassination" },
        ],
      },
    });

    const live = trackerLive("archonHunt", wd, t, NOW);

    expect(live.detail).toBe("dailies.boss(name=Nira)");
    expect(live.lines).toEqual(["Extermination - Arval (Mars)", "Assassination - War (Mars)"]);
  });

  it("names this week's circuit rewards per difficulty", () => {
    const wd = world({
      duviriCycle: {
        choices: [
          { category: "normal", choices: ["Nidus", "Octavia", "Harrow"] },
          { category: "hard", choices: ["Vectis", "Stug"] },
        ],
      },
    });

    expect(trackerLive("circuitNormal", wd, t, NOW).detail).toBe("Nidus - Octavia - Harrow");
    expect(trackerLive("circuitSteelPath", wd, t, NOW).detail).toBe("Vectis - Stug");
    expect(trackerLive("circuitNormal", world({}), t, NOW)).toEqual({});
  });

  it("shows the current Steel Path honor and its essence cost", () => {
    const wd = world({
      steelPath: {
        currentReward: { name: "Umbra Forma", cost: 150 },
        expiry: "2026-08-30T00:00:00Z",
        rotation: [],
        evergreens: [],
      },
    });

    const live = trackerLive("steelPathHonors", wd, t, NOW);

    expect(live.detail).toBe("Umbra Forma - world.steelEssenceCost(cost=150)");
    expect(live.expiry).toBe("2026-08-30T00:00:00Z");
  });

  it("counts Baro's offers while he is here and counts down to his arrival otherwise", () => {
    const here = world({
      voidTrader: {
        activation: "2026-08-24T00:00:00Z",
        expiry: "2026-08-26T00:00:00Z",
        location: "Orcus Relay (Pluto)",
        inventory: [{ item: "Prisma Gorgon" }, { item: "Primed Fury" }],
      },
    });
    const away = world({
      voidTrader: {
        activation: "2026-09-04T14:00:00Z",
        expiry: "2026-09-06T14:00:00Z",
        location: "Larunda Relay (Mercury)",
        inventory: [],
      },
    });

    const arrived = trackerLive("baro", here, t, NOW);
    expect(arrived.detail).toBe(
      "dailies.baroHere(location=Orcus Relay (Pluto)) - dailies.itemCount(count=2)",
    );
    expect(arrived.expiry).toBe("2026-08-26T00:00:00Z");

    const pending = trackerLive("baro", away, t, NOW);
    expect(pending.detail).toBe("dailies.baroAway(location=Larunda Relay (Mercury))");
    expect(pending.expiry).toBe("2026-09-04T14:00:00Z");
  });

  it("summarises Darvo's deal with its discount and stock", () => {
    const wd = world({
      dailyDeals: [
        {
          item: "Vasto",
          salePrice: 114,
          originalPrice: 190,
          discount: 40,
          sold: 80,
          total: 100,
          expiry: "2026-08-24T20:00:00Z",
        },
      ],
    });

    const live = trackerLive("darvo", wd, t, NOW);

    expect(live.detail).toBe("Vasto - 114p (-40%) - world.soldOfTotal(sold=80,total=100)");
    expect(live.expiry).toBe("2026-08-24T20:00:00Z");
  });

  it("skips Darvo entirely when no deal is running", () => {
    expect(trackerLive("darvo", world({ dailyDeals: [] }), t, NOW)).toEqual({});
  });
});
