// Optional Wayland layer-shell addon. Absent on every platform but Linux, and
// absent on Linux too unless it compiled, so nothing here may throw: a failure
// means the caller keeps its ordinary overlay window.

import fs from "node:fs";
import path from "node:path";

import { withScope } from "./logger";

const log = withScope("layerShell");

interface LayerShellAddon {
  available(): boolean;
  outputs(): string[];
}

interface LayerShellProbe {
  available: boolean;
  /** Connector names, e.g. DP-1, matching what the compositor ipc reports. */
  outputs: string[];
}

const ADDON_RELATIVE = path.join("native", "layer-shell", "build", "layershell.node");

function candidatePaths(): string[] {
  const candidates: string[] = [];
  // asarUnpack puts it here in a packaged build; __dirname is inside the asar.
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, "app.asar.unpacked", ADDON_RELATIVE));
  }
  candidates.push(path.join(__dirname, "..", ADDON_RELATIVE));
  return candidates;
}

let cached: LayerShellAddon | null | undefined;

function loadAddon(): LayerShellAddon | null {
  if (cached !== undefined) return cached;
  cached = null;
  if (process.platform !== "linux") return cached;
  for (const candidate of candidatePaths()) {
    if (!fs.existsSync(candidate)) continue;
    try {
      // Late require on purpose: a native module that fails to link must not
      // take the import graph down with it.
      const addon = require(candidate) as LayerShellAddon;
      if (typeof addon?.available === "function") {
        cached = addon;
        return cached;
      }
      log.warn(`[LayerShell] ${candidate} loaded but exports no available()`);
    } catch (err) {
      log.warn(`[LayerShell] ${candidate} failed to load:`, (err as Error)?.message);
    }
  }
  return cached;
}

/** What the running compositor offers. Null when the addon is not there at all,
 *  which is every Windows and macOS run and any Linux build without it. */
export function probeLayerShell(): LayerShellProbe | null {
  const addon = loadAddon();
  if (!addon) return null;
  try {
    const available = addon.available() === true;
    return { available, outputs: available ? addon.outputs() : [] };
  } catch (err) {
    log.warn("[LayerShell] probe failed:", (err as Error)?.message);
    return null;
  }
}
