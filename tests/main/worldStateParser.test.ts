import { describe, expect, it } from "vitest";

import * as parser from "../../services/worldStateParser";

// parseRaw returns Record<string, unknown>; shape only what these tests read.
interface ParsedWorldState {
  fissures: Array<{ tier: string; missionType: string; isStorm?: boolean }>;
  voidTrader?: { location?: string };
  vaultTrader?: { location?: string };
  sortie?: { expiry?: string };
}
const parseRaw = (raw: Parameters<typeof parser.parseRaw>[0]) =>
  parser.parseRaw(raw) as unknown as ParsedWorldState;

interface ParsedDailies {
  sortie: {
    expiry: string | null;
    boss: string;
    missions: Array<{ node: string; mission: string; modifier: string }>;
  } | null;
  archonHunt: {
    boss: string;
    missions: Array<{ node: string; mission: string }>;
  } | null;
  nightwave: {
    season: number;
    phase: number;
    challenges: Array<{
      id: string;
      title: string;
      description: string;
      standing: number;
      requiredCount: number;
      isDaily: boolean;
      isElite: boolean;
    }>;
  } | null;
  alerts: Array<{
    id: string;
    node: string;
    mission: string;
    faction: string;
    minLevel: number;
    maxLevel: number;
    credits: number;
    items: Array<{ name: string; count: number }>;
  }>;
}
const parseDailies = (raw: Parameters<typeof parser.parseRaw>[0]) =>
  parser.parseRaw(raw) as unknown as ParsedDailies;

function dateLong(ms: number) {
  return { $date: { $numberLong: `${ms}` } };
}

describe("worldStateParser.parseRaw", () => {
  it("parses fissures and traders from raw world state", () => {
    const now = Date.now();
    const raw = {
      ActiveMissions: [
        {
          Modifier: "VoidT4",
          MissionType: "MT_CAPTURE",
          Node: "Marduk",
          Expiry: dateLong(now + 60_000),
        },
      ],
      VoidTraders: {
        Activation: dateLong(now - 60_000),
        Expiry: dateLong(now + 3600_000),
        Node: "EarthHUB",
      },
      PrimeVaultTraders: {
        Activation: dateLong(now - 60_000),
        Expiry: dateLong(now + 7200_000),
        Node: "MarsHUB",
        Manifest: [{ ItemType: "/Lotus/StoreItems/Types/Items/TestItem" }],
      },
      Sorties: [
        {
          Expiry: dateLong(now + 600_000),
        },
      ],
      Descents: [],
    };

    const parsed = parseRaw(raw);

    expect(parsed.fissures).toHaveLength(1);
    expect(parsed.fissures[0].tier).toBe("Axi");
    expect(parsed.fissures[0].missionType).toBe("Capture");
    expect(parsed.voidTrader?.location).toBe("Larunda Relay (Earth)");
    expect(parsed.vaultTrader?.location).toBe("Strata Relay (Mars)");
    expect(parsed.sortie?.expiry).toBeTruthy();
  });

  it("derives the real mission type for railjack void storms", () => {
    const now = Date.now();
    const parsed = parseRaw({
      VoidStorms: [
        { Node: "CrewBattleNode515", ActiveMissionTier: "VoidT3", Expiry: dateLong(now + 60_000) },
      ],
    });

    const storm = parsed.fissures.find((f) => f.isStorm);
    expect(storm?.tier).toBe("Neo");
    // Resolves the node's railjack mission instead of a hardcoded label.
    expect(storm?.missionType).toBe("Survival");
  });

  it("parses daily deals and drops expired ones", () => {
    const now = Date.now();
    const parsed = parser.parseRaw({
      DailyDeals: [
        {
          StoreItem: "/Lotus/StoreItems/Types/Items/TestItem",
          Expiry: dateLong(now + 3600_000),
          Discount: 50,
          OriginalPrice: 150,
          SalePrice: 75,
          AmountTotal: 300,
          AmountSold: 97,
        },
        { StoreItem: "/Lotus/StoreItems/Types/Items/OldItem", Expiry: dateLong(now - 1000) },
      ],
    }) as Record<string, unknown>;

    const deals = parsed.dailyDeals as Array<Record<string, unknown>>;
    expect(deals).toHaveLength(1);
    expect(deals[0].uniqueName).toBe("/Lotus/Types/Items/TestItem");
    expect(deals[0].salePrice).toBe(75);
    expect(deals[0].discount).toBe(50);
    expect(deals[0].sold).toBe(97);
    expect(deals[0].expiry).toBeTruthy();
  });

  it("resolves weapon deals to their in-game name, not the path slug", () => {
    const now = Date.now();
    const parsed = parser.parseRaw({
      DailyDeals: [
        {
          StoreItem: "/Lotus/StoreItems/Weapons/Tenno/Melee/Glaives/Boomerang/BoomerangWeapon",
          Expiry: dateLong(now + 3600_000),
        },
      ],
    }) as Record<string, unknown>;

    const deals = parsed.dailyDeals as Array<Record<string, unknown>>;
    // Was "Boomerang Weapon" before ExportWeapons joined the lookup.
    expect(deals[0].item).toBe("Kestrel");
  });

  it("returns null for empty input", () => {
    expect(parser.parseRaw(null)).toBeNull();
  });
});

