import { describe, expect, it } from "vitest";

import { buildCodexRows, sortCodexRows } from "../../../src/lib/codexScans";
import { CODEX_EXTRA_INFO, CODEX_SCAN_REQUIREMENTS } from "../../../src/data/codexScanRequirements";

const BUTCHER = "/Lotus/Types/Enemies/Grineer/AIWeek/BladeSawman";
const TERRA_ELITE_CREWMAN = "/Lotus/Types/Enemies/Corpus/Venus/VenusHeavyEliteSpacemanAgent";
// The profile files this one under an /Avatars/ directory the wiki omits.
const TERRA_ELITE_CREWMAN_SCAN =
  "/Lotus/Types/Enemies/Corpus/Venus/Avatars/VenusHeavyEliteSpacemanAvatar";
const ROGUE_CONDROC =
  "/Lotus/Types/NeutralCreatures/Conservation/BirdOfPrey/UncommonBirdOfPreyAvatar";

describe("buildCodexRows", () => {
  it("ships a populated requirements table", () => {
    expect(Object.keys(CODEX_SCAN_REQUIREMENTS).length).toBeGreaterThan(500);
    expect(CODEX_SCAN_REQUIREMENTS[BUTCHER]).toMatchObject({
      name: "Butcher",
      scans: 20,
      faction: "grineer",
    });
  });

  it("matches profile avatar paths against wiki agent paths", () => {
    const rows = buildCodexRows([{ type: `${BUTCHER}Avatar`, count: 20 }]);
    const butcher = rows.find((row) => row.type === BUTCHER);
    expect(butcher).toMatchObject({ name: "Butcher", scanned: 20, required: 20, complete: true });
  });

  it("matches through the profile's extra /Avatars/ directory", () => {
    const rows = buildCodexRows([{ type: TERRA_ELITE_CREWMAN_SCAN, count: 3087 }]);
    expect(rows.find((row) => row.type === TERRA_ELITE_CREWMAN)).toMatchObject({
      name: "Terra Elite Crewman",
      scanned: 3087,
      complete: true,
    });
    // No leftover row under the raw internal name.
    expect(rows.some((row) => row.name.startsWith("Venus Heavy Elite"))).toBe(false);
  });

  it("keeps tileset variants apart instead of folding them into the base", () => {
    const rows = buildCodexRows([
      { type: "/Lotus/Types/Enemies/Grineer/Desert/Avatars/RifleLancerAvatar", count: 9 },
    ]);
    expect(rows.find((row) => row.name === "Arid Lancer")?.scanned).toBe(9);
    expect(rows.find((row) => row.name === "Lancer")?.scanned).toBe(0);
  });

  it("a scan feeds only the wiki entry it matches at the strictest level", () => {
    // Both Nightwatch gunners share one loose stem; the /Avatars/ path is
    // Bombard's own key, so Gunner must stay untouched.
    const rows = buildCodexRows([
      {
        type: "/Lotus/Types/Enemies/Grineer/AIWeek/Avatars/NightwatchHeavyGunnerAvatar",
        count: 3,
      },
    ]);
    expect(rows.find((row) => row.name === "Nightwatch Bombard")).toMatchObject({
      scanned: 3,
      complete: true,
    });
    expect(rows.find((row) => row.name === "Nightwatch Gunner")).toMatchObject({
      scanned: 0,
      complete: false,
    });
  });

  it("suffix twins that are different enemies never share one scan count", () => {
    const rows = buildCodexRows([
      {
        type: "/Lotus/Types/Enemies/Grineer/InfestedMicroPlanet/GrineerShotgunSurvivorAvatar",
        count: 10,
      },
    ]);
    expect(rows.find((row) => row.name === "Trooper Survivor")).toMatchObject({
      scanned: 10,
      complete: true,
    });
    expect(rows.find((row) => row.name === "Lancer Survivor")).toMatchObject({ scanned: 0 });
  });

  it("same-name extras with different requirements stay separate rows", () => {
    const rows = buildCodexRows([]);
    const sacs = rows.filter((row) => row.name === "Mytocardia Sac");
    expect(sacs.map((row) => row.required).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([5, 12]);
  });

  it("an extras entry's leader scans surface as their own Eximus row", () => {
    const rows = buildCodexRows([
      { type: ROGUE_CONDROC, count: 20 },
      { type: `${ROGUE_CONDROC}Leader`, count: 7 },
    ]);
    expect(rows.find((row) => row.name === "Rogue Condroc")?.scanned).toBe(20);
    expect(rows.find((row) => row.name === "Rogue Condroc Eximus")?.scanned).toBe(7);
  });

  it("splits leader avatars into their own Eximus entry", () => {
    const rows = buildCodexRows([
      { type: `${BUTCHER}Avatar`, count: 20 },
      { type: `${BUTCHER}AvatarLeader`, count: 3 },
    ]);
    expect(rows.find((row) => row.name === "Butcher")).toMatchObject({ scanned: 20 });
    expect(rows.find((row) => row.name === "Butcher Eximus")).toMatchObject({
      scanned: 3,
      required: 20,
      complete: false,
    });
  });

  it("omits the Eximus row when the profile reports no leader scans", () => {
    const rows = buildCodexRows([{ type: `${BUTCHER}Avatar`, count: 20 }]);
    expect(rows.some((row) => row.name === "Butcher Eximus")).toBe(false);
  });

  it("lists never-scanned enemies at zero", () => {
    const rows = buildCodexRows([]);
    const butcher = rows.find((row) => row.type === BUTCHER);
    expect(butcher).toMatchObject({ scanned: 0, complete: false });
    expect(rows.length).toBeGreaterThan(500);
  });

  it("seeds codex extras so unscanned fragments and wildlife still list", () => {
    const rows = buildCodexRows([]);
    expect(Object.keys(CODEX_EXTRA_INFO).length).toBeGreaterThan(500);
    expect(rows.find((row) => row.name === "Rogue Condroc")).toMatchObject({
      scanned: 0,
      faction: "wildlife",
      complete: false,
    });
    expect(rows.filter((row) => row.faction === "lore").length).toBeGreaterThan(100);
  });

  it("completes conservation rows, which DE's export gives no requirement", () => {
    const rows = buildCodexRows([{ type: ROGUE_CONDROC, count: 20 }]);
    expect(rows.find((row) => row.name === "Rogue Condroc")).toMatchObject({
      scanned: 20,
      required: 20,
      complete: true,
    });
  });

  it("collapses a creature's male, female and base avatars into one row", () => {
    const rows = buildCodexRows([{ type: ROGUE_CONDROC, count: 20 }]);
    expect(rows.filter((row) => row.name === "Rogue Condroc")).toHaveLength(1);
  });

  it("appends scanned enemies the table does not know with a readable name", () => {
    const rows = buildCodexRows([{ type: "/Lotus/Types/Enemies/New/UnknownBossAvatar", count: 2 }]);
    const unknown = rows.find((row) => row.type === "/Lotus/Types/Enemies/New/UnknownBossAvatar");
    expect(unknown).toMatchObject({
      name: "Unknown Boss",
      scanned: 2,
      required: null,
      complete: null,
    });
  });

  it("keeps an unknown enemy's leader scans off its base row", () => {
    const rows = buildCodexRows([
      { type: "/Lotus/Types/Enemies/New/UnknownBossAvatar", count: 2 },
      { type: "/Lotus/Types/Enemies/New/UnknownBossAvatarLeader", count: 7 },
    ]);
    expect(rows.find((row) => row.name === "Unknown Boss")?.scanned).toBe(2);
    expect(rows.find((row) => row.name === "Unknown Boss Eximus")?.scanned).toBe(7);
  });

  it("gives every row a unique key so keyed rendering cannot collide", () => {
    const rows = buildCodexRows([
      { type: `${BUTCHER}Avatar`, count: 20 },
      { type: `${BUTCHER}AvatarLeader`, count: 3 },
    ]);
    expect(new Set(rows.map((row) => row.type)).size).toBe(rows.length);
  });

  it("sorts rows by display name", () => {
    const rows = buildCodexRows([]);
    const names = rows.map((row) => row.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });
});

describe("sortCodexRows", () => {
  const rows = buildCodexRows([
    { type: `${BUTCHER}Avatar`, count: 15 },
    { type: "/Lotus/Types/Enemies/New/UnknownBossAvatar", count: 99 },
  ]);

  it("scans puts the highest raw counts first", () => {
    const sorted = sortCodexRows(rows, "scans");
    expect(sorted[0].scanned).toBe(99);
    expect(sorted[1].name).toBe("Butcher");
  });

  it("progress ranks partial completion above zero and unknown last", () => {
    const sorted = sortCodexRows(rows, "progress");
    const butcherIdx = sorted.findIndex((row) => row.name === "Butcher");
    const zeroIdx = sorted.findIndex((row) => row.scanned === 0);
    expect(butcherIdx).toBeLessThan(zeroIdx);

    const firstUnknown = sorted.findIndex((row) => row.required === null);
    expect(firstUnknown).toBeGreaterThan(-1);
    expect(sorted.slice(firstUnknown).every((row) => row.required === null)).toBe(true);
  });

  it("name sorts alphabetically whatever order it is handed", () => {
    const shuffled = sortCodexRows(rows, "scans");
    const sorted = sortCodexRows(shuffled, "name");
    expect(sorted.map((row) => row.name)).toEqual(
      [...shuffled.map((row) => row.name)].sort((a, b) => a.localeCompare(b)),
    );
  });
});

describe("codex entries whose scan lands on a world prop", () => {
  // Real paths and counts from an affected player's profile: the in-game codex
  // showed these fully scanned while the app reported 0.
  it("credits an Ayatan sculpture scanned on its deco prop", () => {
    const rows = buildCodexRows([
      { type: "/Lotus/Objects/Gameplay/OroFusexADeco", count: 1 },
      { type: "/Lotus/Objects/Gameplay/OroFusexBDeco", count: 3 },
    ]);
    expect(rows.find((row) => row.name === "Ayatan Sah Sculpture")).toMatchObject({
      scanned: 1,
      required: 1,
      complete: true,
    });
    expect(rows.find((row) => row.name === "Ayatan Ayr Sculpture")).toMatchObject({
      scanned: 3,
      complete: true,
    });
  });

  it("credits an Ayatan star scanned on its deco prop", () => {
    const rows = buildCodexRows([
      { type: "/Lotus/Objects/Gameplay/OroFusexOrnamentADeco", count: 5 },
    ]);
    expect(rows.find((row) => row.name === "Ayatan Cyan Star")).toMatchObject({
      scanned: 5,
      required: 5,
      complete: true,
    });
    expect(rows.find((row) => row.name === "Ayatan Amber Star")?.scanned).toBe(0);
  });

  it("credits a lore fragment scanned on its deco prop", () => {
    const rows = buildCodexRows([
      {
        type: "/Lotus/Types/Lore/Fragments/SolarisFragments/EudicoLoreFragmentBDeco",
        count: 1,
      },
    ]);
    const fragment = rows.find(
      (row) => row.type === "/Lotus/Types/Lore/Fragments/SolarisFragments/EudicoLoreFragmentB",
    );
    expect(fragment).toMatchObject({ scanned: 1, complete: true });
  });

  it("leaves an unrelated gameplay prop alone", () => {
    const rows = buildCodexRows([
      { type: "/Lotus/Objects/Gameplay/CollectibleSeriesOneDeco", count: 4 },
    ]);
    const ayatan = rows.filter((row) => row.name.startsWith("Ayatan"));
    expect(ayatan.length).toBeGreaterThan(0);
    expect(ayatan.every((row) => row.scanned === 0)).toBe(true);
  });
});

describe("plants", () => {
  it("names a plant scan from the pickup item it disagrees with", () => {
    const rows = buildCodexRows([
      { type: "/Lotus/Types/Items/Plants/NightCommonPlant", count: 670 },
      { type: "/Lotus/Types/Items/Plants/DayRarePlant", count: 52 },
    ]);
    expect(rows.find((row) => row.name === "Moonlight Threshcone")).toMatchObject({
      scanned: 670,
      faction: "objects",
    });
    expect(rows.find((row) => row.name === "Sunlight Jadeleaf")).toMatchObject({ scanned: 52 });
  });

  it("leaves plant completion unknown, since no source states a requirement", () => {
    const rows = buildCodexRows([]);
    const plant = rows.find((row) => row.name === "Lunar Pitcher");
    expect(plant).toMatchObject({ scanned: 0, required: null, complete: null });
  });

  it("lists every plant the in-game codex shows", () => {
    const names = new Set(buildCodexRows([]).map((row) => row.name));
    for (const plant of [
      "Sunlight Threshcone",
      "Moonlight Threshcone",
      "Sunlight Dragonlily",
      "Moonlight Dragonlily",
      "Sunlight Jadeleaf",
      "Moonlight Jadeleaf",
      "Vestan Moss",
      "Lunar Pitcher",
      "Frostleaf",
      "Dusklight Sarracenia",
      "Ruk's Claw",
    ]) {
      expect(names.has(plant)).toBe(true);
    }
  });
});
