import { describe, expect, it } from "vitest";
import {
  formatCompactDollarsDisplay,
  formatDollarsDisplay,
  formatFinanceNumber,
  formatFinancePercent,
  formatFinanceSignedNumber,
  formatSignedDollarsDisplay,
} from "@/lib/finance-format";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

describe("finance display formatters", () => {
  it("formats whole dollars with thousands separators and no cents", () => {
    expect(formatDollarsDisplay(44_667_484, CLUB_FORMAT_TEST)).toBe("$446,675");
    expect(formatDollarsDisplay(123_456, CLUB_FORMAT_TEST)).toBe("$1,235");
    expect(formatDollarsDisplay(49, CLUB_FORMAT_TEST)).toBe("$0");
    expect(formatDollarsDisplay(-2_500_00, CLUB_FORMAT_TEST)).toBe("-$2,500");
  });

  it("formats signed dollar deltas", () => {
    expect(formatSignedDollarsDisplay(120_400, CLUB_FORMAT_TEST)).toBe("+$1,204");
    expect(formatSignedDollarsDisplay(-31_000, CLUB_FORMAT_TEST)).toBe("-$310");
    expect(formatSignedDollarsDisplay(0, CLUB_FORMAT_TEST)).toBe("$0");
    expect(formatSignedDollarsDisplay(20, CLUB_FORMAT_TEST)).toBe("$0");
  });

  it("formats counts and percentages", () => {
    expect(formatFinanceNumber(12_345, CLUB_FORMAT_TEST)).toBe("12,345");
    expect(formatFinanceSignedNumber(42, CLUB_FORMAT_TEST)).toBe("+42");
    expect(formatFinanceSignedNumber(-7, CLUB_FORMAT_TEST)).toBe("-7");
    expect(formatFinancePercent(0.125, CLUB_FORMAT_TEST)).toBe("12.5%");
  });
});

describe("formatCompactDollarsDisplay (#3325)", () => {
  it("keeps the chart theme's k/m tick shape under the default configuration", () => {
    expect(formatCompactDollarsDisplay(1_000_000, CLUB_FORMAT_TEST)).toBe("$10k");
    expect(formatCompactDollarsDisplay(120_000_000, CLUB_FORMAT_TEST)).toBe("$1.2m");
    expect(formatCompactDollarsDisplay(45_000, CLUB_FORMAT_TEST)).toBe("$450");
    expect(formatCompactDollarsDisplay(-120_000_000, CLUB_FORMAT_TEST)).toBe("$-1.2m");
  });

  // The symbol and its position come from the club's locale, not a
  // hand-spelt `$` prefix: de-DE writes the euro AFTER the number. The format
  // is an argument now (#3565), so a different club is a different argument
  // rather than a re-mocked environment and a fresh import.
  it("places the compact number where the club's locale puts its digits", () => {
    const de = { currencyCode: "EUR", locale: "de-DE" };
    expect(formatCompactDollarsDisplay(1_000_000, de)).toBe("10k\u00a0€");
    expect(formatCompactDollarsDisplay(120_000_000, de)).toBe("1.2m\u00a0€");
  });
});
