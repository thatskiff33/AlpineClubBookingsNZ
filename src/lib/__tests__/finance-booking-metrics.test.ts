import { beforeEach, describe, expect, it, vi } from "vitest";
import { BookingStatus, PaymentStatus } from "@prisma/client";

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    booking: {
      findMany: vi.fn(),
    },
  },
}));

vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));

import { getFinanceBookingMetrics } from "@/lib/finance-booking-metrics";

describe("finance-booking-metrics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("derives realized stays, forward pipeline, and payment summaries from TACBookings rows", async () => {
    mockPrisma.booking.findMany.mockResolvedValue([
      {
        id: "booking-confirmed-split",
        checkIn: new Date("2026-04-20T00:00:00.000Z"),
        checkOut: new Date("2026-04-23T00:00:00.000Z"),
        status: BookingStatus.CONFIRMED,
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
            BookingStatus.CONFIRMED,
            BookingStatus.PAID,
            BookingStatus.COMPLETED,
            BookingStatus.PENDING,
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
      capturedPrimaryCents: 42000,
      capturedAdditionalCents: 0,
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
          capacityBedNights: 116,
          occupancyRate: 0.0776,
        },
      },
      statusBreakdown: {
        CONFIRMED: {
          bookingCount: 1,
          bookingNights: 2,
          guestNights: 4,
          bookedRevenueCents: 20000,
        },
        PAID: {
          bookingCount: 1,
          bookingNights: 2,
          guestNights: 2,
          bookedRevenueCents: 12000,
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
          availableBeds: 28,
          occupancyRate: 0.0345,
          bookedRevenueCents: 6000,
        },
        {
          date: "2026-04-19",
          bookingCount: 2,
          guestNights: 4,
          occupiedBeds: 4,
          availableBeds: 25,
          occupancyRate: 0.1379,
          bookedRevenueCents: 6000,
        },
        {
          date: "2026-04-20",
          bookingCount: 1,
          guestNights: 2,
          occupiedBeds: 2,
          availableBeds: 27,
          occupancyRate: 0.069,
          bookedRevenueCents: 10000,
        },
        {
          date: "2026-04-21",
          bookingCount: 1,
          guestNights: 2,
          occupiedBeds: 2,
          availableBeds: 27,
          occupancyRate: 0.069,
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
            capacityBedNights: 87,
            occupancyRate: 0.023,
          },
          statusBreakdown: {
            CONFIRMED: {
              bookingCount: 1,
              bookingNights: 1,
              guestNights: 2,
              bookedRevenueCents: 10000,
            },
            PAID: {
              bookingCount: 0,
              bookingNights: 0,
              guestNights: 0,
              bookedRevenueCents: 0,
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
            capacityBedNights: 87,
            occupancyRate: 0.023,
          },
          statusBreakdown: {
            PENDING: {
              bookingCount: 1,
              bookingNights: 2,
              guestNights: 2,
              bookedRevenueCents: 8000,
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
            capacityBedNights: 87,
            occupancyRate: 0.046,
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
            availableBeds: 27,
            occupancyRate: 0.069,
            bookedRevenueCents: 10000,
          },
          atRisk: {
            date: "2026-04-22",
            bookingCount: 1,
            guestNights: 1,
            occupiedBeds: 1,
            availableBeds: 28,
            occupancyRate: 0.0345,
            bookedRevenueCents: 4000,
          },
          totalPipeline: {
            date: "2026-04-22",
            bookingCount: 2,
            guestNights: 3,
            occupiedBeds: 3,
            availableBeds: 26,
            occupancyRate: 0.1034,
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
            availableBeds: 29,
            occupancyRate: 0,
            bookedRevenueCents: 0,
          },
          atRisk: {
            date: "2026-04-23",
            bookingCount: 1,
            guestNights: 1,
            occupiedBeds: 1,
            availableBeds: 28,
            occupancyRate: 0.0345,
            bookedRevenueCents: 4000,
          },
          totalPipeline: {
            date: "2026-04-23",
            bookingCount: 1,
            guestNights: 1,
            occupiedBeds: 1,
            availableBeds: 28,
            occupancyRate: 0.0345,
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
            availableBeds: 29,
            occupancyRate: 0,
            bookedRevenueCents: 0,
          },
          atRisk: {
            date: "2026-04-24",
            bookingCount: 0,
            guestNights: 0,
            occupiedBeds: 0,
            availableBeds: 29,
            occupancyRate: 0,
            bookedRevenueCents: 0,
          },
          totalPipeline: {
            date: "2026-04-24",
            bookingCount: 0,
            guestNights: 0,
            occupiedBeds: 0,
            availableBeds: 29,
            occupancyRate: 0,
            bookedRevenueCents: 0,
          },
        },
      ],
    });
  });

  it("rejects an empty query", async () => {
    await expect(getFinanceBookingMetrics({})).rejects.toThrow(
      "At least one finance booking metrics section is required"
    );
    expect(mockPrisma.booking.findMany).not.toHaveBeenCalled();
  });
});
