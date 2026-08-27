import type { NativeImage } from "electron";
import { describe, expect, it } from "vitest";

import {
  cropRivenStatAreaFallback,
  cropRivenStatImage,
  RIVEN_SCAN_CROPS,
  rivenContentRect,
} from "../../ipc/overlay/rivenScanImage";

// Minimal structural NativeImage over a BGRA buffer; crop returns another fake
// so nested crops (rough -> aspect trim -> stat band) work.
function wrapImage(bitmap: Buffer, width: number, height: number): NativeImage {
  return {
    getSize: () => ({ width, height }),
    toBitmap: () => bitmap,
    isEmpty: () => false,
    crop: (rect: { x: number; y: number; width: number; height: number }) => {
      const cropped = Buffer.alloc(rect.width * rect.height * 4);
      for (let cy = 0; cy < rect.height; cy++) {
        const srcStart = ((rect.y + cy) * width + rect.x) * 4;
        bitmap.copy(cropped, cy * rect.width * 4, srcStart, srcStart + rect.width * 4);
      }
      return wrapImage(cropped, rect.width, rect.height);
    },
  } as unknown as NativeImage;
}

const SCREEN_W = 2560;
const SCREEN_H = 1440;
const TEXT_W = 340;
// Stat text rows sit inside the stat band of the rough singleCard crop
// (screen y 839..1163 at 1440p).
const TEXT_TOP = 880;
const TEXT_BOTTOM = 1160;
const CLIENT_GEOMETRIES = [
  ["16:9", 1280, 720],
  ["16:10", 1280, 800],
  ["4:3", 1024, 768],
  ["21:9", 1720, 720],
] as const;
const RIVEN_LAYOUTS = [
  ["single-card", RIVEN_SCAN_CROPS.singleCard, 0.61, 0.78],
  ["chat-card", RIVEN_SCAN_CROPS.chatCard, 0.5, 0.64],
  ["roll-card", RIVEN_SCAN_CROPS.rollCard, 0.6, 0.75],
] as const;
const RIVEN_GEOMETRY_CASES = RIVEN_LAYOUTS.flatMap(([layout, crop, top, bottom]) =>
  CLIENT_GEOMETRIES.map(
    ([aspect, width, height]) => [layout, aspect, crop, top, bottom, width, height] as const,
  ),
);

/** Dark screen with white "stat line" stripes starting at textLeft. */
function makeRivenScreen(
  textLeft: number,
  textTop = TEXT_TOP,
  textBottom = TEXT_BOTTOM,
  width = SCREEN_W,
  height = SCREEN_H,
  textWidth = TEXT_W,
  background = 30,
): NativeImage {
  const bitmap = Buffer.alloc(width * height * 4);
  for (let i = 0; i < bitmap.length; i += 4) {
    bitmap[i] = background;
    bitmap[i + 1] = background;
    bitmap[i + 2] = background;
    bitmap[i + 3] = 255;
  }
  for (let y = textTop; y < textBottom; y++) {
    if ((y - textTop) % 28 >= 16) continue; // 16px text line, 12px gap
    for (let x = textLeft; x < textLeft + textWidth; x++) {
      const idx = (y * width + x) * 4;
      bitmap[idx] = 255;
      bitmap[idx + 1] = 255;
      bitmap[idx + 2] = 255;
    }
  }
  return wrapImage(bitmap, width, height);
}

/** Width of the white text span found in a crop (0 when absent). */
function whiteSpan(image: NativeImage): number {
  const { width, height } = image.getSize();
  const bitmap = image.toBitmap();
  let minX = -1;
  let maxX = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      if (bitmap[idx] > 200 && bitmap[idx + 1] > 200 && bitmap[idx + 2] > 200) {
        if (minX < 0 || x < minX) minX = x;
        if (x > maxX) maxX = x;
      }
    }
  }
  return minX < 0 ? 0 : maxX - minX + 1;
}

function whiteRowGroups(image: NativeImage): number {
  const { width, height } = image.getSize();
  const bitmap = image.toBitmap();
  let groups = 0;
  let previousRowWasWhite = false;

  for (let y = 0; y < height; y++) {
    let rowIsWhite = false;
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      if (bitmap[idx] > 200 && bitmap[idx + 1] > 200 && bitmap[idx + 2] > 200) {
        rowIsWhite = true;
        break;
      }
    }
    if (rowIsWhite && !previousRowWasWhite) groups++;
    previousRowWasWhite = rowIsWhite;
  }

  return groups;
}

