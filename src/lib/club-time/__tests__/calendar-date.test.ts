/**
 * The calendar-date half of the kernel: identity, arithmetic, and the promise
 * that no zone can reach it (CT-2, #2990).
 */
import { describe, expect, it } from "vitest";

import {
  addCalendarDays,
  addCalendarMonths,
  calendarDateFromParts,
  calendarDateParts,
  calendarMonthOf,
  compareCalendarDates,
  countClubNights,
  daysInCalendarMonth,
  eachCalendarDate,
  isCalendarDate,
  parseCalendarDate,
  requireCalendarDate,
} from "../calendar-date";
import { withTimeZone } from "@/lib/__tests__/helpers/timezone";

const cd = requireCalendarDate;

describe("what counts as a club calendar date", () => {
  it("accepts a zero-padded four-digit-year day that really exists", () => {
    expect(isCalendarDate("2026-04-16")).toBe(true);
    expect(isCalendarDate("2028-02-29")).toBe(true);
    expect(isCalendarDate("0001-01-01")).toBe(true);
  });

  it("refuses every shape that is not exactly YYYY-MM-DD", () => {
    for (const value of [
      "2026-4-16",
      "20260416",
      "2026-04-16T00:00:00Z",
      "2026-04-16 ",
      "26-04-16",
      "2026-04-16Z",
      "",
    ]) {
      expect(isCalendarDate(value), value).toBe(false);
    }
  });

  it("refuses a day that does not exist, and NEVER rolls it forward", () => {
    // The whole point: `new Date("2026-02-30")` in some parsers is 2 March, and
    // a typo silently becomes a booking on the wrong night.
    expect(parseCalendarDate("2026-02-30")).toBeNull();
    expect(parseCalendarDate("2026-02-29")).toBeNull(); // 2026 is not a leap year
    expect(parseCalendarDate("2026-13-01")).toBeNull();
    expect(parseCalendarDate("2026-00-10")).toBeNull();
    expect(parseCalendarDate("2026-04-31")).toBeNull();
    expect(parseCalendarDate("2026-04-00")).toBeNull();
  });

  it("refuses a non-string without throwing", () => {
    expect(isCalendarDate(null)).toBe(false);
    expect(isCalendarDate(undefined)).toBe(false);
    expect(isCalendarDate(new Date())).toBe(false);
    expect(isCalendarDate(20260416)).toBe(false);
  });

  it("names the offending value when it throws", () => {
    expect(() => requireCalendarDate("2026-02-30")).toThrow(/2026-02-30/);
    expect(() => calendarDateFromParts(2026, 2, 30)).toThrow(/day=30/);
    // Months are 1-12, NOT the 0-based Date.getMonth() convention.
    expect(() => calendarDateFromParts(2026, 0, 1)).toThrow(/month=0/);
    expect(calendarDateFromParts(2026, 1, 1)).toBe("2026-01-01");
  });
});

