import { get } from "svelte/store";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { NotificationEntry } from "../../../config/shared/notifications.js";

const h = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("../../../src/lib/ipc.js", () => ({ invoke: h.invoke }));

async function importStore() {
  vi.resetModules();
  return import("../../../src/stores/notifications.js");
}

function entry(id: string): NotificationEntry {
  return { id, at: "2026-08-30T10:00:00.000Z", kind: "trade", title: `T${id}`, body: "" };
}

beforeEach(() => {
  h.invoke.mockReset();
  try {
    localStorage.clear();
  } catch {
    // no localStorage in this environment
  }
});

describe("notification history store", () => {
  it("seeds from the invoke and keeps the newest push first", async () => {
    h.invoke.mockResolvedValueOnce([entry("2"), entry("1")]);
    const store = await importStore();

    await store.loadNotificationHistory();
    store.addNotificationEntry(entry("3"));

    expect(get(store.notificationHistory).map((e) => e.id)).toEqual(["3", "2", "1"]);
  });

  it("mirrors the main-process cap of 200", async () => {
    const store = await importStore();

    for (let index = 0; index < 205; index += 1) store.addNotificationEntry(entry(`n${index}`));

    const entries = get(store.notificationHistory);
    expect(entries).toHaveLength(200);
    expect(entries[0].id).toBe("n204");
  });

  it("leaves the list alone when a failed load or clear rejects", async () => {
    h.invoke.mockRejectedValue(new Error("no bridge"));
    const store = await importStore();
    store.addNotificationEntry(entry("1"));

    await store.loadNotificationHistory();
    await store.clearNotificationHistory();

    expect(get(store.notificationHistory).map((e) => e.id)).toEqual(["1"]);
  });

  // The badge counts arrivals, not the log: a long session sits at the cap.
  it("counts only what arrived since the history was last opened", async () => {
    const store = await importStore();

    store.addNotificationEntry({ ...entry("old"), at: "2026-08-30T10:00:00.000Z" });
    expect(get(store.notificationsUnread)).toBe(1);

    store.markNotificationsSeen();
    expect(get(store.notificationsUnread)).toBe(0);

    store.addNotificationEntry({ ...entry("new"), at: "2099-01-01T00:00:00.000Z" });
    expect(get(store.notificationsUnread)).toBe(1);
  });

  it("empties the list once the clear invoke resolves", async () => {
    h.invoke.mockResolvedValue(undefined);
    const store = await importStore();
    store.addNotificationEntry(entry("1"));

    await store.clearNotificationHistory();

    expect(get(store.notificationHistory)).toEqual([]);
  });
});
