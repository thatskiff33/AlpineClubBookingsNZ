import { describe, expect, it } from "vitest";
import {
  addUtcDays,
  allocateCentsEvenly,
  buildIsoDateRange,
  getFinanceBookingMetricsWindowDayCount,
  parseFinanceBookingMetricDate,
} from "@/lib/finance-booking-metric-calculations";

describe("finance booking metric calculations", () => {
  it("counts inclusive NZ date-only metric windows", () => {
    expect(
      getFinanceBookingMetricsWindowDayCount("2026-04-01", "2026-04-01")
    ).toBe(1);
    expect(
      getFinanceBookingMetricsWindowDayCount("2026-04-30", "2026-05-02")
    ).toBe(3);
  });

  it("rejects invalid and reversed date-only metric windows", () => {
    expect(() =>
      getFinanceBookingMetricsWindowDayCount("2026-02-31", "2026-03-01")
    ).toThrow("from must be a real calendar day as YYYY-MM-DD");
    expect(() =>
      getFinanceBookingMetricsWindowDayCount("2026-05-02", "2026-04-30")
    ).toThrow("to must be on or after from");
  });

  it("builds inclusive ISO date ranges across month boundaries", () => {
    const start = parseFinanceBookingMetricDate("2026-04-30", "start");
    const end = addUtcDays(start, 2);

    expect(buildIsoDateRange(start, end)).toEqual([
      "2026-04-30",
      "2026-05-01",
      "2026-05-02",
    ]);
  });

  it("allocates integer cents without losing totals", () => {
    expect(allocateCentsEvenly(100, 3)).toEqual([34, 33, 33]);
    expect(allocateCentsEvenly(101, 4)).toEqual([26, 25, 25, 25]);
    expect(allocateCentsEvenly(100, 0)).toEqual([]);
  });
});
