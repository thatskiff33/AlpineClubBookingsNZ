import { beforeEach, describe, expect, it, vi } from "vitest";
import { BookingStatus } from "@prisma/client";

import { requireClubTimeZone } from "@/lib/club-time";
import { withTimeZoneAsync } from "@/lib/__tests__/helpers/timezone";

/**
 * The CLUB's zone, supplied explicitly (CT-5, #2869). It used to default to
 * `APP_TIME_ZONE` — `process.env.TZ` — so this export's `created_date` column
 * moved by a day when the container moved region.
 */
const CLUB_ZONE = requireClubTimeZone("Pacific/Auckland");

const { mockFindMany } = vi.hoisted(() => ({
  mockFindMany: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: {
      findMany: mockFindMany,
    },
  },
}));

import { getLegacyDashboardBookingExport } from "@/lib/finance-legacy-dashboard-export";

describe("finance legacy dashboard export", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindMany.mockResolvedValue([
      {
        id: "booking-realized",
        checkIn: new Date("2026-04-08T00:00:00.000Z"),
        checkOut: new Date("2026-04-12T00:00:00.000Z"),
        status: BookingStatus.PAID,
        finalPriceCents: 40000,
        createdAt: new Date("2026-03-20T00:00:00.000Z"),
        guests: [{ id: "guest-1" }, { id: "guest-2" }],
      },
      {
        id: "booking-forward",
        checkIn: new Date("2026-05-01T00:00:00.000Z"),
        checkOut: new Date("2026-05-03T00:00:00.000Z"),
        status: BookingStatus.PENDING,
        finalPriceCents: 10000,
        createdAt: new Date("2026-04-01T00:00:00.000Z"),
        guests: [{ id: "guest-3" }],
      },
    ]);
  });

  it("exports realized and forward booking rows without member PII", async () => {
    const result = await getLegacyDashboardBookingExport({
      historyStartDate: "2026-04-01",
      asOfDate: "2026-04-10",
      clubTimeZone: CLUB_ZONE,
    });

    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({
          id: true,
          guests: { select: { id: true } },
        }),
      })
    );
    expect(mockFindMany.mock.calls[0][0].select).not.toHaveProperty("member");
    expect(result.bookings).toEqual([
      {
        booking_id: "booking-realized",
        start_date: "2026-04-08",
        end_date: "2026-04-11",
        created_date: "2026-03-20",
        status: BookingStatus.PAID,
        guests: 2,
        nights: 3,
        guest_nights: 6,
        total: 300,
      },
    ]);
    expect(result.forward_bookings).toEqual([
      {
        booking_id: "booking-realized",
        start_date: "2026-04-11",
        end_date: "2026-04-12",
        created_date: "2026-03-20",
        status: BookingStatus.PAID,
        guests: 2,
        nights: 1,
        guest_nights: 2,
        total: 100,
        pipeline_bucket: "COMMITTED",
        days_until_arrival: 0,
        month_of_stay: "2026-04",
      },
      {
        booking_id: "booking-forward",
        start_date: "2026-05-01",
        end_date: "2026-05-03",
        created_date: "2026-04-01",
        status: BookingStatus.PENDING,
        guests: 1,
        nights: 2,
        guest_nights: 2,
        total: 100,
        pipeline_bucket: "AT_RISK",
        days_until_arrival: 21,
        month_of_stay: "2026-05",
      },
    ]);
  });

  it("reports created_date on the club calendar, not the UTC day (#2697)", async () => {
    // No `APP_TIME_ZONE` premise any more, and that is the point of CT-5: the
    // zone is an ARGUMENT, so this case holds whatever `TZ` the runner carries.

    // 2026-04-08 00:00 in Pacific/Auckland — the first instant of the club day,
    // while UTC is still on the 7th. Deliberately the START of the club day
    // rather than a comfortable mid-morning time: an instant at 09:30 NZ passes
    // under any zone from about UTC+10 up, so it would not pin the offset.
    // `createdAt` is a `DateTime` instant, unlike start_date/end_date, which are
    // `@db.Date` lodge nights.
    const createdAt = new Date("2026-04-07T12:00:00.000Z");
    expect(createdAt.toISOString().slice(0, 10)).toBe("2026-04-07");

    mockFindMany.mockResolvedValue([
      {
        id: "booking-nz-morning",
        checkIn: new Date("2026-04-08T00:00:00.000Z"),
        checkOut: new Date("2026-04-10T00:00:00.000Z"),
        status: BookingStatus.PAID,
        finalPriceCents: 20000,
        createdAt,
        guests: [{ id: "guest-1" }],
      },
    ]);

    const result = await getLegacyDashboardBookingExport({
      historyStartDate: "2026-04-01",
      asOfDate: "2026-04-10",
      clubTimeZone: CLUB_ZONE,
    });

    expect(result.bookings[0].created_date).toBe("2026-04-08");
    // The lodge nights are date-only and must be untouched by the fix.
    expect(result.bookings[0].start_date).toBe("2026-04-08");
    expect(result.bookings[0].end_date).toBe("2026-04-10");
  });

  it("keeps the club's calendar day whatever zone the container runs in", async () => {
    /*
      THE #2869 s4 REQUIREMENT, stated almost verbatim in the issue: a report's
      date column must not change because the report was generated on a server
      in another region. Before this the column came from
      `formatDateOnlyForTimeZone(createdAt)`, which defaults to `APP_TIME_ZONE`
      — `process.env.TZ` — so a container moved to Denver reported 7 April for a
      booking the club made on the 8th.

      The host zones are pinned through PowerShell-safe `withTimeZone`, and the
      instant is the first of the club day so that any host west of NZ disagrees.
    */
    mockFindMany.mockResolvedValue([
      {
        id: "booking-nz-morning",
        checkIn: new Date("2026-04-08T00:00:00.000Z"),
        checkOut: new Date("2026-04-10T00:00:00.000Z"),
        status: BookingStatus.PAID,
        finalPriceCents: 20000,
        createdAt: new Date("2026-04-07T12:00:00.000Z"),
        guests: [{ id: "guest-1" }],
      },
    ]);

    for (const hostZone of ["UTC", "America/Denver", "Pacific/Auckland"]) {
      const created = await withTimeZoneAsync(hostZone, async () => {
        const result = await getLegacyDashboardBookingExport({
          historyStartDate: "2026-04-01",
          asOfDate: "2026-04-10",
          clubTimeZone: CLUB_ZONE,
        });
        return result.bookings[0]?.created_date;
      });
      expect(created, `host zone ${hostZone}`).toBe("2026-04-08");
    }
  });

  it("rejects malformed export dates before querying", async () => {
    await expect(
      getLegacyDashboardBookingExport({
        historyStartDate: "04-01-2026",
        asOfDate: "2026-04-10",
        clubTimeZone: CLUB_ZONE,
      })
    ).rejects.toThrow("historyStartDate must use YYYY-MM-DD");
    expect(mockFindMany).not.toHaveBeenCalled();
  });
});
