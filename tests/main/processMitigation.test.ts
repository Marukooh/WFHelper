import fs from "node:fs";
import os from "node:os";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: {
    getPath: () => os.tmpdir(),
    isPackaged: false,
  },
}));

import { describeKnownInjectors, listForeignModules } from "../../services/processMitigation";

const tempDirs: string[] = [];

const realPlatform = process.platform;

/** Pin the platform, or the Windows-shaped cases read as skipped on CI's linux runner. */
function withPlatform<T>(platform: string, fn: () => T): T {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  try {
    return fn();
  } finally {
    Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
  }
}

function withReport<T>(modules: string[], fn: () => T): T {
  const report = process.report as unknown as { getReport: () => object };
  const spy = vi.spyOn(report, "getReport").mockReturnValue({ sharedObjects: modules });
  try {
    return fn();
  } finally {
    spy.mockRestore();
  }
}

afterEach(() => {
  vi.unstubAllEnvs();
});

afterAll(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

describe("describeKnownInjectors", () => {
  it("names the suite behind an injected module", () => {
    const modules = [
      "C:\\ProgramData\\A-Volute\\DellInc.AlienwareSoundCenter\\Modules\\x64\\NahimicOSD.dll",
      "C:\\Program Files\\RivaTuner Statistics Server\\RTSSHooks64.dll",
    ];

    expect(describeKnownInjectors(modules)).toEqual(
      expect.arrayContaining([
        "Nahimic audio OSD (A-Volute)",
        "A-Volute audio suite",
        "RivaTuner Statistics Server",
      ]),
    );
  });

  it("stays quiet for modules it does not recognise", () => {
    expect(describeKnownInjectors(["C:\\Program Files\\Something\\thing.dll"])).toEqual([]);
  });
});

describe("listForeignModules", () => {
  it("drops Windows' own modules and ours", () => {
    const foreign = listForeignModules();

    expect(foreign.every((entry) => !entry.toLowerCase().includes("app.asar.unpacked"))).toBe(true);
    expect(foreign.every((entry) => !/^c:[\\/]windows[\\/]/i.test(entry))).toBe(true);
  });

  it("stays quiet off Windows, where every system object would look injected", () => {
    withPlatform("linux", () => {
      withReport(["/usr/lib/x86_64-linux-gnu/libc.so.6", "/usr/lib/libGL.so.1"], () => {
        expect(listForeignModules()).toEqual([]);
      });
    });
  });

  it("treats the Windows install as system wherever the drive is", () => {
    vi.stubEnv("SystemRoot", "D:\\Windows");
    const injected = "C:\\Users\\someone\\AppData\\Local\\Overwolf\\ow-injector.dll";

    withPlatform("win32", () => {
      withReport(
        [
          "D:\\Windows\\System32\\ntdll.dll",
          "D:\\Windows\\WinSxS\\amd64_comctl32\\comctl32.dll",
          injected,
        ],
        () => {
          expect(listForeignModules()).toEqual([injected]);
        },
      );
    });
  });
});
