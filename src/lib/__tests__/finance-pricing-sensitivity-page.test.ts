import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FinanceSnapshotType } from "@prisma/client";

const { mockListFinanceSnapshots, mockGetFinanceBookingMetrics } = vi.hoisted(
  () => ({
    mockListFinanceSnapshots: vi.fn(),
    mockGetFinanceBookingMetrics: vi.fn(),
  })
);

vi.mock("@/lib/finance-sync-storage", () => ({
  DEFAULT_FINANCE_SNAPSHOT_SCOPE: "default",
  listFinanceSnapshots: mockListFinanceSnapshots,
}));

vi.mock("@/lib/finance-booking-metrics", () => ({
  getFinanceBookingMetrics: mockGetFinanceBookingMetrics,
}));

vi.mock("@/lib/finance-auth", () => ({
  hasFinanceManagerAccess: (level: string) => level === "MANAGER",
}));

import {
  buildDefaultFinancePricingSensitivityFilters,
  buildFinancePricingSensitivityPageModel,
  resolveFinancePricingSensitivityFilters,
} from "@/lib/finance-pricing-sensitivity-page";

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

function profitAndLossSnapshot(input: {
  id: string;
  periodLabel: string;
  asOfDate: string;
  periodStart: string;
  periodEnd: string;
  sourceUpdatedAt: string;
  electricity: string;
  insurance: string;
  kitchenSupplies: string;
  totalOperatingExpenses: string;
  totalDirectCosts: string;
}) {
  return {
    id: input.id,
    snapshotType: FinanceSnapshotType.PROFIT_AND_LOSS_MONTHLY,
    scope: "default",
    asOfDate: new Date(`${input.asOfDate}T00:00:00.000Z`),
    periodStart: new Date(`${input.periodStart}T00:00:00.000Z`),
    periodEnd: new Date(`${input.periodEnd}T00:00:00.000Z`),
    rowCount: 5,
    currency: null,
    sourceUpdatedAt: new Date(input.sourceUpdatedAt),
    payload: {
      reportDate: input.asOfDate,
      reportTitles: [
        "Profit and Loss",
        "Tokoroa Alpine Club",
        input.periodLabel,
      ],
      fields: [
        {
          fieldId: "period",
          description: "Period",
          value: input.periodLabel,
        },
      ],
      rows: [
        {
          rowType: "Section",
          title: "Operating Expenses",
          cells: [],
          rows: [
            {
              rowType: "Row",
              title: null,
              cells: [{ value: "Electricity" }, { value: input.electricity }],
              rows: [],
            },
            {
              rowType: "Row",
              title: null,
              cells: [{ value: "Insurance" }, { value: input.insurance }],
              rows: [],
            },
            {
              rowType: "SummaryRow",
              title: null,
              cells: [
                { value: "Total Operating Expenses" },
                { value: input.totalOperatingExpenses },
              ],
              rows: [],
            },
          ],
        },
        {
          rowType: "Section",
          title: "Direct Costs",
          cells: [],
          rows: [
            {
              rowType: "Row",
              title: null,
              cells: [
                { value: "Kitchen supplies" },
                { value: input.kitchenSupplies },
              ],
              rows: [],
            },
            {
              rowType: "SummaryRow",
              title: null,
              cells: [
                { value: "Total Direct Costs" },
                { value: input.totalDirectCosts },
              ],
              rows: [],
            },
          ],
        },
      ],
    },
    syncRunId: "run-1",
    createdAt: new Date("2026-05-01T00:20:00.000Z"),
    updatedAt: new Date("2026-05-01T00:20:00.000Z"),
  };
}

