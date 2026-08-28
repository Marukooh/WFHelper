import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RELIC_RECOMMENDATIONS } from "../../config/shared/ipcChannels";
import type { OverlaySettings } from "../../config/runtime/overlaySettings";
import { createRelicSelectionController } from "../../ipc/overlay/relicSelection";

const tempDirs: string[] = [];

function makeTempSnapshot(snapshot: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wfhelper-relic-selection-"));
  tempDirs.push(dir);
  const filePath = path.join(dir, "snapshot-cache.json");
  fs.writeFileSync(filePath, JSON.stringify(snapshot), "utf-8");
  return filePath;
}

describe("relic selection planner", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses snapshot prices even when their entry timestamp is older than the live cache ttl", async () => {
    const staleTimestamp = Date.now() - 31 * 24 * 60 * 60 * 1000;
    const cacheFilePath = makeTempSnapshot({
      version: 1,
      generatedAt: staleTimestamp,
      prices: {
        akarius_prime_blueprint: {
          status: "ok",
          median: 15,
          timestamp: staleTimestamp,
        },
      },
      meta: {
        akarius_prime_blueprint: {
          ducats: 100,
        },
      },
      orderSummaries: {},
    });

    const sentEvents: Array<{ channel: string; payload: unknown }> = [];
    const controller = createRelicSelectionController({
      log: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
      ctx: {
        // controller only reads autoTriggerEnabled
        overlaySettings: { autoTriggerEnabled: true } as OverlaySettings,
        currentInventoryData: {
          LevelKeys: [{ ItemType: "/Lotus/Types/Game/Projections/NeoTestIntact", ItemCount: 1 }],
        },
      },
      windows: {
        createOverlayWindow: vi.fn(),
        clearOverlayAutoHideTimer: vi.fn(),
        scheduleOverlayAutoHide: vi.fn(),
        sendOverlayEvent: (channel, payload) => sentEvents.push({ channel, payload }),
        positionOverlayWindow: vi.fn(),
        getAnchorMeta: () => null,
        setAnchorMeta: vi.fn(),
      },
      relicService: {
        getRelicDatabase: () => ({
          groups: {
            "Neo Test": {
              key: "Neo Test",
              name: "Neo Test",
              tier: "Neo",
              qualities: {
                intact: {
                  rewards: [
                    {
                      chance: 100,
                      urlName: "akarius_prime_blueprint",
                      ducats: null,
                      rarity: "Rare",
                    },
                  ],
                },
              },
            },
          },
          byUniqueName: {
            "/Lotus/Types/Game/Projections/NeoTestIntact": {
              groupKey: "Neo Test",
              quality: "intact",
            },
          },
        }),
      },
      rewardScanner: {
        detectRelicSelectionEra: async () => ({
          era: "Neo",
          confidence: 1,
        }),
      },
      wfmStatsPrice: {
        getCachedPriceBySlug: vi.fn(),
      },
      fs,
      cacheFilePath,
    });

    await controller.onRelicSelectionTrigger("manual");
    await new Promise((resolve) => setTimeout(resolve, 10));

    const recommendation = sentEvents
      .filter((event) => event.channel === RELIC_RECOMMENDATIONS)
      .at(-1)?.payload as { rows?: Array<{ platEv: number | null; ducatEv: number | null }> };

    expect(recommendation.rows?.[0]?.platEv).toBe(15);
    expect(recommendation.rows?.[0]?.ducatEv).toBe(100);
  });

  it("serves reward prices from the snapshot, refusing a too-old file", () => {
    const cacheFilePath = makeTempSnapshot({
      version: 1,
      generatedAt: Date.now(),
      prices: {
        akarius_prime_blueprint: { status: "ok", median: 15, timestamp: Date.now() },
      },
      meta: {},
      orderSummaries: {},
    });
    const controller = createRelicSelectionController({
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      ctx: {
        overlaySettings: { autoTriggerEnabled: true } as OverlaySettings,
        currentInventoryData: null,
      },
      windows: {
        createOverlayWindow: vi.fn(),
        clearOverlayAutoHideTimer: vi.fn(),
        scheduleOverlayAutoHide: vi.fn(),
        sendOverlayEvent: vi.fn(),
        positionOverlayWindow: vi.fn(),
        getAnchorMeta: () => null,
        setAnchorMeta: vi.fn(),
      },
      relicService: { getRelicDatabase: () => ({ groups: {}, byUniqueName: {} }) },
      rewardScanner: { detectRelicSelectionEra: async () => ({ era: null, confidence: 0 }) },
      wfmStatsPrice: { getCachedPriceBySlug: vi.fn() },
      fs,
      cacheFilePath,
    });

    expect(controller.getSnapshotPrice("akarius_prime_blueprint")).toBe(15);
    expect(controller.getSnapshotPrice("unknown_slug")).toBeNull();

    const old = new Date(Date.now() - 49 * 60 * 60 * 1000);
    fs.utimesSync(cacheFilePath, old, old);
    expect(controller.getSnapshotPrice("akarius_prime_blueprint")).toBeNull();
  });

  function makeTwoEraController(currentInventoryData?: Record<string, unknown>) {
    const cacheFilePath = makeTempSnapshot({
      version: 1,
      generatedAt: Date.now(),
      prices: {
        lith_prize_blueprint: { status: "ok", median: 5, timestamp: Date.now() },
        akarius_prime_blueprint: { status: "ok", median: 15, timestamp: Date.now() },
      },
      meta: {},
      orderSummaries: {},
    });

    const sentEvents: Array<{ channel: string; payload: unknown }> = [];
    const ocrSpy = vi.fn(
      async (): Promise<{ era: string | null; confidence: number; candidateId?: string }> => ({
        era: "Lith",
        confidence: 1,
      }),
    );
    const group = (name: string, tier: string, slug: string) => ({
      key: name,
      name,
      tier,
      qualities: {
        intact: {
          rewards: [{ chance: 100, urlName: slug, ducats: null, rarity: "Rare" }],
        },
      },
    });
    const controller = createRelicSelectionController({
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      ctx: {
        overlaySettings: { autoTriggerEnabled: true } as OverlaySettings,
        currentInventoryData: currentInventoryData ?? {
          LevelKeys: [
            { ItemType: "/Lotus/Types/Game/Projections/LithTestIntact", ItemCount: 1 },
            { ItemType: "/Lotus/Types/Game/Projections/NeoTestIntact", ItemCount: 1 },
          ],
        },
      },
      windows: {
        createOverlayWindow: vi.fn(),
        clearOverlayAutoHideTimer: vi.fn(),
        scheduleOverlayAutoHide: vi.fn(),
        sendOverlayEvent: (channel, payload) => sentEvents.push({ channel, payload }),
        positionOverlayWindow: vi.fn(),
        getAnchorMeta: () => null,
        setAnchorMeta: vi.fn(),
      },
      relicService: {
        getRelicDatabase: () => ({
          groups: {
            "Lith Test": group("Lith Test", "Lith", "lith_prize_blueprint"),
            "Neo Test": group("Neo Test", "Neo", "akarius_prime_blueprint"),
          },
          byUniqueName: {
            "/Lotus/Types/Game/Projections/LithTestIntact": {
              groupKey: "Lith Test",
              quality: "intact",
            },
            "/Lotus/Types/Game/Projections/NeoTestIntact": {
              groupKey: "Neo Test",
              quality: "intact",
            },
          },
        }),
      },
      rewardScanner: { detectRelicSelectionEra: ocrSpy },
      wfmStatsPrice: { getCachedPriceBySlug: vi.fn() },
      fs,
      cacheFilePath,
    });

    const lastRecommendation = () =>
      sentEvents.filter((event) => event.channel === RELIC_RECOMMENDATIONS).at(-1)?.payload as {
        era?: string | null;
        rows?: Array<{ label: string }>;
      };

    return { controller, ocrSpy, lastRecommendation };
  }

  it("uses the shared split-stack and collection precedence rules", async () => {
    const lith = "/Lotus/Types/Game/Projections/LithTestIntact";
    const neo = "/Lotus/Types/Game/Projections/NeoTestIntact";
    const { controller, lastRecommendation } = makeTwoEraController({
      LevelKeys: [
        { ItemType: lith, ItemCount: 2 },
        { ItemType: lith, ItemCount: 3 },
      ],
      MiscItems: [
        { ItemType: lith, ItemCount: 4 },
        { ItemType: lith, ItemCount: 3 },
        { ItemType: neo, ItemCount: 0 },
      ],
      Recipes: [{ ItemType: lith, ItemCount: 1 }],
    });

    await controller.onRelicSelectionTrigger("manual");
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(lastRecommendation().rows?.map((row) => row.label)).toEqual(["7x Lith Test Intact"]);
  });

  it("omnia mission tag recommends every era; tile-style OCR cannot override it", async () => {
    const { controller, ocrSpy, lastRecommendation } = makeTwoEraController();

    controller.setActiveMissionTag("VoidT6");
    await controller.onRelicSelectionTrigger("manual");
    await new Promise((resolve) => setTimeout(resolve, 10));

    const payload = lastRecommendation();
    expect(payload.era).toBe("omnia");
    expect(payload.rows?.map((row) => row.label).sort()).toEqual([
      "1x Lith Test Intact",
      "1x Neo Test Intact",
    ]);
    // tag set -> only the cheap label recheck runs; its lith answer carries no
    // filter-label candidate, so the tag stands
    expect(ocrSpy).toHaveBeenCalledWith(expect.objectContaining({ labelOnly: true }));
  });

  it("stale mission tag yields to a confident filter-label read", async () => {
    const { controller, ocrSpy, lastRecommendation } = makeTwoEraController();
    ocrSpy.mockResolvedValue({ era: "omnia", confidence: 1, candidateId: "filter-label" });

    controller.setActiveMissionTag("VoidT1"); // lith tag lingering from the last mission
    await controller.onRelicSelectionTrigger("manual");
    await new Promise((resolve) => setTimeout(resolve, 10));

    const payload = lastRecommendation();
    expect(payload.era).toBe("omnia");
    expect(payload.rows?.map((row) => row.label).sort()).toEqual([
      "1x Lith Test Intact",
      "1x Neo Test Intact",
    ]);
    expect(ocrSpy).toHaveBeenCalledWith(expect.objectContaining({ labelOnly: true }));
  });

  it("void tag era survives picker close; non-fissure tag falls back to OCR", async () => {
    const { controller, ocrSpy, lastRecommendation } = makeTwoEraController();

    controller.setActiveMissionTag("VoidT3");
    await controller.onRelicSelectionTrigger("manual");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(lastRecommendation().rows?.map((row) => row.label)).toEqual(["1x Neo Test Intact"]);

    controller.resetMissionTier();
    await controller.onRelicSelectionTrigger("manual");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(lastRecommendation().rows?.map((row) => row.label)).toEqual(["1x Neo Test Intact"]);
    // while the tag rules, OCR is only consulted as the label-only recheck
    for (const call of ocrSpy.mock.calls) {
      expect(call).toEqual([expect.objectContaining({ labelOnly: true })]);
    }

    controller.setActiveMissionTag("EntratiHubKey");
    controller.resetMissionTier();
    await controller.onRelicSelectionTrigger("manual");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(ocrSpy).toHaveBeenCalled();
    expect(lastRecommendation().rows?.map((row) => row.label)).toEqual(["1x Lith Test Intact"]);
  });

  it("mission end clears the fissure tag so the next pick trusts OCR again", async () => {
    const { controller, lastRecommendation } = makeTwoEraController();

    controller.setActiveMissionTag("VoidT6"); // omnia fissure
    await controller.onRelicSelectionTrigger("manual");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(lastRecommendation().era).toBe("omnia");

    // extraction/abort routes the EndOfMission sentinel through the same callback
    controller.setActiveMissionTag("EndOfMission");
    controller.resetMissionTier();
    await controller.onRelicSelectionTrigger("manual");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(lastRecommendation().era).toBe("lith");
    expect(lastRecommendation().rows?.map((row) => row.label)).toEqual(["1x Lith Test Intact"]);
  });

  it("an OCR era ages out instead of renewing itself on every pick", async () => {
    const { controller, ocrSpy, lastRecommendation } = makeTwoEraController();
    const realNow = Date.now();
    let clock = realNow;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => clock);

    try {
      ocrSpy.mockResolvedValue({ era: "neo", confidence: 1, candidateId: "tile-slot-1" });
      await controller.onRelicSelectionTrigger("manual");
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(lastRecommendation().era).toBe("neo");

      // Keep picking inside the window: the cached read is reused, but its
      // clock must not restart, or a wrong era never expires.
      clock += 20 * 60 * 1000;
      await controller.onRelicSelectionTrigger("manual");
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(lastRecommendation().era).toBe("neo");

      clock += 10 * 60 * 1000;
      ocrSpy.mockResolvedValue({ era: null, confidence: 0 });
      await controller.onRelicSelectionTrigger("manual");
      await new Promise((resolve) => setTimeout(resolve, 900));
      expect(lastRecommendation().era).toBeNull();
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("retries an empty era read once before sending unfiltered rows", async () => {
    const { controller, ocrSpy, lastRecommendation } = makeTwoEraController();
    ocrSpy.mockResolvedValueOnce({ era: null, confidence: 0 });

    await controller.onRelicSelectionTrigger("manual");
    await new Promise((resolve) => setTimeout(resolve, 900));

    expect(ocrSpy).toHaveBeenCalledTimes(2);
    const payload = lastRecommendation();
    expect(payload.era).toBe("lith");
    expect(payload.rows?.map((row) => row.label)).toEqual(["1x Lith Test Intact"]);
  });
});
