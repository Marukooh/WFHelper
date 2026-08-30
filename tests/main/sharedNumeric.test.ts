import { describe, it, expect } from "vitest";

import { clampNumber, toFiniteNumber, normalizeDucats } from "../../config/shared/numeric";

// Warframe inventory numbers may use nested BSON wrappers.
describe("toFiniteNumber boxed-number handling", () => {
  it("unwraps BSON-style boxed numbers, including nested", () => {
    expect(toFiniteNumber({ $numberLong: "1000" })).toBe(1000);
    expect(toFiniteNumber({ $numberDouble: "2.5" })).toBe(2.5);
    expect(toFiniteNumber({ $numberInt: { $numberLong: "42" } })).toBe(42);
  });

  it("still handles plain numbers/strings and rejects junk", () => {
    expect(toFiniteNumber("  3.14  ")).toBe(3.14);
    expect(toFiniteNumber(NaN)).toBeNull();
    expect(toFiniteNumber("abc")).toBeNull();
  });

  it("normalizeDucats parses boxed values", () => {
    expect(normalizeDucats({ $numberLong: "45" })).toBe(45);
  });
});

describe("clampNumber fallback", () => {
  // An emptied number input binds to null, and a hand-edited settings file can
  // carry the key as null or "". Coercing those to 0 would clamp to the floor.
  it("falls back for an absent value instead of clamping to the floor", () => {
    expect(clampNumber(null, 2, 60, 5)).toBe(5);
    expect(clampNumber(undefined, 2, 60, 5)).toBe(5);
    expect(clampNumber("", 2, 60, 5)).toBe(5);
    expect(clampNumber("   ", 2, 60, 5)).toBe(5);
  });

  it("still clamps a real number, zero included", () => {
    expect(clampNumber(0, 2, 60, 5)).toBe(2);
    expect(clampNumber(90, 2, 60, 5)).toBe(60);
    expect(clampNumber("12", 2, 60, 5)).toBe(12);
  });

  it("falls back for junk and throws without a fallback", () => {
    expect(clampNumber("abc", 2, 60, 5)).toBe(5);
    expect(() => clampNumber(Number.NaN, 2, 60)).toThrow(TypeError);
  });
});
