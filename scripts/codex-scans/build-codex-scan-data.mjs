// Builds Codex scan data from the Warframe wiki enemy modules (CC BY-SA) and
// DE PublicExport animals, objects and fragments.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const FACTIONS = [
  "grineer",
  "corpus",
  "infestation",
  "orokin",
  "sentient",
  "stalker",
  "narmer",
  "themurmur",
  "techrot",
  "scaldra",
  "anarchs",
  "unaffiliated",
];

const OUT_FILE = path.join(process.cwd(), "src", "data", "codexScanRequirements.ts");

function parseEntries(lua, faction) {
  const entries = [];
  // Each enemy's General block carries InternalName, Name and Scans in one
  // brace group; field order varies, so pluck fields independently per block.
  const blocks = lua.split(/General\s*=\s*\{/).slice(1);
  for (const block of blocks) {
    const internal = block.match(/InternalName\s*=\s*"([^"]+)"/)?.[1];
    const name = block.match(/\bName\s*=\s*"([^"]+)"/)?.[1];
    const scans = block.match(/\bScans\s*=\s*(\d+)/)?.[1];
    const image = block.match(/\bImage\s*=\s*"([^"]+)"/)?.[1] ?? null;
    if (!internal || !name || !scans) continue;
    entries.push({ internal, name, scans: Number(scans), faction, image });
  }
  return entries;
}

const all = new Map();
for (const faction of FACTIONS) {
  const url = `https://wiki.warframe.com/w/Module:Enemies/data/${faction}?action=raw`;
  const res = await fetch(url, { headers: { "User-Agent": "WFHelper data build" } });
  if (!res.ok) {
    throw new Error(`${faction}: HTTP ${res.status} - refusing to overwrite`);
  }
  const entries = parseEntries(await res.text(), faction);
  if (entries.length === 0)
    throw new Error(`${faction}: no entries parsed - refusing to overwrite`);
  for (const entry of entries) {
    if (!all.has(entry.internal)) all.set(entry.internal, entry);
  }
  console.log(`${faction}: ${entries.length} entries`);
}

if (all.size < 300) {
  console.error(`only ${all.size} entries parsed - refusing to overwrite`);
  process.exit(1);
}

// The wiki module points a few entries at DE's red pixel codex sprites; the
// wiki's own pages display these renders instead.
const WIKI_IMAGE_OVERRIDES = {
  "Decaying Battalyst": "SentientTrooper.png",
  "Decaying Conculyst": "SentientMeleeTrooper.png",
  "Kavor Defector": "KavorDefector.png",
  "Senta Turret": "FortressAutoTurret.png",
};
for (const entry of all.values()) {
  if (entry.image && (entry.image === "?" || !entry.image.includes("."))) entry.image = null;
  const override = WIKI_IMAGE_OVERRIDES[entry.name];
  if (override) entry.image = override;
}

// Conservation animals, codex objects, lore fragments and songs are absent
// from the wiki enemy modules but present in profile scan stats; DE's export
// carries their names, icons and (for codex sections) required scan counts.
const pepDir = path.join(process.cwd(), "node_modules", "warframe-public-export-plus");
const readPep = (file) => JSON.parse(fs.readFileSync(path.join(pepDir, file), "utf-8"));
const dictEn = readPep("dict.en.json");
const MIRROR_BASE = "https://assets.wfhelper.com";

// Matches services/itemDatabase.ts toIconMirrorUrl: same source URL, same hash.
function deIconMirror(iconPath) {
  if (typeof iconPath !== "string" || !iconPath.startsWith("/")) return null;
  const sourceUrl = `https://browse.wf${iconPath}`;
  const rawExt = path.extname(iconPath).toLowerCase();
  const ext = rawExt && rawExt.length <= 8 ? rawExt : ".png";
  const hash = crypto.createHash("sha256").update(sourceUrl).digest("hex").slice(0, 24);
  return { sourceUrl, mirrorUrl: `${MIRROR_BASE}/icons/${hash}${ext}` };
}

