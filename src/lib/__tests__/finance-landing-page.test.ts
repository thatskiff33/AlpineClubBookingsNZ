import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseDateOnly } from "@/lib/date-only";

const {
  mockGetFinanceSyncDiagnosticsStatus,
  mockGetFinanceBookingMetrics,
} = vi.hoisted(() => ({
  mockGetFinanceSyncDiagnosticsStatus: vi.fn(),
  mockGetFinanceBookingMetrics: vi.fn(),
}));

vi.mock("@/lib/finance-sync-diagnostics", () => ({
  getFinanceSyncDiagnosticsStatus: mockGetFinanceSyncDiagnosticsStatus,
}));

vi.mock("@/lib/finance-booking-metrics", () => ({
  getFinanceBookingMetrics: mockGetFinanceBookingMetrics,
}));

vi.mock("@/lib/finance-auth", () => ({
  hasFinanceManagerAccess: (level: string) => level === "MANAGER",
}));

import {
  buildFinanceLandingMetricsQuery,
  buildFinanceLandingPageModel,
} from "@/lib/finance-landing-page";

const consoleErrorSpy = vi
  .spyOn(console, "error")
  .mockImplementation(() => undefined);

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

function diagnosticsStatus() {
  return {
    workflow: "daily-finance-sync",
    latestRun: {
      id: "run-1",
      workflow: "daily-finance-sync",
      trigger: "CRON",
      status: "SUCCEEDED",
      startedAt: "2026-04-21T00:00:00.000Z",
      completedAt: "2026-04-21T00:02:00.000Z",
      durationMs: 120000,
      xeroTenantId: "finance-tenant-1",
      requestedByMemberId: null,
      snapshotCount: 8,
      totalRowCount: 2400,
      datasetCount: 8,
      successfulDatasetCount: 8,
      failedDatasetCount: 0,
      datasets: [],
      errorSummary: null,
      failureDetails: [],
    },
    cron: {
      jobName: "finance-daily-sync",
      schedule: "0 5 * * *",
      timezone: "Pacific/Auckland",
      latestRun: {
        id: "cron-1",
        jobName: "finance-daily-sync",
        status: "SUCCESS",
        startedAt: "2026-04-21T00:00:00.000Z",
        completedAt: "2026-04-21T00:02:00.000Z",
        durationMs: 120000,
        financeSyncRunId: "run-1",
        financeSyncStatus: "SUCCEEDED",
        snapshotCount: 8,
        totalRowCount: 2400,
        datasetCount: 8,
        failedDatasetCount: 0,
        error: null,
        reason: null,
      },
    },
    recentFailures: {
      syncRuns: [],
      cronRuns: [],
    },
  };
}

function bookingMetrics() {
  return {
    generatedAt: "2026-04-21T01:00:00.000Z",
    bookingCount: 12,
    paymentSummary: {
      bookingCount: 12,
      bookingsWithPayment: 10,
      bookingsWithoutPayment: 2,
      paymentStatusBreakdown: {
        PENDING: 1,
        PROCESSING: 0,
        SUCCEEDED: 8,
        FAILED: 0,
        REFUNDED: 1,
        PARTIALLY_REFUNDED: 0,
        NONE: 2,
      },
      additionalPaymentStatusBreakdown: {
        PENDING: 1,
        SUCCEEDED: 2,
        FAILED: 0,
        NONE: 9,
      },
      capturedPrimaryCents: 456700,
      capturedAdditionalCents: 12000,
      refundedCents: 5000,
      netCollectedCents: 463700,
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
        bookingCount: 5,
        bookingNights: 14,
        guestNights: 30,
        bookedRevenueCents: 120000,
        averageNightlyRevenueCents: 8571,
        occupancy: {
          occupiedBedNights: 30,
          capacityBedNights: 609,
          occupancyRate: 0.0493,
        },
      },
      statusBreakdown: {
        CONFIRMED: {
          bookingCount: 2,
          bookingNights: 6,
          guestNights: 10,
          bookedRevenueCents: 45000,
        },
        PAID: {
          bookingCount: 2,
          bookingNights: 5,
          guestNights: 12,
          bookedRevenueCents: 50000,
        },
        COMPLETED: {
          bookingCount: 1,
          bookingNights: 3,
          guestNights: 8,
          bookedRevenueCents: 25000,
        },
      },
      byDate: [],
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
          bookingCount: 4,
          bookingNights: 20,
          guestNights: 42,
          bookedRevenueCents: 200000,
          occupancy: {
            occupiedBedNights: 42,
            capacityBedNights: 2610,
            occupancyRate: 0.0161,
          },
          statusBreakdown: {
            CONFIRMED: {
              bookingCount: 2,
              bookingNights: 8,
              guestNights: 16,
              bookedRevenueCents: 80000,
            },
            PAID: {
              bookingCount: 2,
              bookingNights: 12,
              guestNights: 26,
              bookedRevenueCents: 120000,
            },
          },
        },
        atRisk: {
          bookingCount: 1,
          bookingNights: 5,
          guestNights: 10,
          bookedRevenueCents: 50000,
          occupancy: {
            occupiedBedNights: 10,
            capacityBedNights: 2610,
            occupancyRate: 0.0038,
          },
          statusBreakdown: {
            PENDING: {
              bookingCount: 1,
              bookingNights: 5,
              guestNights: 10,
              bookedRevenueCents: 50000,
            },
          },
        },
        totalPipeline: {
          bookingCount: 5,
          bookingNights: 25,
          guestNights: 52,
          bookedRevenueCents: 250000,
          occupancy: {
            occupiedBedNights: 52,
            capacityBedNights: 2610,
            occupancyRate: 0.0199,
          },
        },
      },
      byDate: [],
    },
  };
}

