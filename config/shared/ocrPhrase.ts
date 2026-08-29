/** OCR-comparable form that keeps word boundaries: a capture reproduces neither
 *  case nor punctuation, but which words appeared and in what order is the
 *  evidence. Use normalizeForOcr instead when single characters are compared. */
export function normalizeOcrPhrase(value: unknown): string {
  return String(value || "")
    .toUpperCase()
    .replace(/[^A-Z0-9\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
