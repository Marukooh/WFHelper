import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.join(__dirname, "..", "..");
const SCANNED_DIRS = ["ipc", "services"];

function collectTsFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return collectTsFiles(full);
    return entry.isFile() && full.endsWith(".ts") ? [full] : [];
  });
}

describe("renderer asset paths", () => {
  // At runtime __dirname is .electron-build, which contains no renderer/ - so a
  // renderer file resolved from it never loads. Linux capture and the trade
  // toasts both depend on this.
  it("never resolves a renderer file from __dirname", () => {
    const offenders: string[] = [];

    for (const dir of SCANNED_DIRS) {
      for (const file of collectTsFiles(path.join(ROOT, dir))) {
        const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
        lines.forEach((line, index) => {
          if (line.includes("__dirname") && line.includes('"renderer"')) {
            offenders.push(`${path.relative(ROOT, file)}:${index + 1}`);
          }
        });
      }
    }

    expect(offenders).toEqual([]);
  });
});
