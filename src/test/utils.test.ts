import { describe, it, expect } from "vitest";
import { formatCents, formatCentsPlain } from "@/lib/utils";
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

  // #3302 review (equivalence lens): the sign sits BEFORE the symbol, matching
  // `formatSignedCents` and the locale convention — deliberate, and it is what
  // #3264 already shipped onto these same screens. The four sites this issue
  // folded into `formatCents` previously rendered a negative as `$-25.00`
  // (symbol first, from their own hand-rolled `"$" + (cents/100).toFixed(2)`);
  // every one of them now reads `-$25.00`.
  it("places the sign before the symbol for a negative amount", () => {
    expect(formatCents(-2500)).toBe("-$25.00");
    expect(formatCents(-100000)).toBe("-$1,000.00");
  });

  // #3302 review (equivalence lens F5): a caller that rounds a small negative
  // to zero (`Math.round(-0.4)` is `-0`) must not see a negative-zero balance.
  // `Intl.NumberFormat` renders `-0` as `-$0.00` on its own — verified — so
  // this guards the same class of bug #3264's `formatSignedCents` already
  // guards for its own zero case.
  it("never renders negative zero", () => {
    expect(formatCents(-0)).toBe("$0.00");
    expect(formatCents(Math.round(-0.4))).toBe("$0.00");
  });
});

describe("formatCentsPlain", () => {
  // #3302 review (equivalence lens F4): a separate named function rather than
  // an option on `formatCents`, so the wrong rendering is a different import,
  // not a different argument. The one genuine second rendering — an editable
  // dollars input, and a report line that already reads as a delta — bare two
  // decimals, no symbol or grouping, and no rounding drift from the
  // currency-style path.
  it("formats a bare two-decimal string, no symbol or grouping", () => {
    expect(formatCentsPlain(0)).toBe("0.00");
    expect(formatCentsPlain(1000)).toBe("10.00");
    expect(formatCentsPlain(1234)).toBe("12.34");
    expect(formatCentsPlain(100000)).toBe("1000.00");
  });

  it("formats a negative amount with the sign, no symbol", () => {
    expect(formatCentsPlain(-2500)).toBe("-25.00");
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
