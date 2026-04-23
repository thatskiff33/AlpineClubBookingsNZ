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
  buildDefaultFinanceBalanceSheetReportFilters,
  buildFinanceBalanceSheetReportPageModel,
  resolveFinanceBalanceSheetReportFilters,
} from "@/lib/finance-balance-sheet-report-page";

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

function balanceSheetSnapshot(input: {
  id: string;
  asOfDate: string;
  periodEnd: string;
  sourceUpdatedAt: string;
  bankBalance: string;
  receivables: string;
  equipment: string;
  totalAssets: string;
  payables: string;
  totalLiabilities: string;
  retainedEarnings: string;
  currentEarnings: string;
  totalEquity: string;
}) {
  return {
    id: input.id,
    snapshotType: FinanceSnapshotType.BALANCE_SHEET,
    scope: "default",
    asOfDate: new Date(`${input.asOfDate}T00:00:00.000Z`),
    periodStart: null,
    periodEnd: new Date(`${input.periodEnd}T00:00:00.000Z`),
    rowCount: 10,
    currency: null,
    sourceUpdatedAt: new Date(input.sourceUpdatedAt),
    payload: {
      reportDate: input.asOfDate,
      reportTitles: [
        "Balance Sheet",
        "Tokoroa Alpine Club",
        `As at ${input.asOfDate}`,
      ],
      fields: [
        {
          fieldId: "period",
          description: "Period",
          value: input.asOfDate,
        },
      ],
      rows: [
        {
          rowType: "Section",
          title: "Assets",
          cells: [],
          rows: [
            {
              rowType: "Section",
              title: "Current Assets",
              cells: [],
              rows: [
                {
                  rowType: "Row",
                  title: null,
                  cells: [{ value: "Bank" }, { value: input.bankBalance }],
                  rows: [],
                },
                {
                  rowType: "Row",
                  title: null,
                  cells: [
                    { value: "Accounts receivable" },
                    { value: input.receivables },
                  ],
                  rows: [],
                },
                {
                  rowType: "SummaryRow",
                  title: null,
                  cells: [
                    { value: "Total Current Assets" },
                    {
                      value: (
                        Number.parseFloat(input.bankBalance) +
                        Number.parseFloat(input.receivables)
                      ).toFixed(2),
                    },
                  ],
                  rows: [],
                },
              ],
            },
            {
              rowType: "Section",
              title: "Fixed Assets",
              cells: [],
              rows: [
                {
                  rowType: "Row",
                  title: null,
                  cells: [{ value: "Equipment" }, { value: input.equipment }],
                  rows: [],
                },
                {
                  rowType: "SummaryRow",
                  title: null,
                  cells: [
                    { value: "Total Fixed Assets" },
                    { value: input.equipment },
                  ],
                  rows: [],
                },
              ],
            },
            {
              rowType: "SummaryRow",
              title: null,
              cells: [{ value: "Total Assets" }, { value: input.totalAssets }],
              rows: [],
            },
          ],
        },
        {
          rowType: "Section",
          title: "Liabilities",
          cells: [],
          rows: [
            {
              rowType: "Section",
              title: "Current Liabilities",
              cells: [],
              rows: [
                {
                  rowType: "Row",
                  title: null,
                  cells: [
                    { value: "Accounts payable" },
                    { value: input.payables },
                  ],
                  rows: [],
                },
                {
                  rowType: "SummaryRow",
                  title: null,
                  cells: [
                    { value: "Total Current Liabilities" },
                    { value: input.totalLiabilities },
                  ],
                  rows: [],
                },
              ],
            },
            {
              rowType: "SummaryRow",
              title: null,
              cells: [
                { value: "Total Liabilities" },
                { value: input.totalLiabilities },
              ],
              rows: [],
            },
          ],
        },
        {
          rowType: "Section",
          title: "Equity",
          cells: [],
          rows: [
            {
              rowType: "Row",
              title: null,
              cells: [
                { value: "Retained earnings" },
                { value: input.retainedEarnings },
              ],
              rows: [],
            },
            {
              rowType: "Row",
              title: null,
              cells: [
                { value: "Current earnings" },
                { value: input.currentEarnings },
              ],
              rows: [],
            },
            {
              rowType: "SummaryRow",
              title: null,
              cells: [{ value: "Total Equity" }, { value: input.totalEquity }],
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

describe("finance balance-sheet report page model", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-01T00:30:00.000Z"));
    vi.clearAllMocks();
    mockListFinanceSnapshots.mockResolvedValue([
      balanceSheetSnapshot({
        id: "snapshot-april-30",
        asOfDate: "2026-04-30",
        periodEnd: "2026-04-30",
        sourceUpdatedAt: "2026-05-01T00:15:00.000Z",
        bankBalance: "1000.00",
        receivables: "400.00",
        equipment: "600.00",
        totalAssets: "2000.00",
        payables: "450.00",
        totalLiabilities: "450.00",
        retainedEarnings: "1200.00",
        currentEarnings: "350.00",
        totalEquity: "1550.00",
      }),
      balanceSheetSnapshot({
        id: "snapshot-april-29",
        asOfDate: "2026-04-29",
        periodEnd: "2026-04-29",
        sourceUpdatedAt: "2026-04-30T00:15:00.000Z",
        bankBalance: "900.00",
        receivables: "350.00",
        equipment: "650.00",
        totalAssets: "1900.00",
        payables: "500.00",
        totalLiabilities: "500.00",
        retainedEarnings: "1100.00",
        currentEarnings: "300.00",
        totalEquity: "1400.00",
      }),
    ]);
  });

  afterEach(() => {
    consoleErrorSpy.mockClear();
    vi.useRealTimers();
  });

  it("uses the latest stored balance-sheet snapshots for managers", async () => {
    const model = await buildFinanceBalanceSheetReportPageModel({
      member: financeManager(),
    });

    expect(model.isManager).toBe(true);
    expect(model.filters).toEqual(
      buildDefaultFinanceBalanceSheetReportFilters()
    );
    expect(model.summaryCards[0]).toMatchObject({
      title: "Latest total assets",
      value: "$2000.00",
    });
    expect(model.summaryCards[1]).toMatchObject({
      title: "Latest total liabilities",
      value: "$450.00",
    });
    expect(model.summaryCards[2]).toMatchObject({
      title: "Latest net assets",
      value: "$1550.00",
    });
    expect(model.summaryCards[3]).toMatchObject({
      title: "Balance-sheet lines tracked",
      value: "6",
      footnote: "6 line items appeared in the latest stored snapshot.",
    });
    expect(model.coverageSummary).toBe(
      "Showing 2 stored balance-sheet snapshots from 30 Apr 2026 backwards."
    );
    expect(model.snapshotRows).toEqual([
      {
        snapshotId: "snapshot-april-30",
        asOfDateLabel: "30 Apr 2026",
        sourceWindow: "Through 30 Apr 2026",
        totalAssets: "$2000.00",
        totalLiabilities: "$450.00",
        netAssets: "$1550.00",
        lineItemCount: "6",
        sourceUpdatedAtLabel: "1 May 2026, 12:15 pm",
      },
      {
        snapshotId: "snapshot-april-29",
        asOfDateLabel: "29 Apr 2026",
        sourceWindow: "Through 29 Apr 2026",
        totalAssets: "$1900.00",
        totalLiabilities: "$500.00",
        netAssets: "$1400.00",
        lineItemCount: "6",
        sourceUpdatedAtLabel: "30 Apr 2026, 12:15 pm",
      },
    ]);
    expect(model.lineItemRows).toEqual([
      {
        section: "Assets / Current Assets",
        lineItem: "Bank",
        latestAmount: "$1000.00",
        selectedAverage: "$950.00",
        selectedRange: "$900.00 to $1000.00",
        periodsPresent: "2",
      },
      {
        section: "Assets / Current Assets",
        lineItem: "Accounts receivable",
        latestAmount: "$400.00",
        selectedAverage: "$375.00",
        selectedRange: "$350.00 to $400.00",
        periodsPresent: "2",
      },
      {
        section: "Assets / Fixed Assets",
        lineItem: "Equipment",
        latestAmount: "$600.00",
        selectedAverage: "$625.00",
        selectedRange: "$600.00 to $650.00",
        periodsPresent: "2",
      },
      {
        section: "Liabilities / Current Liabilities",
        lineItem: "Accounts payable",
        latestAmount: "$450.00",
        selectedAverage: "$475.00",
        selectedRange: "$450.00 to $500.00",
        periodsPresent: "2",
      },
      {
        section: "Equity",
        lineItem: "Retained earnings",
        latestAmount: "$1200.00",
        selectedAverage: "$1150.00",
        selectedRange: "$1100.00 to $1200.00",
        periodsPresent: "2",
      },
      {
        section: "Equity",
        lineItem: "Current earnings",
        latestAmount: "$350.00",
        selectedAverage: "$325.00",
        selectedRange: "$300.00 to $350.00",
        periodsPresent: "2",
      },
    ]);
    expect(mockListFinanceSnapshots).toHaveBeenCalledWith({
      snapshotType: FinanceSnapshotType.BALANCE_SHEET,
      scope: "default",
      limit: 6,
    });
  });

  it("falls back invalid balance-sheet period filters to the default window", () => {
    const resolved = resolveFinanceBalanceSheetReportFilters({
      searchParams: {
        periods: "0",
      },
    });

    expect(resolved.filters).toEqual({
      periods: 6,
    });
    expect(resolved.warnings).toEqual([
      "Balance-sheet periods must be a whole number between 1 and 24. Showing the default 6-period window.",
    ]);
  });

  it("returns a safe unavailable state when no balance-sheet snapshots exist", async () => {
    mockListFinanceSnapshots.mockResolvedValue([]);

    const model = await buildFinanceBalanceSheetReportPageModel({
      member: financeViewer(),
    });

    expect(model.isManager).toBe(false);
    expect(model.loadError).toBe(
      "No balance-sheet snapshots are available yet. Run the finance sync and try again once the balance-sheet dataset has landed."
    );
    expect(model.summaryCards).toEqual([]);
    expect(model.snapshotRows).toEqual([]);
  });

  it("returns a safe unavailable state when balance-sheet snapshot loading fails", async () => {
    mockListFinanceSnapshots.mockRejectedValue(new Error("database timeout"));

    const model = await buildFinanceBalanceSheetReportPageModel({
      member: financeViewer(),
    });

    expect(model.isManager).toBe(false);
    expect(model.loadError).toBe(
      "Finance balance-sheet snapshots are temporarily unavailable. Try again shortly or use manager diagnostics to confirm the latest finance sync status."
    );
    expect(model.lineItemRows).toEqual([]);
    expect(consoleErrorSpy).toHaveBeenCalled();
  });
});