describe("worldStateParser sortie, archon hunt, nightwave and alerts", () => {
  const now = Date.now();
  const window = { Activation: dateLong(now - 60_000), Expiry: dateLong(now + 3600_000) };

  it("resolves sortie variants to readable node, mission and modifier", () => {
    const parsed = parseDailies({
      Sorties: [
        {
          ...window,
          Boss: "SORTIE_BOSS_LEPHANTIS",
          Variants: [
            {
              missionType: "MT_SURVIVAL",
              modifierType: "SORTIE_MODIFIER_ARMOR",
              node: "SolNode15",
            },
            {
              missionType: "MT_EXTERMINATION",
              modifierType: "SORTIE_MODIFIER_MELEE_ONLY",
              node: "SolNode11",
            },
            {
              missionType: "MT_DEFENSE",
              modifierType: "SORTIE_MODIFIER_MADE_UP",
              node: "SolNode63",
            },
          ],
        },
      ],
    });

    expect(parsed.sortie?.boss).toBe("Lephantis");
    expect(parsed.sortie?.expiry).toBeTruthy();
    expect(parsed.sortie?.missions).toEqual([
      // The variant mission wins over the node's usual one (Pacific is Rescue).
      { node: "Pacific (Earth)", mission: "Survival", modifier: "Enhanced Enemy Armor" },
      { node: "Tharsis (Mars)", mission: "Exterminate", modifier: "Melee Only" },
      // An unmapped modifier degrades to readable text, not the raw enum.
      { node: "Mantle (Earth)", mission: "Defense", modifier: "Made Up" },
    ]);
  });

  it("parses the archon hunt and yields null without LiteSorties", () => {
    const parsed = parseDailies({
      LiteSorties: [
        {
          ...window,
          Boss: "SORTIE_BOSS_NIRA",
          Missions: [
            { missionType: "MT_RESCUE", node: "SolNode25" },
            { missionType: "MT_SURVIVAL", node: "SolNode15" },
          ],
        },
      ],
    });

    expect(parsed.archonHunt?.boss).toBe("Nira");
    expect(parsed.archonHunt?.missions).toEqual([
      { node: "Callisto (Jupiter)", mission: "Rescue" },
      { node: "Pacific (Earth)", mission: "Survival" },
    ]);
    expect(parseDailies({ ActiveMissions: [] }).archonHunt).toBeNull();
  });

  it("drops expired nightwave acts but keeps ones with no expiry", () => {
    const parsed = parseDailies({
      SeasonInfo: {
        ...window,
        Season: 18,
        Phase: 0,
        ActiveChallenges: [
          {
            _id: { $oid: "live1" },
            ...window,
            Challenge: "/Lotus/Types/Challenges/Seasons/Daily/SeasonDailyAimGlide",
          },
          {
            _id: { $oid: "expired1" },
            Activation: dateLong(now - 7200_000),
            Expiry: dateLong(now - 60_000),
            Challenge: "/Lotus/Types/Challenges/Seasons/Daily/SeasonDailyAimGlide",
          },
          {
            _id: { $oid: "undated1" },
            Activation: dateLong(now - 60_000),
            Challenge: "/Lotus/Types/Challenges/Seasons/Daily/SeasonDailyAimGlide",
          },
        ],
      },
    });

    expect((parsed.nightwave?.challenges ?? []).map((act) => act.id)).toEqual([
      "live1",
      "undated1",
    ]);
  });

  it("resolves nightwave acts, flags elites and degrades unknown challenges", () => {
    const parsed = parseDailies({
      SeasonInfo: {
        ...window,
        Season: 18,
        Phase: 0,
        ActiveChallenges: [
          {
            _id: { $oid: "daily1" },
            Daily: true,
            ...window,
            Challenge: "/Lotus/Types/Challenges/Seasons/Daily/SeasonDailyAimGlide",
          },
          {
            _id: { $oid: "elite1" },
            ...window,
            Challenge:
              "/Lotus/Types/Challenges/Seasons/WeeklyHard/SeasonWeeklyHardRiseOfTheMachine",
          },
          {
            _id: { $oid: "unknown1" },
            ...window,
            Challenge: "/Lotus/Types/Challenges/Seasons/Daily/SeasonDailyMadeUpAct",
          },
        ],
      },
    });

    expect(parsed.nightwave?.season).toBe(18);
    expect(parsed.nightwave?.phase).toBe(0);
    const [daily, elite, unknown] = parsed.nightwave?.challenges ?? [];
    expect(daily).toMatchObject({
      id: "daily1",
      title: "Glider",
      description: "Kill 15 Enemies while Aim Gliding",
      standing: 1000,
      requiredCount: 15,
      isDaily: true,
      isElite: false,
    });
    expect(elite).toMatchObject({
      title: "Rise of the Machine",
      standing: 7000,
      isDaily: false,
      isElite: true,
    });
    // No export entry: the slug carries the title and stands in for the description.
    expect(unknown).toMatchObject({
      title: "Season Daily Made Up Act",
      description: "Season Daily Made Up Act",
      standing: 0,
      requiredCount: 0,
    });
  });

  it("resolves alerts and drops expired ones", () => {
    const parsed = parseDailies({
      Alerts: [
        {
          _id: { $oid: "alert1" },
          ...window,
          MissionInfo: {
            location: "SolNode25",
            missionType: "MT_TERRITORY",
            faction: "FC_CORPUS",
            minEnemyLevel: 1,
            maxEnemyLevel: 2,
            missionReward: {
              credits: 50000,
              countedItems: [
                { ItemType: "/Lotus/Types/Items/MiscItems/WaterFightBucks", ItemCount: 175 },
              ],
              items: ["/Lotus/Types/Items/MiscItems/MadeUpThing"],
            },
          },
        },
        {
          _id: { $oid: "expired" },
          Expiry: dateLong(now - 1000),
          MissionInfo: { location: "SolNode15", missionType: "MT_RESCUE" },
        },
      ],
    });

    expect(parsed.alerts).toHaveLength(1);
    expect(parsed.alerts[0]).toMatchObject({
      id: "alert1",
      // MT_TERRITORY is Interception in DE's own table, not the legacy label.
      node: "Callisto (Jupiter)",
      mission: "Interception",
      faction: "Corpus",
      minLevel: 1,
      maxLevel: 2,
      credits: 50000,
      items: [
        { name: "Nakak Pearls", count: 175 },
        { name: "Made Up Thing", count: 1 },
      ],
    });
  });

  it("parses a payload carrying none of the four keys", () => {
    const parsed = parseDailies({ ActiveMissions: [] });
    expect(parsed.sortie).toBeNull();
    expect(parsed.archonHunt).toBeNull();
    expect(parsed.nightwave).toBeNull();
    expect(parsed.alerts).toEqual([]);
  });

  it("survives a payload where any of the four keys is not an array", () => {
    // DE has shipped scalars in array slots before; one bad field must not cost
    // the fissures, cycles and bounties parsed from the same payload.
    const parsed = parseDailies({
      ActiveMissions: [],
      Sorties: [{ ...window, Boss: "SORTIE_BOSS_LEPHANTIS", Variants: {} }],
      LiteSorties: [{ ...window, Boss: "SORTIE_BOSS_NIRA", Missions: "nope" }],
      SeasonInfo: { ...window, Season: 18, Phase: 0, ActiveChallenges: {} },
      Alerts: {},
    } as unknown as Parameters<typeof parseDailies>[0]);

    expect(parsed.sortie).toMatchObject({ boss: "Lephantis", missions: [] });
    expect(parsed.archonHunt).toMatchObject({ boss: "Nira", missions: [] });
    expect(parsed.nightwave).toMatchObject({ season: 18, challenges: [] });
    expect(parsed.alerts).toEqual([]);
  });

  it("keeps an alert whose reward arrays are malformed", () => {
    const parsed = parseDailies({
      Alerts: [
        {
          ...window,
          _id: { $oid: "alert-1" },
          MissionInfo: {
            location: "SolNode25",
            missionType: "MT_RESCUE",
            faction: "FC_CORPUS",
            missionReward: { credits: 5000, countedItems: {}, items: "nope" },
          },
        },
      ],
    } as unknown as Parameters<typeof parseDailies>[0]);

    expect(parsed.alerts).toHaveLength(1);
    expect(parsed.alerts?.[0]).toMatchObject({ credits: 5000, items: [] });
  });
});

