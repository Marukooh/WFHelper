import type { ParsedItem } from "../../types/inventory.js";

// Card ids that have a parsed row behind them, so a generated set row gets no
// detail modal. Modular builds and ranked stacks card by inventoryKey rather
// than by uniqueName, and a parts-less build has no modularParts marker, so
// comparing the two keys is what decides.
export function buildDetailKeys(parsed: ParsedItem[]): Set<string> {
  return new Set(
    parsed.flatMap((entry) =>
      typeof entry.inventoryKey === "string" && entry.inventoryKey !== entry.internalName
        ? [entry.internalName, entry.inventoryKey]
        : [entry.internalName],
    ),
  );
}