function realizedMetrics(input: {
  from: string;
  to: string;
  dayCount: number;
  guestNights: number;
  bookedRevenueCents: number;
  occupancyRate: number;
  capacityBedNights: number;
}) {
  return {
    generatedAt: "2026-05-01T00:30:00.000Z",
    bookingCount: 3,
    paymentSummary: {
      bookingCount: 3,
      bookingsWithPayment: 3,
      bookingsWithoutPayment: 0,
      paymentStatusBreakdown: {
        PENDING: 0,
        PROCESSING: 0,
        SUCCEEDED: 3,
        FAILED: 0,
        REFUNDED: 0,
        PARTIALLY_REFUNDED: 0,
        NONE: 0,
      },
      additionalPaymentStatusBreakdown: {
        PENDING: 0,
        SUCCEEDED: 0,
        FAILED: 0,
        NONE: 3,
      },
      capturedPrimaryCents: input.bookedRevenueCents,
      capturedAdditionalCents: 0,
      refundedCents: 0,
      netCollectedCents: input.bookedRevenueCents,
      creditAppliedCents: 0,
      changeFeeCents: 0,
    },
    realized: {
      window: {
        from: input.from,
        to: input.to,
        cutoffDate: input.to,
        effectiveFrom: input.from,
        effectiveTo: input.to,
        dayCount: input.dayCount,
      },
      totals: {
        bookingCount: 3,
        bookingNights: 10,
        guestNights: input.guestNights,
        bookedRevenueCents: input.bookedRevenueCents,
        averageNightlyRevenueCents:
          input.guestNights > 0
            ? Math.round(input.bookedRevenueCents / input.guestNights)
            : null,
        occupancy: {
          occupiedBedNights: input.guestNights,
          capacityBedNights: input.capacityBedNights,
          occupancyRate: input.occupancyRate,
        },
      },
      statusBreakdown: {
        CONFIRMED: {
          bookingCount: 1,
          bookingNights: 3,
          guestNights: Math.floor(input.guestNights / 3),
          bookedRevenueCents: Math.round(input.bookedRevenueCents / 3),
        },
        PAID: {
          bookingCount: 1,
          bookingNights: 4,
          guestNights: Math.floor(input.guestNights / 3),
          bookedRevenueCents: Math.round(input.bookedRevenueCents / 3),
        },
        COMPLETED: {
          bookingCount: 1,
          bookingNights: 3,
          guestNights:
            input.guestNights - 2 * Math.floor(input.guestNights / 3),
          bookedRevenueCents:
            input.bookedRevenueCents -
            2 * Math.round(input.bookedRevenueCents / 3),
        },
      },
      byDate: [],
    },
  };
}

const consoleErrorSpy = vi
  .spyOn(console, "error")
  .mockImplementation(() => undefined);

