import { describe, expect, it } from "vitest";

import { isPickerEntryMapping } from "../../services/eeLogMonitor";

describe("relic picker close gate", () => {
  it("treats an InitMapping right after the open dispatch as picker entry", () => {
    expect(isPickerEntryMapping(1_500, 1_000, false)).toBe(true);
  });

  it("closes on a fast back-out beyond the entry window", () => {
    // 1.4s after the open is past the entry window, so this is a back-out, not entry.
    expect(isPickerEntryMapping(2_400, 1_000, false)).toBe(false);
  });

  it("never skips twice, so a session cannot swallow its real close", () => {
    expect(isPickerEntryMapping(1_500, 1_000, true)).toBe(false);
  });
});