describe("calendar arithmetic", () => {
  it("steps whole days across month, year and leap boundaries", () => {
    expect(addCalendarDays(cd("2026-04-16"), 1)).toBe("2026-04-17");
    expect(addCalendarDays(cd("2026-04-30"), 1)).toBe("2026-05-01");
    expect(addCalendarDays(cd("2026-12-31"), 1)).toBe("2027-01-01");
    expect(addCalendarDays(cd("2027-01-01"), -1)).toBe("2026-12-31");
    expect(addCalendarDays(cd("2028-02-28"), 1)).toBe("2028-02-29");
    expect(addCalendarDays(cd("2028-02-29"), 1)).toBe("2028-03-01");
    expect(addCalendarDays(cd("2026-02-28"), 1)).toBe("2026-03-01");
    expect(addCalendarDays(cd("2026-04-16"), 0)).toBe("2026-04-16");
  });

  it("clamps a month step to the target month's length", () => {
    expect(addCalendarMonths(cd("2026-01-31"), 1)).toBe("2026-02-28");
    expect(addCalendarMonths(cd("2028-01-31"), 1)).toBe("2028-02-29");
    expect(addCalendarMonths(cd("2026-03-31"), -1)).toBe("2026-02-28");
    expect(addCalendarMonths(cd("2026-12-15"), 1)).toBe("2027-01-15");
    expect(addCalendarMonths(cd("2026-01-15"), -1)).toBe("2025-12-15");
    expect(addCalendarMonths(cd("2026-01-15"), 24)).toBe("2028-01-15");
  });

  it("documents that the clamp makes a month step non-reversible", () => {
    const forward = addCalendarMonths(cd("2026-01-31"), 1);
    expect(addCalendarMonths(forward, -1)).toBe("2026-01-28");
  });

  it("orders days chronologically", () => {
    expect(compareCalendarDates(cd("2026-04-16"), cd("2026-04-17"))).toBe(-1);
    expect(compareCalendarDates(cd("2026-04-17"), cd("2026-04-16"))).toBe(1);
    expect(compareCalendarDates(cd("2026-04-16"), cd("2026-04-16"))).toBe(0);
    expect(compareCalendarDates(cd("2026-09-30"), cd("2026-10-01"))).toBe(-1);
  });

  it("counts nights as a half-open range", () => {
    expect(countClubNights(cd("2026-07-01"), cd("2026-07-02"))).toBe(1);
    expect(countClubNights(cd("2026-04-03"), cd("2026-04-06"))).toBe(3);
    expect(countClubNights(cd("2026-07-01"), cd("2026-07-01"))).toBe(0);
    expect(countClubNights(cd("2026-07-02"), cd("2026-07-01"))).toBe(-1);
    expect(countClubNights(cd("2026-01-01"), cd("2027-01-01"))).toBe(365);
    expect(countClubNights(cd("2028-01-01"), cd("2029-01-01"))).toBe(366);
  });

  it("expands a range half-open, in order, and refuses to invert", () => {
    expect(eachCalendarDate(cd("2026-04-03"), cd("2026-04-06"))).toEqual([
      "2026-04-03",
      "2026-04-04",
      "2026-04-05",
    ]);
    expect(eachCalendarDate(cd("2026-04-03"), cd("2026-04-03"))).toEqual([]);
    expect(eachCalendarDate(cd("2026-04-06"), cd("2026-04-03"))).toEqual([]);
  });

  it("reads back its own parts and month key", () => {
    expect(calendarDateParts(cd("2026-04-06"))).toEqual({
      year: 2026,
      month: 4,
      day: 6,
    });
    expect(calendarMonthOf(cd("2026-04-06"))).toBe("2026-04");
    expect(daysInCalendarMonth(2026, 2)).toBe(28);
    expect(daysInCalendarMonth(2028, 2)).toBe(29);
    expect(daysInCalendarMonth(2000, 2)).toBe(29);
    expect(daysInCalendarMonth(1900, 2)).toBe(28);
  });
});

describe("the integer civil-calendar arithmetic agrees with the platform", () => {
  /*
    `calendar-date.ts` deliberately holds no `Date` at all (the census suite
    asserts that), so its day arithmetic is Hinnant's `days_from_civil` pair
    rather than `setUTCDate`. That is only worth doing if the two provably agree,
    so every day of a century is stepped against `Date.UTC` here. A single
    off-by-one in the era arithmetic — the easy mistake, in the negative branch
    or on a 400-year boundary — fails on the day it happens rather than in
    production a decade later.
  */
  it("steps every day of 1970-2070 exactly as Date.UTC does", () => {
    const start = Date.UTC(1970, 0, 1);
    const end = Date.UTC(2070, 0, 1);
    let expected = new Date(start);
    let actual = cd("1970-01-01");
    for (let ms = start; ms < end; ms += 86_400_000) {
      expect(actual).toBe(expected.toISOString().slice(0, 10));
      expected = new Date(expected.getTime() + 86_400_000);
      actual = addCalendarDays(actual, 1);
    }
  });

  it("handles years outside the two-digit-year trap", () => {
    // `Date.UTC(47, 0, 1)` is 1947, which is why `date-only.ts` avoids it. The
    // kernel never calls `Date.UTC` for a calendar day at all.
    expect(calendarDateFromParts(47, 1, 1)).toBe("0047-01-01");
    expect(addCalendarDays(cd("0047-12-31"), 1)).toBe("0048-01-01");
    expect(countClubNights(cd("0047-01-01"), cd("0048-01-01"))).toBe(365);
  });
});

describe("no host timezone can reach a calendar date", () => {
  /*
    The premise is asserted first. A host-zone test that pins two zones which
    resolve to the SAME zone passes vacuously, which is exactly how a recorded
    guard in this repository stayed green while the defect it existed for was
    restored.
  */
  it("the two host zones really do differ", () => {
    const seen = new Set(
      ["UTC", "America/Los_Angeles"].map((zone) =>
        withTimeZone(zone, () => Intl.DateTimeFormat().resolvedOptions().timeZone),
      ),
    );
    expect(seen.size).toBe(2);
  });

  it("gives identical answers under UTC and America/Los_Angeles", () => {
    const answersIn = (hostZone: string) =>
      withTimeZone(hostZone, () => ({
        parsed: parseCalendarDate("2026-04-16"),
        plusOne: addCalendarDays(cd("2026-04-16"), 1),
        plusMonth: addCalendarMonths(cd("2026-01-31"), 1),
        nights: countClubNights(cd("2026-04-03"), cd("2026-04-06")),
        range: eachCalendarDate(cd("2026-04-03"), cd("2026-04-06")),
        parts: calendarDateParts(cd("2026-04-16")),
      }));
    expect(answersIn("UTC")).toEqual(answersIn("America/Los_Angeles"));
  });
});
