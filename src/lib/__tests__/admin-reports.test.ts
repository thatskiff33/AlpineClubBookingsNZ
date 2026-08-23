import { describe, expect, it } from "vitest";
import { addDays } from "date-fns";
import { BookingStatus, PaymentStatus } from "@prisma/client";
import fc from "fast-check";
import { withTimeZone } from "@/lib/__tests__/helpers/timezone";
import {
  buildBookingTrendSeries,
  buildRevenueSeries,
  getBookingRevenueByNight,
  getRevenueGranularity,
  summarizeNetCollectedCash,
  summarizeOverlappingGuests,
  type RevenueBookingLike,
} from "@/lib/admin-reports";

const EXPECTED_REPORT_STATUS_VALUES = [
  "PENDING",
  "PAYMENT_PENDING",
  "CONFIRMED",
  "PAID",
  "AWAITING_REVIEW",
  "COMPLETED",
] as const;

const EXPECTED_EXCLUDED_REPORT_STATUS_VALUES = [
  "DRAFT",
  "WAITLISTED",
  "WAITLIST_OFFERED",
  "CANCELLED",
  "BUMPED",
] as const;

const date = (value: string) => new Date(`${value}T00:00:00.000Z`);

function booking(
  overrides: Partial<RevenueBookingLike> = {},
): RevenueBookingLike {
  return {
    id: "booking-1",
    checkIn: date("2026-04-07"),
    checkOut: date("2026-04-10"),
    finalPriceCents: 100,
    status: BookingStatus.PAID,
    guests: [],
    ...overrides,
  };
}

