import { describe, expect, it } from "vitest";

import {
  IDENTITY_RATE_MICROS,
  MAX_RATE_MICROS,
  MICROS_PER_CLUB_UNIT,
  MIN_RATE_MICROS,
  convertNzdCentsToClubCents,
  formatClubUnitsPerNzd,
  isValidRateMicros,
  parseClubUnitsPerNzdToMicros,
} from "@/lib/ai-spend-currency";

// #3354: the pure arithmetic and grammar of the NZD -> club-currency rate. Every
// boundary here is one a mutant could cross silently — a zero rate disarms both
// caps, a rounded-down conversion hands back the over-count margin, and a
// non-identity identity would move every NZD club's ledger on deploy.

describe("parseClubUnitsPerNzdToMicros", () => {
  it("parses a plain decimal exactly, up to six places", () => {
    expect(parseClubUnitsPerNzdToMicros("0.92")).toBe(920_000);
    expect(parseClubUnitsPerNzdToMicros("1")).toBe(1_000_000);
    expect(parseClubUnitsPerNzdToMicros("1.000000")).toBe(1_000_000);
    expect(parseClubUnitsPerNzdToMicros("1.234567")).toBe(1_234_567);
    expect(parseClubUnitsPerNzdToMicros("  0.5  ")).toBe(500_000);
    expect(parseClubUnitsPerNzdToMicros("0.000001")).toBe(MIN_RATE_MICROS);
    expect(parseClubUnitsPerNzdToMicros("1000")).toBe(MAX_RATE_MICROS);
  });

  it("refuses zero — a zero rate would price every call at nothing", () => {
    expect(parseClubUnitsPerNzdToMicros("0")).toBeNull();
    expect(parseClubUnitsPerNzdToMicros("0.0")).toBeNull();
    expect(parseClubUnitsPerNzdToMicros("0.000000")).toBeNull();
  });

  it("refuses a negative, a sign, a symbol, a separator, a leading zero and over-precision", () => {
    for (const bad of [
      "-0.92",
      "+0.92",
      "$0.92",
      "0,92",
      "1,000",
      "007",
      "00.5",
      "0.9200001",
      ".92",
      "0.",
      "",
      "   ",
      "abc",
      "NaN",
      "Infinity",
      "1e3",
    ]) {
      expect(parseClubUnitsPerNzdToMicros(bad), bad).toBeNull();
    }
  });

  it("refuses anything above the upper bound", () => {
    expect(parseClubUnitsPerNzdToMicros("1000.000001")).toBeNull();
    expect(parseClubUnitsPerNzdToMicros("1001")).toBeNull();
    expect(parseClubUnitsPerNzdToMicros("99999999999999999999")).toBeNull();
  });
});

describe("isValidRateMicros", () => {
  it("accepts the closed range and nothing outside it", () => {
    expect(isValidRateMicros(MIN_RATE_MICROS)).toBe(true);
    expect(isValidRateMicros(IDENTITY_RATE_MICROS)).toBe(true);
    expect(isValidRateMicros(MAX_RATE_MICROS)).toBe(true);
    expect(isValidRateMicros(0)).toBe(false);
    expect(isValidRateMicros(-1)).toBe(false);
    expect(isValidRateMicros(MAX_RATE_MICROS + 1)).toBe(false);
    expect(isValidRateMicros(1.5)).toBe(false);
    expect(isValidRateMicros(Number.NaN)).toBe(false);
    expect(isValidRateMicros(Number.POSITIVE_INFINITY)).toBe(false);
  });
});

