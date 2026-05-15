import { describe, expect, it } from "vitest";
import {
  addDaysDateOnly,
  eachDateOnlyInRange,
  formatDateOnly,
  formatDateOnlyForTimeZone,
  formatLocalDateOnly,
  getTodayDateOnly,
  isDateOnlyString,
  parseDateOnly,
} from "@/lib/date-only";

describe("date-only helpers", () => {
  it("parses a date-only string as UTC midnight", () => {
    expect(parseDateOnly("2026-04-16").toISOString()).toBe(
      "2026-04-16T00:00:00.000Z"
    );
  });

  it("formats Prisma-style date-only values without timezone drift", () => {
    expect(formatDateOnly(new Date("2026-04-16T00:00:00.000Z"))).toBe(
      "2026-04-16"
    );
  });

  it("formats local calendar dates without UTC timezone drift", () => {
    expect(formatLocalDateOnly(new Date(2026, 3, 30))).toBe("2026-04-30");
  });

  it("formats instants as New Zealand date-only values", () => {
    expect(
      formatDateOnlyForTimeZone(new Date("2026-04-29T12:00:00.000Z"))
    ).toBe("2026-04-30");
  });

  it("adds days in UTC so lodge dates stay aligned with @db.Date values", () => {
    expect(
      addDaysDateOnly(parseDateOnly("2026-04-16"), 1).toISOString()
    ).toBe("2026-04-17T00:00:00.000Z");
  });

  it("iterates date-only ranges without dropping the last day of the month", () => {
    const dates = eachDateOnlyInRange(
      parseDateOnly("2026-04-01"),
      parseDateOnly("2026-05-01")
    ).map(formatDateOnly);

    expect(dates).toHaveLength(30);
    expect(dates[0]).toBe("2026-04-01");
    expect(dates.at(-1)).toBe("2026-04-30");
    expect(dates).not.toContain("2026-03-31");
  });

  it("derives today's NZ date as a date-only value", () => {
    expect(formatDateOnly(getTodayDateOnly("Pacific/Auckland"))).toMatch(
      /^\d{4}-\d{2}-\d{2}$/
    );
  });

  it("rejects impossible or malformed date-only strings", () => {
    expect(isDateOnlyString("not-a-date")).toBe(false);
    expect(isDateOnlyString("2026-02-31")).toBe(false);
    expect(Number.isNaN(parseDateOnly("2026-02-31").getTime())).toBe(true);
  });
});
