import { describe, expect, it } from "vitest";

import {
  hasLowConfidenceLine,
  recognizePaddleCrops,
  type RgbCrop,
} from "../../services/rivenOcrOnnx";

async function wordCrop(word: string, width: number, height: number): Promise<RgbCrop> {
  const sharp = (await import("sharp")).default;
  const svg =
    `<svg width="${width}" height="${height}">` +
    `<rect width="${width}" height="${height}" fill="black"/>` +
    `<text x="6" y="${Math.round(height * 0.74)}" font-family="Arial" ` +
    `font-size="${Math.round(height * 0.6)}" fill="white">${word}</text></svg>`;
  const { data, info } = await sharp(Buffer.from(svg))
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

describe("recognizePaddleCrops", () => {
  // Crops are regrouped by width before inference, so the batch order is not the
  // caller's order. A stat line read into the wrong row grades the wrong stat.
  it("returns a result per crop in the caller's order", async () => {
    const crops = await Promise.all([
      wordCrop("Sobek", 300, 48),
      wordCrop("Braton Braton Braton", 900, 26),
      wordCrop("Lex", 120, 60),
      wordCrop("Boar", 240, 40),
      wordCrop("Paris Paris", 520, 30),
      wordCrop("Kuva", 200, 52),
      wordCrop("Ogris", 260, 44),
      wordCrop("Latron Latron", 640, 34),
    ]);

    const batched = await recognizePaddleCrops(crops);
    expect(batched).toHaveLength(crops.length);

    const alone = [];
    for (const crop of crops) alone.push((await recognizePaddleCrops([crop]))[0]);
    expect(batched.map((row) => row.text)).toEqual(alone.map((row) => row.text));
    expect(batched.some((row) => row.text.length > 0)).toBe(true);
  }, 120_000);

  // Real riven captures produce text crops up to 59:1 while solid panel rules sit
  // at 27-37:1, so no aspect threshold can tell them apart. Wide text has to
  // survive intact, which rules out squeezing every crop to a fixed ratio.
  it("reads a wide text crop the same beside a wider blank one", async () => {
    const wide = await wordCrop("Kuva Sobek Boar Prime Paris Prime Latron", 1740, 30);
    expect(wide.width / wide.height).toBeGreaterThan(55);
    const rule: RgbCrop = { data: Buffer.alloc(1721 * 21 * 3, 235), width: 1721, height: 21 };

    const [alone] = await recognizePaddleCrops([wide]);
    expect(alone.text.length).toBeGreaterThan(0);

    const beside = await recognizePaddleCrops([wide, rule]);
    expect(beside).toHaveLength(2);
    expect(beside[0].text).toBe(alone.text);
  }, 120_000);

  it("skips a crop that busts the decode budget on its own", async () => {
    const good = await wordCrop("Sobek", 300, 48);
    const artifact: RgbCrop = { data: Buffer.alloc(3840 * 5 * 3, 235), width: 3840, height: 5 };

    const results = await recognizePaddleCrops([good, artifact]);
    expect(results).toHaveLength(2);
    expect(results[1]).toEqual({ text: "", confidence: 0 });
    expect(results[0].text.length).toBeGreaterThan(0);
  }, 120_000);
});

describe("hasLowConfidenceLine", () => {
  const line = (text: string, confidence: number) => ({ text, confidence });
  const result = (lines: Array<{ text: string; confidence: number }>) => ({
    lines,
    text: lines.map((l) => l.text).join("\n"),
    minConfidence: Math.min(...lines.map((l) => l.confidence)),
    yoloBoxCount: lines.length,
  });

  it("ignores a garbled MR badge that happens to start with X", () => {
    // "X(m R9" once gated a perfect four-stat read at 0.92+.
    expect(
      hasLowConfidenceLine(
        result([
          line("+72.7% Fire Rate (X2 for", 0.93),
          line("-66.2% Weapon Recoil", 0.92),
          line("+85.7% Multishot", 0.94),
          line("-65,1% Status Duration", 0.92),
          line("X(m R9", 0.57),
        ]),
      ),
    ).toBe(false);
  });

  it("still gates low-confidence stat and multiplier lines", () => {
    expect(hasLowConfidenceLine(result([line("-66.2% Weapon Recoil", 0.7)]))).toBe(true);
    expect(hasLowConfidenceLine(result([line("x2 Combo Duration", 0.7)]))).toBe(true);
  });
});
