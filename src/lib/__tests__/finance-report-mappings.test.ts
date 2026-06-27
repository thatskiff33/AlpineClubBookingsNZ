import { beforeEach, describe, expect, it, vi } from "vitest";
import { FinanceSnapshotType } from "@prisma/client";

const {
  mockCategoryFindMany,
  mockCategoryUpsert,
  mockListFinanceSnapshots,
} = vi.hoisted(() => ({
  mockCategoryFindMany: vi.fn(),
  mockCategoryUpsert: vi.fn(),
  mockListFinanceSnapshots: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    financeReportCategory: {
      findMany: mockCategoryFindMany,
      upsert: mockCategoryUpsert,
    },
  },
}));

vi.mock("@/lib/finance-sync-storage", () => ({
  DEFAULT_FINANCE_SNAPSHOT_SCOPE: "default",
  listFinanceSnapshots: mockListFinanceSnapshots,
}));

import {
  buildFinanceMappedPnlSummary,
  UNMAPPED_FINANCE_CATEGORY_ID,
  validateFinanceReportMappingsInput,
} from "@/lib/finance-report-mappings";

function row(label: string, amount: string, accountId: string | null = null) {
  return {
    rowType: "Row",
    title: null,
    cells: [
      {
        value: label,
        attributes: accountId ? [{ id: "account", value: accountId }] : [],
      },
      { value: amount, attributes: [] },
    ],
    rows: [],
  };
}

function pnlSnapshot(input: {
  id: string;
  periodStart: string;
  periodEnd: string;
  periodLabel: string;
  sectionTitle: string;
  rows: unknown[];
}) {
  return {
    id: input.id,
    snapshotType: FinanceSnapshotType.PROFIT_AND_LOSS_MONTHLY,
    scope: "default",
    asOfDate: new Date(`${input.periodEnd}T00:00:00.000Z`),
    periodStart: new Date(`${input.periodStart}T00:00:00.000Z`),
    periodEnd: new Date(`${input.periodEnd}T00:00:00.000Z`),
    rowCount: input.rows.length,
    currency: "NZD",
    sourceUpdatedAt: null,
    payload: {
      reportDate: input.periodEnd,
      reportTitles: ["Profit and Loss"],
      fields: [{ fieldId: "period", description: "Period", value: input.periodLabel }],
      rows: [
        {
          rowType: "Section",
          title: input.sectionTitle,
          cells: [],
          rows: input.rows,
        },
      ],
    },
    syncRunId: "run-1",
    createdAt: new Date(`${input.periodEnd}T00:00:00.000Z`),
    updatedAt: new Date(`${input.periodEnd}T00:00:00.000Z`),
  };
}

function chartSnapshot() {
  return {
    id: "chart-1",
    snapshotType: FinanceSnapshotType.CHART_OF_ACCOUNTS,
    scope: "default",
    asOfDate: new Date("2026-04-30T00:00:00.000Z"),
    periodStart: null,
    periodEnd: null,
    rowCount: 1,
    currency: null,
    sourceUpdatedAt: null,
    payload: {
      accounts: [{ accountId: "acct-hut", code: "200" }],
    },
    syncRunId: "run-1",
    createdAt: new Date("2026-04-30T00:00:00.000Z"),
    updatedAt: new Date("2026-04-30T00:00:00.000Z"),
  };
}

const categories = [
  {
    id: "cat-hut-fees",
    kind: "REVENUE",
    name: "Hut Fees",
    sortOrder: 10,
    archived: false,
    mappings: [
      {
        id: "map-hut",
        accountCode: "200",
        sectionLabel: null,
        lineLabel: null,
      },
    ],
  },
  {
    id: "cat-entrance",
    kind: "REVENUE",
    name: "Entrance Fees",
    sortOrder: 20,
    archived: false,
    mappings: [
      {
        id: "map-entrance",
        accountCode: null,
        sectionLabel: "Income",
        lineLabel: "Entrance Fees",
      },
    ],
  },
  {
    id: "cat-insurance",
    kind: "EXPENSE",
    name: "Insurance & Compliance",
    sortOrder: 50,
    archived: false,
    mappings: [
      {
        id: "map-insurance",
        accountCode: null,
        sectionLabel: "Expenses",
        lineLabel: "Insurance",
      },
    ],
  },
];

