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

// warframe.market spells "&" as "and" in its slugs (silva_and_aegis), so folding
// the game name straight to underscores would never meet its side.
function weaponSlug(weaponName: string): string {
  return normalizeWfmSlugKey(weaponName.replace(/&/g, " and "));
}

// A riven covers the whole weapon family, so "rubico" and "rubico_prime" have to
// match either way round. Both sides go through one slug rule or punctuation and
// case differences read as a listing the inventory lost.
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
  const name = riven.rivenName ?? "";
  const weapon = riven.weaponName ?? "";
  const suffix = name.toLowerCase().startsWith(weapon.toLowerCase())
    ? name.slice(weapon.length)
    : name;
  return suffix.trim().toLowerCase();
}

/**
 * Whether an active riven listing still lines up with the inventory. Name and
 * rank both have to agree, so a levelled riven reads as a mismatch, not missing.
 */
export function contractInventoryMatch(
  contract: ContractIdentity,
  owned: readonly OwnedRiven[],
): ListingInventoryMatch {
  const suffix = (contract.rivenSuffix ?? "").trim().toLowerCase();
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
