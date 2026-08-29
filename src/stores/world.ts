import { writable } from "svelte/store";
import { persistedString } from "../lib/persistence.js";
import type { WorldState } from "../types/world.js";

export const worldData = writable<WorldState | null>(null);
export const worldLastFetch = writable<number>(0);
export const worldLoading = writable<boolean>(false);
export type FissureMode = "all" | "normal" | "steel" | "railjack";

const FISSURE_MODES: readonly FissureMode[] = ["all", "normal", "steel", "railjack"];

export const worldFissureMode = persistedString<FissureMode>(
  "wf_fissure_mode",
  FISSURE_MODES,
  "normal",
);
