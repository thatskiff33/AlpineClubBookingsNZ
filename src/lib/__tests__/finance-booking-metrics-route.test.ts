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
  getFinanceBookingMetricsWindowDayCount: (from: string, to: string) =>
    Math.round(
      (new Date(`${to}T00:00:00.000Z`).getTime() -
        new Date(`${from}T00:00:00.000Z`).getTime()) /
        86_400_000
    ) + 1,
  MAX_FINANCE_BOOKING_METRICS_WINDOW_DAYS: 366,
}));

import { GET as getFinanceBookingMetricsRoute } from "@/app/api/finance/bookings/metrics/route";

function viewerSession() {
  return { user: { id: "finance-viewer-1", role: "USER", accessRoles: [{ role: "USER" }] } };
}

function viewerMember() {
  return {
    id: "finance-viewer-1",
    email: "viewer@example.com",
    firstName: "View",
    lastName: "Only",
    role: "USER",
    financeAccessLevel: "NONE",
    accessRoles: [{ role: "FINANCE_USER" }],
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
    role: "USER",
    financeAccessLevel: "NONE",
    accessRoles: [{ role: "USER" }],
    active: true,
    forcePasswordChange: false,
  };
}

function fullAdminMember() {
  return {
    id: "admin-1",
    email: "admin@example.com",
    firstName: "Admin",
    lastName: "Only",
    role: "ADMIN",
    financeAccessLevel: "NONE",
    accessRoles: [{ role: "ADMIN" }],
    active: true,
    forcePasswordChange: false,
  };
}

function contentManagerMember() {
  return {
    id: "content-1",
    email: "content@example.com",
    firstName: "Content",
    lastName: "Only",
    role: "USER",
    financeAccessLevel: "NONE",
    accessRoles: [{ role: "ADMIN_CONTENT" }],
    active: true,
    forcePasswordChange: false,
  };
}

function mixedLodgeFinanceViewerMember() {
  return {
    id: "finance-lodge-1",
    email: "lodge@example.com",
    firstName: "Lodge",
    lastName: "Session",
    role: "LODGE",
    financeAccessLevel: "NONE",
    accessRoles: [{ role: "LODGE" }, { role: "FINANCE_USER" }],
    active: true,
    forcePasswordChange: false,
  };
}

function lodgeOnlyMember() {
  return {
    id: "lodge-only-1",
    email: "lodge-only@example.com",
    firstName: "Lodge",
    lastName: "Only",
    role: "LODGE",
    financeAccessLevel: "NONE",
    accessRoles: [{ role: "LODGE" }],
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
        capturedGrossCents: 12000,
        capturedAdditionalCents: 0,
        outstandingAdditionalCents: 0,
        outstandingAdditionalBookings: 0,
        additionalLedgerGapCents: 0,
        additionalLedgerGapBookings: 0,
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
      "https://example.org/api/finance/bookings/metrics?realizedFrom=2026-04-01&realizedTo=2026-04-10&realizedCutoff=2026-04-10&forwardFrom=2026-04-11&forwardTo=2026-04-20&forwardAsOf=2026-04-10"
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
      // #3372: one request, so it carries Refunds owed and Credits owed.
      includeRefundsAndCreditsOwed: true,
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
        "https://example.org/api/finance/bookings/metrics?realizedFrom=2026-04-01&realizedTo=2026-04-10"
      )
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Finance viewer access required",
    });
    expect(mockGetFinanceBookingMetrics).not.toHaveBeenCalled();
  });

  it("allows Full Admins as matrix-derived finance viewers", async () => {
    // Finance access derives from the merged finance area level, so the
    // full-edit ADMIN matrix includes it (intentional widening).
    mockAuth.mockResolvedValue({ user: { id: "admin-1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] } });
    mockFindUnique.mockResolvedValue(fullAdminMember());

    const response = await getFinanceBookingMetricsRoute(
      new NextRequest(
        "https://example.org/api/finance/bookings/metrics?realizedFrom=2026-04-01&realizedTo=2026-04-10"
      )
    );

    expect(response.status).toBe(200);
  });

  it("rejects admins whose matrix has no finance access", async () => {
    mockAuth.mockResolvedValue({ user: { id: "content-1", role: "USER", accessRoles: [{ role: "ADMIN_CONTENT" }] } });
    mockFindUnique.mockResolvedValue(contentManagerMember());

    const response = await getFinanceBookingMetricsRoute(
      new NextRequest(
        "https://example.org/api/finance/bookings/metrics?realizedFrom=2026-04-01&realizedTo=2026-04-10"
      )
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Finance viewer access required",
    });
    expect(mockGetFinanceBookingMetrics).not.toHaveBeenCalled();
  });

  it("allows mixed LODGE plus FINANCE_USER accounts to read metrics", async () => {
    mockAuth.mockResolvedValue({ user: { id: "finance-lodge-1", role: "LODGE", accessRoles: [{ role: "LODGE" }] } });
    mockFindUnique.mockResolvedValue(mixedLodgeFinanceViewerMember());

    const response = await getFinanceBookingMetricsRoute(
      new NextRequest(
        "https://example.org/api/finance/bookings/metrics?realizedFrom=2026-04-01&realizedTo=2026-04-10"
      )
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      bookingCount: 2,
    });
    expect(mockGetFinanceBookingMetrics).toHaveBeenCalled();
  });

  it("rejects lodge-only accounts without finance access", async () => {
    mockAuth.mockResolvedValue({ user: { id: "lodge-only-1", role: "LODGE", accessRoles: [{ role: "LODGE" }] } });
    mockFindUnique.mockResolvedValue(lodgeOnlyMember());

    const response = await getFinanceBookingMetricsRoute(
      new NextRequest(
        "https://example.org/api/finance/bookings/metrics?realizedFrom=2026-04-01&realizedTo=2026-04-10"
      )
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Finance viewer access required",
    });
    expect(mockGetFinanceBookingMetrics).not.toHaveBeenCalled();
  });

  it("rejects unauthenticated callers", async () => {
    mockAuth.mockResolvedValue(null);

    const response = await getFinanceBookingMetricsRoute(
      new NextRequest(
        "https://example.org/api/finance/bookings/metrics?realizedFrom=2026-04-01&realizedTo=2026-04-10"
      )
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: "Unauthorised",
    });
    expect(mockGetFinanceBookingMetrics).not.toHaveBeenCalled();
  });

  it("returns 400 when the query is incomplete", async () => {
    const response = await getFinanceBookingMetricsRoute(
      new NextRequest(
        "https://example.org/api/finance/bookings/metrics?realizedFrom=2026-04-01"
      )
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error:
        "Invalid finance booking metrics query. Use paired realizedFrom/realizedTo and/or forwardFrom/forwardTo dates in YYYY-MM-DD format.",
    });
    expect(mockGetFinanceBookingMetrics).not.toHaveBeenCalled();
  });

  it("returns 400 when a requested metrics window is too large", async () => {
    const response = await getFinanceBookingMetricsRoute(
      new NextRequest(
        "https://example.org/api/finance/bookings/metrics?realizedFrom=2020-01-01&realizedTo=2026-12-31"
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
        "https://example.org/api/finance/bookings/metrics?realizedFrom=2026-04-01&realizedTo=2026-04-10"
      )
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: "Failed to load finance booking metrics",
    });
  });
});