describe("cropRivenStatImage", () => {
  it("keeps the full text column when the card is centered", () => {
    const screen = makeRivenScreen(SCREEN_W / 2 - TEXT_W / 2);
    const { statCrop } = cropRivenStatImage(screen, RIVEN_SCAN_CROPS.singleCard);
    expect(whiteSpan(statCrop)).toBeGreaterThanOrEqual(TEXT_W - 4);
  });

  it("keeps the full text column when the card sits 150px left of center", () => {
    // Letterbox shaving on dark scenes shifts the card within the rough crop.
    const screen = makeRivenScreen(SCREEN_W / 2 - TEXT_W / 2 - 150);
    const { statCrop } = cropRivenStatImage(screen, RIVEN_SCAN_CROPS.singleCard);
    expect(whiteSpan(statCrop)).toBeGreaterThanOrEqual(TEXT_W - 4);
  });

  it("falls back to the geometric center when no text is found", () => {
    const bitmap = Buffer.alloc(SCREEN_W * SCREEN_H * 4, 30);
    const screen = wrapImage(bitmap, SCREEN_W, SCREEN_H);
    const { statCrop } = cropRivenStatImage(screen, RIVEN_SCAN_CROPS.singleCard);
    const { width, height } = statCrop.getSize();
    expect(width).toBeGreaterThan(100);
    expect(height).toBeGreaterThan(100);
  });

  it("recovers an off-center card in the widened roll crop", () => {
    const screen = makeRivenScreen(SCREEN_W / 2 - TEXT_W / 2 - 120);
    const { statCrop } = cropRivenStatImage(screen, RIVEN_SCAN_CROPS.rollCard);
    expect(whiteSpan(statCrop)).toBeGreaterThanOrEqual(TEXT_W - 4);
  });

  it("keeps every stat row in the higher chat-link card layout", () => {
    const screen = makeRivenScreen(
      SCREEN_W / 2 - TEXT_W / 2,
      Math.round(SCREEN_H * 0.53),
      Math.round(SCREEN_H * 0.62),
    );
    const chat = cropRivenStatImage(screen, RIVEN_SCAN_CROPS.chatCard);
    const reroll = cropRivenStatImage(screen, RIVEN_SCAN_CROPS.singleCard);

    expect(whiteRowGroups(chat.statCrop)).toBe(5);
    expect(whiteRowGroups(reroll.statCrop)).toBeLessThan(5);
  });

  it.each(RIVEN_GEOMETRY_CASES)(
    "keeps the %s stat column in a %s client",
    (_layout, _aspect, crop, topRatio, bottomRatio, width, height) => {
      const canvasWidth = Math.min(width, Math.round((height * 16) / 9));
      const canvasHeight = Math.min(height, Math.round((width * 9) / 16));
      const canvasX = Math.floor((width - canvasWidth) / 2);
      const canvasY = Math.floor((height - canvasHeight) / 2);
      const textWidth = Math.max(120, Math.round(canvasWidth * 0.135));
      const textLeft = canvasX + Math.round((canvasWidth - textWidth) / 2);
      const textTop = canvasY + Math.round(canvasHeight * topRatio);
      const textBottom = canvasY + Math.round(canvasHeight * bottomRatio);
      const screen = makeRivenScreen(textLeft, textTop, textBottom, width, height, textWidth);

      const { statCrop } = cropRivenStatImage(screen, crop, "window");

      expect(whiteSpan(statCrop)).toBeGreaterThanOrEqual(textWidth - 4);
      expect(whiteRowGroups(statCrop)).toBeGreaterThanOrEqual(3);
    },
  );

  it("does not detect black bars again inside a dark 1280x960 window client", () => {
    const width = 1280;
    const height = 960;
    const canvasHeight = 720;
    const canvasY = 120;
    const textWidth = 190;
    const screen = makeRivenScreen(
      (width - textWidth) / 2,
      canvasY + Math.round(canvasHeight * 0.61),
      canvasY + Math.round(canvasHeight * 0.78),
      width,
      height,
      textWidth,
      0,
    );

    expect(rivenContentRect(screen, "window")).toEqual({
      x: 0,
      y: 120,
      width: 1280,
      height: 720,
    });

    const windowCrop = cropRivenStatImage(screen, RIVEN_SCAN_CROPS.singleCard, "window");
    const redetectedCrop = cropRivenStatImage(screen, RIVEN_SCAN_CROPS.singleCard, "screen");

    expect(whiteSpan(windowCrop.statCrop)).toBeGreaterThanOrEqual(textWidth - 4);
    expect(whiteRowGroups(windowCrop.statCrop)).toBeGreaterThanOrEqual(4);
    expect(whiteSpan(redetectedCrop.statCrop)).toBeLessThan(textWidth - 4);
  });
});

describe("cropRivenStatAreaFallback", () => {
  it("re-trims a half-size card around its text and asks for an upscale", () => {
    // 50% interface scale: text half as wide, in a short band whose first
    // rows sit above the fixed stat band (as on real captures).
    const smallTextW = Math.floor(TEXT_W / 2);
    const screen = makeRivenScreen(
      SCREEN_W / 2 - smallTextW / 2,
      780,
      920,
      SCREEN_W,
      SCREEN_H,
      smallTextW,
    );
    const { cardCrop, statCrop } = cropRivenStatImage(screen, RIVEN_SCAN_CROPS.singleCard);
    // The fixed stat band clips part of the shrunken text column.
    expect(whiteRowGroups(statCrop)).toBeLessThan(5);

    const fallback = cropRivenStatAreaFallback(cardCrop);
    expect(fallback).not.toBeNull();
    expect(fallback!.upscaleFactor).toBeGreaterThanOrEqual(2);
    expect(whiteSpan(fallback!.image)).toBeGreaterThanOrEqual(smallTextW - 8);
    expect(whiteRowGroups(fallback!.image)).toBe(5);
  });

  it("returns no upscale request for a full-size card", () => {
    const screen = makeRivenScreen(SCREEN_W / 2 - TEXT_W / 2);
    const { cardCrop } = cropRivenStatImage(screen, RIVEN_SCAN_CROPS.singleCard);

    const fallback = cropRivenStatAreaFallback(cardCrop);
    expect(fallback).not.toBeNull();
    expect(fallback!.upscaleFactor).toBe(1);
    expect(whiteSpan(fallback!.image)).toBeGreaterThanOrEqual(TEXT_W - 8);
  });

  it("returns null when the crop holds no text", () => {
    const screen = makeRivenScreen(SCREEN_W / 2 - TEXT_W / 2, 0, 0);
    const { cardCrop } = cropRivenStatImage(screen, RIVEN_SCAN_CROPS.singleCard);

    expect(cropRivenStatAreaFallback(cardCrop)).toBeNull();
  });
});