describe("admin reports helpers", () => {
  it("chooses daily, weekly, and monthly granularity at the boundaries", () => {
    const start = date("2026-04-01");
    expect(getRevenueGranularity(start, addDays(start, 13))).toBe("daily");
    expect(getRevenueGranularity(start, addDays(start, 14))).toBe("weekly");
    expect(getRevenueGranularity(start, addDays(start, 89))).toBe("weekly");
    expect(getRevenueGranularity(start, addDays(start, 90))).toBe("monthly");
  });

  it("allocates 100 cents across three leap-day stay nights as 34/33/33", () => {
    const row = booking({
      checkIn: date("2028-02-28"),
      checkOut: date("2028-03-02"),
    });
    expect(getBookingRevenueByNight(row, date("2028-02-28"), date("2028-03-01"))).toEqual([
      { date: "2028-02-28", revenueCents: 34 },
      { date: "2028-02-29", revenueCents: 33 },
      { date: "2028-03-01", revenueCents: 33 },
    ]);
  });

  it("assigns the remainder before slicing when the first night is outside the report", () => {
    const row = booking();
    expect(getBookingRevenueByNight(row, date("2026-04-08"), date("2026-04-08"))).toEqual([
      { date: "2026-04-08", revenueCents: 33 },
    ]);
  });

  it("preserves every integer cent across the full stay (property)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10_000_000 }),
        fc.integer({ min: 1, max: 60 }),
        (totalCents, nights) => {
          const checkIn = date("2026-01-01");
          const checkOut = addDays(checkIn, nights);
          const allocations = getBookingRevenueByNight(
            booking({ checkIn, checkOut, finalPriceCents: totalCents }),
            checkIn,
            addDays(checkOut, -1),
          );
          expect(allocations).toHaveLength(nights);
          expect(allocations.reduce((sum, value) => sum + value.revenueCents, 0)).toBe(
            totalCents,
          );
          expect(
            Math.max(...allocations.map((value) => value.revenueCents)) -
              Math.min(...allocations.map((value) => value.revenueCents)),
          ).toBeLessThanOrEqual(1);
        },
      ),
    );
  });

  it("counts each booking once per overlapped bucket while summing nightly revenue", () => {
    const result = buildRevenueSeries(
      [booking({ finalPriceCents: 300 }), booking({ id: "booking-2", finalPriceCents: 600 })],
      date("2026-04-01"),
      date("2026-04-14"),
    );
    expect(result.granularity).toBe("daily");
    expect(result.data).toHaveLength(14);
    expect(result.data[6]).toMatchObject({
      periodStart: "2026-04-07",
      label: "Tue 7 Apr",
      revenueCents: 300,
      bookingCount: 2,
    });
  });

  it("does not count a multi-night booking more than once in a weekly bucket", () => {
    const result = buildRevenueSeries(
      [booking({ finalPriceCents: 300 })],
      date("2026-04-01"),
      date("2026-04-14"),
    );
    expect(result.granularity).toBe("daily");

    const weekly = buildRevenueSeries(
      [booking({ finalPriceCents: 300 })],
      date("2026-04-01"),
      date("2026-04-15"),
    );
    expect(weekly.granularity).toBe("weekly");
    expect(weekly.data.find((bucket) => bucket.periodStart === "2026-04-06")).toMatchObject({
      revenueCents: 300,
      bookingCount: 1,
    });
  });

  it("allocates a 100-cent cross-month stay before monthly bucketing", () => {
    const row = booking({
      checkIn: date("2026-04-30"),
      checkOut: date("2026-05-03"),
      finalPriceCents: 100,
    });

    expect(
      getBookingRevenueByNight(row, date("2026-04-30"), date("2026-05-02")),
    ).toEqual([
      { date: "2026-04-30", revenueCents: 34 },
      { date: "2026-05-01", revenueCents: 33 },
      { date: "2026-05-02", revenueCents: 33 },
    ]);

    const result = buildRevenueSeries(
      [row],
      date("2026-02-01"),
      date("2026-05-02"),
    );
    expect(result.granularity).toBe("monthly");
    expect(result.data.find((bucket) => bucket.periodStart === "2026-04-01")).toMatchObject({
      revenueCents: 34,
      bookingCount: 1,
    });
    expect(result.data.find((bucket) => bucket.periodStart === "2026-05-01")).toMatchObject({
      revenueCents: 66,
      bookingCount: 1,
    });
    expect(result.data.reduce((sum, bucket) => sum + bucket.revenueCents, 0)).toBe(100);
  });

  it("excludes the exhaustive literal non-report status list", () => {
    expect(Object.values(BookingStatus).sort()).toEqual(
      [...EXPECTED_REPORT_STATUS_VALUES, ...EXPECTED_EXCLUDED_REPORT_STATUS_VALUES].sort(),
    );
    const result = buildRevenueSeries(
      [
        ...EXPECTED_EXCLUDED_REPORT_STATUS_VALUES.map((status, index) =>
          booking({
            id: `excluded-${status}`,
            status: status as BookingStatus,
            finalPriceCents: 5_000 + index,
          }),
        ),
        booking({ id: "paid", status: BookingStatus.PAID, finalPriceCents: 300 }),
      ],
      date("2026-04-01"),
      date("2026-04-14"),
    );
    expect(result.data.reduce((sum, bucket) => sum + bucket.revenueCents, 0)).toBe(300);
  });

  it("counts a spanning booking once in each overlapped week with its current status", () => {
    const trends = buildBookingTrendSeries(
      [booking({ checkIn: date("2026-04-12"), checkOut: date("2026-04-15") })],
      date("2026-04-10"),
      date("2026-04-25"),
    );
    expect(trends.map(({ week, total, paid }) => ({ week, total, paid }))).toEqual([
      { week: "2026-04-06", total: 1, paid: 1 },
      { week: "2026-04-13", total: 1, paid: 1 },
      { week: "2026-04-20", total: 0, paid: 0 },
    ]);
  });

  it("counts distinct guest rows by their own half-open envelope despite sparse night rows", () => {
    const result = summarizeOverlappingGuests(
      [
        booking({
          guests: [
            {
              id: "member-guest",
              isMember: true,
              stayStart: date("2026-04-07"),
              stayEnd: date("2026-04-10"),
            },
            {
              id: "sparse-guest",
              isMember: false,
              stayStart: date("2026-04-07"),
              stayEnd: date("2026-04-10"),
              nights: [{ stayDate: date("2026-04-07") }, { stayDate: date("2026-04-09") }],
            },
            {
              id: "departed-guest",
              isMember: false,
              stayStart: date("2026-04-07"),
              stayEnd: date("2026-04-08"),
            },
            {
              id: "arriving-after-selection",
              isMember: false,
              stayStart: date("2026-04-09"),
              stayEnd: date("2026-04-10"),
            },
          ],
        }),
      ],
      date("2026-04-08"),
      date("2026-04-08"),
    );
    // Reports counts guest rows, not guest-nights. Both envelopes overlap the
    // selected night even though one guest has a gap in its sparse night rows.
    expect(result).toEqual({ totalGuests: 2, memberGuests: 1, nonMemberGuests: 1 });
  });

  it("derives net collected cash from payment aggregates without double-counting additions", () => {
    expect(
      summarizeNetCollectedCash([
        {
          status: PaymentStatus.PARTIALLY_REFUNDED,
          amountCents: 12_100,
          refundedAmountCents: 1_000,
        },
        {
          status: PaymentStatus.PENDING,
          amountCents: 9_000,
          refundedAmountCents: 0,
        },
      ]),
    ).toBe(11_100);
  });
});