describe("finance landing page model", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-21T10:00:00.000Z"));
    vi.clearAllMocks();
    mockGetFinanceSyncDiagnosticsStatus.mockResolvedValue(diagnosticsStatus());
    mockGetFinanceBookingMetrics.mockResolvedValue(bookingMetrics());
  });

  afterEach(() => {
    consoleErrorSpy.mockClear();
    vi.useRealTimers();
  });

  it("builds month-to-date realized and next-90-days forward windows", () => {
    const query = buildFinanceLandingMetricsQuery(parseDateOnly("2026-04-21"));

    expect(query.query).toEqual({
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
    expect(query.windows.realized.detail).toContain("1 Apr 2026");
    expect(query.windows.forward.detail).toContain("20 Jul 2026");
  });

  it("returns a manager operations panel alongside the live section summaries", async () => {
    const model = await buildFinanceLandingPageModel({
      member: financeManager(),
      today: parseDateOnly("2026-04-21"),
    });

    expect(model.isManager).toBe(true);
    expect(model.managerWorkspace).toMatchObject({
      badgeLabel: "Manager tools",
      badgeVariant: "secondary",
    });
    expect(
      model.managerWorkspace?.actions.map((action) => ({
        kind: action.kind,
        href: action.href ?? null,
      }))
    ).toEqual([
      {
        kind: "sync",
        href: "/api/finance/sync/run",
      },
    ]);
    expect(
      model.managerWorkspace?.technicalActions.map((action) => action.href ?? null)
    ).toEqual(["/api/finance/sync/status"]);
    expect(model.sync.badgeLabel).toBe("Healthy");
    expect(model.realized.cards[0]).toMatchObject({
      title: "Guest nights",
      value: "30",
    });
    expect(model.realized.cards[2].footnote).toBe("$85.71 average nightly revenue.");
    expect(model.forward.cards[0]).toMatchObject({
      title: "Committed guest nights",
      value: "42",
    });
  });

  it("hides manager-only actions for finance viewers", async () => {
    const model = await buildFinanceLandingPageModel({
      member: financeViewer(),
      today: parseDateOnly("2026-04-21"),
    });

    expect(model.isManager).toBe(false);
    expect(model.managerWorkspace).toBeNull();
    expect(model.sectionLinks).toHaveLength(3);
  });

  it("keeps the sync section live when booking metrics fail", async () => {
    mockGetFinanceBookingMetrics.mockRejectedValue(
      new Error("booking metrics unavailable")
    );

    const model = await buildFinanceLandingPageModel({
      member: financeViewer(),
      today: parseDateOnly("2026-04-21"),
    });

    expect(model.sync.error).toBeUndefined();
    expect(model.sync.cards[0]).toMatchObject({
      title: "Latest sync run",
      value: "Succeeded",
    });
    expect(model.realized.error).toBe(
      "Finance booking metrics are temporarily unavailable."
    );
    expect(model.forward.error).toBe(
      "Finance booking metrics are temporarily unavailable."
    );
    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  it("marks the sync section as stale when the latest successful sync is too old", async () => {
    mockGetFinanceSyncDiagnosticsStatus.mockResolvedValue({
      ...diagnosticsStatus(),
      latestRun: {
        ...diagnosticsStatus().latestRun!,
        startedAt: "2026-04-18T00:00:00.000Z",
        completedAt: "2026-04-18T00:02:00.000Z",
      },
    });

    const model = await buildFinanceLandingPageModel({
      member: financeViewer(),
      today: parseDateOnly("2026-04-21"),
    });

    expect(model.sync.badgeLabel).toBe("Stale");
    expect(model.sync.description).toContain("older than expected");
  });
});
