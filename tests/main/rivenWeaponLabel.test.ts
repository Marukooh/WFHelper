import { beforeEach, describe, expect, it, vi } from "vitest";

const recognizeMock = vi.fn();
vi.mock("../../services/rewardOcrOnnx", () => ({
  recognizeRewardStripOnnx: (png: Buffer) => recognizeMock(png),
}));

const paddleMock = vi.fn();
vi.mock("../../services/rivenOcrOnnx", () => ({
  paddleRecognizerAvailable: () => true,
  recognizePaddleCrops: (crops: unknown) => paddleMock(crops),
}));

import { findWeaponByLabelLine } from "../../services/rivenData";
import {
  readFitsInWeapon,
  readFitsInWeaponSmallUi,
  readWeaponLabelFromPanelPng,
  shouldApplyLabelWeapon,
} from "../../ipc/overlay/rivenWeaponLabel";

function rows(...texts: string[]) {
  return {
    text: texts.join(" "),
    rows: texts.map((text) => ({ text, confidence: 0.95 })),
  };
}

async function makePng(width: number, height: number): Promise<Buffer> {
  const sharp = (await import("sharp")).default;
  return sharp({
    create: { width, height, channels: 3, background: { r: 10, g: 10, b: 18 } },
  })
    .png()
    .toBuffer();
}

describe("findWeaponByLabelLine", () => {
  it("matches the linked variant among the panel captions", () => {
    const match = findWeaponByLabelLine(["FITS IN", "Kuva Sobek", "SHOW RANKED", "CANCEL"]);
    expect(match).toEqual({ name: "Kuva Sobek", exact: true });
  });

  it("is case-insensitive and matches variant families", () => {
    expect(findWeaponByLabelLine(["KUVA SOBEK"])).toEqual({ name: "Kuva Sobek", exact: true });
    expect(findWeaponByLabelLine(["Boar Prime"])).toEqual({ name: "Boar Prime", exact: true });
    expect(findWeaponByLabelLine(["Sobek"])).toEqual({ name: "Sobek", exact: true });
    expect(findWeaponByLabelLine(["MK1-Braton"])).toEqual({ name: "MK1-Braton", exact: true });
  });

  it("tolerates one misread letter on long names only", () => {
    expect(findWeaponByLabelLine(["Kuva Sobck"])).toEqual({ name: "Kuva Sobek", exact: false });
    // Short names must be exact; "Lat0" could be too many things.
    expect(findWeaponByLabelLine(["Lat0"])).toBeNull();
  });

  it("prefers the longest exact hit", () => {
    expect(findWeaponByLabelLine(["Boar", "Boar Prime"])).toEqual({
      name: "Boar Prime",
      exact: true,
    });
  });

  it("never matches the other panel captions or stat lines", () => {
    expect(
      findWeaponByLabelLine(["FITS IN", "SHOW RANKED", "CANCEL", "Remaining Kuva 89528"]),
    ).toBeNull();
    // The chat-linked item-details view shows EXIT instead of the roll buttons.
    expect(findWeaponByLabelLine(["FITS IN", "EXIT"])).toBeNull();
    expect(findWeaponByLabelLine(["+72,7% Fire Rate (x2 for Bows)"])).toBeNull();
    expect(findWeaponByLabelLine([])).toBeNull();
  });
});

