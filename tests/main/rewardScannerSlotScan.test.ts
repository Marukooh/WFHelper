import { describe, expect, it, vi } from "vitest";

import { scanRewardSlotsFallback } from "../../services/rewardScannerSlotScan";

const h = vi.hoisted(() => ({
  layouts: [] as unknown[],
  matches: {} as Record<string, unknown[]>,
}));

vi.mock("../../services/logger", () => ({
  withScope: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
const dumpRewardScanDebug = vi.hoisted(() => vi.fn());
vi.mock("../../services/rewardScanDebug", () => ({ dumpRewardScanDebug }));
vi.mock("../../services/rewardScannerSupport", () => ({ hasConfidentSlotLayout: () => true }));
vi.mock("../../services/rewardOcrOnnx", () => ({
  rewardOcrOnnxAvailable: () => false,
  recognizeRewardStripOnnx: vi.fn(),
}));
vi.mock("../../services/rewardScannerMatch", () => ({
  MAX_REWARD_SLOTS: 4,
  SUBSTRING_SCORE_FLOOR: 0.88,
  rankRewardCandidatesDetailed: (text: string) => h.matches[text] || [],
}));
vi.mock("../../services/rewardScannerImage", () => ({
  detectRewardSlotLayoutCandidates: () => h.layouts,
  binarizeRewardRegion: async (png: Buffer) => png,
  cropRect: (_image: unknown, rect: { x: number }) => ({
    toPNG: () => Buffer.from(`crop:${rect.x}`),
  }),
}));

function slot(x: number) {
  return { titleRect: { x, y: 0, width: 90, height: 20 } };
}

function match(name: string, score = 200, mode = "exact", confidence = 0.99) {
  return [{ item: { name }, confidence, score, mode }];
}

async function scan(ocrByCrop: Record<string, string>) {
  return scanRewardSlotsFallback({ image: {} as never }, 4, 60_000, Date.now(), {
    sortedItems: [],
    ocrTimeoutMs: 1000,
    runOCRStructuredBuffer: async (buffer: Buffer) => ({
      text: ocrByCrop[buffer.toString()] || "",
    }),
    reader: "windows",
  });
}

describe("scanRewardSlotsFallback layout merge", () => {
  it("fills the winner's empty slots from losing layout hits at the same x", async () => {
    h.layouts = [
      { count: 4, confidence: 0.9, slots: [slot(0), slot(100), slot(200), slot(300)] },
      { count: 3, confidence: 0.7, slots: [slot(10), slot(150), slot(302)] },
    ];
    h.matches = {
      "item alpha": match("Item Alpha"),
      "item beta": match("Item Beta"),
      "item gamma": match("Item Gamma"),
      "item delta": match("Item Delta"),
    };
    const result = await scan({
      "crop:0": "item alpha",
      "crop:100": "item beta",
      "crop:200": "item gamma",
      "crop:302": "item delta",
    });

    expect(result?.strategy).toBe("slot-merged");
    expect(result?.items.map((item) => item.name)).toEqual([
      "Item Alpha",
      "Item Beta",
      "Item Gamma",
      "Item Delta",
    ]);
    expect(result?.items.map((item) => item.slotIndex)).toEqual([0, 1, 2, 3]);
    expect(result?.emptySlots).toBe(0);
    expect(result?.matchedSlots).toBe(4);
  });

  // Real 4-reward screen: two cards matched perfectly, two matched correctly but
  // weaker, and the 2-slot subset outscored the full read on averages.
  it("keeps a full four-slot read over a cleaner two-slot subset", async () => {
    h.layouts = [
      { count: 4, confidence: 0.9, slots: [slot(0), slot(100), slot(200), slot(300)] },
      { count: 2, confidence: 0.9, slots: [slot(100), slot(200)] },
    ];
    h.matches = {
      "orthos prime handle": match("Orthos Prime Handle", 300, "substring"),
      "mesa prime blueprint": match("Mesa Prime Blueprint", 1100),
      "odonata prime blueprint": match("Odonata Prime Blueprint", 1100),
      "forma blueprint": match("Forma Blueprint", 300),
    };
    const result = await scan({
      "crop:0": "orthos prime handle",
      "crop:100": "mesa prime blueprint",
      "crop:200": "odonata prime blueprint",
      "crop:300": "forma blueprint",
    });

    expect(result?.matchedSlots).toBe(4);
    expect(result?.items.map((item) => item.name)).toEqual([
      "Orthos Prime Handle",
      "Mesa Prime Blueprint",
      "Odonata Prime Blueprint",
      "Forma Blueprint",
    ]);
  });

  // 4-player squad where only two cracked a relic: the wide layout matches the
  // same two cards but leaves two slots empty, so the tight layout must win.
  it("prefers the smaller layout when the extra slots are empty", async () => {
    h.layouts = [
      { count: 4, confidence: 0.9, slots: [slot(0), slot(100), slot(200), slot(300)] },
      { count: 2, confidence: 0.9, slots: [slot(100), slot(200)] },
    ];
    h.matches = {
      "mesa prime blueprint": match("Mesa Prime Blueprint", 1100),
      "odonata prime blueprint": match("Odonata Prime Blueprint", 1100),
    };
    const result = await scan({
      "crop:100": "mesa prime blueprint",
      "crop:200": "odonata prime blueprint",
    });

    expect(result?.matchedSlots).toBe(2);
    expect(result?.emptySlots).toBe(0);
    expect(result?.items.map((item) => item.name)).toEqual([
      "Mesa Prime Blueprint",
      "Odonata Prime Blueprint",
    ]);
  });

  // Four cards on screen, the wide layout rejects every read and a two-card
  // subset ships as the answer, so the rejected wide crops are what to keep.
  it("dumps the rejected wide crops when a narrower layout wins", async () => {
    dumpRewardScanDebug.mockClear();
    h.layouts = [
      { count: 4, confidence: 0.9, slots: [slot(0), slot(100), slot(200), slot(300)] },
      { count: 2, confidence: 0.9, slots: [slot(110), slot(210)] },
    ];
    h.matches = {
      "kavasa near": match("Kavasa Prime Kubrow Collar Blueprint", 480, "substring", 0.88),
      "forma near": match("Forma Blueprint", 300, "fuzzy", 0.68),
      "forma blueprint": match("Forma Blueprint", 1100),
    };
    const result = await scan({
      "crop:0": "forma near",
      "crop:100": "forma near",
      "crop:200": "kavasa near",
      "crop:110": "forma blueprint",
      "crop:210": "forma blueprint",
    });

    expect(result?.matchedSlots).toBe(2);
    const reasons = dumpRewardScanDebug.mock.calls.map((call) => call[0]);
    expect(reasons).toContain("smaller-layout");
  });

  // Every choice count shares one 0.127W pitch, so a real 2-card screen sits on
  // the middle two slots of a spurious 4-slot layout. Junk off a padding slot
  // must not spend a debug bundle; the cap is 25 and pruning evicts real ones.
  it("stays quiet when a healthy two-card scan sits inside a wider layout", async () => {
    dumpRewardScanDebug.mockClear();
    h.layouts = [
      { count: 4, confidence: 0.9, slots: [slot(0), slot(100), slot(200), slot(300)] },
      { count: 2, confidence: 0.9, slots: [slot(100), slot(200)] },
    ];
    h.matches = {
      "mesa prime blueprint": match("Mesa Prime Blueprint", 1100),
      "odonata prime blueprint": match("Odonata Prime Blueprint", 1100),
      "padding noise": match("Forma Blueprint", 120, "fuzzy", 0.5),
    };
    const result = await scan({
      "crop:0": "padding noise",
      "crop:100": "mesa prime blueprint",
      "crop:200": "odonata prime blueprint",
    });

    expect(result?.matchedSlots).toBe(2);
    expect(dumpRewardScanDebug.mock.calls.map((call) => call[0])).not.toContain("smaller-layout");
  });

  it("keeps a solo single-reward read", async () => {
    h.layouts = [
      { count: 4, confidence: 0.9, slots: [slot(0), slot(100), slot(200), slot(300)] },
      { count: 1, confidence: 0.9, slots: [slot(200)] },
    ];
    h.matches = { "forma blueprint": match("Forma Blueprint", 900) };
    const result = await scan({ "crop:200": "forma blueprint" });

    expect(result?.matchedSlots).toBe(1);
    expect(result?.emptySlots).toBe(0);
    expect(result?.items.map((item) => item.name)).toEqual(["Forma Blueprint"]);
  });

  it("never overrides a slot the winner already filled", async () => {
    h.layouts = [
      { count: 4, confidence: 0.9, slots: [slot(0), slot(100), slot(200), slot(300)] },
      { count: 3, confidence: 0.7, slots: [slot(10), slot(150), slot(302)] },
    ];
    h.matches = {
      "item alpha": match("Item Alpha"),
      "item beta": match("Item Beta"),
      "item gamma": match("Item Gamma"),
      "wrong item": match("Wrong Item", 500),
    };
    const result = await scan({
      "crop:0": "item alpha",
      "crop:100": "item beta",
      "crop:200": "item gamma",
      "crop:10": "wrong item",
    });

    expect(result?.strategy).toBe("slot-primary");
    expect(result?.items.map((item) => item.name)).toEqual([
      "Item Alpha",
      "Item Beta",
      "Item Gamma",
    ]);
    expect(result?.emptySlots).toBe(1);
  });

  // Both engines can resolve the right name while the fuzzy score sits just under
  // the gate, which leaves the slot empty on every retry.
  it("rescues an empty slot from its own near-gate read", async () => {
    h.layouts = [{ count: 4, confidence: 0.9, slots: [slot(0), slot(100), slot(200), slot(300)] }];
    h.matches = {
      "fang prime blade": match("Fang Prime Blade"),
      "lavos prime systems blueprint": match("Lavos Prime Systems Blueprint"),
      "sevagoth ptihe systems blueorint": match(
        "Sevagoth Prime Systems Blueprint",
        300,
        "fuzzy",
        0.825,
      ),
      "caliban prime blueprint": match("Caliban Prime Blueprint"),
    };
    const result = await scan({
      "crop:0": "fang prime blade",
      "crop:100": "lavos prime systems blueprint",
      "crop:200": "sevagoth ptihe systems blueorint",
      "crop:300": "caliban prime blueprint",
    });

    expect(result?.strategy).toBe("slot-rescued");
    expect(result?.items.map((item) => item.name)).toEqual([
      "Fang Prime Blade",
      "Lavos Prime Systems Blueprint",
      "Sevagoth Prime Systems Blueprint",
      "Caliban Prime Blueprint",
    ]);
    expect(result?.emptySlots).toBe(0);
  });

  it("never rescues a substring candidate sitting on the clamp floor", async () => {
    h.layouts = [{ count: 4, confidence: 0.9, slots: [slot(0), slot(100), slot(200), slot(300)] }];
    h.matches = {
      "forma blueprint": match("Forma Blueprint"),
      "lavos prime systems blueprint": match("Lavos Prime Systems Blueprint"),
      // A wrap-eaten read that is a substring of one long name. 0.88 is the
      // clamp, not a measurement, so the rescue margin must not carry it.
      lueprint: match("Kavasa Prime Kubrow Collar Blueprint", 260, "substring", 0.88),
      "caliban prime blueprint": match("Caliban Prime Blueprint"),
    };
    const result = await scan({
      "crop:0": "forma blueprint",
      "crop:100": "lavos prime systems blueprint",
      "crop:200": "lueprint",
      "crop:300": "caliban prime blueprint",
    });

    expect(result?.items.map((item) => item.name)).not.toContain(
      "Kavasa Prime Kubrow Collar Blueprint",
    );
    expect(result?.emptySlots).toBe(1);
  });

  it("still rescues a substring candidate scored above the clamp floor", async () => {
    h.layouts = [{ count: 4, confidence: 0.9, slots: [slot(0), slot(100), slot(200), slot(300)] }];
    h.matches = {
      "forma blueprint": match("Forma Blueprint"),
      "lavos prime systems blueprint": match("Lavos Prime Systems Blueprint"),
      "sevagoth prime systems blueprin": match(
        "Sevagoth Prime Systems Blueprint",
        300,
        "substring",
        0.9,
      ),
      "caliban prime blueprint": match("Caliban Prime Blueprint"),
    };
    const result = await scan({
      "crop:0": "forma blueprint",
      "crop:100": "lavos prime systems blueprint",
      "crop:200": "sevagoth prime systems blueprin",
      "crop:300": "caliban prime blueprint",
    });

    expect(result?.strategy).toBe("slot-rescued");
    expect(result?.emptySlots).toBe(0);
  });

  it("leaves far-below-gate junk and duplicate near-misses out", async () => {
    h.layouts = [{ count: 4, confidence: 0.9, slots: [slot(0), slot(100), slot(200), slot(300)] }];
    h.matches = {
      "fang prime blade": match("Fang Prime Blade"),
      "lavos prime systems blueprint": match("Lavos Prime Systems Blueprint"),
      // A misaligned crop scores far lower - must stay an empty slot.
      "systems sevagoth blue": match("Sevagoth Prime Systems Blueprint", 150, "fuzzy", 0.525),
      // A near-gate read of an already-accepted card must not duplicate it.
      "lavos prime systems blueorint": match("Lavos Prime Systems Blueprint", 280, "fuzzy", 0.84),
    };
    const result = await scan({
      "crop:0": "fang prime blade",
      "crop:100": "lavos prime systems blueprint",
      "crop:200": "systems sevagoth blue",
      "crop:300": "lavos prime systems blueorint",
    });

    expect(result?.strategy).toBe("slot-primary");
    expect(result?.items.map((item) => item.name)).toEqual([
      "Fang Prime Blade",
      "Lavos Prime Systems Blueprint",
    ]);
    expect(result?.emptySlots).toBe(2);
  });

  // Partial crack: two of four squad members cracked, the wide layout won.
  // The uncracked slots read background noise or nothing - both stay empty.
  it("leaves genuinely empty crack slots empty", async () => {
    h.layouts = [{ count: 4, confidence: 0.9, slots: [slot(0), slot(100), slot(200), slot(300)] }];
    h.matches = {
      "fang prime blade": match("Fang Prime Blade"),
      "caliban prime blueprint": match("Caliban Prime Blueprint"),
      "background noise": match("Odonata Prime Blueprint", 120, "fuzzy", 0.62),
    };
    const result = await scan({
      "crop:0": "fang prime blade",
      "crop:100": "caliban prime blueprint",
      "crop:200": "background noise",
    });

    expect(result?.strategy).toBe("slot-primary");
    expect(result?.items.map((item) => item.name)).toEqual([
      "Fang Prime Blade",
      "Caliban Prime Blueprint",
    ]);
    expect(result?.emptySlots).toBe(2);
  });

  it("does not rescue into a winner that has no exact hit", async () => {
    h.layouts = [{ count: 2, confidence: 0.9, slots: [slot(0), slot(100)] }];
    h.matches = {
      "mesa prime bluepr": match("Mesa Prime Blueprint", 400, "fuzzy", 0.9),
      "odonata prime bluepri": match("Odonata Prime Blueprint", 300, "fuzzy", 0.82),
    };
    const result = await scan({
      "crop:0": "mesa prime bluepr",
      "crop:100": "odonata prime bluepri",
    });

    expect(result?.strategy).toBe("slot-primary");
    expect(result?.items.map((item) => item.name)).toEqual(["Mesa Prime Blueprint"]);
    expect(result?.emptySlots).toBe(1);
  });

  it("ignores donors that barely overlap any winner slot", async () => {
    h.layouts = [
      { count: 4, confidence: 0.9, slots: [slot(0), slot(100), slot(200), slot(300)] },
      { count: 2, confidence: 0.7, slots: [slot(150), slot(355)] },
    ];
    h.matches = {
      "item alpha": match("Item Alpha"),
      "item beta": match("Item Beta"),
      "item gamma": match("Item Gamma"),
      "item delta": match("Item Delta"),
    };
    const result = await scan({
      "crop:0": "item alpha",
      "crop:100": "item beta",
      "crop:200": "item gamma",
      "crop:355": "item delta",
    });

    expect(result?.strategy).toBe("slot-primary");
    expect(result?.items).toHaveLength(3);
  });
});
