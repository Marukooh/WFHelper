import fs from "node:fs";
import { withScope } from "./logger";
import { createEraOcr, createRewardOcrRunner } from "./rewardScannerOcr";
import { recognizeRewardStripOnnx, rewardOcrOnnxAvailable } from "./rewardOcrOnnx";
import { SCANNER_TUNING } from "./rewardScannerSupport";
import { detectRelicSelectionEra as detectRelicSelectionEraWithOcr } from "./rewardScannerEra";
import {
  resetFrameDedup,
  runRewardScanPipeline,
  type PreCaptureResult,
  type RewardScanSettings,
} from "./rewardScannerPipeline";
import type { SortedItem } from "./rewardScannerMatch";
import type { RewardReader } from "./rewardScannerSlotScan";
import { REFERENCE_WARFRAME_UI_SCALE } from "../config/runtime/overlaySettings";

export { captureSourceMeta } from "./screenCapture";
export { resetFrameDedup };

const log = withScope("rewardScanner");

const REWARD_SCAN_SETTINGS: RewardScanSettings = Object.freeze({
  cropPreset: "balanced",
  ocrPasses: 2,
  matchThreshold: 0.74,
  ocrTimeoutMs: 15_000,
});

const { runOCR, runOCRBuffer, runOCRStructuredBuffer } = createRewardOcrRunner({
  log,
  getRequestedEngine: () => "windows",
  ocrScriptPath: SCANNER_TUNING.paths.ocrScript,
  engineWindows: "windows",
});

let relicItems: SortedItem[] = [];
let sortedItems: SortedItem[] = [];

export function setRelicItems(items: SortedItem[]): void {
  relicItems = Array.isArray(items) ? items : [];
  sortedItems = [...relicItems].sort((a, b) => b.name.length - a.name.length);
  log.info(`[RewardScanner] Item list updated: ${relicItems.length} items`);
}

const eraOcr = createEraOcr({
  runOCR,
  runOCRBuffer,
  recognizeStrip: recognizeRewardStripOnnx,
  stripAvailable: rewardOcrOnnxAvailable,
  readFile: (imagePath) => fs.readFileSync(imagePath),
});

export function detectRelicSelectionEra(
  options: { timeoutMs?: number; preferredDisplayId?: string | null; labelOnly?: boolean } = {},
): ReturnType<typeof detectRelicSelectionEraWithOcr> {
  return detectRelicSelectionEraWithOcr(options, eraOcr, REWARD_SCAN_SETTINGS);
}

export async function scanRewardsDetailed(
  preCapture?: PreCaptureResult | null,
  scanOptions?: { reader?: RewardReader; warframeUiScale?: number },
): Promise<{
  items: SortedItem[];
  meta: Record<string, unknown>;
} | null> {
  if (sortedItems.length === 0) {
    log.warn("[RewardScanner] No relic items loaded - call setRelicItems() first");
    return null;
  }

  return runRewardScanPipeline({
    preCapture,
    sortedItems,
    settings: {
      ...REWARD_SCAN_SETTINGS,
      warframeUiScale: scanOptions?.warframeUiScale ?? REFERENCE_WARFRAME_UI_SCALE,
    },
    runOCRStructuredBuffer,
    // Windows OCR does not exist off-Windows; pin the cross-platform onnx reader.
    reader: process.platform === "win32" ? scanOptions?.reader : "onnx",
  });
}
