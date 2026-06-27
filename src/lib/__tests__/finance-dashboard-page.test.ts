import { beforeEach, describe, expect, it, vi } from "vitest";
import { FinanceSnapshotType } from "@prisma/client";

const {
  mockBuildFinanceMappedPnlSummary,
  mockBuildFinanceRevenueReconciliation,
  mockGetFinanceBookingMetrics,
  mockGetFinanceSyncDiagnosticsStatus,
  mockListFinanceSnapshots,
  mockParseBalanceSheetSnapshot,
  mockParseCashSnapshot,
  mockSeasonFindMany,
} = vi.hoisted(() => ({
  mockBuildFinanceMappedPnlSummary: vi.fn(),
  mockBuildFinanceRevenueReconciliation: vi.fn(),
  mockGetFinanceBookingMetrics: vi.fn(),
  mockGetFinanceSyncDiagnosticsStatus: vi.fn(),
  mockListFinanceSnapshots: vi.fn(),
  mockParseBalanceSheetSnapshot: vi.fn(),
  mockParseCashSnapshot: vi.fn(),
  mockSeasonFindMany: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    season: {
      findMany: mockSeasonFindMany,
    },
  },
}));

vi.mock("@/lib/finance-sync-diagnostics", () => ({
  getFinanceSyncDiagnosticsStatus: mockGetFinanceSyncDiagnosticsStatus,
}));

vi.mock("@/lib/finance-booking-metrics", () => ({
  getFinanceBookingMetrics: mockGetFinanceBookingMetrics,
}));

vi.mock("@/lib/finance-report-mappings", () => ({
  buildFinanceMappedPnlSummary: mockBuildFinanceMappedPnlSummary,
}));

vi.mock("@/lib/finance-revenue-reconciliation", () => ({
  buildFinanceRevenueReconciliation: mockBuildFinanceRevenueReconciliation,
}));

vi.mock("@/lib/finance-sync-storage", () => ({
  DEFAULT_FINANCE_SNAPSHOT_SCOPE: "default",
  listFinanceSnapshots: mockListFinanceSnapshots,
}));

vi.mock("@/lib/finance-cash-report-page", () => ({
  parseCashSnapshot: mockParseCashSnapshot,
}));

vi.mock("@/lib/finance-balance-sheet-report-page", () => ({
  parseBalanceSheetSnapshot: mockParseBalanceSheetSnapshot,
}));

