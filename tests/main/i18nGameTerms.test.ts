import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import de from "../../src/i18n/de.json";
import zh from "../../src/i18n/zh.json";
import { en } from "../../src/i18n/en";

// The package blocks deep imports through "exports", so read the files directly.
const DICT_DIR = path.resolve(__dirname, "../../node_modules/warframe-public-export-plus");

function officialDict(locale: string): Record<string, string> {
  return JSON.parse(fs.readFileSync(path.join(DICT_DIR, `dict.${locale}.json`), "utf8"));
}

const OFFICIAL_EN = officialDict("en");
const OFFICIAL_DE = officialDict("de");
const OFFICIAL_ZH = officialDict("zh");

type Term = {
  en: string;
  de: string;
  stem?: string;
  enPattern?: RegExp;
  ownChoice?: string;
  /** Absent where the export never renders the term alone in Chinese. */
  zh?: string;
  zhStem?: string;
};

const englishPattern = (term: Term): RegExp =>
  term.enPattern ?? new RegExp(`\\b${term.en}(s|es)?\\b`, "i");

// Match Digital Extremes by default; ownChoice records deliberate differences.
const TERMS: Term[] = [
  { en: "Arbitration", de: "Arbitration", ownChoice: "German players say the English word" },
  { en: "Relic", de: "Relikt", zh: "虚空遗物", zhStem: "遗物" },
  { en: "Orokin Ducats", de: "Orokin Dukaten", zh: "奥罗金杜卡德金币", zhStem: "杜卡德" },
  { en: "Rifle", de: "Gewehr", zh: "步枪" },
  { en: "Shotgun", de: "Schrot", zh: "霰弹枪" },
  { en: "Melee", de: "Nahkampf", zh: "近战" },
  { en: "Vitus Essence", de: "Vitus-Essenz", zh: "生息精华" },
  { en: "The Circuit", de: "Der Rundkurs", stem: "Rundkurs", zh: "无尽回廊" },
  { en: "Riven", de: "Riven", zh: "裂罅" },
  { en: "Kuva", de: "Kuva", zh: "赤毒" },
  { en: "Endo", de: "Endo", zh: "内融核心" },
  { en: "Nightwave", de: "Nightwave", zh: "午夜电波" },
  { en: "Railjack", de: "Railjack", zh: "航道星舰" },
  { en: "Cetus", de: "Cetus", zh: "希图斯" },
  { en: "Duviri", de: "Duviri", zh: "双衍王境" },
];

// Words DE only writes inside longer phrases, so they cannot be pinned against
// the export; the consistency check below is what keeps them honest.
const UNPINNED: Term[] = [
  { en: "Foundry", de: "Schmiede" },
  { en: "Platinum", de: "Platinum" },
  { en: "Ducats", de: "Dukaten" },
  { en: "Fissure", de: "Riss" },
  { en: "Bounty", de: "Auftrag", stem: "Auftr", enPattern: /\bBount(y|ies)\b/i },
  { en: "Invasion", de: "Invasion" },
  { en: "Mastery", de: "Meisterschaft" },
  { en: "Arcane", de: "Arkana", stem: "Arkan" },
  { en: "Veiled", de: "Verschleiert", stem: "erschleiert", zh: "未揭示" },
  { en: "Credits", de: "Credits" },
];

function shippedOfficial(term: Term, dict: Record<string, string>): Set<string> {
  const needle = term.en.toLowerCase();
  const shipped = new Set<string>();
  for (const [key, value] of Object.entries(OFFICIAL_EN)) {
    if (typeof value === "string" && value.trim().toLowerCase() === needle && dict[key]) {
      shipped.add(dict[key].trim());
    }
  }
  return shipped;
}

describe("german game terminology", () => {
  it("matches the game's own German unless a term says otherwise", () => {
    const wrong: string[] = [];

    for (const term of TERMS) {
      const shipped = shippedOfficial(term, OFFICIAL_DE);
      if (term.ownChoice) {
        if (shipped.has(term.de)) {
          wrong.push(`${term.en}: ownChoice "${term.ownChoice}" is stale, DE now agrees with us`);
        }
      } else if (shipped.size === 0) {
        wrong.push(`${term.en}: gone from the DE export, move it to UNPINNED or re-pin it`);
      } else if (!shipped.has(term.de)) {
        wrong.push(`${term.en}: we use "${term.de}", DE uses ${[...shipped].join(" / ")}`);
      }
    }

    expect(wrong).toEqual([]);
  });

  it("uses each term the same way everywhere", () => {
    // Catch half-migrated wording after a German term is chosen.
    const inconsistent: string[] = [];

    for (const term of [...TERMS, ...UNPINNED]) {
      const mentions = englishPattern(term);
      const stem = (term.stem ?? term.de).toLowerCase();
      for (const [key, value] of Object.entries(en)) {
        const german = de[key as keyof typeof de];
        if (german === undefined || !mentions.test(value)) continue;
        if (!german.toLowerCase().includes(stem)) {
          inconsistent.push(`${key}: English says ${term.en}, German drops "${term.de}"`);
        }
      }
    }

    expect(inconsistent).toEqual([]);
  });
});

describe("chinese game terminology", () => {
  const pinned = TERMS.filter((term) => term.zh !== undefined);

  it("matches the game's own Chinese", () => {
    const wrong: string[] = [];

    for (const term of pinned) {
      const shipped = shippedOfficial(term, OFFICIAL_ZH);
      if (shipped.size === 0) {
        wrong.push(`${term.en}: gone from the CN export, drop its zh pin`);
      } else if (!shipped.has(term.zh!)) {
        wrong.push(`${term.en}: we use "${term.zh}", DE uses ${[...shipped].join(" / ")}`);
      }
    }

    expect(wrong).toEqual([]);
  });

  it("uses each term the same way everywhere", () => {
    // Chinese is a partial catalogue, so an absent key is fine; a present key
    // that drops the agreed word is the half-migrated wording this catches.
    const inconsistent: string[] = [];

    for (const term of [...TERMS, ...UNPINNED]) {
      if (term.zh === undefined) continue;
      const mentions = englishPattern(term);
      const stem = term.zhStem ?? term.zh;
      for (const [key, value] of Object.entries(en)) {
        const chinese = zh[key as keyof typeof zh];
        if (chinese === undefined || !mentions.test(value)) continue;
        if (!chinese.includes(stem)) {
          inconsistent.push(`${key}: English says ${term.en}, Chinese drops "${term.zh}"`);
        }
      }
    }

    expect(inconsistent).toEqual([]);
  });
});
