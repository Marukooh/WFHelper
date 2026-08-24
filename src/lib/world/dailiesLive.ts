import type { Translator } from "../i18n.js";
import type { ArchonHunt, Sortie, WorldState } from "../../types/world.js";
import type { TrackerExpiries } from "./dailies.js";

interface TrackerLive {
  /** One-line subtitle under the task label. */
  detail?: string | undefined;
  /** Sub-lines revealed by the row's expand toggle. */
  lines?: string[] | undefined;
  /** Drives the per-row countdown; null when the task has no live window. */
  expiry?: string | null | undefined;
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
