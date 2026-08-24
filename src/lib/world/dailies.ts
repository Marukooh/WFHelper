import { nextDailyResetUtc, nextWeeklyResetUtc } from "../format.js";
import { readStorage, writeStorage } from "../persistence.js";

/** Calendar periods reset on the clock; the rest key off a world-state expiry. */
type TrackerPeriod =
  | "daily"
  | "weekly"
  | "sortie"
  | "archon"
  | "steelPath"
  | "baro"
  | "darvo"
  | "varzia";
export type TrackerGroup = "daily" | "nightwave" | "weekly" | "vendors" | "alerts";
/** The only periods a user may pick; the expiry-driven ones are ours to assign. */
export type TrackerUserPeriod = "daily" | "weekly";

interface TrackerDef {
  id: string;
  period: TrackerPeriod;
  /** Ticks needed to count as done; 1 renders a plain checkbox. */
  target: number;
  /** Wiki page name, omitted when no single page covers the task. */
  wiki?: string;
  /** Set only on user-added tasks; built-ins resolve `dailies.task.<id>`. */
  label?: string;
}

const STORAGE_KEY = "world-dailies";
const MAX_CUSTOM_TASKS = 30;
const MAX_LABEL_LENGTH = 60;
const MAX_TARGET = 99;
/** Live Nightwave acts and alerts rotate, so their progress rows are pruned. */
const DYNAMIC_ID = /^(nw|alert):/;

export const BUILTIN_TASKS: readonly TrackerDef[] = [
  { id: "sortie", period: "sortie", target: 1, wiki: "Sortie" },
  { id: "spIncursions", period: "daily", target: 5, wiki: "Steel Path" },
  { id: "simaris", period: "daily", target: 1, wiki: "Cephalon Simaris" },
  { id: "syndicateStanding", period: "daily", target: 1, wiki: "Syndicate" },
  { id: "archonHunt", period: "archon", target: 1, wiki: "Archon Hunt" },
  { id: "circuitNormal", period: "weekly", target: 1, wiki: "The Circuit" },
  { id: "circuitSteelPath", period: "weekly", target: 1, wiki: "The Circuit" },
  { id: "netracells", period: "weekly", target: 5, wiki: "Netracell" },
  { id: "deepArchimedea", period: "weekly", target: 1, wiki: "Deep Archimedea" },
  { id: "temporalArchimedea", period: "weekly", target: 1, wiki: "Temporal Archimedea" },
  { id: "kahl", period: "weekly", target: 1, wiki: "Kahl's Garrison" },
  { id: "clem", period: "weekly", target: 1, wiki: "Clem" },
  { id: "ayatanHunt", period: "weekly", target: 1, wiki: "Maroo" },
  { id: "ergoGlast", period: "weekly", target: 1, wiki: "Ergo Glast" },
  { id: "steelPathHonors", period: "steelPath", target: 1, wiki: "Teshin" },
  { id: "baro", period: "baro", target: 1, wiki: "Baro Ki'Teer" },
  { id: "varzia", period: "varzia", target: 1, wiki: "Prime Resurgence" },
  { id: "darvo", period: "darvo", target: 1, wiki: "Darvo" },
];

/** World-state expiries that drive the non-calendar periods, null while unknown. */
export interface TrackerExpiries {
  sortie: string | null;
  archon: string | null;
  steelPath: string | null;
  baro: string | null;
  darvo: string | null;
  varzia: string | null;
}

interface TrackerEntry {
  /** Period the count belongs to; a mismatch means the task has since reset. */
  key: string;
  count: number;
}

export interface TrackerState {
  progress: Record<string, TrackerEntry>;
  hidden: string[];
  periods: Record<string, TrackerUserPeriod>;
  custom: TrackerDef[];
  /** Monotonic suffix for custom ids so a deleted task never reuses one. */
  seq: number;
}

