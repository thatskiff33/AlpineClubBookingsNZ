import { describe, expect, it } from "vitest";
import {
  bookingFilterDateRangePresets,
  findMatchingDateRangePreset,
  getDateRangeForPreset,
  reportsDateRangePresets,
} from "@/lib/date-range-presets";

/**
 * #3123 deleted this module's `today` default, so nothing here reads a clock any
 * more and the suite no longer moves one. Every case states the day it is about,
 * which is also what the one caller now does: `DateRangeControls` passes
 * `dateOnlyInstantOf(useClubTime().today())`, the club's persisted-zone day
 * delivered to the browser as data. Where that day comes from is proved in
 * `date-range-controls-club-time.test.tsx`; what the presets DO with it is
 * proved here.
 */
const APRIL_13 = new Date("2026-04-13T00:00:00.000Z");

describe("date-range-presets", () => {

  it("builds last month ranges for filters", () => {
    const preset = bookingFilterDateRangePresets.find(
      (option) => option.key === "last_month"
    );

    expect(preset).toBeDefined();
    expect(getDateRangeForPreset(preset!, APRIL_13)).toEqual({
      from: "2026-03-01",
      to: "2026-03-31",
    });
  });

  it("builds next month ranges for booking filters", () => {
    const preset = bookingFilterDateRangePresets.find(
      (option) => option.key === "next_month"
    );

    expect(preset).toBeDefined();
    expect(getDateRangeForPreset(preset!, APRIL_13)).toEqual({
      from: "2026-05-01",
      to: "2026-05-31",
    });
  });

  it("clamps month-based ranges when today is at the end of a month", () => {
    const lastMonth = bookingFilterDateRangePresets.find(
      (option) => option.key === "last_month"
    );
    const nextMonth = bookingFilterDateRangePresets.find(
      (option) => option.key === "next_month"
    );
    const today = new Date("2026-03-31T00:00:00.000Z");

    expect(lastMonth).toBeDefined();
    expect(nextMonth).toBeDefined();
    expect(getDateRangeForPreset(lastMonth!, today)).toEqual({
      from: "2026-02-01",
      to: "2026-02-28",
    });
    expect(getDateRangeForPreset(nextMonth!, today)).toEqual({
      from: "2026-04-01",
      to: "2026-04-30",
    });
  });

  it("builds last year ranges for reports", () => {
    const preset = reportsDateRangePresets.find(
      (option) => option.key === "last_year"
    );

    expect(preset).toBeDefined();
    expect(getDateRangeForPreset(preset!, APRIL_13)).toEqual({
      from: "2025-01-01",
      to: "2025-12-31",
    });
  });

  it.each([
    {
      today: "2026-04-13T00:00:00.000Z",
      expected: { from: "2026-05-01", to: "2026-05-31" },
    },
    {
      today: "2026-12-15T00:00:00.000Z",
      expected: { from: "2027-01-01", to: "2027-01-31" },
    },
    {
      today: "2024-01-20T00:00:00.000Z",
      expected: { from: "2024-02-01", to: "2024-02-29" },
    },
  ])("builds the next calendar month for reports from $today", ({ today, expected }) => {
    const preset = reportsDateRangePresets.find(
      (option) => option.key === "next_month"
    );

    expect(preset).toBeDefined();
    expect(getDateRangeForPreset(preset!, new Date(today))).toEqual(expected);
  });

  it("matches an exact preset range", () => {
    expect(
      findMatchingDateRangePreset(
        "2026-03-01",
        "2026-03-31",
        bookingFilterDateRangePresets,
        APRIL_13
      )
    ).toBe("last_month");
  });

  it("matches presets against the day it is given, not a clock", () => {
    expect(
      findMatchingDateRangePreset(
        "2026-05-01",
        "2026-05-31",
        bookingFilterDateRangePresets,
        new Date("2026-05-01T00:00:00.000Z")
      )
    ).toBe("this_month");
  });

  it("has no default day, so omitting it does not compile (#3123)", () => {
    // Never called: `@ts-expect-error` is a COMPILE-time assertion, and `tsc`
    // fails if either signature regains the environment-zone default this issue
    // removed.
    const refusedByTheCompiler = () => {
      // @ts-expect-error the reference day is required (#3123)
      getDateRangeForPreset(bookingFilterDateRangePresets[0]);
      // @ts-expect-error the reference day is required (#3123)
      findMatchingDateRangePreset("2026-05-01", "2026-05-31", bookingFilterDateRangePresets);
    };
    expect(refusedByTheCompiler).toBeTypeOf("function");
  });

  it("returns null for custom ranges", () => {
    expect(
      findMatchingDateRangePreset(
        "2026-02-10",
        "2026-04-05",
        reportsDateRangePresets,
        APRIL_13
      )
    ).toBeNull();
  });
});
