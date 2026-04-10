import { describe, expect, it } from "vitest";
import {
  addDaysDateOnly,
  formatDateOnly,
  getTodayDateOnly,
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

  it("adds days in UTC so lodge dates stay aligned with @db.Date values", () => {
    expect(
      addDaysDateOnly(parseDateOnly("2026-04-16"), 1).toISOString()
    ).toBe("2026-04-17T00:00:00.000Z");
  });

  it("derives today's NZ date as a date-only value", () => {
    expect(formatDateOnly(getTodayDateOnly("Pacific/Auckland"))).toMatch(
      /^\d{4}-\d{2}-\d{2}$/
    );
  });
});