export function trackerGroup(period: TrackerPeriod): TrackerGroup {
  if (period === "baro" || period === "darvo" || period === "varzia") return "vendors";
  if (period === "weekly" || period === "steelPath" || period === "archon") return "weekly";
  return "daily";
}

/** Stable key for anything that resets with a world-state window rather than the clock. */
export function expiryPeriodKey(prefix: string, expiry: string | null | undefined): string | null {
  return expiry ? `${prefix}:${expiry}` : null;
}

/**
 * Null when the world state has not supplied the expiry yet, which tells callers
 * to keep the stored progress instead of clearing it against an unknown period.
 */
export function trackerPeriodKey(
  period: TrackerPeriod,
  now: Date,
  expiries: TrackerExpiries,
): string | null {
  if (period === "daily") return `daily:${nextDailyResetUtc(now).toISOString()}`;
  if (period === "weekly") return `weekly:${nextWeeklyResetUtc(now).toISOString()}`;
  return expiryPeriodKey(period, expiries[period]);
}

function emptyState(): TrackerState {
  return { progress: {}, hidden: [], periods: {}, custom: [], seq: 0 };
}

function isUserPeriod(value: unknown): value is TrackerUserPeriod {
  return value === "daily" || value === "weekly";
}

function reviveCustom(raw: unknown): TrackerDef[] {
  if (!Array.isArray(raw)) return [];
  const revived: TrackerDef[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const { id, label, period, target } = entry as Record<string, unknown>;
    if (typeof id !== "string" || typeof label !== "string" || !label.trim()) continue;
    revived.push({
      id,
      label: label.slice(0, MAX_LABEL_LENGTH),
      period: isUserPeriod(period) ? period : "daily",
      target: typeof target === "number" && target >= 1 ? Math.min(target, MAX_TARGET) : 1,
    });
    if (revived.length >= MAX_CUSTOM_TASKS) break;
  }
  return revived;
}

function reviveProgress(raw: unknown): Record<string, TrackerEntry> {
  if (!raw || typeof raw !== "object") return {};
  const revived: Record<string, TrackerEntry> = {};
  for (const [id, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (!entry || typeof entry !== "object") continue;
    const { key, count } = entry as Record<string, unknown>;
    if (typeof key !== "string" || typeof count !== "number" || !Number.isFinite(count)) continue;
    revived[id] = { key, count: Math.max(0, Math.min(Math.trunc(count), MAX_TARGET)) };
  }
  return revived;
}

function revivePeriods(raw: unknown): Record<string, TrackerUserPeriod> {
  if (!raw || typeof raw !== "object") return {};
  const revived: Record<string, TrackerUserPeriod> = {};
  for (const [id, period] of Object.entries(raw as Record<string, unknown>)) {
    if (isUserPeriod(period)) revived[id] = period;
  }
  return revived;
}

export function loadTracker(): TrackerState {
  const raw = readStorage(STORAGE_KEY);
  if (!raw) return emptyState();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return emptyState();
    const source = parsed as Record<string, unknown>;
    const custom = reviveCustom(source.custom);
    const seq = source.seq;
    return {
      progress: reviveProgress(source.progress),
      hidden: Array.isArray(source.hidden)
        ? source.hidden.filter((id): id is string => typeof id === "string")
        : [],
      periods: revivePeriods(source.periods),
      custom,
      seq: typeof seq === "number" && seq >= 0 ? Math.trunc(seq) : custom.length,
    };
  } catch {
    return emptyState();
  }
}

export function saveTracker(state: TrackerState): void {
  writeStorage(STORAGE_KEY, JSON.stringify(state));
}

/** Built-ins plus custom tasks, with any user period override applied. */
export function trackerList(state: TrackerState): TrackerDef[] {
  return [...BUILTIN_TASKS, ...state.custom].map((task) => {
    const override = state.periods[task.id];
    return override ? { ...task, period: override } : task;
  });
}

