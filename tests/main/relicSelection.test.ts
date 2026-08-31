import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RELIC_RECOMMENDATIONS } from "../../config/shared/ipcChannels";
import type { OverlaySettings } from "../../config/runtime/overlaySettings";
import { createRelicSelectionController } from "../../ipc/overlay/relicSelection";
import { detectRelicEraFromBandText } from "../../services/rewardScannerMatch";

const tempDirs: string[] = [];

// Verbatim OCR previews. The first is the star chart fissure list; the second is
// WFHelper's own planner overlay read back off the screen, with "profits" and
// "VAULTED" mangled by the scan.
const STAR_CHART_FISSURE_LIST =
  "Requiem Fissure Garus (Kuva Fortres: CIII 14m ASSAULT (160-17 Requiem Fissure Koro " +
  "(Kuva Fortress) C31m 27s VOID FLOOD (158. Omnia Fissure Everview Arc";
const OWN_OVERLAY_BAND =
  "29x Requiem III Intact 6.6 E. proflts: VAULTEO 29x Requiem IV Intact VAULTEO 6.6 E. proflts:";

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
      // Real timers here, so the production start delay would race every assertion.
      eraStartDelayMs: 0,
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
      eraStartDelayMs: 0,
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
      async (): Promise<{
        era: string | null;
        confidence: number;
        candidateId?: string;
        textPreview?: string;
      }> => ({
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
      eraStartDelayMs: 0,
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

  function makeRequiemController() {
    const cacheFilePath = makeTempSnapshot({
      version: 1,
      generatedAt: Date.now(),
      prices: {},
      meta: {},
      orderSummaries: {},
    });

    const sentEvents: Array<{ channel: string; payload: unknown }> = [];
    const ocrSpy = vi.fn(
      async (): Promise<{
        era: string | null;
        confidence: number;
        candidateId?: string;
        textPreview?: string;
      }> => ({ era: null, confidence: 0 }),
    );
    const group = (name: string, tier: string) => ({
      key: name,
      name,
      tier,
      qualities: { intact: { rewards: [{ chance: 100, urlName: "x", ducats: null }] } },
    });
    const uniqueName = (name: string) => `/Lotus/Types/Game/Projections/${name}Intact`;

    const controller = createRelicSelectionController({
      eraStartDelayMs: 0,
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      ctx: {
        overlaySettings: { autoTriggerEnabled: true } as OverlaySettings,
        currentInventoryData: {
          LevelKeys: [
            { ItemType: uniqueName("Requiem III"), ItemCount: 29 },
            { ItemType: uniqueName("Requiem IV"), ItemCount: 29 },
            { ItemType: uniqueName("Lith Test"), ItemCount: 1 },
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
            "Requiem III": group("Requiem III", "Requiem"),
            "Requiem IV": group("Requiem IV", "Requiem"),
            "Lith Test": group("Lith Test", "Lith"),
          },
          byUniqueName: {
            [uniqueName("Requiem III")]: { groupKey: "Requiem III", quality: "intact" as const },
            [uniqueName("Requiem IV")]: { groupKey: "Requiem IV", quality: "intact" as const },
            [uniqueName("Lith Test")]: { groupKey: "Lith Test", quality: "intact" as const },
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

  it("drops an era read that only matched the planner overlay's own cards", async () => {
    // The band guard sees one era here, so nothing upstream rejects the
    // self-read. The controller has to recognise the rows it just painted.
    expect(detectRelicEraFromBandText(OWN_OVERLAY_BAND).era).toBe("requiem");

    const { controller, ocrSpy, lastRecommendation } = makeRequiemController();

    ocrSpy.mockResolvedValue({
      era: "requiem",
      confidence: 1,
      candidateId: "header-band",
      textPreview: "REQUIEM RELICS",
    });
    await controller.onRelicSelectionTrigger("manual");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(
      lastRecommendation()
        .rows?.map((row) => row.label)
        .sort(),
    ).toEqual(["29x Requiem III Intact", "29x Requiem IV Intact"]);

    controller.resetMissionTier();
    ocrSpy.mockClear();
    ocrSpy.mockResolvedValue({
      era: "requiem",
      confidence: 1,
      candidateId: "header-band",
      textPreview: OWN_OVERLAY_BAND,
    });
    await controller.onRelicSelectionTrigger("manual");
    await new Promise((resolve) => setTimeout(resolve, 900));

    // A rejected read counts as empty, so it retries and then shows every era.
    expect(ocrSpy).toHaveBeenCalledTimes(2);
    const payload = lastRecommendation();
    expect(payload.era).toBeNull();
    expect(payload.rows?.map((row) => row.label).sort()).toEqual([
      "1x Lith Test Intact",
      "29x Requiem III Intact",
      "29x Requiem IV Intact",
    ]);
  });

  it("keeps a genuine single-era read while overlay rows are on screen", async () => {
    const { controller, ocrSpy, lastRecommendation } = makeRequiemController();

    ocrSpy.mockResolvedValue({
      era: "lith",
      confidence: 1,
      candidateId: "filter-label",
      textPreview: "LITH RELICS",
    });
    await controller.onRelicSelectionTrigger("manual");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(lastRecommendation().rows?.map((row) => row.label)).toEqual(["1x Lith Test Intact"]);

    // The game's own tiles can echo the same words; only a contiguous run of a
    // label we painted counts as reading ourselves.
    controller.resetMissionTier();
    ocrSpy.mockResolvedValue({
      era: "requiem",
      confidence: 1,
      candidateId: "filter-label",
      textPreview: "REQUIEM 1x Lith Test Relic Intact",
    });
    await controller.onRelicSelectionTrigger("manual");
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(lastRecommendation().era).toBe("requiem");
    expect(
      lastRecommendation()
        .rows?.map((row) => row.label)
        .sort(),
    ).toEqual(["29x Requiem III Intact", "29x Requiem IV Intact"]);
  });

  // An all-eras paint builds one row per owned relic group, and the planner
  // grid scrolls, so every painted row can reach the screen and the capture.
  function makeManyRowController(rowCount: number) {
    const cacheFilePath = makeTempSnapshot({
      version: 1,
      generatedAt: Date.now(),
      prices: {},
      meta: {},
      orderSummaries: {},
    });

    const names = Array.from(
      { length: rowCount },
      (_unused, index) => `Requiem A${String(index + 1).padStart(2, "0")}`,
    );
    const uniqueName = (name: string) => `/Lotus/Types/Game/Projections/${name}Intact`;
    const sentEvents: Array<{ channel: string; payload: unknown }> = [];
    const ocrSpy = vi.fn(
      async (): Promise<{
        era: string | null;
        confidence: number;
        candidateId?: string;
        textPreview?: string;
      }> => ({ era: null, confidence: 0 }),
    );

    const controller = createRelicSelectionController({
      eraStartDelayMs: 0,
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      ctx: {
        overlaySettings: { autoTriggerEnabled: true } as OverlaySettings,
        currentInventoryData: {
          LevelKeys: names.map((name) => ({ ItemType: uniqueName(name), ItemCount: 1 })),
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
          groups: Object.fromEntries(
            names.map((name) => [
              name,
              {
                key: name,
                name,
                tier: "Requiem",
                qualities: { intact: { rewards: [{ chance: 100, urlName: "x", ducats: null }] } },
              },
            ]),
          ),
          byUniqueName: Object.fromEntries(
            names.map((name) => [uniqueName(name), { groupKey: name, quality: "intact" as const }]),
          ),
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

    return { controller, ocrSpy, lastRecommendation, names };
  }

  it("rejects a self-read of any row it painted", async () => {
    const { controller, ocrSpy, lastRecommendation } = makeManyRowController(40);

    ocrSpy.mockResolvedValue({
      era: "requiem",
      confidence: 1,
      candidateId: "header-band",
      textPreview: "REQUIEM RELICS",
    });
    await controller.onRelicSelectionTrigger("manual");
    await new Promise((resolve) => setTimeout(resolve, 10));
    const painted = lastRecommendation().rows?.map((row) => row.label) ?? [];
    expect(painted).toHaveLength(40);

    controller.resetMissionTier();
    ocrSpy.mockClear();
    ocrSpy.mockResolvedValue({
      era: "requiem",
      confidence: 1,
      candidateId: "header-band",
      textPreview: `${painted[0]} VAULTEO 6.6 E. proflts:`,
    });
    await controller.onRelicSelectionTrigger("manual");
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(ocrSpy).toHaveBeenCalledTimes(2);
    expect(lastRecommendation().era).toBeNull();

    // The last row scrolls into view like the first one, so quoting it back is
    // the same self-read and has to be rejected the same way.
    controller.resetMissionTier();
    ocrSpy.mockClear();
    ocrSpy.mockResolvedValue({
      era: "requiem",
      confidence: 1,
      candidateId: "header-band",
      textPreview: `${painted[39]} VAULTEO 6.6 E. proflts:`,
    });
    await controller.onRelicSelectionTrigger("manual");
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(ocrSpy).toHaveBeenCalledTimes(2);
    expect(lastRecommendation().era).toBeNull();
  });

  it("a fissure list naming several eras never reaches the planner", () => {
    expect(detectRelicEraFromBandText(STAR_CHART_FISSURE_LIST)).toEqual({
      era: null,
      confidence: 0,
    });
  });
});
