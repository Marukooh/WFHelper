import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

// The module caches its load, so each case needs a fresh copy of it.
async function freshProbe() {
  vi.resetModules();
  const module = await import("../../services/layerShell");
  return module.probeLayerShell;
}

const realPlatform = process.platform;

function setPlatform(value: string): void {
  Object.defineProperty(process, "platform", { value, configurable: true });
}

afterEach(() => {
  setPlatform(realPlatform);
  vi.restoreAllMocks();
});

// The addon's own behaviour is covered by running it against a real compositor;
// what matters here is that its absence is never fatal.
describe("probeLayerShell", () => {
  it("is null off linux without even looking for the addon", async () => {
    setPlatform("win32");
    const exists = vi.spyOn(fs, "existsSync");

    expect((await freshProbe())()).toBeNull();
    // Other modules stat their own files during the import, so only ours counts.
    const looked = exists.mock.calls.map(([target]) => String(target));
    expect(looked.some((target) => target.includes("layershell.node"))).toBe(false);
  });

  it("is null on linux when the addon was never built", async () => {
    setPlatform("linux");
    const exists = vi.spyOn(fs, "existsSync").mockReturnValue(false);

    expect((await freshProbe())()).toBeNull();
    // Not vacuous: it did look, and looked where a packaged build puts it.
    expect(exists).toHaveBeenCalled();
    const looked = exists.mock.calls.map(([target]) => String(target));
    expect(looked.some((target) => target.includes("layershell.node"))).toBe(true);
  });

  // The whole point of the optional addon: a present but broken one is not fatal.
  it("is null when a present addon fails to load", async () => {
    setPlatform("linux");
    vi.spyOn(fs, "existsSync").mockReturnValue(true);

    expect((await freshProbe())()).toBeNull();
  });

  it("caches the failed load instead of retrying every call", async () => {
    setPlatform("linux");
    const exists = vi.spyOn(fs, "existsSync").mockReturnValue(false);
    const probe = await freshProbe();

    probe();
    const afterFirst = exists.mock.calls.length;
    probe();

    expect(exists.mock.calls.length).toBe(afterFirst);
  });
});
