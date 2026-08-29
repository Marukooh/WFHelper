import { writable, type Writable } from "svelte/store";

import { VALUE_MIN_PLATINUM_PRESETS } from "../lib/inventory/valueTotals.js";
import { persistedBoolean, readStorage, writeStorage } from "../lib/persistence.js";

/**
 * Numeric twin of persistedString. A value outside the preset list, including a
 * hand-edited one, falls back rather than filtering by a number no button shows.
 */
function persistedPresetNumber(
  key: string,
  allowed: readonly number[],
  fallback: number,
): Writable<number> {
  const normalize = (value: number): number => (allowed.includes(value) ? value : fallback);
  const raw = readStorage(key);
  const store = writable<number>(normalize(raw == null ? Number.NaN : Number(raw)));
  const save = (value: number) => writeStorage(key, String(value));

  return {
    subscribe: store.subscribe,
    set(value: number): void {
      const next = normalize(value);
      save(next);
      store.set(next);
    },
    update(fn: (value: number) => number): void {
      store.update((current) => {
        const next = normalize(fn(current));
        save(next);
        return next;
      });
    },
  };
}

export const hideFounderMasteryItems = persistedBoolean("wf_hide_founder_mastery_items", false);
export const hideFoundryClaims = persistedBoolean("wf_hide_foundry_claims", true);
export const autoFocusSearch = persistedBoolean("wf_auto_focus_search", false);
/** Widens the inventory value totals from prime parts to every tradable row. */
export const inventoryValueAllTradables = persistedBoolean(
  "wf_inventory_value_all_tradables",
  false,
);
/** Drops rows below this per-unit median out of the inventory value totals. */
export const inventoryValueMinPlatinum = persistedPresetNumber(
  "wf_inventory_value_min_plat",
  VALUE_MIN_PLATINUM_PRESETS,
  0,
);
