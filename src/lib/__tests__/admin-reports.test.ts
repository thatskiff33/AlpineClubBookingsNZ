import { describe, expect, it } from "vitest";
import { addDays } from "date-fns";
import { BookingStatus } from "@prisma/client";
import { buildRevenueSeries, getRevenueGranularity } from "@/lib/admin-reports";

describe("admin reports helpers", () => {
  it("uses daily granularity for date ranges up to 14 days", () => {
    expect(
      getRevenueGranularity(new Date("2026-04-01T00:00:00"), new Date("2026-04-14T00:00:00"))
    ).toBe("daily");
  });

  it("uses weekly granularity for date ranges from 15 to 90 days", () => {
    const start = new Date("2026-04-01T00:00:00");
    expect(getRevenueGranularity(start, addDays(start, 14))).toBe("weekly");
    expect(getRevenueGranularity(start, addDays(start, 89))).toBe("weekly");
  });

  it("uses monthly granularity for date ranges longer than 90 days", () => {
    const start = new Date("2026-04-01T00:00:00");
    expect(getRevenueGranularity(start, addDays(start, 90))).toBe("monthly");
  });

  it("builds daily revenue buckets with daily labels", () => {
    const result = buildRevenueSeries(
      [
        {
          createdAt: new Date("2026-04-07T10:00:00"),
          finalPriceCents: 12500,
          status: BookingStatus.PAID,
        },
      ],
      new Date("2026-04-01T00:00:00"),
      new Date("2026-04-14T00:00:00")
    );

    expect(result.granularity).toBe("daily");
    expect(result.data).toHaveLength(14);
    expect(result.data[6]).toMatchObject({
      periodStart: "2026-04-07",
      label: "Tue 7 Apr",
      tooltipLabel: "Tuesday 7 April 2026",
      revenueCents: 12500,
      bookingCount: 1,
    });
  });

  it("builds weekly revenue buckets keyed to Monday", () => {
    const result = buildRevenueSeries(
      [
        {
          createdAt: new Date("2026-04-10T09:00:00"),
          finalPriceCents: 5000,
          status: BookingStatus.CONFIRMED,
        },
        {
          createdAt: new Date("2026-04-18T09:00:00"),
          finalPriceCents: 7500,
          status: BookingStatus.PAID,
        },
      ],
      new Date("2026-04-10T00:00:00"),
      new Date("2026-04-25T00:00:00")
    );

    expect(result.granularity).toBe("weekly");
    expect(result.data.map((entry) => entry.label)).toEqual([
      "Week of 6 Apr",
      "Week of 13 Apr",
      "Week of 20 Apr",
    ]);
    expect(result.data[0].revenueCents).toBe(5000);
    expect(result.data[1].revenueCents).toBe(7500);
    expect(result.data[2].revenueCents).toBe(0);
  });

  it("keeps monthly buckets and skips cancelled revenue", () => {
    const result = buildRevenueSeries(
      [
        {
          createdAt: new Date("2026-04-05T10:00:00"),
          finalPriceCents: 10000,
          status: BookingStatus.PAID,
        },
        {
          createdAt: new Date("2026-05-02T10:00:00"),
          finalPriceCents: 25000,
          status: BookingStatus.CANCELLED,
        },
        {
          createdAt: new Date("2026-07-03T10:00:00"),
          finalPriceCents: 30000,
          status: BookingStatus.CONFIRMED,
        },
      ],
      new Date("2026-04-01T00:00:00"),
      new Date("2026-07-15T00:00:00")
    );

    expect(result.granularity).toBe("monthly");
    expect(result.data.map((entry) => entry.label)).toEqual([
      "Apr 2026",
      "May 2026",
      "Jun 2026",
      "Jul 2026",
    ]);
    expect(result.data[0].revenueCents).toBe(10000);
    expect(result.data[1].revenueCents).toBe(0);
    expect(result.data[3].revenueCents).toBe(30000);
  });
});