/** Baro and Varzia key off the visit's ACTIVATION (stable from "away" through
 *  "here", see `trackerExpiries`), so a past date there says nothing about the
 *  window still being open. */
const ACTIVATION_KEYED = /^(baro|varzia):/;

/** Every other key ends in the ISO expiry it was recorded against, which is the
 *  only way to date stored progress while the live period key is unknown. */
function keyExpiryMs(key: string): number | null {
  if (ACTIVATION_KEYED.test(key)) return null;
  const parsed = Date.parse(key.slice(key.indexOf(":") + 1));
  return Number.isFinite(parsed) ? parsed : null;
}

export function trackerCount(
  state: TrackerState,
  id: string,
  periodKey: string | null,
  nowMs: number,
): number {
  const entry = state.progress[id];
  if (!entry) return 0;
  if (periodKey !== null) return entry.key === periodKey ? entry.count : 0;
  // Offline or after a failed fetch: retire an entry whose own window has closed,
  // but keep anything undateable rather than silently dropping progress.
  const expiryMs = keyExpiryMs(entry.key);
  return expiryMs !== null && expiryMs <= nowMs ? 0 : entry.count;
}

export function setTrackerCount(
  state: TrackerState,
  id: string,
  periodKey: string | null,
  count: number,
): TrackerState {
  const key = periodKey ?? state.progress[id]?.key ?? "";
  const clamped = Math.max(0, Math.min(Math.trunc(count), MAX_TARGET));
  return { ...state, progress: { ...state.progress, [id]: { key, count: clamped } } };
}

/** Rotating Nightwave acts and alerts would grow the store forever otherwise. */
export function pruneDynamicProgress(state: TrackerState, liveIds: Set<string>): TrackerState {
  const stale = Object.keys(state.progress).filter((id) => DYNAMIC_ID.test(id) && !liveIds.has(id));
  if (stale.length === 0) return state;
  const progress = { ...state.progress };
  for (const id of stale) delete progress[id];
  return { ...state, progress };
}

export function toggleTrackerHidden(state: TrackerState, id: string): TrackerState {
  const hidden = state.hidden.includes(id)
    ? state.hidden.filter((entry) => entry !== id)
    : [...state.hidden, id];
  return { ...state, hidden };
}

export function setTrackerPeriod(
  state: TrackerState,
  id: string,
  period: TrackerUserPeriod,
): TrackerState {
  const custom = state.custom.map((task) => (task.id === id ? { ...task, period } : task));
  return { ...state, periods: { ...state.periods, [id]: period }, custom };
}

/** Built-in targets follow game rules, so only user-added tasks are retargetable. */
export function setTrackerTarget(state: TrackerState, id: string, target: number): TrackerState {
  const clamped = Math.max(1, Math.min(Math.trunc(target) || 1, MAX_TARGET));
  return {
    ...state,
    custom: state.custom.map((task) => (task.id === id ? { ...task, target: clamped } : task)),
  };
}

export function addCustomTask(
  state: TrackerState,
  label: string,
  period: TrackerUserPeriod,
): TrackerState {
  const trimmed = label.trim().slice(0, MAX_LABEL_LENGTH);
  if (!trimmed || state.custom.length >= MAX_CUSTOM_TASKS) return state;
  const seq = state.seq + 1;
  const added: TrackerDef = { id: `custom:${seq}`, label: trimmed, period, target: 1 };
  return { ...state, seq, custom: [...state.custom, added] };
}

export function removeCustomTask(state: TrackerState, id: string): TrackerState {
  if (!state.custom.some((task) => task.id === id)) return state;
  const progress = { ...state.progress };
  delete progress[id];
  const periods = { ...state.periods };
  delete periods[id];
  return {
    ...state,
    progress,
    periods,
    custom: state.custom.filter((task) => task.id !== id),
    hidden: state.hidden.filter((entry) => entry !== id),
  };
}
