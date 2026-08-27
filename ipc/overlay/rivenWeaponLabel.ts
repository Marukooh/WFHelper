import type { NativeImage } from "electron";

import { withScope } from "../../services/logger";
import { areOcrDebugDumpsEnabled } from "../../services/rewardScanDebug";
import { cropRectContent } from "../../services/rewardScannerImage";
import { recognizeRewardStripOnnx } from "../../services/rewardOcrOnnx";
import { findWeaponByLabelLine, type WeaponLabelMatch } from "../../services/rivenData";
import type { CaptureResult } from "../../services/screenCapture";
import { userDataPath } from "../../services/userDataPath";
import { rivenContentRect } from "./rivenScanImage";

const log = withScope("rivenScan");

const FITS_IN_DUMP_KEEP = 6;

// A failed read leaves no evidence in the log rows alone; the crop is what
// turns a "wrong weapon at scale X" report into a reproducible fixture.
function dumpFitsInCrop(label: string, crop: NativeImage): void {
  if (!areOcrDebugDumpsEnabled()) return;
  try {
    const fs = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");
    const dir = userDataPath("riven-scan-debug");
    fs.mkdirSync(dir, { recursive: true });

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    fs.writeFileSync(path.join(dir, `${stamp}-fits-in-${label}.png`), crop.toPNG());

    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".png") && f.includes("Z-fits-in-"))
      .sort();
    for (const f of files.slice(0, Math.max(0, files.length - FITS_IN_DUMP_KEEP))) {
      fs.unlinkSync(path.join(dir, f));
    }
  } catch (err) {
    log.warn("[RivenScan] fits-in crop dump failed:", String(err));
  }
}

// The item plate can use either text polarity across Warframe UI themes.
const RIVEN_FITS_IN_NAME_CROP = { x: 0.78, y: 0.72, width: 0.21, height: 0.22 };
const RIVEN_FITS_IN_PANEL_CROP = { x: 0.7, y: 0.55, width: 0.3, height: 0.45 };
// Interface scales below 100% pull the plate toward screen center; this covers
// its position across the whole 50-100% slider range.
const RIVEN_FITS_IN_WIDE_CROP = { x: 0.58, y: 0.48, width: 0.42, height: 0.47 };

// Label text is ~20px at 1080p; the strip reader's row-height windows assume
// that scale, so the crop is normalized to it before recognition.
const REFERENCE_CONTENT_HEIGHT = 1080;

export type RivenWeaponSource = "" | "dialog" | "ocr" | "diorama" | "label";

/** Whether a fits-in label read replaces the current weapon. */
export function shouldApplyLabelWeapon(
  match: WeaponLabelMatch,
  currentName: string,
  currentSource: RivenWeaponSource,
  sameFamily: boolean,
): boolean {
  if (!currentName || currentName === "Riven") return true;
  if (match.name === currentName) return false;
  if (match.exact || sameFamily) return true;
  return currentSource === "ocr";
}

export async function readWeaponLabelFromPanelPng(
  png: Buffer,
  contentHeight: number,
  options: { invert?: boolean; upscale?: boolean; uiScale?: number } = {},
): Promise<WeaponLabelMatch | null> {
  let normalized = png;
  // A sub-100% interface scale shrinks the label text independently of the
  // resolution, so its correction applies even where upscaling is off.
  const uiCorrection = 1 / Math.min(1, Math.max(0.5, options.uiScale ?? 1));
  const scale = (REFERENCE_CONTENT_HEIGHT / Math.max(1, contentHeight)) * uiCorrection;
  const resize = scale < 0.98 || uiCorrection > 1.02 || (options.upscale !== false && scale > 1.02);
  if (resize || options.invert) {
    const sharp = require("sharp") as (typeof import("sharp"))["default"];
    const meta = await sharp(png).metadata();
    const height = Math.max(1, Math.round((meta.height ?? 1) * scale));
    let pipeline = sharp(png);
    if (resize) {
      pipeline = pipeline.resize({ height, kernel: "lanczos3" });
    }
    if (options.invert) pipeline = pipeline.negate({ alpha: false });
    normalized = await pipeline.png().toBuffer();
  }

  const read = await recognizeRewardStripOnnx(normalized);
  if (!read || read.rows.length === 0) {
    log.info("[RivenScan] fits-in label: no legible rows");
    return null;
  }
  const match = findWeaponByLabelLine(read.rows.map((row) => row.text));
  const rowsLog = read.rows.map((row) => `"${row.text}"`).join(", ");
  log.info(
    `[RivenScan] fits-in label rows: ${rowsLog} -> ` +
      (match ? `${match.name}${match.exact ? "" : " (fuzzy)"}` : "no weapon"),
  );
  return match;
}

/** Reads the linked weapon variant off the FITS IN panel of a full capture. */
export async function readFitsInWeapon(
  image: NativeImage,
  sourceType?: CaptureResult["sourceType"],
): Promise<WeaponLabelMatch | null> {
  const content = rivenContentRect(image, sourceType);
  const nameCrop = cropRectContent(image, RIVEN_FITS_IN_NAME_CROP, content);
  const { width, height } = nameCrop.getSize();
  if (width < 48 || height < 48) return null;

  const namePng = nameCrop.toPNG();
  const normal = await readWeaponLabelFromPanelPng(namePng, content.height, { upscale: false });
  if (normal) return normal;
  const inverted = await readWeaponLabelFromPanelPng(namePng, content.height, {
    invert: true,
    upscale: false,
  });
  if (inverted) return inverted;

  const panelCrop = cropRectContent(image, RIVEN_FITS_IN_PANEL_CROP, content);
  const panel = await readWeaponLabelFromPanelPng(panelCrop.toPNG(), content.height);
  if (!panel) dumpFitsInCrop("panel", panelCrop);
  return panel;
}

/** Reads the linked weapon at sub-100% interface scales, where the plate sits
 *  closer to screen center and its text needs the 1/scale enlargement. */
export async function readFitsInWeaponSmallUi(
  image: NativeImage,
  uiScale: number,
  sourceType?: CaptureResult["sourceType"],
): Promise<WeaponLabelMatch | null> {
  const content = rivenContentRect(image, sourceType);
  const wideCrop = cropRectContent(image, RIVEN_FITS_IN_WIDE_CROP, content);
  const { width, height } = wideCrop.getSize();
  if (width < 48 || height < 48) return null;

  const widePng = wideCrop.toPNG();
  const normal = await readWeaponLabelFromPanelPng(widePng, content.height, { uiScale });
  if (normal) return normal;
  const inverted = await readWeaponLabelFromPanelPng(widePng, content.height, {
    invert: true,
    uiScale,
  });
  if (!inverted) dumpFitsInCrop("wide", wideCrop);
  return inverted;
}
