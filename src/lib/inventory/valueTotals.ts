import { toFiniteNumber } from "../../../config/shared/numeric.js";
import { isWfmExcludedSlug } from "../../../config/shared/wfmExclusions.js";
import type { InventoryGroup, PartType } from "../../types/inventory.js";

/** "prime" is the sellable prime stock; "tradable" widens to every listed row. */
export type InventoryValueScope = "prime" | "tradable";

/** Structural row shape. `InventoryBaseItem` and `InventoryViewItem` satisfy it. */
interface InventoryValueEntry {
  inventoryGroup?: InventoryGroup | null;
  partType?: PartType | null;
  isPrime?: boolean;
  tradable?: boolean;
  amount?: number | null;
  marketSlug?: string | null;
  platinum?: number | null;
  ducats?: number | null;
}

export interface InventoryValueTotals {
  /** Sum of quantity x snapshot median over the priced rows. */
  platinum: number;
  /** Sum of quantity x ducat value over the priced prime rows. */
  ducats: number;
  /** Counted rows with no snapshot median, so the platinum total is a floor. */
  platinumUnpriced: number;
  /** Counted prime rows with no ducat value, so the ducat total is a floor. */
  ducatsUnpriced: number;
  /** Counted rows missing either price, so the strip can hint once instead of twice. */
  unpriced: number;
  /** Rows that passed the sellable and scope gate. */
  counted: number;
}

/** The two figures the strip can show: the current view, and the whole inventory. */
type InventoryValueRowKey = "inView" | "inventory";

// Set rows aggregate parts that are already counted one by one, so including
// them would double the same stock.
const AGGREGATE_GROUPS: ReadonlySet<string> = new Set(["full_sets", "incomplete_sets"]);

function isPrimeRow(entry: InventoryValueEntry): boolean {
  return entry.partType === "prime" || entry.isPrime === true;
}

function isSellable(entry: InventoryValueEntry): boolean {
  if (entry.tradable === false) return false;
  if (AGGREGATE_GROUPS.has(entry.inventoryGroup ?? "")) return false;
  const slug = entry.marketSlug;
  if (typeof slug !== "string" || slug.length === 0) return false;
  return !isWfmExcludedSlug(slug);
}

/** A row with no amount is one copy; a broken or non-positive amount is none. */
function stackSize(entry: InventoryValueEntry): number {
  if (entry.amount == null) return 1;
  const amount = toFiniteNumber(entry.amount);
  if (amount == null || amount <= 0) return 0;
  return Math.floor(amount);
}

/**
 * Scope + sellable gate. Exported so callers can prefilter cheap base rows
 * before paying for the priced view rows.
 */
export function isCountedForValue(entry: InventoryValueEntry, scope: InventoryValueScope): boolean {
  if (!isSellable(entry)) return false;
  if (scope === "tradable") return true;
  // The default scope is the prime stock you actually dump: parts, not built gear.
  return entry.inventoryGroup === "all_parts" && isPrimeRow(entry);
}

export function computeInventoryValueTotals(
  entries: readonly InventoryValueEntry[],
  scope: InventoryValueScope,
): InventoryValueTotals {
  let platinum = 0;
  let ducats = 0;
  let platinumUnpriced = 0;
  let ducatsUnpriced = 0;
  let unpriced = 0;
  let counted = 0;

  for (const entry of entries) {
    if (!isCountedForValue(entry, scope)) continue;
    const quantity = stackSize(entry);
    if (quantity <= 0) continue;
    counted++;
    let hole = false;

    const median = toFiniteNumber(entry.platinum);
    if (median != null && median > 0) platinum += median * quantity;
    else {
      platinumUnpriced++;
      hole = true;
    }

    // Only prime parts have a Baro price, so a null anywhere else is not a hole.
    if (isPrimeRow(entry)) {
      const ducatValue = toFiniteNumber(entry.ducats);
      if (ducatValue != null && ducatValue > 0) ducats += ducatValue * quantity;
      else {
        ducatsUnpriced++;
        hole = true;
      }
    }

    if (hole) unpriced++;
  }

  return {
    platinum: Math.round(platinum),
    ducats: Math.round(ducats),
    platinumUnpriced,
    ducatsUnpriced,
    unpriced,
    counted,
  };
}

/**
 * The whole-inventory figure only earns its space when the view narrows the
 * stock; an empty view falls back to it rather than printing zeros.
 */
export function selectValueStripRows(
  inView: InventoryValueTotals,
  inventory: InventoryValueTotals,
): InventoryValueRowKey[] {
  if (inView.counted === 0) return inventory.counted > 0 ? ["inventory"] : [];
  if (inView.counted >= inventory.counted) return ["inView"];
  return ["inView", "inventory"];
}

/**
 * Single-slot memo keyed by reference. A `$:` block re-runs for any dependency
 * it lists, and a 3k-row walk must not repeat for inputs that did not change.
 */
export function createValueTotalsMemo(): (
  entries: readonly InventoryValueEntry[],
  scope: InventoryValueScope,
) => InventoryValueTotals {
  let lastEntries: readonly InventoryValueEntry[] | null = null;
  let lastScope: InventoryValueScope | null = null;
  let lastResult: InventoryValueTotals | null = null;

  return (entries, scope) => {
    if (lastResult && entries === lastEntries && scope === lastScope) return lastResult;
    lastEntries = entries;
    lastScope = scope;
    lastResult = computeInventoryValueTotals(entries, scope);
    return lastResult;
  };
}
