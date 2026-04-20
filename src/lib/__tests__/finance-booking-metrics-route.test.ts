import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const {
  mockAuth,
  mockFindUnique,
  mockGetFinanceBookingMetrics,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockFindUnique: vi.fn(),
  mockGetFinanceBookingMetrics: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  auth: mockAuth,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: {
      findUnique: mockFindUnique,
    },
  },
}));

vi.mock("@/lib/finance-booking-metrics", () => ({
  getFinanceBookingMetrics: mockGetFinanceBookingMetrics,
}));

import { GET as getFinanceBookingMetricsRoute } from "@/app/api/finance/bookings/metrics/route";

function viewerSession() {
  return { user: { id: "finance-viewer-1", role: "MEMBER" } };
}

function viewerMember() {
  return {
    id: "finance-viewer-1",
    email: "viewer@example.com",
    firstName: "View",
    lastName: "Only",
    role: "MEMBER",
    financeAccessLevel: "VIEWER",
    active: true,
    forcePasswordChange: false,
  };
}

function memberWithoutFinanceAccess() {
  return {
    id: "member-1",
    email: "member@example.com",
    firstName: "Plain",
    lastName: "Member",
    role: "MEMBER",
    financeAccessLevel: "NONE",
    active: true,
    forcePasswordChange: false,
  };
}

describe("finance booking metrics route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue(viewerSession());
    mockFindUnique.mockResolvedValue(viewerMember());
    mockGetFinanceBookingMetrics.mockResolvedValue({
      generatedAt: "2026-04-21T09:00:00.000Z",
      bookingCount: 2,
      paymentSummary: {
        bookingCount: 2,
        bookingsWithPayment: 1,
        bookingsWithoutPayment: 1,
        paymentStatusBreakdown: {
          PENDING: 0,
          PROCESSING: 0,
          SUCCEEDED: 1,
          FAILED: 0,
          REFUNDED: 0,
          PARTIALLY_REFUNDED: 0,
          NONE: 1,
        },
        additionalPaymentStatusBreakdown: {
          PENDING: 0,
          SUCCEEDED: 0,
          FAILED: 0,
          NONE: 2,
        },
        capturedPrimaryCents: 12000,
        capturedAdditionalCents: 0,
        refundedCents: 0,
        netCollectedCents: 12000,
        creditAppliedCents: 0,
        changeFeeCents: 0,
      },
      realized: {
        window: {
          from: "2026-04-01",
          to: "2026-04-10",
          cutoffDate: "2026-04-10",
          effectiveFrom: "2026-04-01",
          effectiveTo: "2026-04-10",
          dayCount: 10,
        },
        totals: {
          bookingCount: 2,
          bookingNights: 3,
          guestNights: 4,
          bookedRevenueCents: 12000,
          averageNightlyRevenueCents: 4000,
          occupancy: {
            occupiedBedNights: 4,
            capacityBedNights: 290,
            occupancyRate: 0.0138,
          },
        },
        statusBreakdown: {
          CONFIRMED: {
            bookingCount: 1,
            bookingNights: 2,
            guestNights: 2,
            bookedRevenueCents: 8000,
          },
          PAID: {
            bookingCount: 1,
            bookingNights: 1,
            guestNights: 2,
            bookedRevenueCents: 4000,
          },
          COMPLETED: {
            bookingCount: 0,
            bookingNights: 0,
            guestNights: 0,
            bookedRevenueCents: 0,
          },
        },
        byDate: [],
      },
    });
  });

  it("returns metrics for a finance viewer", async () => {
    const request = new NextRequest(
      "https://tokoroa.org.nz/api/finance/bookings/metrics?realizedFrom=2026-04-01&realizedTo=2026-04-10&realizedCutoff=2026-04-10&forwardFrom=2026-04-11&forwardTo=2026-04-20&forwardAsOf=2026-04-10"
    );

    const response = await getFinanceBookingMetricsRoute(request);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      bookingCount: 2,
      realized: {
        totals: {
          bookingCount: 2,
        },
      },
    });
    expect(mockGetFinanceBookingMetrics).toHaveBeenCalledWith({
      realized: {
        from: "2026-04-01",
        to: "2026-04-10",
        cutoffDate: "2026-04-10",
      },
      forward: {
        from: "2026-04-11",
        to: "2026-04-20",
        asOfDate: "2026-04-10",
      },
    });
  });

  it("rejects members without finance viewer access", async () => {
    mockFindUnique.mockResolvedValue(memberWithoutFinanceAccess());

    const response = await getFinanceBookingMetricsRoute(
      new NextRequest(
        "https://tokoroa.org.nz/api/finance/bookings/metrics?realizedFrom=2026-04-01&realizedTo=2026-04-10"
      )
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Finance viewer access required",
    });
    expect(mockGetFinanceBookingMetrics).not.toHaveBeenCalled();
  });

  it("returns 400 when the query is incomplete", async () => {
    const response = await getFinanceBookingMetricsRoute(
      new NextRequest(
        "https://tokoroa.org.nz/api/finance/bookings/metrics?realizedFrom=2026-04-01"
      )
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error:
        "Invalid finance booking metrics query. Use paired realizedFrom/realizedTo and/or forwardFrom/forwardTo dates in YYYY-MM-DD format.",
    });
    expect(mockGetFinanceBookingMetrics).not.toHaveBeenCalled();
  });

  it("returns 500 when metric loading fails", async () => {
    mockGetFinanceBookingMetrics.mockRejectedValue(
      new Error("Failed to read finance booking metrics")
    );

    const response = await getFinanceBookingMetricsRoute(
      new NextRequest(
        "https://tokoroa.org.nz/api/finance/bookings/metrics?realizedFrom=2026-04-01&realizedTo=2026-04-10"
      )
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: "Failed to read finance booking metrics",
    });
  });
});