import { buildFinanceDashboardPageModel } from "@/lib/finance-dashboard-page";
import type { FinanceDashboardView } from "@/lib/finance-dashboard-ranges";

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
  const bucket = {
    bookingCount: 2,
    bookingNights: 3,
    guestNights: 6,
    bookedRevenueCents: 24_000,
    occupancy: {
      occupiedBedNights: 6,
      capacityBedNights: 60,
      occupancyRate: 0.1,
    },
  };
  return {
    generatedAt: "2026-06-28T00:00:00.000Z",
    bookingCount: 2,
    paymentSummary: {
      bookingCount: 2,
      bookingsWithPayment: 2,
      bookingsWithoutPayment: 0,
      paymentStatusBreakdown: {
        PENDING: 0,
        PROCESSING: 0,
        SUCCEEDED: 2,
        FAILED: 0,
        REFUNDED: 0,
        PARTIALLY_REFUNDED: 0,
        NONE: 0,
      },
      additionalPaymentStatusBreakdown: {
        PENDING: 0,
        SUCCEEDED: 0,
        FAILED: 0,
        NONE: 2,
      },
      capturedPrimaryCents: 24_000,
      capturedAdditionalCents: 0,
      refundedCents: 0,
      netCollectedCents: 24_000,
      creditAppliedCents: 0,
      changeFeeCents: 0,
    },
    realized: {
      window: {
        from: "2026-05-01",
        to: "2026-05-31",
        cutoffDate: "2026-05-31",
        effectiveFrom: "2026-05-01",
        effectiveTo: "2026-05-31",
        dayCount: 31,
      },
      totals: {
        ...bucket,
        averageNightlyRevenueCents: 8_000,
      },
      statusBreakdown: {
        CONFIRMED: bucket,
        PAID: { ...bucket, bookingCount: 0, guestNights: 0, bookedRevenueCents: 0 },
        COMPLETED: { ...bucket, bookingCount: 0, guestNights: 0, bookedRevenueCents: 0 },
      },
      byDate: [
        {
          date: "2026-05-01",
          bookingCount: 1,
          guestNights: 2,
          occupiedBeds: 2,
          availableBeds: 30,
          occupancyRate: 0.0667,
          bookedRevenueCents: 8_000,
        },
      ],
    },
    forward: {
      window: {
        from: "2026-07-01",
        to: "2026-07-31",
        asOfDate: "2026-05-31",
        effectiveFrom: "2026-07-01",
        effectiveTo: "2026-07-31",
        dayCount: 31,
      },
      totals: {
        committed: {
          ...bucket,
          statusBreakdown: { PAID: bucket },
        },
        atRisk: {
          ...bucket,
          guestNights: 3,
          statusBreakdown: {
            PENDING: { ...bucket, guestNights: 3 },
            CONFIRMED: { ...bucket, bookingCount: 0, guestNights: 0 },
          },
        },
        totalPipeline: { ...bucket, guestNights: 9 },
      },
      byDate: [
        {
          date: "2026-07-01",
          committed: {
            date: "2026-07-01",
            bookingCount: 1,
            guestNights: 2,
            occupiedBeds: 2,
            availableBeds: 30,
            occupancyRate: 0.0667,
            bookedRevenueCents: 8_000,
          },
          atRisk: {
            date: "2026-07-01",
            bookingCount: 1,
            guestNights: 1,
            occupiedBeds: 1,
            availableBeds: 30,
            occupancyRate: 0.0333,
            bookedRevenueCents: 4_000,
          },
          totalPipeline: {
            date: "2026-07-01",
            bookingCount: 2,
            guestNights: 3,
            occupiedBeds: 3,
            availableBeds: 30,
            occupancyRate: 0.1,
            bookedRevenueCents: 12_000,
          },
        },
      ],
    },
  };
}

function mappedSummary(kind: "REVENUE" | "EXPENSE") {
  return {
    kind,
    from: "2026-05-01",
    to: "2026-05-31",
    compareFrom: "2026-04-01",
    compareTo: "2026-04-30",
    amountCents: kind === "REVENUE" ? 100_000 : 40_000,
    comparisonAmountCents: kind === "REVENUE" ? 80_000 : 35_000,
    deltaCents: kind === "REVENUE" ? 20_000 : 5_000,
    formattedAmount: kind === "REVENUE" ? "$1000.00" : "$400.00",
    formattedComparisonAmount: kind === "REVENUE" ? "$800.00" : "$350.00",
    formattedDelta: kind === "REVENUE" ? "+$200.00" : "+$50.00",
    groups: [
      {
        id: "group-1",
        name: kind === "REVENUE" ? "Hut Fees" : "Insurance",
        kind,
        sortOrder: 10,
        amountCents: kind === "REVENUE" ? 100_000 : 40_000,
        comparisonAmountCents: kind === "REVENUE" ? 80_000 : 35_000,
        deltaCents: kind === "REVENUE" ? 20_000 : 5_000,
        formattedAmount: kind === "REVENUE" ? "$1000.00" : "$400.00",
        formattedComparisonAmount: kind === "REVENUE" ? "$800.00" : "$350.00",
        formattedDelta: kind === "REVENUE" ? "+$200.00" : "+$50.00",
        lineCount: 1,
        lines: [
          {
            key: "line-1",
            sectionLabel: kind === "REVENUE" ? "Income" : "Expenses",
            lineLabel: kind === "REVENUE" ? "Hut Fees" : "Insurance",
            accountCode: kind === "REVENUE" ? "200" : null,
            amountCents: kind === "REVENUE" ? 100_000 : 40_000,
            comparisonAmountCents: kind === "REVENUE" ? 80_000 : 35_000,
            formattedAmount: kind === "REVENUE" ? "$1000.00" : "$400.00",
            formattedComparisonAmount: kind === "REVENUE" ? "$800.00" : "$350.00",
            formattedDelta: kind === "REVENUE" ? "+$200.00" : "+$50.00",
            periodsPresent: 1,
          },
        ],
      },
    ],
    mix: [
      {
        name: kind === "REVENUE" ? "Hut Fees" : "Insurance",
        valueCents: kind === "REVENUE" ? 100_000 : 40_000,
      },
    ],
    trend: [{ label: "May 2026", amountCents: kind === "REVENUE" ? 100_000 : 40_000 }],
    availableExpenseLines:
      kind === "EXPENSE"
        ? [{ value: "Insurance", label: "Insurance", categoryId: "group-1" }]
        : [],
    warnings: [],
    selectedSnapshotCount: 1,
    comparisonSnapshotCount: 1,
  };
}

