import { describe, expect, it, vi } from "vitest";

const holder = vi.hoisted(() => ({ png: Buffer.alloc(0) }));
const recognizeStatAreaMock = vi.fn();

vi.mock("../../services/rivenOcrOnnx", () => ({
  rivenOcrOnnxAvailable: () => true,
  recognizeStatArea: (...args: unknown[]) => recognizeStatAreaMock(...args),
  hasLowConfidenceLine: () => false,
  LOW_CONFIDENCE_THRESHOLD: 0.8,
}));

vi.mock("../../services/rewardScanDebug", () => ({
  areOcrDebugDumpsEnabled: () => false,
}));

vi.mock("../../ipc/overlay/rivenScanImage", () => {
  const crop = () => ({
    getSize: () => ({ width: 64, height: 48 }),
    toPNG: () => holder.png,
  });
  return {
    cropRivenStatImage: () => ({ cardCrop: crop(), statCrop: crop() }),
    cropRivenStatAreaFallback: () => null,
  };
});

import { recognizeRivenCardStats } from "../../ipc/overlay/rivenScanOcr";

describe("recognizeRivenCardStats", () => {
  it("refuses a read that recovered fewer than two stats", async () => {
    const sharp = (await import("sharp")).default;
    holder.png = await sharp({
      create: { width: 64, height: 48, channels: 3, background: { r: 10, g: 10, b: 18 } },
    })
      .png()
      .toBuffer();

    // A degraded frame that only ever yields one stat line.
    recognizeStatAreaMock.mockResolvedValue({
      lines: [{ text: "-66.2% Weapon Recoil", confidence: 0.9 }],
      text: "-66.2% Weapon Recoil",
      minConfidence: 0.9,
      yoloBoxCount: 3,
    });

    const result = await recognizeRivenCardStats(
      {} as never,
      { x: 0, y: 0, width: 1, height: 1 },
      { generation: 1, isStale: () => false, label: "test" },
    );

    expect(result.stats).toEqual([]);
    expect(result.lowConfidence).toBe(true);
  });
});
