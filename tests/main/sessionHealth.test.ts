import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: {
    getPath: () => os.tmpdir(),
    isPackaged: false,
  },
}));

import {
  beginSession,
  crashDumpsFromPreviousSession,
  endSessionCleanly,
  peekPreviousSessionEnd,
} from "../../services/sessionHealth";

const tempDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

describe("beginSession", () => {
  it("cannot judge a first run", () => {
    expect(beginSession(tempDir("wfh-health-"))).toBe("unknown");
  });

  it("reads a quit that left a marker as clean", () => {
    const dir = tempDir("wfh-health-");
    beginSession(dir);
    endSessionCleanly();

    expect(beginSession(dir)).toBe("clean");
  });

  it("reads a run that never got to quit as unclean", () => {
    const dir = tempDir("wfh-health-");
    beginSession(dir);

    expect(beginSession(dir)).toBe("unclean");
  });
});

describe("session marker durability", () => {
  it("writes through a rename so a crash cannot truncate it", () => {
    const dir = tempDir("wfh-health-");
    const stateFile = path.join(dir, "session-state.json");
    const write = vi.spyOn(fs, "writeFileSync");
    const rename = vi.spyOn(fs, "renameSync");

    beginSession(dir);

    expect(write.mock.calls.some((call) => call[0] === stateFile)).toBe(false);
    expect(rename.mock.calls.some((call) => call[1] === stateFile)).toBe(true);
    write.mockRestore();
    rename.mockRestore();

    const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8")) as { status?: string };
    expect(parsed.status).toBe("running");
    expect(fs.readdirSync(dir)).toEqual(["session-state.json"]);
  });

  it("reads a half-written marker as unknown instead of clean", () => {
    const dir = tempDir("wfh-health-");
    fs.writeFileSync(path.join(dir, "session-state.json"), '{"status":"run');

    expect(beginSession(dir)).toBe("unknown");
  });
});

describe("peekPreviousSessionEnd", () => {
  it("reports the outcome without claiming the file", () => {
    const dir = tempDir("wfh-health-");
    beginSession(dir);

    expect(peekPreviousSessionEnd(dir)).toBe("unclean");
    expect(peekPreviousSessionEnd(dir)).toBe("unclean");
    expect(beginSession(dir)).toBe("unclean");
  });

  it("reports unknown when nothing was ever written", () => {
    expect(peekPreviousSessionEnd(tempDir("wfh-health-"))).toBe("unknown");
  });

  it("reports clean after a marker-leaving quit", () => {
    const dir = tempDir("wfh-health-");
    beginSession(dir);
    endSessionCleanly();

    expect(peekPreviousSessionEnd(dir)).toBe("clean");
  });
});

describe("crashDumpsFromPreviousSession", () => {
  it("returns dumps written during the previous run, newest first", () => {
    const userData = tempDir("wfh-health-");
    const crashDumps = tempDir("wfh-dumps-");
    const reports = path.join(crashDumps, "reports");
    fs.mkdirSync(reports);

    beginSession(userData); // first run, nothing to report yet
    fs.writeFileSync(path.join(reports, "older.dmp"), "x");
    fs.writeFileSync(path.join(reports, "newer.dmp"), "x");
    const now = Date.now();
    fs.utimesSync(path.join(reports, "older.dmp"), now / 1000, now / 1000);
    fs.utimesSync(path.join(reports, "newer.dmp"), now / 1000 + 5, now / 1000 + 5);

    beginSession(userData); // second run sees the first run's dumps

    expect(crashDumpsFromPreviousSession(crashDumps)).toEqual(["newer.dmp", "older.dmp"]);
  });

  it("ignores a dump left over from long before the previous run", () => {
    const userData = tempDir("wfh-health-");
    const crashDumps = tempDir("wfh-dumps-");
    const reports = path.join(crashDumps, "reports");
    fs.mkdirSync(reports);

    const stale = path.join(reports, "stale.dmp");
    fs.writeFileSync(stale, "x");
    const longAgo = Date.now() / 1000 - 86_400;
    fs.utimesSync(stale, longAgo, longAgo);

    beginSession(userData);
    beginSession(userData);

    expect(crashDumpsFromPreviousSession(crashDumps)).toEqual([]);
  });

  it("returns nothing when the reports folder is missing", () => {
    const userData = tempDir("wfh-health-");
    beginSession(userData);

    expect(crashDumpsFromPreviousSession(tempDir("wfh-dumps-"))).toEqual([]);
  });
});
