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
  buildDefaultFinanceCostsReportFilters,
  buildFinanceCostsReportPageModel,
  resolveFinanceCostsReportFilters,
} from "@/lib/finance-costs-report-page";

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
        "Example Alpine Club",
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

const consoleErrorSpy = vi
  .spyOn(console, "error")
  .mockImplementation(() => undefined);

describe("finance costs report page model", () => {
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
  });

  afterEach(() => {
    consoleErrorSpy.mockClear();
    vi.useRealTimers();
  });

  it("uses the latest stored monthly costs snapshots for managers", async () => {
    const model = await buildFinanceCostsReportPageModel({
      member: financeManager(),
    });

    expect(model.isManager).toBe(true);
    expect(model.filters).toEqual(buildDefaultFinanceCostsReportFilters());
    expect(model.summaryCards[0]).toMatchObject({
      title: "Latest synced month",
      value: "$650.00",
    });
    expect(model.summaryCards[1]).toMatchObject({
      title: "Selected periods total",
      value: "$1200.00",
    });
    expect(model.coverageSummary).toBe(
      "Showing 2 monthly profit-and-loss snapshots with cost detail from April 2026 backwards."
    );
    expect(model.monthlyRows[0]).toMatchObject({
      periodLabel: "April 2026",
      sourceWindow: "1 Apr 2026 to 30 Apr 2026",
      totalCosts: "$650.00",
      lineItemCount: "3",
      asOfDateLabel: "30 Apr 2026",
    });
    expect(model.lineItemRows).toEqual([
      {
        section: "Direct Costs",
        lineItem: "Kitchen supplies",
        latestPeriodAmount: "$150.00",
        selectedPeriodsAmount: "$250.00",
        periodsPresent: "2",
      },
      {
        section: "Operating Expenses",
        lineItem: "Electricity",
        latestPeriodAmount: "$300.00",
        selectedPeriodsAmount: "$550.00",
        periodsPresent: "2",
      },
      {
        section: "Operating Expenses",
        lineItem: "Insurance",
        latestPeriodAmount: "$200.00",
        selectedPeriodsAmount: "$400.00",
        periodsPresent: "2",
      },
    ]);
    expect(mockListFinanceSnapshots).toHaveBeenCalledWith({
      snapshotType: FinanceSnapshotType.PROFIT_AND_LOSS_MONTHLY,
      scope: "default",
      limit: 6,
    });
  });

  it("falls back invalid costs period filters to the default window", () => {
    const resolved = resolveFinanceCostsReportFilters({
      searchParams: {
        periods: "0",
      },
    });

    expect(resolved.filters).toEqual({
      periods: 6,
    });
    expect(resolved.warnings).toEqual([
      "Costs periods must be a whole number between 1 and 24. Showing the default 6-period window.",
    ]);
  });

  it("returns a safe unavailable state when no costs snapshots exist", async () => {
    mockListFinanceSnapshots.mockResolvedValue([]);

    const model = await buildFinanceCostsReportPageModel({
      member: financeViewer(),
    });

    expect(model.isManager).toBe(false);
    expect(model.loadError).toBe(
      "The setup status for This costs report could not be checked right now. Try again shortly."
    );
    expect(model.summaryCards).toEqual([]);
    expect(model.monthlyRows).toEqual([]);
  });

  it("returns a safe unavailable state when costs snapshot loading fails", async () => {
    mockListFinanceSnapshots.mockRejectedValue(new Error("database timeout"));

    const model = await buildFinanceCostsReportPageModel({
      member: financeViewer(),
    });

    expect(model.isManager).toBe(false);
    expect(model.loadError).toBe(
      "This costs report could not be loaded right now. Try again shortly."
    );
    expect(model.lineItemRows).toEqual([]);
    expect(consoleErrorSpy).toHaveBeenCalled();
  });
});
