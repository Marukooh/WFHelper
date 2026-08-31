import { derived, writable } from "svelte/store";

import { invoke } from "../lib/ipc.js";
import { log } from "../lib/log.js";
import { NOTIFICATION_LOG_MAX_ENTRIES } from "../../config/shared/notifications.js";
import type { NotificationEntry } from "../../config/shared/notifications.js";

const SEEN_STORAGE_KEY = "wf_notifications_seen_at";

function readSeenAt(): string {
  try {
    return localStorage.getItem(SEEN_STORAGE_KEY) ?? "";
  } catch {
    // no localStorage (tests, hardened webview)
    return "";
  }
}

/** Newest first. */
export const notificationHistory = writable<NotificationEntry[]>([]);

const seenAt = writable<string>(readSeenAt());

/** Arrivals since the history was last opened. The badge counts these rather
 *  than the whole log, which sits at the cap for anyone who plays a while. */
export const notificationsUnread = derived(
  [notificationHistory, seenAt],
  ([entries, since]) => entries.filter((entry) => entry.at > since).length,
);

export function markNotificationsSeen(): void {
  const stamp = new Date().toISOString();
  seenAt.set(stamp);
  try {
    localStorage.setItem(SEEN_STORAGE_KEY, stamp);
  } catch {
    // no localStorage (tests, hardened webview)
  }
}

export async function loadNotificationHistory(): Promise<void> {
  try {
    notificationHistory.set(await invoke("getNotificationHistory"));
  } catch (err) {
    log.warn("[Notifications] history load failed:", err);
  }
}

export function addNotificationEntry(entry: NotificationEntry): void {
  notificationHistory.update((entries) =>
    [entry, ...entries].slice(0, NOTIFICATION_LOG_MAX_ENTRIES),
  );
}

export async function removeNotificationEntry(id: string): Promise<void> {
  try {
    await invoke("removeNotificationEntry", id);
    notificationHistory.update((entries) => entries.filter((entry) => entry.id !== id));
  } catch (err) {
    log.warn("[Notifications] history remove failed:", err);
  }
}

export async function clearNotificationHistory(): Promise<void> {
  try {
    await invoke("clearNotificationHistory");
    notificationHistory.set([]);
  } catch (err) {
    log.warn("[Notifications] history clear failed:", err);
  }
}
