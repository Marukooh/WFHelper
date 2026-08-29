import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const state = vi.hoisted(() => ({ home: "" }));

// The linux discovery walks $HOME, so a fake home is the only way to reach
// cachedLinuxEeLog without the developer's own Steam install answering.
vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  const homedir = (): string => state.home;
  return { ...actual, homedir, default: { ...actual, homedir } };
});

const PROTON_SUFFIX = path.join(
  "steamapps",
  "compatdata",
  "230410",
  "pfx",
  "drive_c",
  "users",
  "steamuser",
  "AppData",
  "Local",
  "Warframe",
);
const ORIGINAL_PLATFORM = process.platform;
const ORIGINAL_OVERRIDE = process.env.WFHELPER_EE_LOG;
const tempRoots: string[] = [];

function makeTempRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

function eeLogIn(library: string): string {
  return path.join(library, PROTON_SUFFIX, "EE.log");
}

function makePrefixOnly(library: string): void {
  fs.mkdirSync(path.join(library, "steamapps", "compatdata", "230410"), { recursive: true });
}

function makeEeLog(library: string): string {
  const target = eeLogIn(library);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, "");
  return target;
}

function writeLibraryFolders(steamRoot: string, libraries: string[]): void {
  const entries = libraries
    .map(
      (library, index) =>
        `\t"${index}"\n\t{\n\t\t"path"\t\t"${library.replace(/\\/g, "\\\\")}"\n\t}`,
    )
    .join("\n");
  fs.mkdirSync(path.join(steamRoot, "steamapps"), { recursive: true });
  fs.writeFileSync(
    path.join(steamRoot, "steamapps", "libraryfolders.vdf"),
    `"libraryfolders"\n{\n${entries}\n}\n`,
  );
}

/** Fresh module instance so the linux memo starts empty, plus a movable clock. */
async function loadEeLogPath(home: string): Promise<{
  resolveEeLogPath: () => string | null;
  advance: (ms: number) => void;
}> {
  state.home = home;
  Object.defineProperty(process, "platform", { value: "linux", configurable: true });
  delete process.env.WFHELPER_EE_LOG;
  vi.resetModules();
  const module = await import("../../services/eeLogPath");
  let clock = 1_700_000_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => clock);
  return {
    resolveEeLogPath: module.resolveEeLogPath,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(process, "platform", { value: ORIGINAL_PLATFORM, configurable: true });
  if (ORIGINAL_OVERRIDE === undefined) delete process.env.WFHELPER_EE_LOG;
  else process.env.WFHELPER_EE_LOG = ORIGINAL_OVERRIDE;
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("cachedLinuxEeLog", () => {
  it("pins a path that exists so later calls stat nothing", async () => {
    const home = makeTempRoot("wfh-eelog-home-");
    const steamRoot = path.join(home, ".local", "share", "Steam");
    const expected = makeEeLog(steamRoot);

    const { resolveEeLogPath, advance } = await loadEeLogPath(home);
    expect(resolveEeLogPath()).toBe(expected);

    // The whole install disappears; a pinned hit must not go looking again,
    // which is what keeps the per-scan call off the Steam roots.
    fs.rmSync(path.join(home, ".local"), { recursive: true, force: true });
    advance(10 * 60_000);
    expect(resolveEeLogPath()).toBe(expected);
  });

  it("re-probes a miss so a game installed later is found", async () => {
    const home = makeTempRoot("wfh-eelog-home-");
    const steamRoot = path.join(home, ".local", "share", "Steam");

    const { resolveEeLogPath, advance } = await loadEeLogPath(home);
    expect(resolveEeLogPath()).toBeNull();

    const expected = makeEeLog(steamRoot);
    expect(resolveEeLogPath()).toBeNull();

    advance(61_000);
    expect(resolveEeLogPath()).toBe(expected);
  });

  // The second discovery loop answers with a path it never checked, and pinning
  // that guess left the session watching a file that was never going to exist.
  it("does not pin a guessed path with no EE.log behind it", async () => {
    const home = makeTempRoot("wfh-eelog-home-");
    const steamRoot = path.join(home, ".local", "share", "Steam");
    const secondLibrary = makeTempRoot("wfh-eelog-lib-");
    makePrefixOnly(steamRoot);
    writeLibraryFolders(steamRoot, [steamRoot, secondLibrary]);

    const { resolveEeLogPath, advance } = await loadEeLogPath(home);
    // Still handed out so a watcher can attach to a prefix the game has not
    // written yet, and still re-probed because nothing confirmed it.
    expect(resolveEeLogPath()).toBe(eeLogIn(steamRoot));

    const real = makeEeLog(secondLibrary);
    advance(30_000);
    expect(resolveEeLogPath()).toBe(eeLogIn(steamRoot));

    advance(31_000);
    expect(resolveEeLogPath()).toBe(real);

    // Now it is a confirmed hit, so it stops looking like every other hit.
    fs.rmSync(secondLibrary, { recursive: true, force: true });
    advance(61_000);
    expect(resolveEeLogPath()).toBe(real);
  });
});
