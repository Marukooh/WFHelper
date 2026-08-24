import type { MessageKey, Translator } from "../i18n.js";
import type { ArchonHunt, CalendarDay, Sortie, WorldState } from "../../types/world.js";
import { fourDayResetIso, type TrackerExpiries } from "./dailies.js";

interface TrackerLive {
  /** One-line subtitle under the task label. */
  detail?: string | undefined;
  /** Sub-lines revealed by the row's expand toggle. */
  lines?: string[] | undefined;
  /** Drives the per-row countdown; null when the task has no live window. */
  expiry?: string | null | undefined;
}

/** Ergo Glast always sells all five; the 4-day tick only rerolls elements. */
export const TENET_MELEE_STOCK = [
  "Tenet Agendus",
  "Tenet Exec",
  "Tenet Ferrox",
  "Tenet Grigori",
  "Tenet Livia",
];

/** Eleanor alternates two fixed batches; A occupies the second half of the
 *  8-day loop from the wiki anchor (2025-03-18T00:00Z). */
const CODA_LOOP_ANCHOR_MS = Date.UTC(2025, 2, 18);
const CODA_HALF_MS = 4 * 24 * 60 * 60_000;
const CODA_BATCH_A = [
  "Coda Hema",
  "Coda Sporothrix",
  "Coda Catabolyst",
  "Coda Pox",
  "Dual Coda Torxica",
  "Coda Mire",
  "Coda Motovore",
];
const CODA_BATCH_B = [
  "Coda Bassocyst",
  "Coda Bubonico",
  "Coda Synapse",
  "Coda Tysis",
  "Coda Caustacyst",
  "Coda Hirudo",
  "Coda Pathocyst",
];

export function codaBatch(nowMs: number): { batch: "A" | "B"; weapons: string[] } {
  const offset =
    (((nowMs - CODA_LOOP_ANCHOR_MS) % (2 * CODA_HALF_MS)) + 2 * CODA_HALF_MS) % (2 * CODA_HALF_MS);
  return offset >= CODA_HALF_MS
    ? { batch: "A", weapons: CODA_BATCH_A }
    : { batch: "B", weapons: CODA_BATCH_B };
}

/** Bird 3's weekly Archon Shard color; wiki formula anchored 2022-09-12T00:00Z. */
const BIRD3_ANCHOR_MS = Date.UTC(2022, 8, 12);
const WEEK_MS = 7 * 24 * 60 * 60_000;
const BIRD3_SHARDS = ["Azure", "Amber", "Crimson"];
/** Shard names are item names, so the plain colour is spelled out beside them. */
const SHARD_PLAIN_KEYS: Record<string, MessageKey> = {
  Azure: "dailies.shardBlue",
  Amber: "dailies.shardYellow",
  Crimson: "dailies.shardRed",
};

export function bird3ShardColor(nowMs: number): string {
  const offset = (((nowMs - BIRD3_ANCHOR_MS) % (3 * WEEK_MS)) + 3 * WEEK_MS) % (3 * WEEK_MS);
  return BIRD3_SHARDS[Math.floor(offset / WEEK_MS)];
}

/** A season spans a whole quarter, so the row shows only the near future and
 *  leaves the rest to the wiki link. */
const CALENDAR_LINE_CAP = 15;

function dayOfYearUtc(nowMs: number): number {
  const now = new Date(nowMs);
  const start = Date.UTC(now.getUTCFullYear(), 0, 1);
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.floor((today - start) / 86_400_000) + 1;
}

/** DE numbers calendar days by day-of-year; a season numbered from its own start
 *  would match nothing, so an empty upcoming list falls back to the whole list. */
function calendarLines(days: CalendarDay[], t: Translator, nowMs: number): string[] {
  const today = dayOfYearUtc(nowMs);
  const upcoming = days.filter((entry) => entry.day >= today);
  return (upcoming.length > 0 ? upcoming : days)
    .slice(0, CALENDAR_LINE_CAP)
    .map(
      (entry) =>
        `${t("dailies.calendarDay", { day: String(entry.day) })} - ${entry.events.join(", ")}`,
    );
}

function isActive(activation?: string, expiry?: string, nowMs = Date.now()): boolean {
  const start = activation ? Date.parse(activation) : NaN;
  const end = expiry ? Date.parse(expiry) : NaN;
  if (Number.isNaN(start) || Number.isNaN(end)) return false;
  return nowMs >= start && nowMs < end;
}

function circuitChoices(wd: WorldState | null, category: string): string[] {
  const set = (wd?.duviriCycle?.choices ?? []).find((entry) => entry.category === category);
  return set?.choices ?? [];
}

export function trackerExpiries(wd: WorldState | null): TrackerExpiries {
  return {
    sortie: wd?.sortie?.expiry ?? null,
    archon: wd?.archonHunt?.expiry ?? null,
    steelPath: wd?.steelPath?.expiry ?? null,
    descendia: wd?.descents?.expiry ?? null,
    calendar1999: wd?.calendarSeason?.expiry ?? null,
    // Baro's activation is stable from "away" through "here", so it names one visit.
    baro: wd?.voidTrader?.activation ?? null,
    darvo: wd?.dailyDeals?.[0]?.expiry ?? null,
    varzia: wd?.vaultTrader?.activation ?? null,
  };
}

