import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BookingStatus,
  PaymentStatus,
  PaymentTransactionKind,
} from "@prisma/client";

const { mockPrisma, mockLogger } = vi.hoisted(() => ({
  mockPrisma: {
    booking: {
      findMany: vi.fn(),
    },
    // #1982 — the default lodge's capacity is a DB override (self-healed from
    // the config bed total), not a club.json runtime fallback. Return value set
    // in beforeEach so it stays LODGE_CAPACITY.
    lodgeSettings: {
      findUnique: vi.fn(),
    },
  },
  // #2408: the ledger-gap guard's alarm is part of its contract, so it is
  // asserted rather than swallowed.
  mockLogger: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/logger", () => ({ default: mockLogger }));

import { getFinanceBookingMetrics } from "@/lib/finance-booking-metrics";
import { FALLBACK_LODGE_CAPACITY as LODGE_CAPACITY } from "@/lib/lodge-capacity";

function availableBeds(occupiedBeds: number): number {
  return LODGE_CAPACITY - occupiedBeds;
}

/**
 * #2408: fixtures state the payment LEDGER, not just the summary columns,
 * because the guard reads the ledger. `Payment.amountCents` is the sum of the
 * captured rows below it — that is the invariant these tests are about.
 */
function primaryLedgerRow(
  amountCents: number,
  status: PaymentStatus = PaymentStatus.SUCCEEDED,
) {
  return { kind: PaymentTransactionKind.PRIMARY, status, amountCents };
}

function additionalLedgerRow(
  amountCents: number,
  status: PaymentStatus = PaymentStatus.SUCCEEDED,
) {
  return { kind: PaymentTransactionKind.ADDITIONAL, status, amountCents };
}

function occupancyRate(occupiedBedNights: number, dayCount = 1): number {
  const capacityBedNights = LODGE_CAPACITY * dayCount;
  return capacityBedNights > 0
    ? Number((occupiedBedNights / capacityBedNights).toFixed(4))
    : 0;
}

type FinanceFixtureBooking = {
  checkIn: Date;
  checkOut: Date;
  finalPriceCents: number;
  guests: Array<{
    id: string;
    stayStart?: Date | null;
    stayEnd?: Date | null;
  }>;
};

function allocate(totalCents: number, parts: number): number[] {
  const base = Math.floor(totalCents / parts);
  let remainder = totalCents - base * parts;
  return Array.from({ length: parts }, () => {
    if (remainder <= 0) return base;
    remainder -= 1;
    return base + 1;
  });
}

function fixtureNightDates(start: Date, end: Date): Date[] {
  const dates: Date[] = [];
  for (let cursor = start; cursor < end; cursor = new Date(cursor.getTime() + 86_400_000)) {
    dates.push(cursor);
  }
  return dates;
}

function withReconciledMoneyEvidence<T extends FinanceFixtureBooking>(rows: T[]): T[] {
  return rows.map((row) => {
    const guestTotals = allocate(row.finalPriceCents, row.guests.length);
    return {
      ...row,
      totalPriceCents: row.finalPriceCents,
      discountCents: 0,
      promoAdjustmentCents: 0,
      promoRedemption: null,
      nightAdjustments: [],
      guests: row.guests.map((guest, guestIndex) => {
        const nights = fixtureNightDates(
          guest.stayStart ?? row.checkIn,
          guest.stayEnd ?? row.checkOut,
        );
        const nightPrices = allocate(guestTotals[guestIndex] ?? 0, nights.length);
        return {
          ...guest,
          priceCents: guestTotals[guestIndex] ?? 0,
          stayStart: guest.stayStart ?? null,
          stayEnd: guest.stayEnd ?? null,
          nights: nights.map((stayDate, index) => ({
            stayDate,
            priceCents: nightPrices[index] ?? 0,
            priceSource: "SOLD" as const,
          })),
        };
      }),
    };
  });
}

function mockBookingRows<T extends FinanceFixtureBooking>(rows: T[]): void {
  mockPrisma.booking.findMany.mockResolvedValue(withReconciledMoneyEvidence(rows));
}

describe("finance-booking-metrics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.lodgeSettings.findUnique.mockResolvedValue({
      capacity: LODGE_CAPACITY,
    });
  });

  it("carries the complete booking-money trust summary beside finance figures", async () => {
    const checkIn = new Date("2026-08-01T00:00:00.000Z");
    const checkOut = new Date("2026-08-02T00:00:00.000Z");
    mockPrisma.booking.findMany.mockResolvedValue([
      {
        id: "booking-unreconciled",
        checkIn,
        checkOut,
        status: BookingStatus.PAID,
        totalPriceCents: 10_000,
        discountCents: 1,
        promoAdjustmentCents: 0,
        finalPriceCents: 9_999,
        guests: [
          {
            id: "guest-1",
            priceCents: 10_000,
            stayStart: null,
            stayEnd: null,
            nights: [
              {
                stayDate: checkIn,
                priceCents: 10_000,
                priceSource: "SOLD",
              },
            ],
          },
        ],
        promoRedemption: null,
        nightAdjustments: [],
        payment: null,
      },
    ]);

    const result = await getFinanceBookingMetrics({
      forward: { from: "2026-08-01", to: "2026-08-01", asOfDate: "2026-07-01" },
    });
    expect(result.moneyReconciliation).toMatchObject({
      totalBookings: 1,
      byState: { RECONCILED: 0, UNRECONCILED: 1 },
      byReason: {
        DISCOUNT_COMPONENT_MISMATCH: 1,
        FINAL_PRICE_RELATION_MISMATCH: 1,
      },
    });
  });

  it("derives realized stays, forward pipeline, and payment summaries from booking rows", async () => {
    mockBookingRows([
      {
        id: "booking-confirmed-split",
        checkIn: new Date("2026-04-20T00:00:00.000Z"),
        checkOut: new Date("2026-04-23T00:00:00.000Z"),
        status: BookingStatus.PAID,
        finalPriceCents: 30000,
        guests: [{ id: "g-1" }, { id: "g-2" }],
        payment: {
          status: PaymentStatus.SUCCEEDED,
          amountCents: 30000,
          refundedAmountCents: 0,
          changeFeeCents: 0,
          creditAppliedCents: 0,
          additionalAmountCents: 0,
          additionalPaymentStatus: null,
        },
      },
      {
        id: "booking-paid-realized",
        checkIn: new Date("2026-04-18T00:00:00.000Z"),
        checkOut: new Date("2026-04-20T00:00:00.000Z"),
        status: BookingStatus.PAID,
        finalPriceCents: 12000,
        guests: [{ id: "g-3" }],
        payment: {
          status: PaymentStatus.PARTIALLY_REFUNDED,
          amountCents: 12000,
          refundedAmountCents: 2000,
          changeFeeCents: 500,
          creditAppliedCents: 1000,
          additionalAmountCents: 0,
          additionalPaymentStatus: null,
        },
      },
      {
        id: "booking-completed-free",
        checkIn: new Date("2026-04-19T00:00:00.000Z"),
        checkOut: new Date("2026-04-20T00:00:00.000Z"),
        status: BookingStatus.COMPLETED,
        finalPriceCents: 0,
        guests: [{ id: "g-4" }, { id: "g-5" }, { id: "g-6" }],
        payment: null,
      },
      {
        id: "booking-pending-forward",
        checkIn: new Date("2026-04-22T00:00:00.000Z"),
        checkOut: new Date("2026-04-24T00:00:00.000Z"),
        status: BookingStatus.PENDING,
        finalPriceCents: 8000,
        guests: [{ id: "g-7" }],
        payment: {
          status: PaymentStatus.PENDING,
          amountCents: 8000,
          refundedAmountCents: 0,
          changeFeeCents: 0,
          creditAppliedCents: 0,
          additionalAmountCents: 0,
          additionalPaymentStatus: null,
        },
      },
      {
        id: "booking-waitlisted",
        checkIn: new Date("2026-04-22T00:00:00.000Z"),
        checkOut: new Date("2026-04-23T00:00:00.000Z"),
        status: BookingStatus.WAITLISTED,
        finalPriceCents: 7000,
        guests: [{ id: "g-8" }],
        payment: null,
      },
    ]);

    const metrics = await getFinanceBookingMetrics({
      realized: {
        from: "2026-04-18",
        to: "2026-04-22",
        cutoffDate: "2026-04-21",
      },
      forward: {
        from: "2026-04-20",
        to: "2026-04-24",
        asOfDate: "2026-04-21",
      },
    });

    expect(mockPrisma.booking.findMany).toHaveBeenCalledWith({
      where: {
        checkIn: { lte: new Date("2026-04-24T00:00:00.000Z") },
        checkOut: { gt: new Date("2026-04-18T00:00:00.000Z") },
        status: {
          in: [
            BookingStatus.PAID,
            BookingStatus.COMPLETED,
            BookingStatus.PENDING,
            BookingStatus.PAYMENT_PENDING,
            BookingStatus.CONFIRMED,
          ],
        },
      },
      orderBy: [{ checkIn: "asc" }, { id: "asc" }],
      select: expect.any(Object),
    });

    expect(metrics.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(metrics.bookingCount).toBe(4);
    expect(metrics.paymentSummary).toEqual({
      bookingCount: 4,
      bookingsWithPayment: 3,
      bookingsWithoutPayment: 1,
      paymentStatusBreakdown: {
        PENDING: 1,
        PROCESSING: 0,
        SUCCEEDED: 1,
        FAILED: 0,
        REFUNDED: 0,
        PARTIALLY_REFUNDED: 1,
        NONE: 1,
      },
      additionalPaymentStatusBreakdown: {
        PENDING: 0,
        SUCCEEDED: 0,
        FAILED: 0,
        NONE: 4,
      },
      capturedGrossCents: 42000,
      capturedAdditionalCents: 0,
      outstandingAdditionalCents: 0,
      outstandingAdditionalBookings: 0,
      additionalLedgerGapCents: 0,
      additionalLedgerGapBookings: 0,
      refundedCents: 2000,
      netCollectedCents: 40000,
      creditAppliedCents: 1000,
      changeFeeCents: 500,
    });
    expect(metrics.realized).toEqual({
      window: {
        from: "2026-04-18",
        to: "2026-04-22",
        cutoffDate: "2026-04-21",
        effectiveFrom: "2026-04-18",
        effectiveTo: "2026-04-21",
        dayCount: 4,
      },
      totals: {
        bookingCount: 3,
        bookingNights: 5,
        guestNights: 9,
        bookedRevenueCents: 32000,
        averageNightlyRevenueCents: 6400,
        occupancy: {
          occupiedBedNights: 9,
          capacityBedNights: 4 * LODGE_CAPACITY,
          occupancyRate: occupancyRate(9, 4),
        },
      },
      statusBreakdown: {
        PAID: {
          bookingCount: 2,
          bookingNights: 4,
          guestNights: 6,
          bookedRevenueCents: 32000,
        },
        COMPLETED: {
          bookingCount: 1,
          bookingNights: 1,
          guestNights: 3,
          bookedRevenueCents: 0,
        },
      },
      byDate: [
        {
          date: "2026-04-18",
          bookingCount: 1,
          guestNights: 1,
          occupiedBeds: 1,
          availableBeds: availableBeds(1),
          occupancyRate: occupancyRate(1),
          bookedRevenueCents: 6000,
        },
        {
          date: "2026-04-19",
          bookingCount: 2,
          guestNights: 4,
          occupiedBeds: 4,
          availableBeds: availableBeds(4),
          occupancyRate: occupancyRate(4),
          bookedRevenueCents: 6000,
        },
        {
          date: "2026-04-20",
          bookingCount: 1,
          guestNights: 2,
          occupiedBeds: 2,
          availableBeds: availableBeds(2),
          occupancyRate: occupancyRate(2),
          bookedRevenueCents: 10000,
        },
        {
          date: "2026-04-21",
          bookingCount: 1,
          guestNights: 2,
          occupiedBeds: 2,
          availableBeds: availableBeds(2),
          occupancyRate: occupancyRate(2),
          bookedRevenueCents: 10000,
        },
      ],
    });
    expect(metrics.forward).toEqual({
      window: {
        from: "2026-04-20",
        to: "2026-04-24",
        asOfDate: "2026-04-21",
        effectiveFrom: "2026-04-22",
        effectiveTo: "2026-04-24",
        dayCount: 3,
      },
      totals: {
        committed: {
          bookingCount: 1,
          bookingNights: 1,
          guestNights: 2,
          bookedRevenueCents: 10000,
          occupancy: {
            occupiedBedNights: 2,
            capacityBedNights: 3 * LODGE_CAPACITY,
            occupancyRate: occupancyRate(2, 3),
          },
          statusBreakdown: {
            PAID: {
              bookingCount: 1,
              bookingNights: 1,
              guestNights: 2,
              bookedRevenueCents: 10000,
            },
          },
        },
        atRisk: {
          bookingCount: 1,
          bookingNights: 2,
          guestNights: 2,
          bookedRevenueCents: 8000,
          occupancy: {
            occupiedBedNights: 2,
            capacityBedNights: 3 * LODGE_CAPACITY,
            occupancyRate: occupancyRate(2, 3),
          },
          statusBreakdown: {
            PENDING: {
              bookingCount: 1,
              bookingNights: 2,
              guestNights: 2,
              bookedRevenueCents: 8000,
            },
            PAYMENT_PENDING: {
              bookingCount: 0,
              bookingNights: 0,
              guestNights: 0,
              bookedRevenueCents: 0,
            },
            CONFIRMED: {
              bookingCount: 0,
              bookingNights: 0,
              guestNights: 0,
              bookedRevenueCents: 0,
            },
          },
        },
        totalPipeline: {
          bookingCount: 2,
          bookingNights: 3,
          guestNights: 4,
          bookedRevenueCents: 18000,
          occupancy: {
            occupiedBedNights: 4,
            capacityBedNights: 3 * LODGE_CAPACITY,
            occupancyRate: occupancyRate(4, 3),
          },
        },
      },
      byDate: [
        {
          date: "2026-04-22",
          committed: {
            date: "2026-04-22",
            bookingCount: 1,
            guestNights: 2,
            occupiedBeds: 2,
            availableBeds: availableBeds(2),
            occupancyRate: occupancyRate(2),
            bookedRevenueCents: 10000,
          },
          atRisk: {
            date: "2026-04-22",
            bookingCount: 1,
            guestNights: 1,
            occupiedBeds: 1,
            availableBeds: availableBeds(1),
            occupancyRate: occupancyRate(1),
            bookedRevenueCents: 4000,
          },
          totalPipeline: {
            date: "2026-04-22",
            bookingCount: 2,
            guestNights: 3,
            occupiedBeds: 3,
            availableBeds: availableBeds(3),
            occupancyRate: occupancyRate(3),
            bookedRevenueCents: 14000,
          },
        },
        {
          date: "2026-04-23",
          committed: {
            date: "2026-04-23",
            bookingCount: 0,
            guestNights: 0,
            occupiedBeds: 0,
            availableBeds: availableBeds(0),
            occupancyRate: 0,
            bookedRevenueCents: 0,
          },
          atRisk: {
            date: "2026-04-23",
            bookingCount: 1,
            guestNights: 1,
            occupiedBeds: 1,
            availableBeds: availableBeds(1),
            occupancyRate: occupancyRate(1),
            bookedRevenueCents: 4000,
          },
          totalPipeline: {
            date: "2026-04-23",
            bookingCount: 1,
            guestNights: 1,
            occupiedBeds: 1,
            availableBeds: availableBeds(1),
            occupancyRate: occupancyRate(1),
            bookedRevenueCents: 4000,
          },
        },
        {
          date: "2026-04-24",
          committed: {
            date: "2026-04-24",
            bookingCount: 0,
            guestNights: 0,
            occupiedBeds: 0,
            availableBeds: availableBeds(0),
            occupancyRate: 0,
            bookedRevenueCents: 0,
          },
          atRisk: {
            date: "2026-04-24",
            bookingCount: 0,
            guestNights: 0,
            occupiedBeds: 0,
            availableBeds: availableBeds(0),
            occupancyRate: 0,
            bookedRevenueCents: 0,
          },
          totalPipeline: {
            date: "2026-04-24",
            bookingCount: 0,
            guestNights: 0,
            occupiedBeds: 0,
            availableBeds: availableBeds(0),
            occupancyRate: 0,
            bookedRevenueCents: 0,
          },
        },
      ],
    });
  });

  it("uses guest stay ranges for finance guest-night occupancy", async () => {
    mockBookingRows([
      {
        id: "booking-with-cut-short-guest",
        checkIn: new Date("2026-04-10T00:00:00.000Z"),
        checkOut: new Date("2026-04-15T00:00:00.000Z"),
        status: BookingStatus.PAID,
        finalPriceCents: 50000,
        guests: [
          {
            id: "guest-full",
            stayStart: new Date("2026-04-10T00:00:00.000Z"),
            stayEnd: new Date("2026-04-15T00:00:00.000Z"),
          },
          {
            id: "guest-cut-short",
            stayStart: new Date("2026-04-10T00:00:00.000Z"),
            stayEnd: new Date("2026-04-13T00:00:00.000Z"),
          },
        ],
        payment: null,
      },
    ]);

    const metrics = await getFinanceBookingMetrics({
      realized: {
        from: "2026-04-10",
        to: "2026-04-14",
        cutoffDate: "2026-04-14",
      },
    });

    expect(metrics.realized?.totals).toMatchObject({
      bookingCount: 1,
      bookingNights: 5,
      guestNights: 8,
      bookedRevenueCents: 50000,
    });
    expect(
      metrics.realized?.byDate.map((row) => ({
        date: row.date,
        guestNights: row.guestNights,
        occupiedBeds: row.occupiedBeds,
      }))
    ).toEqual([
      { date: "2026-04-10", guestNights: 2, occupiedBeds: 2 },
      { date: "2026-04-11", guestNights: 2, occupiedBeds: 2 },
      { date: "2026-04-12", guestNights: 2, occupiedBeds: 2 },
      { date: "2026-04-13", guestNights: 1, occupiedBeds: 1 },
      { date: "2026-04-14", guestNights: 1, occupiedBeds: 1 },
    ]);
  });

  /*
    #2350: the additional-payment status split was already computed here, but
    nothing totalled the MONEY behind it, so no finance surface could say how
    much of the booked revenue had never arrived.
  */
  it("totals uncollected additional payments, counting FAILED with PENDING", async () => {
    mockBookingRows([
      {
        id: "booking-pending-extra",
        checkIn: new Date("2026-04-10T00:00:00.000Z"),
        checkOut: new Date("2026-04-11T00:00:00.000Z"),
        status: BookingStatus.PAID,
        finalPriceCents: 30_000,
        guests: [{ id: "g-1" }],
        payment: {
          status: PaymentStatus.SUCCEEDED,
          amountCents: 9_000,
          refundedAmountCents: 0,
          creditAppliedCents: 0,
          changeFeeCents: 0,
          additionalAmountCents: 21_000,
          additionalPaymentStatus: "PENDING",
          transactions: [
            primaryLedgerRow(9_000),
            additionalLedgerRow(21_000, PaymentStatus.PENDING),
          ],
        },
      },
      {
        id: "booking-failed-extra",
        checkIn: new Date("2026-04-10T00:00:00.000Z"),
        checkOut: new Date("2026-04-11T00:00:00.000Z"),
        status: BookingStatus.PAID,
        finalPriceCents: 10_000,
        guests: [{ id: "g-2" }],
        payment: {
          status: PaymentStatus.SUCCEEDED,
          amountCents: 6_000,
          refundedAmountCents: 0,
          creditAppliedCents: 0,
          changeFeeCents: 0,
          additionalAmountCents: 4_000,
          additionalPaymentStatus: "FAILED",
          transactions: [
            primaryLedgerRow(6_000),
            additionalLedgerRow(4_000, PaymentStatus.FAILED),
          ],
        },
      },
      {
        // Gross capture: an $11,000 booking whose $9,000 increase was collected
        // carries amountCents = 20,000, both ledger rows captured.
        id: "booking-collected-extra",
        checkIn: new Date("2026-04-10T00:00:00.000Z"),
        checkOut: new Date("2026-04-11T00:00:00.000Z"),
        status: BookingStatus.PAID,
        finalPriceCents: 20_000,
        guests: [{ id: "g-3" }],
        payment: {
          status: PaymentStatus.SUCCEEDED,
          amountCents: 20_000,
          refundedAmountCents: 0,
          creditAppliedCents: 0,
          changeFeeCents: 0,
          additionalAmountCents: 9_000,
          additionalPaymentStatus: "SUCCEEDED",
          transactions: [
            primaryLedgerRow(11_000),
            additionalLedgerRow(9_000),
          ],
        },
      },
    ]);

    const metrics = await getFinanceBookingMetrics({
      realized: { from: "2026-04-10", to: "2026-04-11" },
    });

    expect(metrics.paymentSummary.outstandingAdditionalCents).toBe(25_000);
    expect(metrics.paymentSummary.outstandingAdditionalBookings).toBe(2);
    // A collected extra stays in the captured column and out of the shortfall.
    expect(metrics.paymentSummary.capturedAdditionalCents).toBe(9_000);
    // #2408: and it is counted ONCE. The gross figure already contains it, so
    // the net is 9,000 + 6,000 + 20,000 — not 44,000.
    expect(metrics.paymentSummary.capturedGrossCents).toBe(35_000);
    expect(metrics.paymentSummary.netCollectedCents).toBe(35_000);
    expect(metrics.paymentSummary.additionalLedgerGapCents).toBe(0);
  });

  /*
    #2408. The bug, stated as the arithmetic a treasurer would do: a booking
    that grew from $100 to $121 and had the $21 collected shows $121 of cash,
    because `reconcilePaymentAggregates` already put the $21 inside
    `Payment.amountCents`. Adding the additional column back on top reported
    $142 — money the club never took.
  */
  it("counts a collected price increase once, not twice", async () => {
    mockBookingRows([
      {
        id: "booking-grew-and-paid",
        checkIn: new Date("2026-04-10T00:00:00.000Z"),
        checkOut: new Date("2026-04-11T00:00:00.000Z"),
        status: BookingStatus.PAID,
        finalPriceCents: 12_100,
        guests: [{ id: "g-1" }],
        payment: {
          status: PaymentStatus.SUCCEEDED,
          amountCents: 12_100,
          refundedAmountCents: 0,
          creditAppliedCents: 0,
          changeFeeCents: 0,
          additionalAmountCents: 2_100,
          additionalPaymentStatus: "SUCCEEDED",
          transactions: [
            primaryLedgerRow(10_000),
            additionalLedgerRow(2_100),
          ],
        },
      },
    ]);

    const metrics = await getFinanceBookingMetrics({
      realized: { from: "2026-04-10", to: "2026-04-11" },
    });

    expect(metrics.paymentSummary.netCollectedCents).toBe(12_100);
    expect(metrics.paymentSummary.capturedGrossCents).toBe(12_100);
    expect(metrics.paymentSummary.capturedAdditionalCents).toBe(2_100);
    expect(metrics.paymentSummary.outstandingAdditionalCents).toBe(0);
    expect(metrics.paymentSummary.additionalLedgerGapCents).toBe(0);
    expect(metrics.paymentSummary.additionalLedgerGapBookings).toBe(0);
  });

  /*
    #2408, the cases either side of the double count. Neither ever had the bug,
    and neither may move because of the fix: a booking that never grew, and one
    that grew but whose extra is still owed (#2397's "not covered" cash
    settlement writes exactly this shape - $100 recorded, $21 left owing).
  */
  it("leaves an unchanged booking and a still-owed increase counted once each", async () => {
    mockBookingRows([
      {
        id: "booking-never-grew",
        checkIn: new Date("2026-04-10T00:00:00.000Z"),
        checkOut: new Date("2026-04-11T00:00:00.000Z"),
        status: BookingStatus.PAID,
        finalPriceCents: 10_000,
        guests: [{ id: "g-1" }],
        payment: {
          status: PaymentStatus.SUCCEEDED,
          amountCents: 10_000,
          refundedAmountCents: 0,
          creditAppliedCents: 0,
          changeFeeCents: 0,
          additionalAmountCents: 0,
          additionalPaymentStatus: null,
          transactions: [primaryLedgerRow(10_000)],
        },
      },
      {
        id: "booking-grew-still-owing",
        checkIn: new Date("2026-04-10T00:00:00.000Z"),
        checkOut: new Date("2026-04-11T00:00:00.000Z"),
        status: BookingStatus.PAID,
        finalPriceCents: 12_100,
        guests: [{ id: "g-2" }],
        payment: {
          status: PaymentStatus.SUCCEEDED,
          amountCents: 10_000,
          refundedAmountCents: 0,
          creditAppliedCents: 0,
          changeFeeCents: 0,
          additionalAmountCents: 2_100,
          additionalPaymentStatus: "PENDING",
          transactions: [
            primaryLedgerRow(10_000),
            additionalLedgerRow(2_100, PaymentStatus.PENDING),
          ],
        },
      },
    ]);

    const metrics = await getFinanceBookingMetrics({
      realized: { from: "2026-04-10", to: "2026-04-11" },
    });

    expect(metrics.paymentSummary.netCollectedCents).toBe(20_000);
    expect(metrics.paymentSummary.capturedAdditionalCents).toBe(0);
    // Owed, not collected: reported beside the cash, never inside it.
    expect(metrics.paymentSummary.outstandingAdditionalCents).toBe(2_100);
    // An uncollected increase is NOT the guarded shape - it is absent from the
    // captured total on purpose, so nothing is missing and nothing alarms.
    expect(metrics.paymentSummary.additionalLedgerGapBookings).toBe(0);
    expect(mockLogger.error).not.toHaveBeenCalled();
  });

  /*
    #2408, the partly-collected case. An increase is collected in one go, so the
    nearest thing to "half collected" is a collected increase that was later
    partly refunded. The refund comes off the same gross figure, which is why
    the net has to be gross-minus-refunds and not a sum of parts.
  */
  it("takes a refund off a collected increase without double-counting it", async () => {
    mockBookingRows([
      {
        id: "booking-grew-then-partly-refunded",
        checkIn: new Date("2026-04-10T00:00:00.000Z"),
        checkOut: new Date("2026-04-11T00:00:00.000Z"),
        status: BookingStatus.PAID,
        finalPriceCents: 12_100,
        guests: [{ id: "g-1" }],
        payment: {
          status: PaymentStatus.PARTIALLY_REFUNDED,
          amountCents: 12_100,
          refundedAmountCents: 500,
          creditAppliedCents: 0,
          changeFeeCents: 0,
          additionalAmountCents: 2_100,
          additionalPaymentStatus: "SUCCEEDED",
          transactions: [
            primaryLedgerRow(10_000),
            additionalLedgerRow(2_100, PaymentStatus.PARTIALLY_REFUNDED),
          ],
        },
      },
    ]);

    const metrics = await getFinanceBookingMetrics({
      realized: { from: "2026-04-10", to: "2026-04-11" },
    });

    expect(metrics.paymentSummary.capturedGrossCents).toBe(12_100);
    expect(metrics.paymentSummary.refundedCents).toBe(500);
    expect(metrics.paymentSummary.netCollectedCents).toBe(11_600);
    expect(metrics.paymentSummary.additionalLedgerGapBookings).toBe(0);
  });

  /*
    #2408 guard. Counting the gross alone is right BECAUSE a collected increase
    is inside it, and it is inside it because a captured ADDITIONAL payment
    record put it there. A payment claiming the collection with no such record
    is the one shape where that reasoning fails and the cash figure would be
    short. None exist in this club's data today; an import or a future write
    path could make one, and it must not pass quietly.
  */
  it("shouts when a collected increase has no payment record behind it", async () => {
    mockBookingRows([
      {
        id: "booking-unproven-extra",
        checkIn: new Date("2026-04-10T00:00:00.000Z"),
        checkOut: new Date("2026-04-11T00:00:00.000Z"),
        status: BookingStatus.PAID,
        finalPriceCents: 12_100,
        guests: [{ id: "g-1" }],
        payment: {
          status: PaymentStatus.SUCCEEDED,
          amountCents: 10_000,
          refundedAmountCents: 0,
          creditAppliedCents: 0,
          changeFeeCents: 0,
          additionalAmountCents: 2_100,
          additionalPaymentStatus: "SUCCEEDED",
          // The column says collected; the ledger has only the primary leg.
          transactions: [primaryLedgerRow(10_000)],
        },
      },
      {
        // Same gap, subtler: there IS an ADDITIONAL record, but it never
        // captured, so the gross figure does not contain it either. Only a
        // CAPTURED record proves the money arrived.
        id: "booking-stalled-extra",
        checkIn: new Date("2026-04-10T00:00:00.000Z"),
        checkOut: new Date("2026-04-11T00:00:00.000Z"),
        status: BookingStatus.PAID,
        finalPriceCents: 13_000,
        guests: [{ id: "g-2" }],
        payment: {
          status: PaymentStatus.SUCCEEDED,
          amountCents: 10_000,
          refundedAmountCents: 0,
          creditAppliedCents: 0,
          changeFeeCents: 0,
          additionalAmountCents: 3_000,
          additionalPaymentStatus: "SUCCEEDED",
          transactions: [
            primaryLedgerRow(10_000),
            additionalLedgerRow(3_000, PaymentStatus.PENDING),
          ],
        },
      },
    ]);

    const metrics = await getFinanceBookingMetrics({
      realized: { from: "2026-04-10", to: "2026-04-11" },
    });

    expect(metrics.paymentSummary.additionalLedgerGapCents).toBe(5_100);
    expect(metrics.paymentSummary.additionalLedgerGapBookings).toBe(2);
    // The figure is still reported, and reported honestly: it is the cash the
    // ledger can prove, with the unprovable part named beside it.
    expect(metrics.paymentSummary.netCollectedCents).toBe(20_000);
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        bookingIds: ["booking-unproven-extra", "booking-stalled-extra"],
        bookingCount: 2,
        additionalLedgerGapCents: 5_100,
      }),
      expect.stringContaining("no captured ADDITIONAL PaymentTransaction"),
    );
  });

  /*
    #2408, the case the fix must NOT break. Not every settled payment has a
    ledger row behind its primary leg: an organiser-settled group booking, and
    any payment written before the transaction ledger existed, can carry a
    captured `amountCents` with no PRIMARY row at all. The cash figure therefore
    reads the payment's own captured amount and uses the ledger only to prove
    or disprove a CLAIMED increase — never to derive the total. Deriving it from
    ledger rows would report the $121 the club took as the $21 it did not.
  */
  it("counts the full captured amount when no ledger row backs the payment", async () => {
    mockBookingRows([
      {
        id: "booking-organiser-settled",
        checkIn: new Date("2026-04-10T00:00:00.000Z"),
        checkOut: new Date("2026-04-11T00:00:00.000Z"),
        status: BookingStatus.PAID,
        finalPriceCents: 12_100,
        guests: [{ id: "g-1" }],
        payment: {
          status: PaymentStatus.SUCCEEDED,
          amountCents: 12_100,
          refundedAmountCents: 0,
          creditAppliedCents: 0,
          changeFeeCents: 0,
          additionalAmountCents: 0,
          additionalPaymentStatus: null,
          // Settled without a ledger row of its own.
          transactions: [],
        },
      },
      {
        // Older still: the relation is absent from the record entirely.
        id: "booking-pre-ledger",
        checkIn: new Date("2026-04-10T00:00:00.000Z"),
        checkOut: new Date("2026-04-11T00:00:00.000Z"),
        status: BookingStatus.PAID,
        finalPriceCents: 8_000,
        guests: [{ id: "g-2" }],
        payment: {
          status: PaymentStatus.SUCCEEDED,
          amountCents: 8_000,
          refundedAmountCents: 0,
          creditAppliedCents: 0,
          changeFeeCents: 0,
          additionalAmountCents: 0,
          additionalPaymentStatus: null,
        },
      },
    ]);

    const metrics = await getFinanceBookingMetrics({
      realized: { from: "2026-04-10", to: "2026-04-11" },
    });

    // The whole $201, not the $0 the ledger could prove.
    expect(metrics.paymentSummary.capturedGrossCents).toBe(20_100);
    expect(metrics.paymentSummary.netCollectedCents).toBe(20_100);
    // Nothing CLAIMS a collected increase, so there is nothing to disprove.
    expect(metrics.paymentSummary.additionalLedgerGapBookings).toBe(0);
    expect(mockLogger.error).not.toHaveBeenCalled();
  });

  /*
    #2350: a legacy row written before `additionalPaymentStatus` was populated
    still carries a real uncollected delta. The owed total counted it while the
    status split filed it under NONE, so a legacy club read "Awaiting 0,
    Failed 0" beside a non-zero total — the split contradicting its own sum.
  */
  it("files a legacy null-status addition as awaiting, matching the total", async () => {
    mockBookingRows([
      {
        id: "booking-legacy-extra",
        checkIn: new Date("2026-04-10T00:00:00.000Z"),
        checkOut: new Date("2026-04-11T00:00:00.000Z"),
        status: BookingStatus.PAID,
        finalPriceCents: 30_000,
        guests: [{ id: "g-1" }],
        payment: {
          status: PaymentStatus.SUCCEEDED,
          amountCents: 9_000,
          refundedAmountCents: 0,
          creditAppliedCents: 0,
          changeFeeCents: 0,
          additionalAmountCents: 21_000,
          additionalPaymentStatus: null,
        },
      },
    ]);

    const metrics = await getFinanceBookingMetrics({
      realized: { from: "2026-04-10", to: "2026-04-11" },
    });

    expect(metrics.paymentSummary.outstandingAdditionalCents).toBe(21_000);
    expect(
      metrics.paymentSummary.additionalPaymentStatusBreakdown,
    ).toMatchObject({ PENDING: 1, NONE: 0 });
  });

  /*
    #2350 round 2. The finance panel renders "Awaiting payment" and "Payment
    failed" from this breakdown and "Total outstanding" from
    outstandingAdditionalBookings, side by side, as a split and its total. They
    have to measure the SAME population.

    They did not: the total is gated on the owed predicate (booking lifecycle
    included) while the breakdown counted any uncollected delta, and the metrics
    window legitimately includes PENDING and PAYMENT_PENDING bookings — which
    can genuinely carry a delta (adding a guest to a booking with an issued Xero
    invoice raises one). So a panel could read "Awaiting 2, Failed 1" above
    "across 1 booking".
  */
  it("keeps the additional-payment split summing to its own total", async () => {
    mockBookingRows([
      // Owed: counts in both the split and the total.
      {
        id: "booking-owed-pending",
        checkIn: new Date("2026-04-20T00:00:00.000Z"),
        checkOut: new Date("2026-04-21T00:00:00.000Z"),
        status: BookingStatus.PAID,
        finalPriceCents: 30_000,
        guests: [{ id: "g-1" }],
        payment: {
          status: PaymentStatus.SUCCEEDED,
          amountCents: 9_000,
          refundedAmountCents: 0,
          creditAppliedCents: 0,
          changeFeeCents: 0,
          additionalAmountCents: 21_000,
          additionalPaymentStatus: "PENDING",
        },
      },
      // Owed, failed charge: same, in the FAILED half.
      {
        id: "booking-owed-failed",
        checkIn: new Date("2026-04-20T00:00:00.000Z"),
        checkOut: new Date("2026-04-21T00:00:00.000Z"),
        status: BookingStatus.CONFIRMED,
        finalPriceCents: 30_000,
        guests: [{ id: "g-2" }],
        payment: {
          status: PaymentStatus.SUCCEEDED,
          amountCents: 9_000,
          refundedAmountCents: 0,
          creditAppliedCents: 0,
          changeFeeCents: 0,
          additionalAmountCents: 4_000,
          additionalPaymentStatus: "FAILED",
        },
      },
      // A real, uncollected delta on a booking the owed predicate excludes for
      // counting reasons. In NEITHER the split nor the total.
      {
        id: "booking-payment-pending-extra",
        checkIn: new Date("2026-04-20T00:00:00.000Z"),
        checkOut: new Date("2026-04-21T00:00:00.000Z"),
        status: BookingStatus.PAYMENT_PENDING,
        finalPriceCents: 30_000,
        guests: [{ id: "g-3" }],
        payment: {
          status: PaymentStatus.PENDING,
          amountCents: 0,
          refundedAmountCents: 0,
          creditAppliedCents: 0,
          changeFeeCents: 0,
          additionalAmountCents: 5_000,
          additionalPaymentStatus: "PENDING",
        },
      },
      // Legacy null status on a PENDING booking: likewise out of both.
      {
        id: "booking-pending-legacy-extra",
        checkIn: new Date("2026-04-20T00:00:00.000Z"),
        checkOut: new Date("2026-04-21T00:00:00.000Z"),
        status: BookingStatus.PENDING,
        finalPriceCents: 30_000,
        guests: [{ id: "g-4" }],
        payment: {
          status: PaymentStatus.PENDING,
          amountCents: 0,
          refundedAmountCents: 0,
          creditAppliedCents: 0,
          changeFeeCents: 0,
          additionalAmountCents: 6_000,
          additionalPaymentStatus: null,
        },
      },
    ]);

    const metrics = await getFinanceBookingMetrics({
      forward: { from: "2026-04-20", to: "2026-04-24", asOfDate: "2026-04-19" },
    });

    const breakdown =
      metrics.paymentSummary.additionalPaymentStatusBreakdown;
    expect(breakdown.PENDING).toBe(1);
    expect(breakdown.FAILED).toBe(1);
    expect(breakdown.PENDING + breakdown.FAILED).toBe(
      metrics.paymentSummary.outstandingAdditionalBookings,
    );
    expect(metrics.paymentSummary.outstandingAdditionalCents).toBe(25_000);
  });

  it("rejects an empty query", async () => {
    await expect(getFinanceBookingMetrics({})).rejects.toThrow(
      "At least one finance booking metrics section is required"
    );
    expect(mockPrisma.booking.findMany).not.toHaveBeenCalled();
  });

  it("rejects booking metric windows over one year before querying bookings", async () => {
    await expect(
      getFinanceBookingMetrics({
        realized: {
          from: "2020-01-01",
          to: "2026-12-31",
        },
      })
    ).rejects.toThrow("realized window cannot exceed 366 days");
    expect(mockPrisma.booking.findMany).not.toHaveBeenCalled();
  });
});
