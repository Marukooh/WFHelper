import { derived, writable, type Readable } from "svelte/store";
import { en, type MessageKey } from "../i18n/en.js";
import { send } from "./ipc.js";
import { OVERLAY_LOCALE_UPDATED } from "../../config/shared/ipcChannels.js";

type MessageParamValue = string | number;
type MessageParams = Record<string, MessageParamValue>;
export type LocaleCode = "en" | "de" | "zh";
type LocaleDictionary = Partial<Record<MessageKey, string>>;
export type Translator = (key: MessageKey, params?: MessageParams) => string;

export const LOCALE_OPTIONS: ReadonlyArray<{ code: LocaleCode; label: string }> = [
  { code: "en", label: "English" },
  { code: "de", label: "Deutsch" },
  { code: "zh", label: "简体中文" },
];

const LOCALE_STORAGE_KEY = "app-language";

// English is the fallback for every missing key, so it ships in the main chunk.
// Every other locale is its own chunk and only the active one is ever fetched.
const LOADERS: Record<Exclude<LocaleCode, "en">, () => Promise<LocaleDictionary>> = {
  de: () => import("../i18n/de.json").then((module) => module.default),
  zh: () => import("../i18n/zh.json").then((module) => module.default),
};

const dictionaries = writable<Partial<Record<LocaleCode, LocaleDictionary>>>({ en });

function isLocaleCode(value: string | null): value is LocaleCode {
  return value != null && LOCALE_OPTIONS.some((option) => option.code === value);
}

// detectLocale runs at import time, so a webview without navigator.language must not throw here.
function osLanguage(): string {
  if (typeof navigator === "undefined") return "";
  const language: unknown = navigator.language;
  return typeof language === "string" ? language : "";
}

/** Stored choice first, then the OS language, then English. */
function detectLocale(): LocaleCode {
  try {
    const stored = localStorage.getItem(LOCALE_STORAGE_KEY);
    if (isLocaleCode(stored)) return stored;
  } catch {
    // no localStorage (tests, hardened webview)
  }
  const osLang = osLanguage().slice(0, 2);
  return isLocaleCode(osLang) ? osLang : "en";
}

const localeStore = writable<LocaleCode>(detectLocale());

// Read-only so setLocale is the only writer; a bare locale.set would skip persistence.
export const locale: Readable<LocaleCode> = { subscribe: localeStore.subscribe };

const pending = new Map<LocaleCode, Promise<void>>();

// Resolves once the locale can render; English until then, which is what a
// missing key falls back to anyway, so the swap is never a blank UI.
function loadLocale(code: LocaleCode): Promise<void> {
  const loader = code === "en" ? null : LOADERS[code];
  if (!loader) return Promise.resolve();
  let inFlight = pending.get(code);
  if (!inFlight) {
    inFlight = loader()
      .then((dict) => {
        dictionaries.update((all) => ({ ...all, [code]: dict }));
      })
      .catch(() => {
        pending.delete(code);
      });
    pending.set(code, inFlight);
  }
  return inFlight;
}

export function setLocale(code: LocaleCode): void {
  void loadLocale(code);
  localeStore.set(code);
  try {
    localStorage.setItem(LOCALE_STORAGE_KEY, code);
  } catch {
    // no localStorage (tests, hardened webview)
  }
}

void loadLocale(detectLocale());

// index.html ships lang="en" as the boot value; keep the attribute following the live locale.
if (typeof document !== "undefined") {
  localeStore.subscribe((code) => {
    document.documentElement.lang = code;
  });
}

// The in-game overlays are plain HTML windows without store access, so the main
// process resolves their text; it only needs to know which language is active.
localeStore.subscribe((code) => {
  if (typeof window === "undefined") return;
  if (typeof window.api?.updateOverlayLocale !== "function") return;
  send(OVERLAY_LOCALE_UPDATED, code);
});

function interpolate(template: string, params: MessageParams): string {
  return template.replace(/\{(\w+)\}/g, (_match, key: string) => {
    const value = params[key];
    return value == null ? `{${key}}` : String(value);
  });
}

function createTranslator(dict: LocaleDictionary): Translator {
  return (key, params = {}) => {
    const template = dict[key] ?? en[key] ?? key;
    return interpolate(template, params);
  };
}

// Svelte only tracks $tr where it is textual: a helper that reads it is untracked
// at the call site. Return a MessageKey, or take the translator as a parameter.
export const tr = derived([localeStore, dictionaries], ([$locale, $dictionaries]) => {
  return createTranslator($dictionaries[$locale] ?? en);
});

export type { MessageKey };