describe("formatClubUnitsPerNzd", () => {
  it("is the inverse of the parser, with at least two decimals and no trailing noise", () => {
    expect(formatClubUnitsPerNzd(920_000)).toBe("0.92");
    expect(formatClubUnitsPerNzd(1_000_000)).toBe("1.00");
    expect(formatClubUnitsPerNzd(1_234_567)).toBe("1.234567");
    expect(formatClubUnitsPerNzd(1_500_000)).toBe("1.50");
    expect(formatClubUnitsPerNzd(1)).toBe("0.000001");
    expect(formatClubUnitsPerNzd(MAX_RATE_MICROS)).toBe("1000.00");
  });

  it("round-trips every parsed value", () => {
    for (const text of ["0.92", "1.00", "1.234567", "0.000001", "1000.00", "12.5"]) {
      const micros = parseClubUnitsPerNzdToMicros(text);
      expect(micros).not.toBeNull();
      expect(parseClubUnitsPerNzdToMicros(formatClubUnitsPerNzd(micros!))).toBe(micros);
    }
  });
});

describe("convertNzdCentsToClubCents", () => {
  it("leaves cents UNCHANGED at the identity rate — the invariant every NZD club relies on", () => {
    for (const cents of [0, 1, 2, 16, 41, 1323, 100_000, 500_000, 2_147_483_647]) {
      expect(convertNzdCentsToClubCents(cents, IDENTITY_RATE_MICROS)).toBe(cents);
    }
  });

  it("rounds UP, never down, so the over-count margin is kept", () => {
    // 16c x 0.92 = 14.72 -> 15, not 14.
    expect(convertNzdCentsToClubCents(16, 920_000)).toBe(15);
    // 1c x 0.5 = 0.5 -> 1: a real call is never free after conversion.
    expect(convertNzdCentsToClubCents(1, 500_000)).toBe(1);
    // 1c at the smallest rate is still 1c.
    expect(convertNzdCentsToClubCents(1, MIN_RATE_MICROS)).toBe(1);
    // 3c x 0.333333 = 0.999999 -> 1 (not 0).
    expect(convertNzdCentsToClubCents(3, 333_333)).toBe(1);
    // 10c x 1.5 = exactly 15: an exact multiple is not pushed up.
    expect(convertNzdCentsToClubCents(10, 1_500_000)).toBe(15);
    // 1c x 1000 = 1000 exactly.
    expect(convertNzdCentsToClubCents(1, MAX_RATE_MICROS)).toBe(1000);
  });

  it("only zero converts to zero", () => {
    expect(convertNzdCentsToClubCents(0, 920_000)).toBe(0);
    expect(convertNzdCentsToClubCents(0, MIN_RATE_MICROS)).toBe(0);
    expect(convertNzdCentsToClubCents(1, MIN_RATE_MICROS)).toBeGreaterThan(0);
  });

  it("is exact where float division would not be", () => {
    // Every exact multiple of the fixed point stays exact across the range a
    // cap can take (0..500_000 cents) at a rate with a repeating decimal.
    const micros = 333_333;
    for (let cents = 0; cents <= 1_000; cents += 1) {
      const product = cents * micros;
      const expected = Math.floor(product / MICROS_PER_CLUB_UNIT) +
        (product % MICROS_PER_CLUB_UNIT === 0 ? 0 : 1);
      expect(convertNzdCentsToClubCents(cents, micros)).toBe(expected);
    }
  });

  it("throws rather than returning a wrong figure on bad input", () => {
    expect(() => convertNzdCentsToClubCents(-1, IDENTITY_RATE_MICROS)).toThrow();
    expect(() => convertNzdCentsToClubCents(1.5, IDENTITY_RATE_MICROS)).toThrow();
    expect(() => convertNzdCentsToClubCents(Number.NaN, IDENTITY_RATE_MICROS)).toThrow();
    expect(() => convertNzdCentsToClubCents(1, 0)).toThrow();
    expect(() => convertNzdCentsToClubCents(1, -1)).toThrow();
    expect(() => convertNzdCentsToClubCents(1, MAX_RATE_MICROS + 1)).toThrow();
    expect(() => convertNzdCentsToClubCents(1, 1.5)).toThrow();
  });
});
