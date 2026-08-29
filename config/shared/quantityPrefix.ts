/** Reward and drop-table names carry the bonus count ("2X Forma Blueprint"),
 *  and a card prints it as "2 X", so both spellings fold to one before a name
 *  is compared or looked up. */
const QUANTITY_PREFIX = /^\d+\s*x\s+/i;

export function hasQuantityPrefix(value: string): boolean {
  return QUANTITY_PREFIX.test(value);
}

export function stripQuantityPrefix(value: string): string {
  return value.replace(QUANTITY_PREFIX, "");
}
