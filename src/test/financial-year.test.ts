import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  DEFAULT_FINANCIAL_YEAR_END_MONTH,
  __setFinancialYearEndMonthForTesting,
  getFinancialYearEndMonth,
  getSeasonStartMonth,
  normalizeYearEndMonth,
} from "@/lib/financial-year";
import { seasonYearOfStoredDate } from "@/lib/financial-year";
import { getSeasonStartDate } from "@/lib/policies/age-tier";

// The financial-year cache is module-level mutable state shared across the
// process. Reset it around every test so order does not matter.
beforeEach(() => {
  __setFinancialYearEndMonthForTesting(DEFAULT_FINANCIAL_YEAR_END_MONTH);
});
afterEach(() => {
  __setFinancialYearEndMonthForTesting(DEFAULT_FINANCIAL_YEAR_END_MONTH);
});

describe("normalizeYearEndMonth", () => {
  it("keeps valid months 1-12", () => {
    expect(normalizeYearEndMonth(1)).toBe(1);
    expect(normalizeYearEndMonth(12)).toBe(12);
  });
  it("falls back to March for invalid values", () => {
    expect(normalizeYearEndMonth(0)).toBe(3);
    expect(normalizeYearEndMonth(13)).toBe(3);
    expect(normalizeYearEndMonth(null)).toBe(3);
    expect(normalizeYearEndMonth(undefined)).toBe(3);
    expect(normalizeYearEndMonth(Number.NaN)).toBe(3);
  });
});

describe("getSeasonStartMonth", () => {
  it("defaults to April (month after March)", () => {
    expect(getFinancialYearEndMonth()).toBe(3);
    expect(getSeasonStartMonth()).toBe(4);
  });
  it("is January for a December year-end", () => {
    __setFinancialYearEndMonthForTesting(12);
    expect(getSeasonStartMonth()).toBe(1);
  });
  it("is July for a June year-end", () => {
    __setFinancialYearEndMonthForTesting(6);
    expect(getSeasonStartMonth()).toBe(7);
  });
});

// `getSeasonYear` is retired (CT-4 group F1, #2870); every fixture here is a
// UTC-midnight date-only string, so this exercises the stored-calendar-day half.
// The zone-aware half is `clubSeasonYear`, in `club-season-year.test.ts`.
describe("seasonYearOfStoredDate with a configurable year-end", () => {
  it("matches the March default (April -> current year, March -> previous)", () => {
    expect(seasonYearOfStoredDate(new Date("2026-04-01"))).toBe(2026);
    expect(seasonYearOfStoredDate(new Date("2026-12-15"))).toBe(2026);
    expect(seasonYearOfStoredDate(new Date("2026-03-31"))).toBe(2025);
  });

  it("handles a June year-end (season starts July)", () => {
    __setFinancialYearEndMonthForTesting(6);
    expect(seasonYearOfStoredDate(new Date("2026-07-01"))).toBe(2026); // start boundary
    expect(seasonYearOfStoredDate(new Date("2026-12-31"))).toBe(2026);
    expect(seasonYearOfStoredDate(new Date("2026-06-30"))).toBe(2025); // last day of season
  });

  it("handles a December year-end (calendar-year financial year)", () => {
    __setFinancialYearEndMonthForTesting(12);
    expect(seasonYearOfStoredDate(new Date("2026-01-01"))).toBe(2026);
    expect(seasonYearOfStoredDate(new Date("2026-12-31"))).toBe(2026);
    expect(seasonYearOfStoredDate(new Date("2027-01-01"))).toBe(2027);
  });
});

describe("getSeasonStartDate with a configurable year-end", () => {
  it("returns April 1 by default", () => {
    const d = getSeasonStartDate(2026);
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(3); // April (0-based)
    expect(d.getDate()).toBe(1);
  });

  it("returns July 1 for a June year-end", () => {
    __setFinancialYearEndMonthForTesting(6);
    const d = getSeasonStartDate(2026);
    expect(d.getMonth()).toBe(6); // July
    expect(d.getDate()).toBe(1);
  });

  it("returns January 1 for a December year-end", () => {
    __setFinancialYearEndMonthForTesting(12);
    const d = getSeasonStartDate(2026);
    expect(d.getMonth()).toBe(0); // January
    expect(d.getDate()).toBe(1);
  });
});