describe("shouldApplyLabelWeapon", () => {
  const exact = { name: "Kuva Sobek", exact: true };
  const fuzzy = { name: "Kuva Sobek", exact: false };

  it("fills an unknown weapon", () => {
    expect(shouldApplyLabelWeapon(exact, "", "", false)).toBe(true);
    expect(shouldApplyLabelWeapon(fuzzy, "Riven", "", false)).toBe(true);
  });

  it("is a no-op for the same name", () => {
    expect(shouldApplyLabelWeapon(exact, "Kuva Sobek", "diorama", true)).toBe(false);
  });

  it("always wins within the family - the label is the live linked variant", () => {
    expect(
      shouldApplyLabelWeapon({ name: "Boar", exact: true }, "Boar Prime", "diorama", true),
    ).toBe(true);
    expect(
      shouldApplyLabelWeapon({ name: "Boar", exact: false }, "Boar Prime", "label", true),
    ).toBe(true);
  });

  it("an exact read outranks every other source, across families too", () => {
    for (const source of ["ocr", "diorama", "dialog", ""] as const) {
      expect(shouldApplyLabelWeapon(exact, "Hema", source, false)).toBe(true);
    }
  });

  it("a fuzzy read across families only displaces a card-title OCR guess", () => {
    expect(shouldApplyLabelWeapon(fuzzy, "Hema", "ocr", false)).toBe(true);
    expect(shouldApplyLabelWeapon(fuzzy, "Hema", "diorama", false)).toBe(false);
    expect(shouldApplyLabelWeapon(fuzzy, "Hema", "dialog", false)).toBe(false);
  });
});

describe("readWeaponLabelFromPanelPng", () => {
  beforeEach(() => {
    recognizeMock.mockReset();
  });

  it("passes a 1080p crop through unresized and matches the label", async () => {
    const png = await makePng(576, 486);
    recognizeMock.mockResolvedValue(rows("FITS IN", "Kuva Sobek", "CANCEL"));

    const match = await readWeaponLabelFromPanelPng(png, 1080);
    expect(match).toEqual({ name: "Kuva Sobek", exact: true });
    expect(recognizeMock).toHaveBeenCalledTimes(1);
    expect(recognizeMock.mock.calls[0][0]).toBe(png);
  });

  it("normalizes other resolutions to the 1080p reference scale", async () => {
    const png = await makePng(768, 648);
    recognizeMock.mockResolvedValue(rows("Boar Prime"));

    const match = await readWeaponLabelFromPanelPng(png, 1440);
    expect(match).toEqual({ name: "Boar Prime", exact: true });

    const sharp = (await import("sharp")).default;
    const sent = recognizeMock.mock.calls[0][0] as Buffer;
    const meta = await sharp(sent).metadata();
    expect(meta.height).toBe(486); // 648 * (1080 / 1440)
  });

  it("inverts a light item plate for dark-label themes", async () => {
    const png = await makePng(200, 100);
    recognizeMock.mockResolvedValue(rows("Kuva Sobek"));

    const match = await readWeaponLabelFromPanelPng(png, 1080, { invert: true });
    expect(match).toEqual({ name: "Kuva Sobek", exact: true });

    const sharp = (await import("sharp")).default;
    const sent = recognizeMock.mock.calls[0][0] as Buffer;
    const pixel = await sharp(sent).removeAlpha().raw().toBuffer();
    expect([...pixel.subarray(0, 3)]).toEqual([245, 245, 237]);
  });

  it("returns null when nothing legible or no caption is a weapon", async () => {
    const png = await makePng(576, 486);
    recognizeMock.mockResolvedValueOnce(null);
    expect(await readWeaponLabelFromPanelPng(png, 1080)).toBeNull();

    recognizeMock.mockResolvedValueOnce(rows("FITS IN", "SHOW RANKED", "CANCEL"));
    expect(await readWeaponLabelFromPanelPng(png, 1080)).toBeNull();
  });
});

describe("readFitsInWeapon", () => {
  beforeEach(() => {
    recognizeMock.mockReset();
  });

  it("retries the focused weapon plate with inverted polarity", async () => {
    const png = await makePng(403, 237);
    const crop = vi.fn(() => ({
      getSize: () => ({ width: 403, height: 237 }),
      toPNG: () => png,
    }));
    const image = {
      getSize: () => ({ width: 1920, height: 1080 }),
      crop,
    };
    recognizeMock
      .mockResolvedValueOnce(rows("SHOW RANKED", "CANCEL"))
      .mockResolvedValueOnce(rows("Kuva Sobek"));

    const match = await readFitsInWeapon(image as never, "window");
    expect(match).toEqual({ name: "Kuva Sobek", exact: true });
    expect(recognizeMock).toHaveBeenCalledTimes(2);
    expect(crop).toHaveBeenCalledTimes(1);
    expect(crop).toHaveBeenCalledWith({ x: 1497, y: 777, width: 403, height: 237 });
  });
});

