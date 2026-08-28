import { canonicalRivenStatName } from "../../renderer/riven-similarity.js";
import { normalizeWfmSlugKey } from "../../config/shared/wfm.js";
import type { ListingInventoryMatch } from "./marketListing.js";
import type { DecodedRiven } from "../types/ipc.js";
import type { WfmContract, WfmContractAttribute } from "../types/market.js";

export function attributeKeyword(attribute: WfmContractAttribute): string {
  if (typeof attribute.label === "string" && attribute.label.trim()) return attribute.label;
  if (typeof attribute.urlName === "string" && attribute.urlName.trim()) {
    return attribute.urlName.replace(/_/g, " ");
  }
  return "";
}

type ContractIdentity = Pick<
  WfmContract,
  "weaponUrlName" | "rivenSuffix" | "modRank" | "rerolls" | "masteryLevel"
>;
type OwnedRiven = Pick<
  DecodedRiven,
  "weaponName" | "rivenName" | "currentRank" | "maxRank" | "rerolls" | "masteryReq"
>;

// A generated suffix is ASCII, but a name that travelled through OCR or a
// localized client can carry accents; fold them so both sides still meet.
function foldName(value: string): string {
  return value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();
}

// warframe.market spells "&" as "and" in its slugs (silva_and_aegis), so folding
// the game name straight to underscores would never meet its side.
function weaponSlug(weaponName: string): string {
  return normalizeWfmSlugKey(weaponName.replace(/&/g, " and "));
}

// A riven covers the whole weapon family, so "rubico" and "rubico_prime" match
// either way round; both sides fold through one slug rule or case reads as a loss.
function sameWeapon(contractSlug: string, ownedWeaponName: string): boolean {
  const owned = weaponSlug(ownedWeaponName);
  if (!owned || !contractSlug) return false;
  return (
    owned === contractSlug ||
    owned.startsWith(`${contractSlug}_`) ||
    contractSlug.startsWith(`${owned}_`)
  );
}

/** The generated part of the name, which is what WFM stores as rivenSuffix. */
function ownedSuffix(riven: OwnedRiven): string {
  // Slice the folded name, not the raw one: folding collapses whitespace, so the
  // raw weapon length would cut in the wrong place on a padded name.
  const name = foldName(riven.rivenName ?? "");
  const weapon = foldName(riven.weaponName ?? "");
  return weapon && name.startsWith(weapon) ? name.slice(weapon.length).trim() : name;
}

/**
 * Whether an active riven listing still lines up with the inventory. Name and
 * rank both have to agree, so a levelled riven reads as a mismatch, not missing.
 */
export function contractInventoryMatch(
  contract: ContractIdentity,
  owned: readonly OwnedRiven[],
): ListingInventoryMatch {
  const suffix = foldName(contract.rivenSuffix ?? "");
  const slug = normalizeWfmSlugKey(contract.weaponUrlName);
  // Without both halves of the identity any answer would be a guess.
  if (!suffix || !slug) return { state: "match" };

  const named = owned.filter(
    (riven) => sameWeapon(slug, riven.weaponName ?? "") && ownedSuffix(riven) === suffix,
  );
  if (named.length === 0) return { state: "missing" };

  // The suffix is derived from the buff tags, so two rolls of the same stats on
  // one weapon share a name. Reroll count and mastery separate the twins; a
  // contract that states neither, or that narrows to nothing, keeps the name set.
  const narrowed = named.filter(
    (riven) =>
      (contract.rerolls == null || riven.rerolls === contract.rerolls) &&
      (contract.masteryLevel == null || riven.masteryReq === contract.masteryLevel),
  );
  const candidates = narrowed.length > 0 ? narrowed : named;

  if (contract.modRank == null) return { state: "match" };
  // Listing at max rank is a feature of the riven modal, so a rank-0 riven
  // offered at its max rank is exactly what the user asked for, not a mismatch.
  const ranked = candidates.some(
    (riven) => riven.currentRank === contract.modRank || riven.maxRank === contract.modRank,
  );
  if (ranked) return { state: "match" };
  return { state: "rank-mismatch", ownedRank: candidates[0].currentRank };
}

type ListedRiven = OwnedRiven & Pick<DecodedRiven, "itemId" | "stats">;
type ListedContract = ContractIdentity & Pick<WfmContract, "stats">;

// WFM names an attribute by slug and by label, and neither is guaranteed to be
// the wording the game shows, so both spellings are folded through the same
// alias table the overlay uses. Substring matching is deliberately absent:
// "damage" is contained in half the stat names.
function contractStatKeys(attribute: WfmContractAttribute): string[] {
  const keys = new Set<string>();
  for (const raw of [String(attribute.urlName ?? "").replace(/_/g, " "), attribute.label ?? ""]) {
    const key = canonicalRivenStatName(raw);
    if (key) keys.add(key);
  }
  return [...keys];
}

/** Exact set equality on canonical stat names, used only when a name is absent. */
function sameStatSet(
  attributes: readonly WfmContractAttribute[],
  stats: readonly DecodedRiven["stats"][number][],
): boolean {
  if (attributes.length === 0 || attributes.length !== stats.length) return false;
  const pool = stats.map((stat) => ({ key: canonicalRivenStatName(stat.name), used: false }));
  for (const attribute of attributes) {
    const keys = contractStatKeys(attribute);
    const hit = pool.find((stat) => !stat.used && keys.includes(stat.key));
    if (!hit) return false;
    hit.used = true;
  }
  return true;
}

function sameRiven(contract: ListedContract, riven: ListedRiven): boolean {
  const suffix = foldName(contract.rivenSuffix ?? "");
  const owned = ownedSuffix(riven);
  if (suffix && owned) return suffix === owned;
  return sameStatSet(contract.stats, riven.stats);
}

/**
 * Maps each owned riven to the live auction listing it. Rerolls and mastery only
 * separate same-named twins, so a numeric mismatch never cancels a name match.
 */
export function matchRivenListings<C extends ListedContract>(
  rivens: readonly ListedRiven[],
  contracts: readonly C[],
): Map<string, C> {
  const matched = new Map<string, C>();
  const claimed = new Set<string>();

  for (const contract of contracts) {
    const slug = normalizeWfmSlugKey(contract.weaponUrlName);
    if (!slug) continue;

    const named = rivens.filter(
      (riven) =>
        !claimed.has(riven.itemId) &&
        sameWeapon(slug, riven.weaponName ?? "") &&
        sameRiven(contract, riven),
    );
    if (named.length === 0) continue;

    const narrowed = named.filter(
      (riven) =>
        (contract.rerolls == null || riven.rerolls === contract.rerolls) &&
        (contract.masteryLevel == null || riven.masteryReq === contract.masteryLevel) &&
        (contract.modRank == null ||
          riven.currentRank === contract.modRank ||
          riven.maxRank === contract.modRank),
    );
    const winner = (narrowed.length > 0 ? narrowed : named)[0];
    claimed.add(winner.itemId);
    matched.set(winner.itemId, contract);
  }

  return matched;
}
