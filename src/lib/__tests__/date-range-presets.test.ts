import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  bookingFilterDateRangePresets,
  findMatchingDateRangePreset,
  getDateRangeForPreset,
  reportsDateRangePresets,
} from "@/lib/date-range-presets";

describe("date-range-presets", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-13T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("builds last month ranges for filters", () => {
    const preset = bookingFilterDateRangePresets.find(
      (option) => option.key === "last_month"
    );

    expect(preset).toBeDefined();
    expect(getDateRangeForPreset(preset!)).toEqual({
      from: "2026-03-01",
      to: "2026-03-31",
    });
  });

  it("builds next month ranges for booking filters", () => {
    const preset = bookingFilterDateRangePresets.find(
      (option) => option.key === "next_month"
    );

    expect(preset).toBeDefined();
    expect(getDateRangeForPreset(preset!)).toEqual({
      from: "2026-05-01",
      to: "2026-05-31",
    });
  });

  it("builds last year ranges for reports", () => {
    const preset = reportsDateRangePresets.find(
      (option) => option.key === "last_year"
    );

    expect(preset).toBeDefined();
    expect(getDateRangeForPreset(preset!)).toEqual({
      from: "2025-01-01",
      to: "2025-12-31",
    });
  });

  it("matches an exact preset range", () => {
    expect(
      findMatchingDateRangePreset(
        "2026-03-01",
        "2026-03-31",
        bookingFilterDateRangePresets
      )
    ).toBe("last_month");
  });

  it("returns null for custom ranges", () => {
    expect(
      findMatchingDateRangePreset(
        "2026-02-10",
        "2026-04-05",
        reportsDateRangePresets
      )
    ).toBeNull();
  });
});