describe("readFitsInWeaponSmallUi", () => {
  beforeEach(() => {
    recognizeMock.mockReset();
  });

  it("falls back to a contrast-equalized pass for dim theme captions", async () => {
    const png = await makePng(806, 508);
    const image = {
      getSize: () => ({ width: 1920, height: 1080 }),
      crop: vi.fn(() => ({
        getSize: () => ({ width: 806, height: 508 }),
        toPNG: () => png,
      })),
    };
    // Plain pass sees only the heading; equalization surfaces the caption,
    // whose lost space still fuzzy-matches.
    recognizeMock
      .mockResolvedValueOnce(rows("FITSIN"))
      .mockResolvedValueOnce(rows("FITSIN", "Kuvasobek"));

    const match = await readFitsInWeaponSmallUi(image as never, 0.5, "window");
    expect(match).toEqual({ name: "Kuva Sobek", exact: false });
    expect(recognizeMock).toHaveBeenCalledTimes(2);
  });
});

describe("readFitsInWeaponSmallUi caption band", () => {
  beforeEach(() => {
    recognizeMock.mockReset();
    paddleMock.mockReset();
  });

  it("reads the caption under the FITS IN heading when rows miss it", async () => {
    const png = await makePng(806, 508);
    const bandPng = await makePng(150, 30);
    const wideCrop = {
      getSize: () => ({ width: 806, height: 508 }),
      toPNG: () => png,
      crop: vi.fn(() => ({ toPNG: () => bandPng })),
    };
    const image = {
      getSize: () => ({ width: 1920, height: 1080 }),
      crop: vi.fn(() => wideCrop),
    };
    // Plain pass sees nothing; equalization finds only the heading, whose box
    // anchors the caption band; the raw band read still carries a misread.
    recognizeMock.mockResolvedValueOnce(null).mockResolvedValueOnce({
      text: "FITSIN",
      rows: [
        {
          text: "FITSIN",
          confidence: 0.87,
          box: { x: 0.25, y: 0.21, width: 0.06, height: 0.03 },
        },
      ],
    });
    paddleMock.mockResolvedValueOnce([{ text: "kiva sobek", confidence: 0.62 }]);

    const match = await readFitsInWeaponSmallUi(image as never, 0.5, "window");
    expect(match).toEqual({ name: "Kuva Sobek", exact: false });
    expect(paddleMock).toHaveBeenCalledTimes(1);
  });
});

describe("readFitsInWeaponSmallUi fixed caption band", () => {
  beforeEach(() => {
    recognizeMock.mockReset();
    paddleMock.mockReset();
  });

  it("reads the fixed plate position when even the heading is obscured", async () => {
    const png = await makePng(806, 508);
    const bandPng = await makePng(105, 26);
    const wideCrop = {
      getSize: () => ({ width: 806, height: 508 }),
      toPNG: () => png,
      crop: vi.fn(() => ({ toPNG: () => bandPng })),
    };
    const image = {
      getSize: () => ({ width: 1920, height: 1080 }),
      crop: vi.fn(() => wideCrop),
    };
    recognizeMock.mockResolvedValue(null);
    paddleMock.mockResolvedValueOnce([{ text: "kiva sobek", confidence: 0.62 }]);

    const match = await readFitsInWeaponSmallUi(image as never, 0.5, "window");
    expect(match).toEqual({ name: "Kuva Sobek", exact: false });
    expect(paddleMock).toHaveBeenCalledTimes(1);
    // Band centered on the plate caption: screen (1329, 723) minus crop origin.
    const band = (wideCrop.crop.mock.calls as unknown as Array<[{ x: number; y: number }]>)[0][0];
    expect(band.x).toBeGreaterThan(140);
    expect(band.x).toBeLessThan(190);
    expect(band.y).toBeGreaterThan(175);
    expect(band.y).toBeLessThan(200);
  });
});
