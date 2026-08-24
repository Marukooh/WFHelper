/** Audio and overlay suites inject a DLL into every process on the machine.
 *  NahimicOSD.dll killed the main process this way, inside Chromium's window
 *  code, with no catchable error. */

import path from "node:path";

import { withScope } from "./logger";
import { normalizeErrorMessage } from "../config/shared/errors";

const log = withScope("processMitigation");

const KNOWN_INJECTORS: Array<{ match: string; name: string }> = [
  { match: "nahimic", name: "Nahimic audio OSD (A-Volute)" },
  { match: "a-volute", name: "A-Volute audio suite" },
  { match: "sonicstudio", name: "ASUS Sonic Studio (A-Volute)" },
  { match: "sonicradar", name: "ASUS Sonic Radar (A-Volute)" },
  { match: "rtsshooks", name: "RivaTuner Statistics Server" },
  { match: "overwolf", name: "Overwolf" },
  { match: "gameoverlayrenderer", name: "Steam overlay" },
  { match: "discordhook", name: "Discord overlay" },
  { match: "nvspcap", name: "NVIDIA overlay" },
  { match: "fraps", name: "Fraps" },
  { match: "dxtory", name: "Dxtory" },
  { match: "xsplit", name: "XSplit" },
];

/** Lowercased with forward slashes, so one comparison covers both separators. */
function normalizePath(file: string): string {
  return file.toLowerCase().replace(/\\/g, "/");
}

const INSTALL_DIR = normalizePath(path.dirname(process.execPath));

// node_modules covers a dev tree, where the same natives sit outside the asar.
function isOurOwnModule(file: string): boolean {
  return (
    file.includes("app.asar.unpacked") ||
    file.includes("node_modules") ||
    (INSTALL_DIR.length > 3 && file.startsWith(INSTALL_DIR))
  );
}

// Windows is not always installed on C:, and SystemRoot is where the OS itself
// points; hardcoding the drive made every system DLL look injected.
function windowsRootPrefix(): string {
  const root = normalizePath(process.env.SystemRoot || "C:\\Windows");
  return root.endsWith("/") ? root : `${root}/`;
}

function isSystemModule(file: string, windowsRoot: string): boolean {
  return file.startsWith(windowsRoot) || file.includes("/winsxs/");
}

/** Loaded DLLs that are neither Windows' nor ours, so anything injected shows. */
export function listForeignModules(): string[] {
  // Only Windows has the injection problem, and its path rules are what we filter by.
  if (process.platform !== "win32") return [];

  try {
    const report = process.report?.getReport?.() as { sharedObjects?: unknown } | undefined;
    const modules = Array.isArray(report?.sharedObjects) ? report.sharedObjects : [];
    const windowsRoot = windowsRootPrefix();
    return modules
      .filter((entry): entry is string => typeof entry === "string")
      .filter((entry) => {
        const file = normalizePath(entry);
        return !isSystemModule(file, windowsRoot) && !isOurOwnModule(file);
      });
  } catch (err) {
    log.warn("[Mitigation] module list unavailable:", normalizeErrorMessage(err));
    return [];
  }
}

/** Friendly names for the foreign modules with a known history of crashing hosts. */
export function describeKnownInjectors(modules: string[]): string[] {
  const found = new Set<string>();
  for (const entry of modules) {
    const file = entry.toLowerCase();
    for (const injector of KNOWN_INJECTORS) {
      if (file.includes(injector.match)) found.add(injector.name);
    }
  }
  return [...found];
}
