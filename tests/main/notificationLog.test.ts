import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NOTIFICATION_KINDS } from "../../config/shared/notifications";
import type { NotificationEntry } from "../../config/shared/notifications";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "wfh-notification-log-"));
const logFile = path.join(tempDir, "notification-log.json");

vi.mock("electron", () => ({
  app: { getPath: () => tempDir },
}));

async function importLog() {
  vi.resetModules();
  return import("../../services/notificationLog");
}

beforeEach(() => {
  fs.rmSync(logFile, { force: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock("../../services/atomicFile");
});

describe("notification log", () => {
  it("returns the newest entry first", async () => {
    const log = await importLog();

    log.record("world", "First", "one");
    log.record("trade", "Second", "two");

    expect(log.getAll().map((entry: NotificationEntry) => entry.title)).toEqual([
      "Second",
      "First",
    ]);
  });

  it("gives every entry its own id inside the same millisecond", async () => {
    const log = await importLog();

    log.record("app", "A", "a");
    log.record("app", "B", "b");

    const ids = log.getAll().map((entry: NotificationEntry) => entry.id);
    expect(new Set(ids).size).toBe(2);
  });

  it("keeps 200 entries and drops the oldest past the cap", async () => {
    const log = await importLog();

    for (let index = 0; index < 200; index += 1) log.record("app", `n${index}`, "");
    expect(log.getAll()).toHaveLength(200);
    expect(log.getAll().at(-1)?.title).toBe("n0");

    log.record("app", "n200", "");
    const entries = log.getAll();
    expect(entries).toHaveLength(200);
    expect(entries[0].title).toBe("n200");
    expect(entries.at(-1)?.title).toBe("n1");
  });

  it("round-trips through disk and skips malformed rows", async () => {
    const first = await importLog();
    first.record("message", "Persisted", "from Tenno");

    const stored = JSON.parse(fs.readFileSync(logFile, "utf8")) as unknown[];
    stored.unshift({ id: "bad", at: "2026-01-01T00:00:00.000Z", kind: "nope", title: "x" });
    fs.writeFileSync(logFile, JSON.stringify(stored));

    const reloaded = await importLog();
    expect(reloaded.getAll()).toEqual([
      expect.objectContaining({ kind: "message", title: "Persisted", body: "from Tenno" }),
    ]);
  });

  // A hand-written kind guard would drop every entry of a kind added to the
  // union, and the loss only shows up after a restart.
  it("reloads an entry of every declared kind", async () => {
    const first = await importLog();
    for (const kind of NOTIFICATION_KINDS) first.record(kind, `title-${kind}`, "");

    const reloaded = await importLog();

    expect(
      reloaded
        .getAll()
        .map((entry: NotificationEntry) => entry.kind)
        .sort(),
    ).toEqual([...NOTIFICATION_KINDS].sort());
  });

  it("trims an over-long stored entry back to the cap on load", async () => {
    fs.writeFileSync(
      logFile,
      JSON.stringify([
        {
          id: "a",
          at: "2026-01-01T00:00:00.000Z",
          kind: "app",
          title: "t".repeat(400),
          body: "b".repeat(900),
        },
      ]),
    );

    // The file is user-writable, so record()'s caps say nothing about the size
    // of a row that comes back off disk.
    const [entry] = (await importLog()).getAll();

    expect(entry.title).toHaveLength(200);
    expect(entry.body).toHaveLength(500);
  });

  it("clears the stored history", async () => {
    const log = await importLog();
    log.record("trade", "Listing Closed", "Ash Prime Chassis 45p with Buyer");

    log.clear();

    expect(log.getAll()).toEqual([]);
    expect(JSON.parse(fs.readFileSync(logFile, "utf8"))).toEqual([]);
  });

  it("does not throw when the write fails", async () => {
    vi.doMock("../../services/atomicFile", () => ({
      writeFileAtomicSync: () => {
        throw new Error("EPERM");
      },
    }));
    const log = await importLog();

    expect(() => log.record("app", "Still returned", "body")).not.toThrow();
    expect(log.getAll()[0]).toMatchObject({ title: "Still returned" });
  });
});
