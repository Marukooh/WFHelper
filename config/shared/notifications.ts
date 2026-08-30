import type { TradeMatchPayload, TradeNotificationStatus } from "./tradeMatch";

// The tuple is the source of both the union and the runtime guard that revives
// persisted rows, so a new kind cannot compile while silently failing to load.
export const NOTIFICATION_KINDS = ["trade", "message", "world", "app"] as const;

export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

// Main trims the stored log to this and the renderer trims its live list to the
// same number, so what the badge counts matches what a reload returns.
export const NOTIFICATION_LOG_MAX_ENTRIES = 200;

export interface NotificationEntry {
  id: string;
  /** ISO timestamp; the renderer formats it so a language switch repaints it. */
  at: string;
  kind: NotificationKind;
  title: string;
  body: string;
}

// English on purpose: history entries are stored, and a translated string would
// freeze in whatever language wrote it. These mirror the toast status labels.
const TRADE_STATUS_TITLES: Record<TradeNotificationStatus, string> = {
  closed: "Listing Closed",
  "no-match": "No Listing Matched",
  "close-failed": "Closing Failed",
  detected: "Trade Finished",
};

export function tradeNotificationTitle(status: TradeNotificationStatus): string {
  return TRADE_STATUS_TITLES[status] ?? TRADE_STATUS_TITLES.detected;
}

export function tradeNotificationBody(match: TradeMatchPayload): string {
  const quantity = match.quantity > 1 ? `${match.quantity}x ` : "";
  const priced = (match.type === "sale" || match.type === "purchase") && match.platinum > 0;
  const platinum = priced ? ` ${match.platinum}p` : "";
  const partner = match.partner ? ` with ${match.partner}` : "";
  return `${quantity}${match.itemName}${platinum}${partner}`;
}