describe("finance pricing sensitivity page model", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-01T00:30:00.000Z"));
    vi.clearAllMocks();
    mockListFinanceSnapshots.mockResolvedValue([
      profitAndLossSnapshot({
        id: "snapshot-april",
        periodLabel: "April 2026",
        asOfDate: "2026-04-30",
        periodStart: "2026-04-01",
        periodEnd: "2026-04-30",
        sourceUpdatedAt: "2026-05-01T00:15:00.000Z",
        electricity: "300.00",
        insurance: "200.00",
        kitchenSupplies: "150.00",
        totalOperatingExpenses: "500.00",
        totalDirectCosts: "150.00",
      }),
      profitAndLossSnapshot({
        id: "snapshot-march",
        periodLabel: "March 2026",
        asOfDate: "2026-03-31",
        periodStart: "2026-03-01",
        periodEnd: "2026-03-31",
        sourceUpdatedAt: "2026-04-01T00:15:00.000Z",
        electricity: "250.00",
        insurance: "200.00",
        kitchenSupplies: "100.00",
        totalOperatingExpenses: "450.00",
        totalDirectCosts: "100.00",
      }),
    ]);
    mockGetFinanceBookingMetrics
      .mockResolvedValueOnce(
        realizedMetrics({
          from: "2026-04-01",
          to: "2026-04-30",
          dayCount: 30,
          guestNights: 20,
          bookedRevenueCents: 160000,
          occupancyRate: 0.023,
          capacityBedNights: 870,
        })
      )
      .mockResolvedValueOnce(
        realizedMetrics({
          from: "2026-03-01",
          to: "2026-03-31",
          dayCount: 31,
          guestNights: 16,
          bookedRevenueCents: 124000,
          occupancyRate: 0.0178,
          capacityBedNights: 899,
        })
      );
  });

  afterEach(() => {
    consoleErrorSpy.mockClear();
    vi.useRealTimers();
  });

  it("builds a pricing-sensitivity view from matched monthly costs and realized booking metrics", async () => {
    const model = await buildFinancePricingSensitivityPageModel({
      member: financeManager(),
    });

    expect(model.isManager).toBe(true);
    expect(model.filters).toEqual(
      buildDefaultFinancePricingSensitivityFilters()
    );
    expect(model.coverageSummary).toBe(
      "Showing 2 stored monthly pricing-sensitivity periods from April 2026 backwards."
    );
    expect(model.summaryCards).toEqual([
      expect.objectContaining({
        title: "Average monthly costs",
        value: "$600.00",
      }),
      expect.objectContaining({
        title: "Average realized guest nights",
        value: "18.0",
        footnote: "Average realized occupancy 2.0%.",
      }),
      expect.objectContaining({
        title: "Average realized revenue / guest night",
        value: "$78.89",
      }),
      expect.objectContaining({
        title: "Average booked revenue less costs",
        value: "+$820.00",
        footnote: "Break-even at realized demand: $33.33 per guest night.",
      }),
    ]);
    expect(model.periodRows).toEqual([
      {
        snapshotId: "snapshot-april",
        periodLabel: "April 2026",
        sourceWindow: "1 Apr 2026 to 30 Apr 2026",
        totalCosts: "$650.00",
        guestNights: "20",
        occupancyRate: "2.3%",
        averageRevenuePerGuestNight: "$80.00",
        breakEvenRevenuePerGuestNight: "$32.50",
        bookedRevenueLessCosts: "+$950.00",
      },
      {
        snapshotId: "snapshot-march",
        periodLabel: "March 2026",
        sourceWindow: "1 Mar 2026 to 31 Mar 2026",
        totalCosts: "$550.00",
        guestNights: "16",
        occupancyRate: "1.8%",
        averageRevenuePerGuestNight: "$77.50",
        breakEvenRevenuePerGuestNight: "$34.38",
        bookedRevenueLessCosts: "+$690.00",
      },
    ]);
    expect(model.scenarioRows[0]).toEqual({
      occupancyAssumption: "20.0%",
      impliedGuestNights: "176.9",
      requiredRevenuePerGuestNight: "$3.39",
      impliedRevenueAtActualRate: "$13955.64",
      bookedRevenueLessCosts: "+$13355.64",
    });
    expect(model.scenarioRows[4]).toEqual({
      occupancyAssumption: "80.0%",
      impliedGuestNights: "707.6",
      requiredRevenuePerGuestNight: "$0.85",
      impliedRevenueAtActualRate: "$55822.56",
      bookedRevenueLessCosts: "+$55222.56",
    });
    expect(mockListFinanceSnapshots).toHaveBeenCalledWith({
      snapshotType: FinanceSnapshotType.PROFIT_AND_LOSS_MONTHLY,
      scope: "default",
      limit: 6,
    });
    expect(mockGetFinanceBookingMetrics).toHaveBeenNthCalledWith(1, {
      realized: {
        from: "2026-04-01",
        to: "2026-04-30",
        cutoffDate: "2026-04-30",
      },
    });
    expect(mockGetFinanceBookingMetrics).toHaveBeenNthCalledWith(2, {
      realized: {
        from: "2026-03-01",
        to: "2026-03-31",
        cutoffDate: "2026-03-31",
      },
    });
  });

  it("falls back invalid pricing-sensitivity period filters to the default window", () => {
    const resolved = resolveFinancePricingSensitivityFilters({
      searchParams: {
        periods: "0",
      },
    });

    expect(resolved.filters).toEqual({
      periods: 6,
    });
    expect(resolved.warnings).toEqual([
      "Pricing-sensitivity periods must be a whole number between 1 and 24. Showing the default 6-period window.",
    ]);
  });

  it("skips a month when realized booking metrics fail and continues with remaining months", async () => {
    mockGetFinanceBookingMetrics.mockReset();
    mockGetFinanceBookingMetrics
      .mockRejectedValueOnce(new Error("metrics offline"))
      .mockResolvedValueOnce(
        realizedMetrics({
          from: "2026-03-01",
          to: "2026-03-31",
          dayCount: 31,
          guestNights: 16,
          bookedRevenueCents: 124000,
          occupancyRate: 0.0178,
          capacityBedNights: 899,
        })
      );

    const model = await buildFinancePricingSensitivityPageModel({
      member: financeViewer(),
    });

    expect(model.isManager).toBe(false);
    expect(model.filterWarnings).toContain(
      "Realized booking metrics for April 2026 could not be loaded and that period was ignored."
    );
    expect(model.periodRows).toHaveLength(1);
    expect(model.periodRows[0]?.periodLabel).toBe("March 2026");
    expect(model.loadError).toBeUndefined();
  });

  it("returns a safe unavailable state when no costs snapshots exist", async () => {
    mockListFinanceSnapshots.mockResolvedValue([]);

    const model = await buildFinancePricingSensitivityPageModel({
      member: financeViewer(),
    });

    expect(model.isManager).toBe(false);
    expect(model.loadError).toBe(
      "The setup status for This pricing report could not be checked right now. Try again shortly."
    );
    expect(model.summaryCards).toEqual([]);
    expect(model.periodRows).toEqual([]);
    expect(model.scenarioRows).toEqual([]);
  });
});
