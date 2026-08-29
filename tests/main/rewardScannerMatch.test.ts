import { describe, expect, it } from "vitest";
import {
  detectRelicEraFromBandText,
  detectRelicEraFromFilterLabelText,
  detectRelicEraFromTileLabelText,
  matchSingleRewardTextDetailed,
  rankRewardCandidatesDetailed,
} from "../../services/rewardScannerMatch";

const ITEMS = [
  { name: "Braton Prime Stock" },
  { name: "Trumna Prime Blueprint" },
  { name: "Forma Blueprint" },
  { name: "Caliban Prime Neuroptics Blueprint" },
  { name: "Nautilus Prime Systems" },
  { name: "Epitaph Prime Receiver" },
  { name: "Zephyr Prime Neuroptics Blueprint" },
  { name: "Wukong Prime Chassis Blueprint" },
  { name: "Rhino Prime Blueprint" },
  { name: "Trinity Prime Blueprint" },
  { name: "Limbo Prime Blueprint" },
  { name: "Saryn Prime Blueprint" },
];

describe("matchSingleRewardTextDetailed", () => {
  it("matches exact or near-exact reward names", () => {
    const result = matchSingleRewardTextDetailed("Forma BlueDrint", ITEMS);
    expect(result.item?.name).toBe("Forma Blueprint");
  });

  it("handles fuzzy OCR output for receiver", () => {
    const result = matchSingleRewardTextDetailed("E itaDh Prime Receiver", ITEMS);
    expect(result.item?.name).toBe("Epitaph Prime Receiver");
  });

  it("keeps top candidates for split OCR strings", () => {
    const ranked = rankRewardCandidatesDetailed("Caliban Blueprint Naut", ITEMS, 3);
    expect(
      ranked.some((candidate) => candidate.item?.name === "Caliban Prime Neuroptics Blueprint"),
    ).toBe(true);
  });

  it("does not extract short reward names from inside longer titles", () => {
    const ranked = rankRewardCandidatesDetailed(
      "Paris Prime Upper Limb",
      [{ name: "Paris Prime Upper Limb" }, { name: "Ris" }],
      3,
    );
    expect(ranked[0].item?.name).toBe("Paris Prime Upper Limb");
    expect(ranked.some((candidate) => candidate.item?.name === "Ris")).toBe(false);
  });

  it("still matches exact short Requiem mod names", () => {
    const requiemMods = ["Fass", "Jahu", "Khra", "Lohk", "Netra", "Ris", "Vome", "Xata", "Oull"];
    for (const name of requiemMods) {
      const ranked = rankRewardCandidatesDetailed(
        name.toUpperCase(),
        [{ name: "Paris Prime Upper Limb" }, ...requiemMods.map((modName) => ({ name: modName }))],
        3,
      );
      expect(ranked[0].item?.name).toBe(name);
      expect(ranked[0].mode).toBe("exact");
    }
  });

  it("lifts a first-line-only read that uniquely prefixes one item over the slot gate", () => {
    // "Yareli Prime Chassis Blueprint" wraps to two lines on the reward card;
    // OCR of the first line alone must still resolve it.
    const pool = [
      { name: "Yareli Prime Chassis Blueprint" },
      { name: "Yareli Prime Blueprint" },
      { name: "Yareli Prime Systems Blueprint" },
      { name: "Yareli Prime Neuroptics Blueprint" },
      ...ITEMS,
    ];
    const ranked = rankRewardCandidatesDetailed("Yareli Prime Chassis", pool, 4);
    expect(ranked[0].item?.name).toBe("Yareli Prime Chassis Blueprint");
    expect(ranked[0].mode).toBe("substring");
    expect(ranked[0].confidence).toBeGreaterThanOrEqual(0.92);
  });

  it("keeps ambiguous prefixes below the slot gate", () => {
    const pool = [
      { name: "Braton Prime Stock" },
      { name: "Braton Prime Blueprint" },
      { name: "Braton Prime Receiver" },
      { name: "Braton Prime Barrel" },
    ];
    const ranked = rankRewardCandidatesDetailed("Braton Prime", pool, 4);
    for (const candidate of ranked) {
      if (candidate.mode === "substring") {
        expect(candidate.confidence).toBeLessThan(0.92);
      }
    }
  });

  it("does not boost single-word fragments", () => {
    const ranked = rankRewardCandidatesDetailed("Yareli", [{ name: "Yareli Prime Blueprint" }], 3);
    for (const candidate of ranked) {
      expect(candidate.confidence).toBeLessThan(0.92);
    }
  });

  it("lifts a full name wrapped in noise over the gate (quantity prefix, neighbor bleed)", () => {
    // real crops: "2 X Forma Blueprint" and "Braton Prime Stock Trumna"
    const r1 = rankRewardCandidatesDetailed("2x Forma Blueprint", ITEMS, 4);
    expect(r1[0].item?.name).toBe("Forma Blueprint");
    expect(r1[0].confidence).toBeGreaterThanOrEqual(0.92);

    const r2 = rankRewardCandidatesDetailed("Braton Prime Stock Trumna", ITEMS, 4);
    expect(r2[0].item?.name).toBe("Braton Prime Stock");
    expect(r2[0].confidence).toBeGreaterThanOrEqual(0.92);
  });

  it("does not boost when the text contains two full item names", () => {
    const ranked = rankRewardCandidatesDetailed("Forma Blueprint Braton Prime Stock", ITEMS, 4);
    for (const candidate of ranked) {
      expect(candidate.confidence).toBeLessThan(0.92);
    }
  });

  it("lifts a read that lost an interior word when it is an unambiguous subsequence", () => {
    // Real crop: glare removed "Prime" and garbled "Blueprint".
    const pool = [
      { name: "Wukong Prime Chassis Blueprint" },
      { name: "Wukong Prime Blueprint" },
      ...ITEMS,
    ];
    const ranked = rankRewardCandidatesDetailed("Wukong Chassis Blueprint", pool, 4);
    expect(ranked[0].item?.name).toBe("Wukong Prime Chassis Blueprint");
    expect(ranked[0].confidence).toBeGreaterThanOrEqual(0.92);

    // literal pipeline read of the same crop: aliases don't know "lueorint"
    const corrupted = rankRewardCandidatesDetailed("Wukon Chassis ålueorint", pool, 4);
    expect(corrupted[0].item?.name).toBe("Wukong Prime Chassis Blueprint");
    expect(corrupted[0].confidence).toBeGreaterThanOrEqual(0.92);
  });

  it("keeps ambiguous subsequences below the gate", () => {
    // dropped frame name: could be any "* Prime Chassis Blueprint"
    const pool = [
      { name: "Wukong Prime Chassis Blueprint" },
      { name: "Yareli Prime Chassis Blueprint" },
    ];
    const ranked = rankRewardCandidatesDetailed("Prime Chassis Blueprint", pool, 4);
    for (const candidate of ranked) {
      expect(candidate.confidence).toBeLessThan(0.92);
    }
  });

  it("corrects common OCR misreads via expanded token aliases", () => {
    // "prlme" -> "prime", "bluedrint" -> "blueprint"
    const r1 = matchSingleRewardTextDetailed("Rhino Prlme BlueDrint", ITEMS);
    expect(r1.item?.name).toBe("Rhino Prime Blueprint");

    // "neurootics" -> "neuroptics"
    const r2 = matchSingleRewardTextDetailed("Zephyr Prime Neurootics Blueprint", ITEMS);
    expect(r2.item?.name).toBe("Zephyr Prime Neuroptics Blueprint");

    // "svstems" -> "systems"
    const r3 = matchSingleRewardTextDetailed("Nautilus Prime Svstems", ITEMS);
    expect(r3.item?.name).toBe("Nautilus Prime Systems");

    // "trinlty" -> "trinity"
    const r4 = matchSingleRewardTextDetailed("Trinlty Prime Blueprint", ITEMS);
    expect(r4.item?.name).toBe("Trinity Prime Blueprint");

    // "chassls" -> "chassis"
    const r5 = matchSingleRewardTextDetailed("Wukong Prime Chassls Blueprint", ITEMS);
    expect(r5.item?.name).toBe("Wukong Prime Chassis Blueprint");
  });
});

