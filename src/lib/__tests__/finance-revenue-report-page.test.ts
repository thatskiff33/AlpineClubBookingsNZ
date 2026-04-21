import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FinanceSnapshotType } from "@prisma/client";

const { mockListFinanceSnapshots } = vi.hoisted(() => ({
  mockListFinanceSnapshots: vi.fn(),
}));

vi.mock("@/lib/finance-sync-storage", () => ({
  DEFAULT_FINANCE_SNAPSHOT_SCOPE: "default",
  listFinanceSnapshots: mockListFinanceSnapshots,
}));

vi.mock("@/lib/finance-auth", () => ({
  hasFinanceManagerAccess: (level: string) => level === "MANAGER",
}));

import {
  buildDefaultFinanceRevenueReportFilters,
  buildFinanceRevenueReportPageModel,
  resolveFinanceRevenueReportFilters,
} from "@/lib/finance-revenue-report-page";

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
  accommodationIncome: string;
  retailSales: string;
  totalIncome: string;
}) {
  return {
    id: input.id,
    snapshotType: FinanceSnapshotType.PROFIT_AND_LOSS_MONTHLY,
    scope: "default",
    asOfDate: new Date(`${input.asOfDate}T00:00:00.000Z`),
    periodStart: new Date(`${input.periodStart}T00:00:00.000Z`),
    periodEnd: new Date(`${input.periodEnd}T00:00:00.000Z`),
    rowCount: 3,
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
          title: "Income",
          cells: [],
          rows: [
            {
              rowType: "Row",
              title: null,
              cells: [
                { value: "Accommodation income" },
                { value: input.accommodationIncome },
              ],
              rows: [],
            },
            {
              rowType: "Row",
              title: null,
              cells: [{ value: "Retail sales" }, { value: input.retailSales }],
              rows: [],
            },
            {
              rowType: "SummaryRow",
              title: null,
              cells: [{ value: "Total Income" }, { value: input.totalIncome }],
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

const consoleErrorSpy = vi
  .spyOn(console, "error")
  .mockImplementation(() => undefined);

describe("finance revenue report page model", () => {
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
        accommodationIncome: "1450.00",
        retailSales: "50.00",
        totalIncome: "1500.00",
      }),
      profitAndLossSnapshot({
        id: "snapshot-march",
        periodLabel: "March 2026",
        asOfDate: "2026-03-31",
        periodStart: "2026-03-01",
        periodEnd: "2026-03-31",
        sourceUpdatedAt: "2026-04-01T00:15:00.000Z",
        accommodationIncome: "1200.00",
        retailSales: "100.00",
        totalIncome: "1300.00",
      }),
    ]);
  });

  afterEach(() => {
    consoleErrorSpy.mockClear();
    vi.useRealTimers();
  });

  it("uses the latest stored monthly revenue snapshots for managers", async () => {
    const model = await buildFinanceRevenueReportPageModel({
      member: financeManager(),
    });

    expect(model.isManager).toBe(true);
    expect(model.filters).toEqual(buildDefaultFinanceRevenueReportFilters());
    expect(model.summaryCards[0]).toMatchObject({
      title: "Latest synced month",
      value: "$1500.00",
    });
    expect(model.summaryCards[1]).toMatchObject({
      title: "Selected periods total",
      value: "$2800.00",
    });
    expect(model.coverageSummary).toBe(
      "Showing 2 monthly profit-and-loss snapshots from April 2026 backwards."
    );
    expect(model.monthlyRows[0]).toMatchObject({
      periodLabel: "April 2026",
      sourceWindow: "1 Apr 2026 to 30 Apr 2026",
      totalRevenue: "$1500.00",
      lineItemCount: "2",
      asOfDateLabel: "30 Apr 2026",
    });
    expect(model.lineItemRows).toEqual([
      {
        lineItem: "Accommodation income",
        latestPeriodAmount: "$1450.00",
        selectedPeriodsAmount: "$2650.00",
        periodsPresent: "2",
      },
      {
        lineItem: "Retail sales",
        latestPeriodAmount: "$50.00",
        selectedPeriodsAmount: "$150.00",
        periodsPresent: "2",
      },
    ]);
    expect(mockListFinanceSnapshots).toHaveBeenCalledWith({
      snapshotType: FinanceSnapshotType.PROFIT_AND_LOSS_MONTHLY,
      scope: "default",
      limit: 6,
    });
  });

  it("falls back invalid revenue period filters to the default window", () => {
    const resolved = resolveFinanceRevenueReportFilters({
      searchParams: {
        periods: "0",
      },
    });

    expect(resolved.filters).toEqual({
      periods: 6,
    });
    expect(resolved.warnings).toEqual([
      "Revenue periods must be a whole number between 1 and 24. Showing the default 6-period window.",
    ]);
  });

  it("returns a safe unavailable state when no revenue snapshots exist", async () => {
    mockListFinanceSnapshots.mockResolvedValue([]);

    const model = await buildFinanceRevenueReportPageModel({
      member: financeViewer(),
    });

    expect(model.isManager).toBe(false);
    expect(model.loadError).toBe(
      "No monthly finance revenue snapshots are available yet. Run the finance sync and try again once the profit-and-loss dataset has landed."
    );
    expect(model.summaryCards).toEqual([]);
    expect(model.monthlyRows).toEqual([]);
  });

  it("returns a safe unavailable state when revenue snapshot loading fails", async () => {
    mockListFinanceSnapshots.mockRejectedValue(new Error("database timeout"));

    const model = await buildFinanceRevenueReportPageModel({
      member: financeViewer(),
    });

    expect(model.isManager).toBe(false);
    expect(model.loadError).toBe(
      "Finance revenue snapshots are temporarily unavailable. Try again shortly or use manager diagnostics to confirm the latest finance sync status."
    );
    expect(model.lineItemRows).toEqual([]);
    expect(consoleErrorSpy).toHaveBeenCalled();
  });
});
