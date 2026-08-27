import type { BrowserWindow } from "electron";
import type { RivenStat, RollPanelResult } from "./rivenScan";
import {
  RIVEN_SESSION_START,
  RIVEN_INITIAL_STATS,
  RIVEN_ROLL_SCANNING,
  RIVEN_ROLL_RESULT,
  RIVEN_CHOICE_MADE,
  RIVEN_SESSION_END,
} from "../../config/shared/ipcChannels";

interface RivenSessionState {
  kuvaPerRoll: number;
  rollCount: number;
  totalKuvaSpent: number;
}

let sessionState = createRivenSessionState();

type WindowRef = BrowserWindow | null;

function createRivenSessionState(kuvaPerRoll = 0): RivenSessionState {
  return {
    kuvaPerRoll,
    rollCount: 0,
    totalKuvaSpent: 0,
  };
}

export function createScanGeneration() {
  let current = 0;
  return {
    begin(): number {
      current += 1;
      return current;
    },
    invalidate(): void {
      current += 1;
    },
    isCurrent(generation: number): boolean {
      return generation === current;
    },
    current(): number {
      return current;
    },
  };
}

// A rebuilt riven window starts blank, so every session event is mirrored to the
// owner to be replayed into the new window.
let eventRecorder: ((channel: string, args: unknown[]) => void) | null = null;

export function setEventRecorder(recorder: (channel: string, args: unknown[]) => void): void {
  eventRecorder = recorder;
}

function sendToWindows(wins: WindowRef[], channel: string, ...args: unknown[]): void {
  eventRecorder?.(channel, args);
  for (const win of wins) {
    if (!win || win.isDestroyed()) continue;
    win.webContents.send(channel, ...args);
  }
}

export function startSession(wins: WindowRef[], weapon: string, kuvaPerRoll: number): void {
  sessionState = createRivenSessionState(kuvaPerRoll);
  sendToWindows(wins, RIVEN_SESSION_START, weapon, kuvaPerRoll);
}

export function onInitialStats(wins: WindowRef[], stats: RivenStat[], lowConfidence = false): void {
  sendToWindows(wins, RIVEN_INITIAL_STATS, stats, lowConfidence);
}

export function onRollConfirmed(wins: WindowRef[]): void {
  sendToWindows(wins, RIVEN_ROLL_SCANNING);
}

export function onRollResult(wins: WindowRef[], panels: RollPanelResult): void {
  sessionState = {
    ...sessionState,
    rollCount: sessionState.rollCount + 1,
    totalKuvaSpent: sessionState.totalKuvaSpent + sessionState.kuvaPerRoll,
  };

  sendToWindows(wins, RIVEN_ROLL_RESULT, {
    rollCount: sessionState.rollCount,
    totalKuvaSpent: sessionState.totalKuvaSpent,
    left: panels.left,
    right: panels.right,
  });
}

export function onRollFailed(wins: WindowRef[], left: RivenStat[]): void {
  onRollResult(wins, { left, right: [] });
}

export function onChoiceMade(wins: WindowRef[], side: "left" | "right" | "unknown"): void {
  sendToWindows(wins, RIVEN_CHOICE_MADE, side);
}

export function endSession(wins: WindowRef[]): void {
  sessionState = createRivenSessionState();
  sendToWindows(wins, RIVEN_SESSION_END);
}