describe("a blueprint whose built item is also a reward", () => {
  // Both names sit in the reward pool, so a read holding the blueprint holds the
  // collar too. Before the tier collapse both floored at 0.88 and the slot gate
  // (0.92 for substring) dropped the whole card.
  const PAIR = [
    { name: "Kavasa Prime Kubrow Collar Blueprint" },
    { name: "Kavasa Prime Kubrow Collar" },
  ];

  it("keeps the blueprint above the slot gate when the read carries a quantity", () => {
    const hit = matchSingleRewardTextDetailed("2 X Kavasa Prime Kubrow Collar Blueprint", PAIR);
    expect(hit.item?.name).toBe("Kavasa Prime Kubrow Collar Blueprint");
    expect(hit.confidence).toBeGreaterThanOrEqual(0.92);
  });

  it("reads a clipped tail as the longer name, not its shorter sibling", () => {
    const pool = [{ name: "Forma" }, { name: "Forma Blueprint" }];
    for (const read of ["Forma Blueprin", "Forma Bluepri", "Forma Blue"]) {
      const hit = matchSingleRewardTextDetailed(read, pool);
      expect(hit.item?.name, read).toBe("Forma Blueprint");
      expect(hit.confidence, read).toBeGreaterThanOrEqual(0.92);
    }
  });

  it("keeps the short name when nothing continues the read", () => {
    const pool = [{ name: "Forma" }, { name: "Forma Blueprint" }];
    expect(matchSingleRewardTextDetailed("Forma", pool).item?.name).toBe("Forma");
  });

  it("stays ambiguous when two longer names continue the read", () => {
    const pool = [
      { name: "Braton Prime" },
      { name: "Braton Prime Blueprint" },
      { name: "Braton Prime Barrel" },
    ];
    // "b" continues into both Blueprint and Barrel, so neither may be promoted.
    const hit = matchSingleRewardTextDetailed("Braton Prime B", pool);
    expect(hit.confidence).toBeLessThan(0.92);
  });

  it("still refuses to guess when the two contained names are unrelated", () => {
    const pool = [{ name: "Forma Blueprint" }, { name: "Braton Prime Stock" }];
    const hit = matchSingleRewardTextDetailed("Forma Blueprint Braton Prime Stock", pool);
    expect(hit.confidence).toBeLessThan(0.92);
  });
});

