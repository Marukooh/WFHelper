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

type ListedRiven = OwnedRiven & Pick<DecodedRiven, "itemId" | "polarity" | "stats">;
type ListedContract = ContractIdentity & Pick<WfmContract, "polarity" | "stats">;

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

// The game spells polarity AP_ATTACK where WFM spells it madurai, so both sides
// fold to one vocabulary before they can be compared.
const POLARITY_ALIASES: Record<string, string> = {
  ap_attack: "madurai",
  ap_tactic: "naramon",
  ap_defense: "vazarin",
  ap_power: "zenurik",
  ap_ward: "unairu",
  ap_precept: "penjaga",
  ap_umbra: "umbra",
};

// WFM rounds the roll it was sent, so the two sides differ in the last digit.
const STAT_VALUE_EPSILON = 0.1;

function polarityKey(value: string | null | undefined): string {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  return POLARITY_ALIASES[raw] ?? raw;
}

function samePolarity(contract: ListedContract, riven: ListedRiven): boolean {
  const listed = polarityKey(contract.polarity);
  const own = polarityKey(riven.polarity);
  // An unknown polarity on either side separates nobody.
  return !listed || !own || listed === own;
}

function attributeValue(attribute: WfmContractAttribute): number | null {
  // Number(null) and Number("") are 0, which would demand a zero roll instead of
  // reading as the absent value it is.
  if (attribute.value == null || attribute.value === "") return null;
  const value = Number(attribute.value);
  // Signs travel differently on the two sides, and one stat name never appears
  // twice on a riven, so magnitude is the part worth comparing.
  return Number.isFinite(value) ? Math.abs(value) : null;
}

/** The numeric rolls, which separate twins the shared suffix cannot. */
function sameStatValues(contract: ListedContract, riven: ListedRiven): boolean {
  const pool = (riven.stats ?? []).map((stat) => ({
    key: canonicalRivenStatName(stat.name),
    // Listing an unranked riven at max rank is a feature of the riven modal, so
    // the listed roll is either the copy's own value or that value at rank 8.
    values: [Math.abs(stat.displayValue), Math.abs(stat.maxRankValue)],
    used: false,
  }));

  for (const attribute of contract.stats ?? []) {
    const value = attributeValue(attribute);
    const keys = contractStatKeys(attribute);
    if (value == null || keys.length === 0) continue;
    const hit = pool.find(
      (stat) =>
        !stat.used &&
        keys.includes(stat.key) &&
        stat.values.some((own) => Math.abs(own - value) <= STAT_VALUE_EPSILON),
    );
    if (!hit) return false;
    hit.used = true;
  }
  return true;
}

const NARROWING_HINTS: ReadonlyArray<(contract: ListedContract, riven: ListedRiven) => boolean> = [
  (contract, riven) => contract.rerolls == null || riven.rerolls === contract.rerolls,
  (contract, riven) => contract.masteryLevel == null || riven.masteryReq === contract.masteryLevel,
  (contract, riven) =>
    contract.modRank == null ||
    riven.currentRank === contract.modRank ||
    riven.maxRank === contract.modRank,
  samePolarity,
  sameStatValues,
];

function candidateRivens(
  contract: ListedContract,
  rivens: readonly ListedRiven[],
): readonly ListedRiven[] {
  const slug = normalizeWfmSlugKey(contract.weaponUrlName);
  if (!slug) return [];

  let pool = rivens.filter(
    (riven) => sameWeapon(slug, riven.weaponName ?? "") && sameRiven(contract, riven),
  );
  for (const hint of NARROWING_HINTS) {
    if (pool.length <= 1) break;
    const next = pool.filter((riven) => hint(contract, riven));
    // A hint nobody answers is stale, not disqualifying: a riven rerolled or
    // levelled after it was listed still carries its own auction.
    if (next.length > 0) pool = next;
  }
  return pool;
}

/**
 * Maps each owned riven to the auction listing it, taking only forced pairs. An
 * unmarked riven costs a badge; a wrong mark can remove the wrong listing.
 */
export function matchRivenListings<C extends ListedContract>(
  rivens: readonly ListedRiven[],
  contracts: readonly C[],
): Map<string, C> {
  const matched = new Map<string, C>();
  const claimed = new Set<string>();
  const open = contracts
    .map((contract) => ({ contract, candidates: candidateRivens(contract, rivens), done: false }))
    .filter((entry) => entry.candidates.length > 0);

  const claim = (riven: ListedRiven, contract: C): void => {
    claimed.add(riven.itemId);
    matched.set(riven.itemId, contract);
  };
  const free = (entry: (typeof open)[number]): readonly ListedRiven[] =>
    entry.candidates.filter((riven) => !claimed.has(riven.itemId));

  // Claiming in one pass would let the first auction take a riven a later
  // auction can prove is its own, so repeat until no new pair is forced.
  let settled = true;
  while (settled) {
    settled = false;
    for (const entry of open) {
      if (entry.done) continue;
      const rest = free(entry);
      if (rest.length > 1) continue;
      entry.done = true;
      if (rest.length === 1) {
        claim(rest[0], entry.contract);
        settled = true;
      }
    }
  }

  // Auctions that cannot tell the same N rivens apart still prove all N are
  // listed when there are exactly N of them, so their pairing is arbitrary but
  // never wrong about listedness. Fewer auctions than twins proves nothing.
  const groups = new Map<string, Array<(typeof open)[number]>>();
  for (const entry of open) {
    if (entry.done) continue;
    const signature = free(entry)
      .map((riven) => riven.itemId)
      .sort()
      .join(" ");
    const group = groups.get(signature);
    if (group) group.push(entry);
    else groups.set(signature, [entry]);
  }
  for (const group of groups.values()) {
    const rest = free(group[0]);
    if (group.length !== rest.length) continue;
    group.forEach((entry, index) => claim(rest[index], entry.contract));
  }

  return matched;
}
