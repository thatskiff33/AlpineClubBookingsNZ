import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FinanceSnapshotType } from "@prisma/client";

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    financeSnapshot: {
      findMany: vi.fn(),
    },
  },
}));

vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));

vi.mock("@/lib/finance-auth", () => ({
  hasFinanceManagerAccess: (level: string) => level === "MANAGER",
}));

import { buildFinanceCashReportPageModel } from "@/lib/finance-cash-report-page";
import { buildFinanceBalanceSheetReportPageModel } from "@/lib/finance-balance-sheet-report-page";
import { buildFinanceCostsReportPageModel } from "@/lib/finance-costs-report-page";

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

function bankBalanceSnapshot(input: {
  id: string;
  asOfDate: string;
  periodStart: string;
  periodEnd: string;
  sourceUpdatedAt: string;
  operatingBalance: string;
  savingsBalance: string;
  totalBalance: string;
}) {
  return {
    id: input.id,
    snapshotType: FinanceSnapshotType.BANK_BALANCES,
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
        "Bank Summary",
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
          title: "Bank accounts",
          cells: [],
          rows: [
            {
              rowType: "Row",
              title: null,
              cells: [
                { value: "Operating account" },
                { value: input.operatingBalance },
              ],
              rows: [],
            },
            {
              rowType: "Row",
              title: null,
              cells: [
                { value: "Savings account" },
                { value: input.savingsBalance },
              ],
              rows: [],
            },
            {
              rowType: "SummaryRow",
              title: null,
              cells: [{ value: "Total" }, { value: input.totalBalance }],
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

function representativeCashSnapshots() {
  return [
    bankBalanceSnapshot({
      id: "snapshot-april-30",
      asOfDate: "2026-04-30",
      periodStart: "2026-04-01",
      periodEnd: "2026-04-30",
      sourceUpdatedAt: "2026-05-01T00:15:00.000Z",
      operatingBalance: "1000.00",
      savingsBalance: "500.00",
      totalBalance: "1500.00",
    }),
    bankBalanceSnapshot({
      id: "snapshot-april-29",
      asOfDate: "2026-04-29",
      periodStart: "2026-04-01",
      periodEnd: "2026-04-29",
      sourceUpdatedAt: "2026-04-30T00:15:00.000Z",
      operatingBalance: "900.00",
      savingsBalance: "400.00",
      totalBalance: "1300.00",
    }),
  ];
}

function representativeBalanceSheetSnapshots() {
  return [
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
  ];
}

function representativeCostsSnapshots() {
  return [
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
  ];
}

describe("phase 99 finance report output validation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-01T00:30:00.000Z"));
    vi.clearAllMocks();
    mockPrisma.financeSnapshot.findMany.mockImplementation(async (args) => {
      const snapshotType = args?.where?.snapshotType;
      const take = args?.take;

      if (snapshotType === FinanceSnapshotType.BANK_BALANCES) {
        return representativeCashSnapshots().slice(0, take);
      }

      if (snapshotType === FinanceSnapshotType.BALANCE_SHEET) {
        return representativeBalanceSheetSnapshots().slice(0, take);
      }

      if (snapshotType === FinanceSnapshotType.PROFIT_AND_LOSS_MONTHLY) {
        return representativeCostsSnapshots().slice(0, take);
      }

      return [];
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps the representative cash report output aligned with stored bank-balance snapshots", async () => {
    const model = await buildFinanceCashReportPageModel({
      member: financeViewer(),
      searchParams: { periods: "2" },
    });

    expect(model.summaryCards).toMatchObject([
      {
        title: "Latest stored cash position",
        value: "$1500.00",
      },
      {
        title: "Average stored cash position",
        value: "$1400.00",
      },
      {
        title: "Highest stored cash position",
        value: "$1500.00",
        footnote: "As of 30 Apr 2026.",
      },
      {
        title: "Accounts tracked",
        value: "2",
        footnote: "2 accounts appeared in the latest stored snapshot.",
      },
    ]);
    expect(model.snapshotRows).toEqual([
      {
        snapshotId: "snapshot-april-30",
        asOfDateLabel: "30 Apr 2026",
        sourceWindow: "1 Apr 2026 to 30 Apr 2026",
        totalBalance: "$1500.00",
        accountCount: "2",
        sourceUpdatedAtLabel: "1 May 2026, 12:15 pm",
      },
      {
        snapshotId: "snapshot-april-29",
        asOfDateLabel: "29 Apr 2026",
        sourceWindow: "1 Apr 2026 to 29 Apr 2026",
        totalBalance: "$1300.00",
        accountCount: "2",
        sourceUpdatedAtLabel: "30 Apr 2026, 12:15 pm",
      },
    ]);
    expect(model.accountRows).toEqual([
      {
        accountName: "Operating account",
        latestBalance: "$1000.00",
        selectedAverage: "$950.00",
        selectedRange: "$900.00 to $1000.00",
        periodsPresent: "2",
      },
      {
        accountName: "Savings account",
        latestBalance: "$500.00",
        selectedAverage: "$450.00",
        selectedRange: "$400.00 to $500.00",
        periodsPresent: "2",
      },
    ]);
  });

  it("keeps the representative balance-sheet report output aligned with stored balance-sheet snapshots", async () => {
    const model = await buildFinanceBalanceSheetReportPageModel({
      member: financeViewer(),
      searchParams: { periods: "2" },
    });

    expect(model.summaryCards).toMatchObject([
      {
        title: "Latest total assets",
        value: "$2000.00",
      },
      {
        title: "Latest total liabilities",
        value: "$450.00",
      },
      {
        title: "Latest net assets",
        value: "$1550.00",
      },
      {
        title: "Balance-sheet lines tracked",
        value: "6",
        footnote: "6 line items appeared in the latest stored snapshot.",
      },
    ]);
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
  });

  it("keeps the representative costs report output aligned with stored profit-and-loss snapshots", async () => {
    const model = await buildFinanceCostsReportPageModel({
      member: financeViewer(),
      searchParams: { periods: "2" },
    });

    expect(model.summaryCards).toMatchObject([
      {
        title: "Latest synced month",
        value: "$650.00",
      },
      {
        title: "Selected periods total",
        value: "$1200.00",
      },
      {
        title: "Average monthly costs",
        value: "$600.00",
      },
      {
        title: "Cost lines tracked",
        value: "3",
        footnote: "2 periods loaded from durable FinanceSnapshot storage.",
      },
    ]);
    expect(model.monthlyRows).toEqual([
      {
        snapshotId: "snapshot-april",
        periodLabel: "April 2026",
        sourceWindow: "1 Apr 2026 to 30 Apr 2026",
        totalCosts: "$650.00",
        lineItemCount: "3",
        asOfDateLabel: "30 Apr 2026",
        sourceUpdatedAtLabel: "1 May 2026, 12:15 pm",
      },
      {
        snapshotId: "snapshot-march",
        periodLabel: "March 2026",
        sourceWindow: "1 Mar 2026 to 31 Mar 2026",
        totalCosts: "$550.00",
        lineItemCount: "3",
        asOfDateLabel: "31 Mar 2026",
        sourceUpdatedAtLabel: "1 Apr 2026, 1:15 pm",
      },
    ]);
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
  });
});
