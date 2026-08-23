import { CODEX_EXTRA_INFO, CODEX_SCAN_REQUIREMENTS } from "../data/codexScanRequirements.js";
import type { CodexScanEntry } from "../../config/shared/codexTypes.js";

export interface CodexRow {
  type: string;
  name: string;
  scanned: number;
  /** Null when neither source states a requirement, so completion is unknowable. */
  required: number | null;
  complete: boolean | null;
  faction: string | null;
  image: string | null;
}

export type CodexSortKey = "name" | "scans" | "progress";

/** Wiki partition keys in the order the in-game codex lists factions. */
export const CODEX_FACTIONS: Array<{ key: string; label: string }> = [
  { key: "grineer", label: "Grineer" },
  { key: "corpus", label: "Corpus" },
  { key: "infestation", label: "Infested" },
  { key: "orokin", label: "Orokin" },
  { key: "sentient", label: "Sentient" },
  { key: "narmer", label: "Narmer" },
  { key: "themurmur", label: "The Murmur" },
  { key: "techrot", label: "Techrot" },
  { key: "scaldra", label: "Scaldra" },
  { key: "anarchs", label: "Anarchs" },
  { key: "stalker", label: "Stalker" },
  { key: "unaffiliated", label: "Unaffiliated" },
  { key: "wildlife", label: "Wildlife" },
  { key: "objects", label: "Objects" },
  { key: "lore", label: "Fragments" },
];

const ENEMY_IMAGE_BASE = "https://assets.wfhelper.com/enemies/";

// DE's export states no reqScans; real profiles cap conservation counts at 20.
const WILDLIFE_REQUIRED_SCANS = 20;

/** Wiki rows carry a bare filename; export-sourced rows a full mirror URL. */
export function enemyImageUrl(image: string | null): string | null {
  if (!image) return null;
  if (image.startsWith("https://")) return image;
  return `${ENEMY_IMAGE_BASE}${encodeURIComponent(image)}`;
}

const SUFFIX_RE = /(AvatarLeader|LeaderAvatar|Avatar|Agent)$/i;

// A scan lands on the world prop, which is the catalog path plus "Deco" for
// lore fragments. Ayatan is worse: DE keys the codex entry by the inventory
// item but records the scan against the world prop, so map both the six
// sculptures and the two stars back to /FusionTreasures/.
const PROP_SUFFIX_RE = /Deco$/i;
const AYATAN_PROP_RE = /^\/Lotus\/Objects\/Gameplay\/(OroFusex(?:Ornament)?[A-Z])$/i;

