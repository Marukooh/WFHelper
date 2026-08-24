/** A clean quit leaves a marker behind; a native crash cannot. Reading it on the
 *  next start is the only way to notice a main-process death, which produces no
 *  error, no dialog and no log line. */

import fs from "node:fs";
import path from "node:path";

import { writeFileAtomicSync } from "./atomicFile";
import { withScope } from "./logger";
import { normalizeErrorMessage } from "../config/shared/errors";

const log = withScope("sessionHealth");

const STATE_FILE = "session-state.json";
const DUMP_MATCH_WINDOW_MS = 60_000;

type PreviousSessionEnd = "clean" | "unclean" | "unknown";

interface SessionState {
  status: "running" | "clean";
  startedAt: number;
}

let stateFile: string | null = null;
let previousStart = 0;

function readStateFrom(file: string): SessionState | null {
  if (!fs.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<SessionState>;
    if (parsed.status !== "running" && parsed.status !== "clean") return null;
    return { status: parsed.status, startedAt: Number(parsed.startedAt) || 0 };
  } catch (err) {
    log.warn("[SessionHealth] unreadable state:", normalizeErrorMessage(err));
    return null;
  }
}

function readState(): SessionState | null {
  return stateFile ? readStateFrom(stateFile) : null;
}

function writeState(state: SessionState): void {
  if (!stateFile) return;
  try {
    // This is the one file whose whole job is surviving a crash: a torn write
    // reads back as null and the crash then reports itself as "unknown".
    writeFileAtomicSync(stateFile, JSON.stringify(state));
  } catch (err) {
    log.warn("[SessionHealth] state write failed:", normalizeErrorMessage(err));
  }
}

/** The previous outcome without claiming the file, for decisions that must be
 *  made before beginSession() overwrites it. */
export function peekPreviousSessionEnd(userDataPath: string): PreviousSessionEnd {
  const previous = readStateFrom(path.join(userDataPath, STATE_FILE));
  if (!previous) return "unknown";
  return previous.status === "clean" ? "clean" : "unclean";
}

/** Returns how the previous run ended, then claims the file for this one. */
export function beginSession(userDataPath: string): PreviousSessionEnd {
  stateFile = path.join(userDataPath, STATE_FILE);
  const previous = readState();
  previousStart = previous?.startedAt ?? 0;
  writeState({ status: "running", startedAt: Date.now() });

  if (!previous) return "unknown";
  return previous.status === "clean" ? "clean" : "unclean";
}

export function endSessionCleanly(): void {
  const state = readState();
  writeState({ status: "clean", startedAt: state?.startedAt ?? Date.now() });
}

/** Crashpad dumps written during the previous session, newest first. */
export function crashDumpsFromPreviousSession(crashDumpsPath: string): string[] {
  const reports = path.join(crashDumpsPath, "reports");
  if (!previousStart || !fs.existsSync(reports)) return [];

  try {
    return fs
      .readdirSync(reports)
      .filter((name) => name.toLowerCase().endsWith(".dmp"))
      .map((name) => ({ name, at: fs.statSync(path.join(reports, name)).mtimeMs }))
      .filter((entry) => entry.at >= previousStart - DUMP_MATCH_WINDOW_MS)
      .sort((a, b) => b.at - a.at)
      .map((entry) => entry.name);
  } catch (err) {
    log.warn("[SessionHealth] dump scan failed:", normalizeErrorMessage(err));
    return [];
  }
}