describe("a short pool name against a long read", () => {
  // "Khra" is a real Requiem mod in the reward pool and the fuzzy band scores
  // per word, so it rode one 0.8 word to 0.920 on a 17-character read.
  const POOL = [
    { name: "Khra" },
    { name: "Khora Prime Blueprint" },
    { name: "Khora Prime Chassis Blueprint" },
  ];

  it("does not let a four-letter name win a seventeen-character read", () => {
    const ranked = rankRewardCandidatesDetailed("Khora Prime Bluepr", POOL, 4);
    expect(ranked[0].item?.name).toBe("Khora Prime Blueprint");
    expect(ranked.some((candidate) => candidate.item?.name === "Khra")).toBe(false);
  });

  it("still matches a short reward name from a short read", () => {
    for (const read of ["Khra", "KHRA", "Khra "]) {
      const hit = matchSingleRewardTextDetailed(read, POOL);
      expect(hit.item?.name, read).toBe("Khra");
      expect(hit.mode, read).toBe("exact");
    }
    // fuzzy too: one bad character on a short read must still reach the name
    const fuzzy = matchSingleRewardTextDetailed("Netro", [
      { name: "Netra" },
      { name: "Khora Prime Blueprint" },
    ]);
    expect(fuzzy.item?.name).toBe("Netra");
    expect(fuzzy.mode).toBe("fuzzy");
  });
});