describe("finance dashboard page model", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSeasonFindMany.mockResolvedValue([]);
    mockGetFinanceSyncDiagnosticsStatus.mockResolvedValue({
      latestRun: {
        status: "SUCCEEDED",
        startedAt: "2026-06-28T00:00:00.000Z",
        completedAt: "2026-06-28T00:02:00.000Z",
        snapshotCount: 8,
        totalRowCount: 120,
      },
      cron: { schedule: "0 5 * * *", timezone: "Pacific/Auckland" },
    });
    mockGetFinanceBookingMetrics.mockResolvedValue(bookingMetrics());
    mockBuildFinanceMappedPnlSummary.mockImplementation(async (input: { kind: "REVENUE" | "EXPENSE" }) =>
      mappedSummary(input.kind)
    );
    mockBuildFinanceRevenueReconciliation.mockResolvedValue({
      overallStatus: "TIES",
      periods: [
        {
          periodLabel: "May 2026",
          varianceCents: 0,
          xeroHutFeesIncomeCents: 100_000,
          bookingHutFeesCents: 100_000,
        },
      ],
    });
    mockListFinanceSnapshots.mockResolvedValue([{ id: "snapshot-1" }]);
    mockParseCashSnapshot.mockReturnValue({
      totalBalanceCents: 150_000,
      totalBalance: "$1500.00",
      accountCount: 2,
      snapshotLabel: "31 May 2026",
      sourceUpdatedAtLabel: "31 May 2026, 12:00 pm",
      accounts: [
        { label: "Operating", balanceCents: 100_000 },
        { label: "Savings", balanceCents: 50_000 },
      ],
    });
    mockParseBalanceSheetSnapshot.mockReturnValue({
      snapshotLabel: "31 May 2026",
      totalAssets: "$5000.00",
      totalLiabilities: "$1200.00",
      netAssets: "$3800.00",
      totalAssetsCents: 500_000,
      totalLiabilitiesCents: 120_000,
      netAssetsCents: 380_000,
      currentAssets: "$2000.00",
      currentLiabilities: "$500.00",
      workingCapital: "$1500.00",
      currentAssetsCents: 200_000,
      currentLiabilitiesCents: 50_000,
      workingCapitalCents: 150_000,
      currentRatio: 4,
      lineItemCount: 8,
    });
  });

  it.each<FinanceDashboardView>([
    "bookings",
    "revenue",
    "costs",
    "pricing-sensitivity",
    "working-capital",
    "cash",
    "balance-sheet",
  ])("builds the %s dashboard from stored/modelled data", async (view) => {
    const model = await buildFinanceDashboardPageModel({
      member: financeManager(),
      searchParams: { view },
    });

    expect(model.selection.view).toBe(view);
    expect(model.cards.length).toBeGreaterThan(0);
    expect(model.exportSections[0].title).toBe("Dashboard selection");
    expect(model.sourceNotes.length).toBeGreaterThan(0);
  });

  it("surfaces missing stored snapshot coverage as a compact warning", async () => {
    mockListFinanceSnapshots.mockImplementation(async (input?: { snapshotType?: FinanceSnapshotType }) => {
      if (input?.snapshotType === FinanceSnapshotType.BANK_BALANCES) {
        return [];
      }
      return [{ id: "snapshot-1" }];
    });

    const model = await buildFinanceDashboardPageModel({
      member: financeManager(),
      searchParams: { view: "cash" },
    });

    expect(model.warnings).toContain(
      "No stored bank-balance snapshots cover the selected range."
    );
  });
});