/*
  CT-4 (#2870), epic #2988 -- the overlapping-guest count is calendar-day
  arithmetic, so no zone may reach it.

  `BookingGuest.stayStart`/`stayEnd` and `Booking.checkIn`/`checkOut` are
  `@db.Date`, and `src/app/api/admin/reports/route.ts` hands the window in the
  same encoding, so all four sides of the overlap test are UTC-midnight
  encodings of a day (INV-DATE-010).

  BOTH SIDES USED TO BE ZONE-DEPENDENT, IN TWO DIFFERENT ZONES. The guest keys
  went through `formatDateOnlyForTimeZone`, which reads `APP_TIME_ZONE`; the
  range keys went through date-fns `format`, which reads the HOST's zone. Both
  are the identity for a zone at or ahead of UTC, so New Zealand never saw it,
  and the two agreeing is what made the whole thing look correct rather than
  merely lucky.

  Measured on the fixture below with the host moved behind UTC and the
  environment left at Pacific/Auckland -- which is a real deployment shape, not
  a contrivance: a container that sets `NEXT_PUBLIC_TZ` but not `TZ` -- the old
  code returned ZERO guests where there is one. The guest holds the only night
  in the window, and the range keys slid back a day while the guest keys did
  not.

  This test therefore does the one thing the property allows: it asks the same
  question from three different host zones, one behind UTC, one at it and one
  ahead, and requires the same answer from all three. It is also why fixing only
  the guest half would have been a regression rather than a fix -- that would
  break the mirror image, a self-consistent host and club both behind UTC, which
  the old code got right by accident.
*/
describe("summarizeOverlappingGuests is host-timezone independent (CT-4, #2870)", () => {
  function countOneNightGuest() {
    return summarizeOverlappingGuests(
      [
        booking({
          checkIn: date("2026-04-08"),
          checkOut: date("2026-04-09"),
          guests: [
            {
              id: "one-night-guest",
              isMember: true,
              stayStart: date("2026-04-08"),
              stayEnd: date("2026-04-09"),
            },
          ],
        }),
      ],
      date("2026-04-08"),
      date("2026-04-08"),
    ).totalGuests;
  }

  it.each(["America/Denver", "UTC", "Pacific/Auckland"])(
    "counts the guest holding the only night in the window, on a host in %s",
    (hostZone) => {
      // `stayEnd` is half-open -- a departure morning (INV-DATE-003) -- so this
      // guest holds exactly the night of the 8th, which is the whole window.
      expect(withTimeZone(hostZone, countOneNightGuest)).toBe(1);
    },
  );
});
