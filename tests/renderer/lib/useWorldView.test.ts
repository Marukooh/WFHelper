import { describe, expect, it } from "vitest";

import {
  buildFissureRows,
  fissureMissionTypeOptions,
} from "../../../src/lib/world/useWorldView.js";
import type { Fissure } from "../../../src/types/world.js";

const NOW = Date.parse("2026-08-28T12:00:00.000Z");
const iso = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString();

const FISSURES: Fissure[] = [
  { tier: "Axi", node: "Axi Normal", missionType: "Survival", expiry: iso(50) },
  { tier: "Lith", node: "Lith Steel", missionType: "Capture", expiry: iso(40), isHard: true },
  { tier: "Lith", node: "Lith Normal", missionType: "Defense", expiry: iso(20) },
  { tier: "Meso", node: "Meso Storm", missionType: "Volatile", expiry: iso(30), isStorm: true },
  {
    tier: "Neo",
    node: "Neo Hard Storm",
    missionType: "Orphix",
    expiry: iso(35),
    isHard: true,
    isStorm: true,
  },
  { tier: "Lith", node: "Lith Steel Late", missionType: "Spy", expiry: iso(60), isHard: true },
  { tier: "Meso", node: "Meso Expired", missionType: "Rescue", expiry: iso(90), expired: true },
];

const nodes = (rows: Array<{ node?: string }>) => rows.map((r) => r.node);

describe("buildFissureRows in all mode", () => {
  it("merges normal and Steel Path rows and excludes Void Storms", () => {
    const all = buildFissureRows(FISSURES, "all", NOW, NOW);
    const normal = buildFissureRows(FISSURES, "normal", NOW, NOW);
    const steel = buildFissureRows(FISSURES, "steel", NOW, NOW);

    expect(nodes(all).sort()).toEqual([...nodes(normal), ...nodes(steel)].sort());
    expect(nodes(all)).not.toContain("Meso Storm");
    expect(nodes(all)).not.toContain("Neo Hard Storm");
  });

  it("keeps Void Storms in the railjack mode only", () => {
    const railjack = buildFissureRows(FISSURES, "railjack", NOW, NOW);
    expect(nodes(railjack)).toEqual(["Meso Storm", "Neo Hard Storm"]);
  });

  it("orders by tier then by expiry, same as the single-mode lists", () => {
    const all = buildFissureRows(FISSURES, "all", NOW, NOW);
    expect(nodes(all)).toEqual(["Lith Normal", "Lith Steel", "Lith Steel Late", "Axi Normal"]);

    // The merge must not reshuffle either source list relative to itself.
    const normal = buildFissureRows(FISSURES, "normal", NOW, NOW);
    const steel = buildFissureRows(FISSURES, "steel", NOW, NOW);
    expect(nodes(all.filter((r) => r.sourceMode === "normal"))).toEqual(nodes(normal));
    expect(nodes(all.filter((r) => r.sourceMode === "steel"))).toEqual(nodes(steel));
  });

  it("tags every row with its source mode", () => {
    const all = buildFissureRows(FISSURES, "all", NOW, NOW);
    expect(all.map((r) => [r.node, r.sourceMode])).toEqual([
      ["Lith Normal", "normal"],
      ["Lith Steel", "steel"],
      ["Lith Steel Late", "steel"],
      ["Axi Normal", "normal"],
    ]);
    expect(buildFissureRows(FISSURES, "railjack", NOW, NOW).map((r) => r.sourceMode)).toEqual([
      "railjack",
      "railjack",
    ]);
  });

  it("still drops expired and about-to-expire fissures", () => {
    const soon: Fissure[] = [
      { tier: "Lith", node: "Almost Gone", expiry: new Date(NOW + 500).toISOString() },
      { tier: "Lith", node: "Alive", expiry: iso(10), isHard: true },
    ];
    expect(nodes(buildFissureRows(soon, "all", NOW, NOW))).toEqual(["Alive"]);
    expect(nodes(buildFissureRows(FISSURES, "all", NOW, NOW))).not.toContain("Meso Expired");
  });
});

describe("fissureMissionTypeOptions", () => {
  it("derives alert options from the active API fissures, including Railjack types", () => {
    const fissures: Fissure[] = [
      { missionType: "Void Flood" },
      { missionType: "Alchemy" },
      { missionType: "Assault" },
      { missionType: "Infested Salvage" },
      { missionType: "Skirmish", isStorm: true },
      { missionType: "Orphix", isStorm: true },
      { missionType: "Volatile", isStorm: true },
      { missionType: "Void Flood" },
      { missionType: "  " },
    ];

    expect(fissureMissionTypeOptions(fissures)).toEqual([
      "Alchemy",
      "Assault",
      "Infested Salvage",
      "Orphix",
      "Skirmish",
      "Void Flood",
      "Volatile",
    ]);
  });
});
