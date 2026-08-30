/** Notification history entries, shared by main, preload and the renderer. */

export type NotificationKind = "trade" | "message" | "world" | "app";

export interface NotificationEntry {
  id: string;
  /** ISO timestamp; the renderer formats it so a language switch repaints it. */
  at: string;
  kind: NotificationKind;
  title: string;
  body: string;
}
