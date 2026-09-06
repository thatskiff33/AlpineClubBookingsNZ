import { describe, it, expect } from "vitest";
import { formatCents } from "@/lib/utils";
// `getSeasonYear` lived in `utils.ts` and is gone (CT-4 group F1, #2870): it read
// its argument's HOST-local components. Every fixture below is a UTC-midnight
// date-only string, so the successor is `seasonYearOfStoredDate`, which takes no
// zone at all.
import { seasonYearOfStoredDate } from "@/lib/financial-year";

describe("formatCents", () => {
  it("formats whole dollar amounts", () => {
    expect(formatCents(4500)).toBe("$45.00");
  });

  it("formats cents correctly", () => {
    expect(formatCents(4550)).toBe("$45.50");
  });

  it("formats zero", () => {
    expect(formatCents(0)).toBe("$0.00");
  });

  it("formats large amounts with thousands separators", () => {
    expect(formatCents(100000)).toBe("$1,000.00");
    expect(formatCents(44667484)).toBe("$446,674.84");
  });

  it("formats single cent", () => {
    expect(formatCents(1)).toBe("$0.01");
  });

  // #3302: the one genuine second rendering (an editable dollars input, and a
  // report line that already reads as a delta) — bare two decimals, no symbol
  // or grouping, and no rounding drift from the currency-style path.
  it("formats a bare two-decimal string with { style: \"plain\" }, no symbol or grouping", () => {
    expect(formatCents(0, { style: "plain" })).toBe("0.00");
    expect(formatCents(1000, { style: "plain" })).toBe("10.00");
    expect(formatCents(1234, { style: "plain" })).toBe("12.34");
    expect(formatCents(100000, { style: "plain" })).toBe("1000.00");
  });
});

describe("seasonYearOfStoredDate", () => {
  it("returns current year for April", () => {
    expect(seasonYearOfStoredDate(new Date("2026-04-15"))).toBe(2026);
  });

  it("returns current year for December", () => {
    expect(seasonYearOfStoredDate(new Date("2026-12-15"))).toBe(2026);
  });

  it("returns previous year for January", () => {
    expect(seasonYearOfStoredDate(new Date("2026-01-15"))).toBe(2025);
  });

  it("returns previous year for March", () => {
    expect(seasonYearOfStoredDate(new Date("2026-03-31"))).toBe(2025);
  });

  it("returns current year for April 1 (boundary)", () => {
    expect(seasonYearOfStoredDate(new Date("2026-04-01"))).toBe(2026);
  });
});