describe("a pool pair that differs only by a leading quantity", () => {
  // Both are real reward names; "Forma" alone is not in the pool.
  const PAIR = [{ name: "Forma Blueprint" }, { name: "2X Forma Blueprint" }];

  it("gives a read with no quantity token to the bare name", () => {
    const hit = matchSingleRewardTextDetailed("Forma Blueprin", PAIR);
    expect(hit.item?.name).toBe("Forma Blueprint");
    expect(hit.confidence).toBeGreaterThanOrEqual(0.86);
  });

  it("gives a read carrying a quantity token to the counted name", () => {
    for (const read of ["2X Forma Blueprint", "2 X Forma Blueprint", "2x forma blueprint"]) {
      const hit = matchSingleRewardTextDetailed(read, PAIR);
      expect(hit.item?.name, read).toBe("2X Forma Blueprint");
      expect(hit.mode, read).toBe("exact");
    }
  });

  it("keeps a counted name reachable when it has no bare sibling", () => {
    const kuva = [{ name: "1200X Kuva" }, { name: "Forma Blueprint" }];
    expect(matchSingleRewardTextDetailed("1200 X Kuva", kuva).item?.name).toBe("1200X Kuva");
    expect(matchSingleRewardTextDetailed("1200X Kuv", kuva).item?.name).toBe("1200X Kuva");
  });
});

describe("detectRelicEraFromFilterLabelText", () => {
  it("maps the ALL tab to omnia", () => {
    expect(detectRelicEraFromFilterLabelText("ALL")).toEqual({ era: "omnia", confidence: 1 });
    expect(detectRelicEraFromFilterLabelText("all")).toEqual({ era: "omnia", confidence: 1 });
  });

  it("tolerates common OCR misreads of ALL", () => {
    for (const text of ["AII", "A11", "ALI", "AIL", "A1L"]) {
      const hit = detectRelicEraFromFilterLabelText(text);
      expect(hit.era, text).toBe("omnia");
      expect(hit.confidence, text).toBeGreaterThanOrEqual(0.95);
    }
  });

  it("reads era names and prefers exact eras over ALL misreads", () => {
    expect(detectRelicEraFromFilterLabelText("LITH")).toEqual({ era: "lith", confidence: 1 });
    expect(detectRelicEraFromFilterLabelText("REQUIEM").era).toBe("requiem");
    // AXI misread as AXL folds to ALL-distance 1 but must stay axi via fuzzy era match
    expect(detectRelicEraFromFilterLabelText("AXL").era).not.toBe("omnia");
  });

  it("returns nothing on unrelated screen text", () => {
    expect(detectRelicEraFromFilterLabelText("").era).toBeNull();
    expect(detectRelicEraFromFilterLabelText("VOID RELICS REFINEMENT").era).toBeNull();
  });
});

describe("era ambiguity counts the forms the detector accepts", () => {
  it("treats a misread second era as a second era", () => {
    // The detector reads LITK as Lith, so the guard has to see it too or the
    // screen pins whichever era happened to survive OCR intact.
    for (const text of [
      "REQUIEM FISSURE GARUS LITK FISSURE KORO",
      "REQUIEM RELICS MES RELICS",
      "AXL RELIC REQUIEM RELIC",
    ]) {
      expect(detectRelicEraFromBandText(text).era, text).toBeNull();
      expect(detectRelicEraFromTileLabelText(text).era, text).toBeNull();
    }
  });

  it("still resolves a screen that mentions one era", () => {
    expect(detectRelicEraFromBandText("LITK RELICS").era).toBe("lith");
    expect(detectRelicEraFromBandText("REQUIEM FISSURE GARUS KUVA FORTRESS").era).toBe("requiem");
    expect(detectRelicEraFromTileLabelText("Meso V6 Relic [Radiant]").era).toBe("meso");
    expect(detectRelicEraFromTileLabelText("Axi A12 Relic").era).toBe("axi");
  });
});