describe("finance report mappings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCategoryUpsert.mockResolvedValue({});
    mockCategoryFindMany.mockResolvedValue(categories);
    mockListFinanceSnapshots.mockImplementation(async (input?: { snapshotType?: FinanceSnapshotType }) => {
      if (input?.snapshotType === FinanceSnapshotType.CHART_OF_ACCOUNTS) {
        return [chartSnapshot()];
      }
      return [
        pnlSnapshot({
          id: "april",
          periodStart: "2026-04-01",
          periodEnd: "2026-04-30",
          periodLabel: "April 2026",
          sectionTitle: "Income",
          rows: [
            row("Hut Fees", "100.01", "acct-hut"),
            row("Entrance Fees", "50.02"),
            row("Unmapped Revenue", "5.03"),
            {
              rowType: "Section",
              title: "Other Income",
              cells: [],
              rows: [row("Unmapped Revenue", "7.04")],
            },
          ],
        }),
        pnlSnapshot({
          id: "march",
          periodStart: "2026-03-01",
          periodEnd: "2026-03-31",
          periodLabel: "March 2026",
          sectionTitle: "Income",
          rows: [
            row("Hut Fees", "80.00", "acct-hut"),
            row("Entrance Fees", "20.00"),
            row("Unmapped Revenue", "2.00"),
          ],
        }),
      ];
    });
  });

  it("aggregates mapped, unmapped, account-code, duplicate-label, and comparison totals in cents", async () => {
    const summary = await buildFinanceMappedPnlSummary({
      kind: "REVENUE",
      from: "2026-04-01",
      to: "2026-04-30",
      compareFrom: "2026-03-01",
      compareTo: "2026-03-31",
    });

    expect(summary.amountCents).toBe(16_210);
    expect(summary.comparisonAmountCents).toBe(10_200);
    expect(summary.deltaCents).toBe(6_010);

    const hutFees = summary.groups.find((group) => group.id === "cat-hut-fees");
    expect(hutFees).toMatchObject({
      amountCents: 10_001,
      comparisonAmountCents: 8_000,
      formattedDelta: "+$20.01",
    });
    expect(hutFees?.lines[0]).toMatchObject({
      lineLabel: "Hut Fees",
      accountCode: "200",
    });

    expect(summary.groups.find((group) => group.id === "cat-entrance")).toMatchObject({
      amountCents: 5_002,
      comparisonAmountCents: 2_000,
    });

    const unmapped = summary.groups.find(
      (group) => group.id === UNMAPPED_FINANCE_CATEGORY_ID
    );
    expect(unmapped).toMatchObject({
      name: "Unmapped",
      amountCents: 1_207,
      comparisonAmountCents: 200,
      lineCount: 2,
    });
    expect(unmapped?.lines.map((line) => line.sectionLabel).sort()).toEqual([
      "Income",
      "Income / Other Income",
    ]);
  });

  it("filters expense totals by category and individual Xero line", async () => {
    mockListFinanceSnapshots.mockImplementation(async (input?: { snapshotType?: FinanceSnapshotType }) => {
      if (input?.snapshotType === FinanceSnapshotType.CHART_OF_ACCOUNTS) {
        return [chartSnapshot()];
      }
      return [
        pnlSnapshot({
          id: "april-expense",
          periodStart: "2026-04-01",
          periodEnd: "2026-04-30",
          periodLabel: "April 2026",
          sectionTitle: "Expenses",
          rows: [row("Insurance", "12.34"), row("Utilities", "4.56")],
        }),
      ];
    });

    const summary = await buildFinanceMappedPnlSummary({
      kind: "EXPENSE",
      from: "2026-04-01",
      to: "2026-04-30",
      compareFrom: "2026-03-01",
      compareTo: "2026-03-31",
      expenseCategoryId: "cat-insurance",
      expenseLine: "Insurance",
    });

    expect(summary.amountCents).toBe(1_234);
    expect(summary.groups).toEqual([
      expect.objectContaining({
        id: "cat-insurance",
        amountCents: 1_234,
        lineCount: 1,
      }),
    ]);
    expect(summary.availableExpenseLines).toEqual([
      { value: "Insurance", label: "Insurance", categoryId: "cat-insurance" },
      { value: "Utilities", label: "Utilities", categoryId: "unmapped" },
    ]);
    expect(summary.warnings).toEqual([
      "No comparison profit-and-loss snapshots cover 2026-03-01 to 2026-03-31.",
    ]);
  });

  it("validates duplicate category names and mapping ownership", () => {
    expect(
      validateFinanceReportMappingsInput({
        categories: [
          {
            kind: "REVENUE",
            name: "Hut Fees",
            mappings: [{ accountCode: "200", sectionLabel: null, lineLabel: null }],
          },
          {
            kind: "REVENUE",
            name: "Hut Fees",
            mappings: [],
          },
          {
            kind: "REVENUE",
            name: "Other Revenue",
            mappings: [{ accountCode: "200", sectionLabel: null, lineLabel: null }],
          },
        ],
      })
    ).toEqual([
      "Category Hut Fees is duplicated for REVENUE.",
      "Mapping account 200 is assigned to both REVENUE:Hut Fees and REVENUE:Other Revenue.",
    ]);
  });
});
