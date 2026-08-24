// DE ships a name dictionary per client language, so localized item names need no
// human translation. English stays canonical everywhere inside main: it is the
// join key for warframe.market, OCR matching and every by-name lookup we own.

import fs from "node:fs";
import path from "node:path";

import { normalizeErrorMessage } from "../config/shared/errors";
import { withScope } from "./logger";

const log = withScope("gameLocale");

export const GAME_LOCALES = [
  "en",
  "de",
  "es",
  "fr",
  "it",
  "ja",
  "ko",
  "pl",
  "pt",
  "ru",
  "tc",
  "th",
  "tr",
  "uk",
  "zh",
] as const;

type GameLocale = (typeof GAME_LOCALES)[number];

export const DEFAULT_GAME_LOCALE: GameLocale = "en";

type NameMap = Readonly<Record<string, string>>;

const EMPTY: NameMap = Object.freeze({});

let activeLocale: GameLocale = DEFAULT_GAME_LOCALE;
let activeNames: NameMap = EMPTY;
const cache = new Map<GameLocale, NameMap>();

export function isGameLocale(value: unknown): value is GameLocale {
  return typeof value === "string" && (GAME_LOCALES as readonly string[]).includes(value);
}

// Read from disk rather than importing: resolveJsonModule would hand tsc fifteen
// 7500-key literal types to infer, and the build slows to a crawl.
function candidateFiles(code: GameLocale): string[] {
  const parts = ["src", "data", "itemNames", `${code}.json`];
  return [
    path.resolve(__dirname, "..", ...parts),
    path.resolve(__dirname, "..", "..", ...parts),
    path.resolve(process.cwd(), ...parts),
  ];
}

function loadNames(code: GameLocale): NameMap {
  const cached = cache.get(code);
  if (cached) return cached;
  if (code === DEFAULT_GAME_LOCALE) {
    cache.set(code, EMPTY);
    return EMPTY;
  }
  for (const file of candidateFiles(code)) {
    try {
      if (!fs.existsSync(file)) continue;
      const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as NameMap;
      log.info(`${code}: ${Object.keys(parsed).length} names loaded`);
      cache.set(code, parsed);
      return parsed;
    } catch (err) {
      log.warn(`${code}: failed to read ${file}: ${normalizeErrorMessage(err)}`);
    }
  }
  log.warn(`${code}: no name table found, falling back to English`);
  cache.set(code, EMPTY);
  return EMPTY;
}

/** Returns the newly active locale, or null when nothing changed. */
export function setGameLocale(code: unknown): GameLocale | null {
  const next = isGameLocale(code) ? code : DEFAULT_GAME_LOCALE;
  if (next === activeLocale) return null;
  activeLocale = next;
  activeNames = loadNames(next);
  return next;
}

/**
 * Localized name for a `/Lotus/Language/...` key, or the English fallback.
 * A locale may be partial, so every hole resolves to English.
 */
export function localizeName(nameKey: string | null | undefined, fallback: string): string {
  if (!nameKey) return fallback;
  return activeNames[nameKey] || fallback;
}

/** Active game language code, for callers that pick a whole DE dictionary. */
export function getGameLocale(): string {
  return activeLocale;
}

/** True while the active locale can actually change a name. */
export function isLocalizingNames(): boolean {
  return activeLocale !== DEFAULT_GAME_LOCALE && Object.keys(activeNames).length > 0;
}
