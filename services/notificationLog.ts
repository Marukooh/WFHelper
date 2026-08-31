import { createJsonCache } from "./jsonCache";
import { NOTIFICATION_KINDS, NOTIFICATION_LOG_MAX_ENTRIES } from "../config/shared/notifications";
import type { NotificationEntry, NotificationKind } from "../config/shared/notifications";

const MAX_TITLE_CHARS = 200;
const MAX_BODY_CHARS = 500;

const KINDS: ReadonlySet<string> = new Set<string>(NOTIFICATION_KINDS);

function reviveEntry(raw: unknown): NotificationEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const { id, at, kind, title, body } = raw as Record<string, unknown>;
  if (typeof id !== "string" || !id) return null;
  if (typeof at !== "string" || !at) return null;
  if (typeof kind !== "string" || !KINDS.has(kind)) return null;
  if (typeof title !== "string" || typeof body !== "string") return null;
  // Re-applied on load: the file is user-writable, so a stored entry is not
  // bounded by whatever record() enforced when it was written.
  return {
    id,
    at,
    kind: kind as NotificationKind,
    title: title.slice(0, MAX_TITLE_CHARS),
    body: body.slice(0, MAX_BODY_CHARS),
  };
}

// Stored oldest-first so the cap trims from the front; getAll reverses for the UI.
const cache = createJsonCache<NotificationEntry[]>("notification-log.json", (parsed) => {
  if (!Array.isArray(parsed)) return null;
  const entries: NotificationEntry[] = [];
  for (const raw of parsed) {
    const entry = reviveEntry(raw);
    if (entry) entries.push(entry);
  }
  return entries.slice(-NOTIFICATION_LOG_MAX_ENTRIES);
});

let entries: NotificationEntry[] | null = null;
let sequence = 0;

function load(): NotificationEntry[] {
  if (!entries) entries = cache.read() ?? [];
  return entries;
}

// Date.now alone repeats within a millisecond when one event fans out.
function nextId(): string {
  sequence += 1;
  return `${Date.now().toString(36)}-${sequence.toString(36)}`;
}

export function record(kind: NotificationKind, title: string, body: string): NotificationEntry {
  const entry: NotificationEntry = {
    id: nextId(),
    at: new Date().toISOString(),
    kind,
    title: String(title).slice(0, MAX_TITLE_CHARS),
    body: String(body).slice(0, MAX_BODY_CHARS),
  };
  const current = load();
  current.push(entry);
  if (current.length > NOTIFICATION_LOG_MAX_ENTRIES) {
    current.splice(0, current.length - NOTIFICATION_LOG_MAX_ENTRIES);
  }
  cache.write(current);
  return entry;
}

/** Newest first, the order the history modal renders. */
export function getAll(): NotificationEntry[] {
  return load().slice().reverse();
}

/** Drops one entry and says whether it was there. A test notification, or any
 *  single line the user would rather not keep, otherwise costs the whole log. */
export function remove(id: string): boolean {
  const current = load();
  const at = current.findIndex((entry) => entry.id === id);
  if (at < 0) return false;
  current.splice(at, 1);
  cache.write(current);
  return true;
}

export function clear(): void {
  entries = [];
  cache.write(entries);
}
