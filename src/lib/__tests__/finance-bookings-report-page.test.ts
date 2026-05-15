import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseDateOnly } from "@/lib/date-only";

const { mockGetFinanceBookingMetrics } = vi.hoisted(() => ({
  mockGetFinanceBookingMetrics: vi.fn(),
}));

vi.mock("@/lib/finance-booking-metrics", () => ({
  getFinanceBookingMetrics: mockGetFinanceBookingMetrics,
  getFinanceBookingMetricsWindowDayCount: (from: string, to: string) =>
    Math.round(
      (new Date(`${to}T00:00:00.000Z`).getTime() -
        new Date(`${from}T00:00:00.000Z`).getTime()) /
        86_400_000
    ) + 1,
  MAX_FINANCE_BOOKING_METRICS_WINDOW_DAYS: 366,
}));

vi.mock("@/lib/finance-auth", () => ({
  hasFinanceManagerAccess: (level: string) => level === "MANAGER",
}));

import {
  buildDefaultFinanceBookingsReportFilters,
  buildFinanceBookingsReportPageModel,
  resolveFinanceBookingsReportFilters,
} from "@/lib/finance-bookings-report-page";

function financeViewer() {
  return {
    id: "finance-viewer-1",
    email: "viewer@example.com",
    firstName: "View",
    lastName: "Only",
    role: "MEMBER" as const,
    financeAccessLevel: "VIEWER" as const,
    active: true,
    forcePasswordChange: false,
  };
}

function financeManager() {
  return {
    id: "finance-manager-1",
    email: "manager@example.com",
    firstName: "Fin",
    lastName: "Manager",
    role: "ADMIN" as const,
    financeAccessLevel: "MANAGER" as const,
    active: true,
    forcePasswordChange: false,
  };
}