const canonicalKey = (type: string): string => {
  const stripped = type.replace(SUFFIX_RE, "").replace(PROP_SUFFIX_RE, "");
  const ayatan = AYATAN_PROP_RE.exec(stripped);
  const catalog = ayatan ? `/Lotus/Types/Items/FusionTreasures/${ayatan[1]}` : stripped;
  return catalog.replace(/\/Avatars\//i, "/").toLowerCase();
};

// The wiki stores Agent paths, the profile Avatar paths under an extra
// /Avatars/ dir, but stripping can merge distinct entries (Lancer vs Trooper
// Survivor). A scan feeds its strictest-level hit; shared keys are unusable.
const KEY_LEVELS: Array<(type: string) => string> = [
  (type) => type.toLowerCase(),
  (type) => type.replace(SUFFIX_RE, "").toLowerCase(),
  canonicalKey,
];

/** Leader avatars are the Eximus spawns, which the codex counts separately. DE
 *  spells them both ways round, so both have to read as the same enemy. */
const isLeaderType = (type: string): boolean => /(AvatarLeader|LeaderAvatar)$/i.test(type);

const withoutLeader = (type: string): string =>
  type.replace(/AvatarLeader$/i, "Avatar").replace(/LeaderAvatar$/i, "Avatar");

// The wiki's InternalName is frequently not the path DE records a scan against,
// but its artwork filename usually is (Corrupted Heavy Gunner is
// OrokinMinigunBombard on the wiki and OrokinHeavyFemaleAvatar in a profile).
const artworkKeys = (value: string): Set<string> => {
  const base = value.replace(/\.png$/i, "");
  return new Set([base.toLowerCase(), base.replace(SUFFIX_RE, "").toLowerCase()].filter(Boolean));
};

const scanArtworkKeys = (scanType: string): string[] => {
  const segment = withoutLeader(scanType).split("/").filter(Boolean).pop() || "";
  return [segment.toLowerCase(), segment.replace(SUFFIX_RE, "").toLowerCase()];
};

const LEADER_SUFFIX = "#leader";

function fallbackName(type: string): string {
  const tail = type.split("/").filter(Boolean).pop() || type;
  return tail
    .replace(/(AvatarLeader|LeaderAvatar|Avatar|Agent)$/i, "")
    .replace(/([a-z])([A-Z])/g, "$1 $2");
}

function makeRow(
  type: string,
  name: string,
  scanned: number,
  required: number | null,
  faction: string | null,
  image: string | null,
): CodexRow {
  return {
    type,
    name,
    scanned,
    required,
    complete: required !== null ? scanned >= required : null,
    faction,
    image,
  };
}

/** Every known entry joined with the profile's scan counts, unknown scanned
 * types appended, so never-seen entries still show as 0 of N. */
export function buildCodexRows(scans: CodexScanEntry[]): CodexRow[] {
  // null: key claimed by two wiki entries, unusable at that level.
  const wikiByLevel = KEY_LEVELS.map((level) => {
    const map = new Map<string, string | null>();
    for (const type of Object.keys(CODEX_SCAN_REQUIREMENTS)) {
      const key = level(type);
      map.set(key, map.has(key) ? null : type);
    }
    return map;
  });
  const resolveWikiType = (scanType: string): string | null => {
    const base = withoutLeader(scanType);
    for (const [index, level] of KEY_LEVELS.entries()) {
      const hit = wikiByLevel[index].get(level(base));
      if (hit) return hit;
    }
    return null;
  };

  const wikiScanned = new Map<string, number>();
  const wikiLeaderScanned = new Map<string, number>();
  const credit = (target: string, entry: CodexScanEntry): void => {
    const counts = isLeaderType(entry.type) ? wikiLeaderScanned : wikiScanned;
    counts.set(target, Math.max(counts.get(target) ?? 0, entry.count));
  };

  const pending: CodexScanEntry[] = [];
  for (const entry of scans) {
    const target = resolveWikiType(entry.type);
    if (target) credit(target, entry);
    else pending.push(entry);
  }

  // Artwork is only a fallback, and only for entries the paths left unclaimed,
  // so a filename two enemies share cannot take a count off the one that
  // already matched. Still ambiguous after that means unusable, as elsewhere.
  const claimedTypes = new Set([...wikiScanned.keys(), ...wikiLeaderScanned.keys()]);
  const wikiByArtwork = new Map<string, string | null>();
  for (const [type, requirement] of Object.entries(CODEX_SCAN_REQUIREMENTS)) {
    if (claimedTypes.has(type) || !requirement.image) continue;
    for (const key of artworkKeys(requirement.image)) {
      const seen = wikiByArtwork.get(key);
      wikiByArtwork.set(key, seen === undefined || seen === type ? type : null);
    }
  }
  const resolveByArtwork = (scanType: string): string | null => {
    for (const key of scanArtworkKeys(scanType)) {
      const hit = wikiByArtwork.get(key);
      if (hit) return hit;
    }
    return null;
  };

  const looseScanned = new Map<string, number>();
  const unresolved: CodexScanEntry[] = [];
  for (const entry of pending) {
    const leader = isLeaderType(entry.type);
    const target = resolveByArtwork(entry.type);
    if (target) {
      credit(target, entry);
      continue;
    }
    const key = canonicalKey(withoutLeader(entry.type)) + (leader ? LEADER_SUFFIX : "");
    looseScanned.set(key, Math.max(looseScanned.get(key) ?? 0, entry.count));
    unresolved.push(entry);
  }

  const rows: CodexRow[] = [];
  for (const [type, requirement] of Object.entries(CODEX_SCAN_REQUIREMENTS)) {
    const image = requirement.image ?? null;
    const row = (suffix: string, name: string, scanned: number): CodexRow =>
      makeRow(type + suffix, name, scanned, requirement.scans, requirement.faction, image);
    rows.push(row("", requirement.name, wikiScanned.get(type) ?? 0));
    // The wiki lists no Eximus entries, but the codex gives every enemy that
    // spawns them one, so derive it rather than dropping the leader's scans.
    const leaderScanned = wikiLeaderScanned.get(type);
    if (leaderScanned !== undefined) {
      rows.push(row(LEADER_SUFFIX, `${requirement.name} Eximus`, leaderScanned));
    }
  }

  const wikiCovered = new Set<string>();
  for (const type of Object.keys(CODEX_SCAN_REQUIREMENTS)) wikiCovered.add(canonicalKey(type));

  // Male, female and base avatars are three keys for one codex entry, so extras
  // collapse by display name; only same-requirement forms fold (Mytocardia
  // Sac's large and small containers share a name).
  interface ExtraGroup {
    type: string;
    name: string;
    scanned: number;
    leaderScanned: number | null;
  }
  const extrasCovered = new Set<string>();
  const groups = new Map<string, ExtraGroup>();
  for (const [type, extra] of Object.entries(CODEX_EXTRA_INFO)) {
    const key = canonicalKey(type);
    if (wikiCovered.has(key)) continue;
    extrasCovered.add(key);
    extrasCovered.add(key + LEADER_SUFFIX);
    const name = extra.name || fallbackName(type);
    const scanned = looseScanned.get(key) ?? 0;
    const leaderScanned = looseScanned.get(key + LEADER_SUFFIX) ?? null;
    const groupKey = `${extra.faction}|${name}|${extra.scans ?? ""}`;
    const merged = groups.get(groupKey);
    if (!merged) {
      groups.set(groupKey, { type, name, scanned, leaderScanned });
    } else {
      merged.scanned = Math.max(merged.scanned, scanned);
      if (leaderScanned !== null) {
        merged.leaderScanned = Math.max(merged.leaderScanned ?? 0, leaderScanned);
      }
    }
  }
  for (const { type, name, scanned, leaderScanned } of groups.values()) {
    const extra = CODEX_EXTRA_INFO[type];
    const required = extra.scans ?? (extra.faction === "wildlife" ? WILDLIFE_REQUIRED_SCANS : null);
    const icon = extra.icon ?? null;
    rows.push(makeRow(type, name, scanned, required, extra.faction, icon));
    if (leaderScanned !== null) {
      rows.push(
        makeRow(
          type + LEADER_SUFFIX,
          `${name} Eximus`,
          leaderScanned,
          required,
          extra.faction,
          icon,
        ),
      );
    }
  }

  // Scanned types neither source claimed. Leaders keep their own bucket here
  // too, or an unknown enemy's Eximus count would land on the base row.
  const seen = new Set<string>();
  for (const entry of unresolved) {
    const leader = isLeaderType(entry.type);
    // Same key shape as the looseScanned write, or a LeaderAvatar path would
    // miss extrasCovered and duplicate an Eximus row the extras loop emitted.
    const key = canonicalKey(withoutLeader(entry.type)) + (leader ? LEADER_SUFFIX : "");
    if (extrasCovered.has(key) || seen.has(key)) continue;
    seen.add(key);
    const name = fallbackName(entry.type) + (leader ? " Eximus" : "");
    rows.push(makeRow(entry.type, name, looseScanned.get(key) ?? entry.count, null, null, null));
  }

  return sortCodexRows(rows, "name");
}

/** Complete entries count as full progress, unknown requirements sort last. */
function progressOf(row: CodexRow): number {
  if (row.required === null) return -1;
  if (row.required <= 0) return 1;
  return Math.min(1, row.scanned / row.required);
}

export function sortCodexRows(rows: CodexRow[], sortBy: CodexSortKey): CodexRow[] {
  const byName = (a: CodexRow, b: CodexRow): number => a.name.localeCompare(b.name);
  const sorted = [...rows];
  if (sortBy === "scans") sorted.sort((a, b) => b.scanned - a.scanned || byName(a, b));
  else if (sortBy === "progress")
    sorted.sort((a, b) => progressOf(b) - progressOf(a) || byName(a, b));
  else sorted.sort(byName);
  return sorted;
}