// Lore fragment pages pair each Codex display name with its wiki artwork.
const FRAGMENT_PAGES = [
  "Fragments/Cephalon",
  "Fragments/Fish",
  "Fragments/Glass",
  "Fragments/Ghoul",
  "Fragments/Revenant",
  "Fragments/Solaris United",
  "Fragments/Partnership",
  "Fragments/The Tenets",
  // Fragments/Duviri is absent on purpose: every block there has an empty
  // image field, so the parse below yields nothing and refuses to overwrite.
  "Fragments/Albrecht",
  "Fragments/Isleweaver",
];
// Solaris filenames carry the vendor omitted from the fragment field.
const SOLARIS_VENDORS = {
  Eudico: "Eudico",
  Legs: "Legs",
  LittleDuck: "Little Duck's",
  RudeZuud: "Rude Zuud's",
  Smokefinger: "Smokefinger's",
  TheBusiness: "The Business'",
  Ticker: "Ticker's",
};
const normFragmentName = (name) =>
  name.toLowerCase().replace(/[‘’]/g, "'").replace(/[–—]/g, "-").replace(/\s+/g, " ").trim();
const fragmentImageByName = new Map();
for (const page of FRAGMENT_PAGES) {
  const url = `https://wiki.warframe.com/w/${encodeURI(page)}?action=raw`;
  const res = await fetch(url, { headers: { "User-Agent": "WFHelper data build" } });
  if (!res.ok) {
    throw new Error(`${page}: HTTP ${res.status} - refusing to overwrite`);
  }
  const text = await res.text();
  let parsedImages = 0;
  for (const block of text.split(/\{\{Fragments\s*\n/).slice(1)) {
    let name = block.match(/(?:^|\|)\s*fragment\s*=\s*([^\n|]+)/)?.[1]?.trim();
    const image = block.match(/(?:^|\|)\s*image\s*=\s*([^\n|]+)/)?.[1]?.trim();
    if (!image) continue;
    const solaris = /^Frag_SU(\w+)_0*(\d+)\.png$/.exec(image);
    if (solaris && SOLARIS_VENDORS[solaris[1]]) {
      name = `${SOLARIS_VENDORS[solaris[1]]} Mem Fragment ${solaris[2]}/5`;
    }
    if (!name) continue;
    parsedImages += 1;
    const key = normFragmentName(name);
    if (!fragmentImageByName.has(key)) fragmentImageByName.set(key, image);
  }
  if (parsedImages === 0)
    throw new Error(`${page}: no fragment artwork parsed - refusing to overwrite`);
}
console.log(`wiki fragment artwork: ${fragmentImageByName.size} names`);

// Albrecht entries carry a set prefix the wiki page titles drop.
function wikiFragmentImage(name) {
  if (!name) return null;
  const key = normFragmentName(name);
  const direct = fragmentImageByName.get(key);
  if (direct) return direct;
  const dash = key.indexOf(" - ");
  return dash >= 0 ? (fragmentImageByName.get(key.slice(dash + 3)) ?? null) : null;
}

const extras = new Map();
const codexIconSources = new Set();
const fragmentImagesUsed = new Set();
function resolveName(rawName) {
  return typeof rawName === "string" && rawName.startsWith("/")
    ? (dictEn[rawName] || "").replace(/<[^>]+>/g, "").trim() || null
    : rawName || null;
}

function addExtra(key, rawName, icon, faction, reqScans, wikiImage = null) {
  if (all.has(key) || extras.has(key)) return;
  const name = resolveName(rawName);
  const resolved = icon ? deIconMirror(icon) : null;
  if (!name && !resolved) return;
  if (resolved) codexIconSources.add(resolved.sourceUrl);
  if (!resolved && wikiImage) fragmentImagesUsed.add(wikiImage);
  extras.set(key, {
    name,
    icon: resolved ? resolved.mirrorUrl : wikiImage,
    faction,
    scans: Number.isFinite(reqScans) && reqScans > 0 ? reqScans : null,
  });
}

for (const [key, animal] of Object.entries(readPep("ExportAnimals.json"))) {
  addExtra(key, animal.name, animal.icon, "wildlife", null);
}
const CODEX_SECTION_FACTION = {
  objects: "objects",
  loreFragments: "lore",
  songs: "lore",
  fighterFrames: "objects",
};
// Matching ship decorations fill icons omitted from Codex fragment records.
const resourceIconByName = new Map();
for (const item of Object.values(readPep("ExportResources.json"))) {
  if (!item.icon) continue;
  const name = resolveName(item.name);
  if (!name) continue;
  resourceIconByName.set(name, resourceIconByName.has(name) ? null : item.icon);
}
for (const [section, sectionEntries] of Object.entries(readPep("ExportCodex.json"))) {
  const faction = CODEX_SECTION_FACTION[section] || "objects";
  for (const [key, item] of Object.entries(sectionEntries || {})) {
    const icon = item.icon ?? resourceIconByName.get(resolveName(item.name)) ?? null;
    const wikiImage =
      section === "loreFragments" && !icon ? wikiFragmentImage(resolveName(item.name)) : null;
    addExtra(key, item.name, icon, faction, item.reqScans, wikiImage);
  }
}

// DE records a plant scan against the world path but ships its name and icon on
// the pickup item, and the two disagree on word order, so the pairing is spelled
// out. No export or wiki source states a required scan count for plants.
const PLANT_ITEM_BY_SCAN_NAME = {
  DayCommonPlant: "CommonDayPlantItem",
  DayRarePlant: "RareDayPlantItem",
  DayUnCommonPlant: "UnCommonDayPlantItem",
  GftPlantRuksClawMaturePlant: "GftPlantRuksClawMaturePlantItem",
  MossGroundCoverAPlant: "MossGroundCoverAPlantItem",
  NightCommonPlant: "CommonNightPlantItem",
  NightRarePlant: "RareNightPlantItem",
  NightUnCommonPlant: "UnCommonNightPlantItem",
  WildGingerBPlant: "WildGingerBPlantItem",
  ZenCobraLotusPlant: "ZenCobraLotusPlantItem",
  ZenPitcherPlant: "ZenPitcherPlantItem",
};
const plantResources = readPep("ExportResources.json");
for (const [scanName, itemName] of Object.entries(PLANT_ITEM_BY_SCAN_NAME)) {
  const item = plantResources[`/Lotus/Types/Items/Plants/MiscItems/${itemName}`];
  if (!item) {
    console.warn(`[codex] plant item missing from ExportResources: ${itemName}`);
    continue;
  }
  addExtra(`/Lotus/Types/Items/Plants/${scanName}`, item.name, item.icon, "objects", null);
}

const sorted = [...all.values()].sort((a, b) => a.internal.localeCompare(b.internal));
const lines = sorted.map((e) => {
  const image = e.image ? `, image: ${JSON.stringify(e.image)}` : "";
  return (
    `  ${JSON.stringify(e.internal)}: { name: ${JSON.stringify(e.name)}, ` +
    `scans: ${e.scans}, faction: ${JSON.stringify(e.faction)}${image} },`
  );
});
const banner =
  `// Generated by scripts/codex-scans/build-codex-scan-data.mjs; do not edit.\n` +
  `// Source: wiki.warframe.com Module:Enemies/data/* (CC BY-SA).\n\n`;
const extraLines = [...extras.entries()]
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([key, extra]) => {
    const fields = [
      extra.name ? `name: ${JSON.stringify(extra.name)}` : null,
      extra.icon ? `icon: ${JSON.stringify(extra.icon)}` : null,
      `faction: ${JSON.stringify(extra.faction)}`,
      extra.scans ? `scans: ${extra.scans}` : null,
    ].filter(Boolean);
    return `  ${JSON.stringify(key)}: { ${fields.join(", ")} },`;
  });

const body =
  `export const CODEX_SCAN_REQUIREMENTS: Record<\n` +
  `  string,\n` +
  `  { name: string; scans: number; faction: string; image?: string }\n` +
  `> = {\n` +
  lines.join("\n") +
  `\n};\n\n` +
  `// Profile-only scans from DE PublicExport, with mirrored DE or wiki art.\n` +
  `export const CODEX_EXTRA_INFO: Record<\n` +
  `  string,\n` +
  `  { name?: string; icon?: string; faction: string; scans?: number }\n` +
  `> = {\n` +
  extraLines.join("\n") +
  `\n};\n`;
fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
fs.writeFileSync(OUT_FILE, banner + body);

// Sidecars for the icon mirror: wiki image filenames the table references, and
// the DE texture source URLs the extras need mirrored.
const images = [
  ...new Set([...sorted.map((e) => e.image), ...fragmentImagesUsed].filter(Boolean)),
].sort();
const IMAGES_FILE = path.join(process.cwd(), "scripts", "icon-mirror", "enemy-images.json");
fs.writeFileSync(IMAGES_FILE, JSON.stringify(images, null, 2) + "\n");
const CODEX_ICONS_FILE = path.join(process.cwd(), "scripts", "icon-mirror", "codex-icon-urls.json");
fs.writeFileSync(CODEX_ICONS_FILE, JSON.stringify([...codexIconSources].sort(), null, 2) + "\n");
console.log(
  `wrote ${OUT_FILE} with ${sorted.length} enemies + ${extras.size} extras, ` +
    `${images.length} wiki images, ${codexIconSources.size} DE icon sources`,
);