function bookingMetrics() {
  return {
    generatedAt: "2026-04-21T01:00:00.000Z",
    bookingCount: 8,
    paymentSummary: {
      bookingCount: 8,
      bookingsWithPayment: 6,
      bookingsWithoutPayment: 2,
      paymentStatusBreakdown: {
        PENDING: 1,
        PROCESSING: 0,
        SUCCEEDED: 5,
        FAILED: 0,
        REFUNDED: 0,
        PARTIALLY_REFUNDED: 0,
        NONE: 2,
      },
      additionalPaymentStatusBreakdown: {
        PENDING: 0,
        SUCCEEDED: 1,
        FAILED: 0,
        NONE: 7,
      },
      capturedPrimaryCents: 182000,
      capturedAdditionalCents: 12000,
      refundedCents: 0,
      netCollectedCents: 194000,
      creditAppliedCents: 0,
      changeFeeCents: 0,
    },
    realized: {
      window: {
        from: "2026-04-01",
        to: "2026-04-21",
        cutoffDate: "2026-04-21",
        effectiveFrom: "2026-04-01",
        effectiveTo: "2026-04-21",
        dayCount: 21,
      },
      totals: {
        bookingCount: 3,
        bookingNights: 7,
        guestNights: 14,
        bookedRevenueCents: 98000,
        averageNightlyRevenueCents: 14000,
        occupancy: {
          occupiedBedNights: 14,
          capacityBedNights: 609,
          occupancyRate: 0.023,
        },
      },
      statusBreakdown: {
        CONFIRMED: {
          bookingCount: 1,
          bookingNights: 2,
          guestNights: 4,
          bookedRevenueCents: 28000,
        },
        PAID: {
          bookingCount: 1,
          bookingNights: 3,
          guestNights: 6,
          bookedRevenueCents: 42000,
        },
        COMPLETED: {
          bookingCount: 1,
          bookingNights: 2,
          guestNights: 4,
          bookedRevenueCents: 28000,
        },
      },
      byDate: [
        {
          date: "2026-04-20",
          bookingCount: 2,
          guestNights: 4,
          occupiedBeds: 4,
          availableBeds: 25,
          occupancyRate: 0.1379,
          bookedRevenueCents: 28000,
        },
        {
          date: "2026-04-21",
          bookingCount: 1,
          guestNights: 2,
          occupiedBeds: 2,
          availableBeds: 27,
          occupancyRate: 0.069,
          bookedRevenueCents: 14000,
        },
      ],
    },
    forward: {
      window: {
        from: "2026-04-22",
        to: "2026-07-20",
        asOfDate: "2026-04-21",
        effectiveFrom: "2026-04-22",
        effectiveTo: "2026-07-20",
        dayCount: 90,
      },
      totals: {
        committed: {
          bookingCount: 2,
          bookingNights: 8,
          guestNights: 16,
          bookedRevenueCents: 120000,
          occupancy: {
            occupiedBedNights: 16,
            capacityBedNights: 2610,
            occupancyRate: 0.0061,
          },
          statusBreakdown: {
            CONFIRMED: {
              bookingCount: 1,
              bookingNights: 3,
              guestNights: 6,
              bookedRevenueCents: 45000,
            },
            PAID: {
              bookingCount: 1,
              bookingNights: 5,
              guestNights: 10,
              bookedRevenueCents: 75000,
            },
          },
        },
        atRisk: {
          bookingCount: 1,
          bookingNights: 4,
          guestNights: 8,
          bookedRevenueCents: 52000,
          occupancy: {
            occupiedBedNights: 8,
            capacityBedNights: 2610,
            occupancyRate: 0.0031,
          },
          statusBreakdown: {
            PENDING: {
              bookingCount: 1,
              bookingNights: 4,
              guestNights: 8,
              bookedRevenueCents: 52000,
            },
          },
        },
        totalPipeline: {
          bookingCount: 3,
          bookingNights: 12,
          guestNights: 24,
          bookedRevenueCents: 172000,
          occupancy: {
            occupiedBedNights: 24,
            capacityBedNights: 2610,
            occupancyRate: 0.0092,
          },
        },
      },
      byDate: [
        {
          date: "2026-04-22",
          committed: {
            date: "2026-04-22",
            bookingCount: 1,
            guestNights: 4,
            occupiedBeds: 4,
            availableBeds: 25,
            occupancyRate: 0.1379,
            bookedRevenueCents: 30000,
          },
          atRisk: {
            date: "2026-04-22",
            bookingCount: 1,
            guestNights: 2,
            occupiedBeds: 2,
            availableBeds: 27,
            occupancyRate: 0.069,
            bookedRevenueCents: 12000,
          },
          totalPipeline: {
            date: "2026-04-22",
            bookingCount: 2,
            guestNights: 6,
            occupiedBeds: 6,
            availableBeds: 23,
            occupancyRate: 0.2069,
            bookedRevenueCents: 42000,
          },
        },
      ],
    },
  };
}

const consoleErrorSpy = vi
  .spyOn(console, "error")
  .mockImplementation(() => undefined);