describe("worldStateParser.parseBountyCycleBounties", () => {
  interface SeedBounty {
    syndicate: string;
    jobs: Array<{ enemyLevels: [number, number]; tierIndex: number; standingStages: number[] }>;
  }

  const nodes = (n: number) => Array.from({ length: n }, (_, i) => ({ node: `FakeNode${i}` }));
  const cycle = (bounties: Record<string, { node: string }[]>) =>
    parser.parseBountyCycleBounties({ bounties }) as SeedBounty[];

  it("assigns static per-tier enemy levels (oracle jobs carry none)", () => {
    const [zariman] = cycle({ ZarimanSyndicate: nodes(5) });
    expect(zariman.jobs.map((j) => j.enemyLevels)).toEqual([
      [50, 55],
      [60, 65],
      [70, 75],
      [90, 95],
      [110, 115],
    ]);

    const [cavia] = cycle({ EntratiLabSyndicate: nodes(5) });
    expect(cavia.jobs.map((j) => j.enemyLevels)).toEqual([
      [55, 60],
      [65, 70],
      [75, 80],
      [95, 100],
      [115, 120],
    ]);

    const [hex] = cycle({ HexSyndicate: nodes(7) });
    expect(hex.syndicate).toBe("The Hex");
    expect(hex.jobs.map((j) => j.enemyLevels)).toEqual([
      [65, 70],
      [75, 80],
      [85, 90],
      [95, 100],
      [105, 110],
      [115, 120],
      [125, 130],
    ]);
  });

  it("carries tier index for reward-pool lookup plus single-stage standing", () => {
    const [hex] = cycle({ HexSyndicate: nodes(7) });
    expect(hex.jobs.map((j) => j.tierIndex)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(hex.jobs.map((j) => j.standingStages)).toEqual([
      [1000],
      [2000],
      [3000],
      [4000],
      [5000],
      [6000],
      [7500],
    ]);
  });

  it("skips unknown syndicates and falls back to region levels past the tier table", () => {
    expect(cycle({ MadeUpSyndicate: nodes(1) })).toHaveLength(0);

    const [zariman] = cycle({ ZarimanSyndicate: nodes(6) });
    expect(zariman.jobs[5].enemyLevels).toEqual([0, 0]);
  });
});