/** Live detail for a built-in task, or an empty object when the game has none. */
export function trackerLive(
  id: string,
  wd: WorldState | null,
  t: Translator,
  nowMs: number,
): TrackerLive {
  // The 4-day vendor grids come from the clock, so they tick without world data.
  // Their stock renders as an icon strip, so no text lines here.
  if (id === "tenetMelee") {
    return { expiry: fourDayResetIso("tenet", new Date(nowMs)) };
  }
  if (id === "codaWeapons") {
    return {
      detail: t("dailies.codaBatch", { batch: codaBatch(nowMs).batch }),
      expiry: fourDayResetIso("coda", new Date(nowMs)),
    };
  }
  // Shard color is a 3-week clock cycle; the shard names are item names, so
  // they stay English like everything matched against the game.
  if (id === "bird3") {
    const color = bird3ShardColor(nowMs);
    const plainKey = SHARD_PLAIN_KEYS[color];
    return {
      detail: t("dailies.bird3Shard", { color, plain: plainKey ? t(plainKey) : color }),
    };
  }

  if (!wd) return {};

  switch (id) {
    case "sortie": {
      const sortie: Sortie | null | undefined = wd.sortie;
      const missions = (sortie?.missions ?? []).map(
        (mission) => `${mission.mission} - ${mission.node} - ${mission.modifier}`,
      );
      return {
        detail: sortie?.boss ? t("dailies.boss", { name: sortie.boss }) : undefined,
        lines: missions,
        expiry: sortie?.expiry ?? null,
      };
    }

    case "archonHunt": {
      const hunt: ArchonHunt | null | undefined = wd.archonHunt;
      if (!hunt) return {};
      return {
        detail: hunt.boss ? t("dailies.boss", { name: hunt.boss }) : undefined,
        lines: hunt.missions.map((mission) => `${mission.mission} - ${mission.node}`),
        expiry: hunt.expiry ?? null,
      };
    }

    case "circuitNormal": {
      const choices = circuitChoices(wd, "normal");
      return choices.length > 0 ? { detail: choices.join(" - ") } : {};
    }

    case "circuitSteelPath": {
      const choices = circuitChoices(wd, "hard");
      return choices.length > 0 ? { detail: choices.join(" - ") } : {};
    }

    case "steelPathHonors": {
      const reward = wd.steelPath?.currentReward;
      if (!reward) return {};
      return {
        detail: `${reward.name} - ${t("world.steelEssenceCost", { cost: String(reward.cost) })}`,
        expiry: wd.steelPath?.expiry ?? null,
      };
    }

    case "baro": {
      const baro = wd.voidTrader;
      if (!baro) return {};
      const here = isActive(baro.activation, baro.expiry, nowMs);
      const location = baro.location ?? "";
      const where = location
        ? t(here ? "dailies.baroHere" : "dailies.baroAway", { location })
        : undefined;
      const offers = baro.inventory?.length ?? 0;
      const count = here && offers > 0 ? t("dailies.itemCount", { count: String(offers) }) : "";
      return {
        detail: [where, count].filter(Boolean).join(" - ") || undefined,
        expiry: (here ? baro.expiry : baro.activation) ?? null,
      };
    }

    case "varzia": {
      const varzia = wd.vaultTrader;
      if (!varzia) return {};
      const here = isActive(varzia.activation, varzia.expiry, nowMs);
      const offers = varzia.inventory?.length ?? 0;
      return {
        detail: here && offers > 0 ? t("dailies.itemCount", { count: String(offers) }) : undefined,
        expiry: (here ? varzia.expiry : varzia.activation) ?? null,
      };
    }

    case "descendiaNormal":
    case "descendiaSteelPath": {
      return { expiry: wd.descents?.expiry ?? null };
    }

    case "calendar1999": {
      const season = wd.calendarSeason;
      if (!season) return {};
      // The season tag is a game term (Winter/Spring/...), shown as the game spells it.
      return {
        detail: season.season || undefined,
        lines: season.days?.length ? calendarLines(season.days, t, nowMs) : undefined,
        expiry: season.expiry ?? null,
      };
    }

    case "darvo": {
      const deal = wd.dailyDeals?.[0];
      if (!deal?.item) return {};
      const price =
        typeof deal.salePrice === "number"
          ? `${deal.salePrice}p${typeof deal.discount === "number" ? ` (-${deal.discount}%)` : ""}`
          : "";
      const stock =
        typeof deal.sold === "number" && typeof deal.total === "number"
          ? t("world.soldOfTotal", { sold: String(deal.sold), total: String(deal.total) })
          : "";
      return {
        detail: [deal.item, price, stock].filter(Boolean).join(" - "),
        expiry: deal.expiry ?? null,
      };
    }

    default:
      return {};
  }
}