describe("finance bookings report page model", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-21T10:00:00.000Z"));
    vi.clearAllMocks();
    mockGetFinanceBookingMetrics.mockResolvedValue(bookingMetrics());
  });

  afterEach(() => {
    consoleErrorSpy.mockClear();
    vi.useRealTimers();
  });

  it("uses the landing-page default windows and maps report detail for managers", async () => {
    const model = await buildFinanceBookingsReportPageModel({
      member: financeManager(),
      today: parseDateOnly("2026-04-21"),
    });

    expect(model.isManager).toBe(true);
    expect(model.filters).toEqual(
      buildDefaultFinanceBookingsReportFilters(parseDateOnly("2026-04-21"))
    );
    expect(model.rawMetricsHref).toBe(
      "/api/finance/bookings/metrics?realizedFrom=2026-04-01&realizedTo=2026-04-21&realizedCutoff=2026-04-21&forwardFrom=2026-04-22&forwardTo=2026-07-20&forwardAsOf=2026-04-21"
    );
    expect(model.realized.cards[0]).toMatchObject({
      title: "Guest nights",
      value: "14",
    });
    expect(model.realized.dailyRows[0]).toMatchObject({
      date: "Mon, 20 Apr",
      bookedRevenue: "$280.00",
    });
    expect(model.forward.statusRows).toMatchObject([
      {
        pipeline: "Committed",
        status: "Confirmed",
        bookingCount: "1",
        bookingNights: "3",
        guestNights: "6",
        bookedRevenue: "$450.00",
      },
      {
        pipeline: "Committed",
        status: "Paid",
        bookingCount: "1",
        bookingNights: "5",
        guestNights: "10",
        bookedRevenue: "$750.00",
      },
      {
        pipeline: "At risk",
        status: "Pending",
        bookingCount: "1",
        bookingNights: "4",
        guestNights: "8",
        bookedRevenue: "$520.00",
      },
    ]);
    const paidCommittedRow = model.forward.statusRows.find(
      (row) => row.pipelineKey === "committed" && row.statusCode === "PAID"
    );
    expect(paidCommittedRow).toBeTruthy();
    const paidCommittedUrl = new URL(
      paidCommittedRow!.drilldownHref,
      "https://tacbookings.local"
    );
    expect(paidCommittedUrl.pathname).toBe("/finance/bookings/source");
    expect(paidCommittedUrl.searchParams.get("section")).toBe("forward");
    expect(paidCommittedUrl.searchParams.get("pipeline")).toBe("committed");
    expect(paidCommittedUrl.searchParams.get("status")).toBe("PAID");
    expect(paidCommittedUrl.searchParams.get("returnTo")).toBe(model.reportHref);
    expect(mockGetFinanceBookingMetrics).toHaveBeenCalledWith({
      realized: {
        from: "2026-04-01",
        to: "2026-04-21",
        cutoffDate: "2026-04-21",
      },
      forward: {
        from: "2026-04-22",
        to: "2026-07-20",
        asOfDate: "2026-04-21",
      },
    });
  });

  it("falls back invalid filters for viewers while keeping valid custom ranges", () => {
    const resolved = resolveFinanceBookingsReportFilters({
      today: parseDateOnly("2026-04-21"),
      searchParams: {
        realizedFrom: "2026-04-01",
        forwardFrom: "2026-05-01",
        forwardTo: "2026-05-15",
        forwardAsOf: "not-a-date",
      },
    });

    expect(resolved.filters).toEqual({
      realizedFrom: "2026-04-01",
      realizedTo: "2026-04-21",
      realizedCutoff: "2026-04-21",
      forwardFrom: "2026-05-01",
      forwardTo: "2026-05-15",
      forwardAsOf: "2026-04-21",
    });
    expect(resolved.warnings).toEqual([
      "Realized filters were incomplete. Showing the default month-to-date window.",
      "Forward as-of date was invalid. Using today's New Zealand date instead.",
    ]);
  });

  it("falls back oversized booking metric windows", () => {
    const resolved = resolveFinanceBookingsReportFilters({
      today: parseDateOnly("2026-04-21"),
      searchParams: {
        realizedFrom: "2020-01-01",
        realizedTo: "2026-12-31",
        forwardFrom: "2026-05-01",
        forwardTo: "2030-05-01",
      },
    });

    expect(resolved.filters).toEqual(buildDefaultFinanceBookingsReportFilters(
      parseDateOnly("2026-04-21")
    ));
    expect(resolved.warnings).toEqual([
      "Realized filters cannot exceed 366 days. Showing the default month-to-date window.",
      "Forward filters cannot exceed 366 days. Showing the default next-90-days window.",
    ]);
  });

  it("returns a safe unavailable state when the booking metrics boundary fails", async () => {
    mockGetFinanceBookingMetrics.mockRejectedValue(
      new Error("database connection refused")
    );

    const model = await buildFinanceBookingsReportPageModel({
      member: financeViewer(),
      today: parseDateOnly("2026-04-21"),
    });

    expect(model.isManager).toBe(false);
    expect(model.loadError).toBe(
      "Booking figures could not be loaded right now. Try again shortly."
    );
    expect(model.realized.cards).toEqual([]);
    expect(model.forward.cards).toEqual([]);
    expect(consoleErrorSpy).toHaveBeenCalled();
  });
});
