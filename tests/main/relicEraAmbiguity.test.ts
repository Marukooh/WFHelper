import { describe, expect, it } from "vitest";

import {
  detectRelicEraFromBandText,
  detectRelicEraFromFilterLabelText,
  detectRelicEraFromTileLabelText,
} from "../../services/rewardScannerMatch";

// Verbatim OCR preview from a user's main.log. The player picked the Omnia
// fissure, but two Requiem fissures are listed above it in the star chart.
const STAR_CHART_LIST =
  "Requiem Fissure Garus (Kuva Fortres: CIII 14m ASSAULT (160-17 Requiem Fissure Koro " +
  "(Kuva Fortress) C31m 27s VOID FLOOD (158. Omnia Fissure Everview Arc CI 4m 23s";

describe("relic era detection with several eras on screen", () => {
  it("refuses to pick an era from a fissure list", () => {
    expect(detectRelicEraFromTileLabelText(STAR_CHART_LIST)).toEqual({ era: null, confidence: 0 });
    expect(detectRelicEraFromBandText(STAR_CHART_LIST)).toEqual({ era: null, confidence: 0 });
  });

  it("still reads a single era tile", () => {
    const hit = detectRelicEraFromTileLabelText("Meso V6 Relic [Radiant]");
    expect(hit.era).toBe("meso");
    expect(hit.confidence).toBeGreaterThan(0.9);
  });

  it("still reads a single era band", () => {
    expect(detectRelicEraFromBandText("AXI RELICS").era).toBe("axi");
  });

  it("treats an omnia mention beside another era as ambiguous", () => {
    expect(detectRelicEraFromBandText("Omnia Fissure Lith Fissure").era).toBeNull();
  });

  it("leaves the authoritative filter label alone", () => {
    // The selected tab is a deliberate single pick, so it keeps deciding.
    expect(detectRelicEraFromFilterLabelText("ALL").era).toBe("omnia");
    expect(detectRelicEraFromFilterLabelText("REQUIEM").era).toBe("requiem");
  });
});
