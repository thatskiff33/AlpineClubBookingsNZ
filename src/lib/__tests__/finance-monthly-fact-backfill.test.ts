import { beforeEach, describe, expect, it, vi } from "vitest";
import { FinanceSyncRunTrigger } from "@prisma/client";

const {
  mockFetchPnl,
  mockFetchBalanceSheet,
  mockGetMonthKey,
  mockSyncChart,
  mockLoadChartContext,
  mockRunFinanceSync,
} = vi.hoisted(() => ({
  mockFetchPnl: vi.fn(),
  mockFetchBalanceSheet: vi.fn(),
  mockGetMonthKey: vi.fn(),
  mockSyncChart: vi.fn(),
  mockLoadChartContext: vi.fn(),
  mockRunFinanceSync: vi.fn(),
}));

vi.mock("@/lib/finance-sync-xero-datasets", () => ({
  fetchFinanceProfitAndLossByMonthSnapshot: mockFetchPnl,
  fetchFinanceBalanceSheetByMonthSnapshot: mockFetchBalanceSheet,
  getFinanceMonthKeyForDate: mockGetMonthKey,
  syncFinanceChartOfAccountsSnapshot: mockSyncChart,
  FINANCE_SYNC_XERO_CHART_OF_ACCOUNTS_DATASET_KEY: "xero-chart-of-accounts",
}));

vi.mock("@/lib/finance-monthly-fact-store", () => ({
  loadFinanceMonthlyChartContext: mockLoadChartContext,
}));

vi.mock("@/lib/finance-sync-service", () => ({
  runFinanceSync: mockRunFinanceSync,
}));

import {
  backfillFinanceMonthlyFacts,
  buildFinanceMonthlyFactBackfillDatasets,
  DEFAULT_FINANCE_BACKFILL_MAX_CHUNKS,
  FINANCE_MONTHLY_FACT_BACKFILL_WORKFLOW,
} from "@/lib/finance-monthly-fact-backfill";
import { shiftMonthKey } from "@/lib/finance-monthly-facts";
import type { FinanceSyncDatasetContext } from "@/lib/finance-sync-service";

const chartContext = { accountsById: new Map([["acc-hut", { code: "200" }]]) };

function createContext(): FinanceSyncDatasetContext {
  return {
    runId: "run-1",
    workflow: FINANCE_MONTHLY_FACT_BACKFILL_WORKFLOW,
    trigger: FinanceSyncRunTrigger.BACKFILL,
    startedAt: new Date("2026-04-20T10:15:00.000Z"),
    xeroTenantId: "tenant-123",
    xero: {} as never,
    // CT-5 (#2869): the run carries the club's civil-time authority.
    clubTimeZone: "Pacific/Auckland" as FinanceSyncDatasetContext["clubTimeZone"],
  };
}

function buildChunkSnapshot(endMonth: string, amountCents: number) {
  const months = Array.from({ length: 12 }, (_, index) =>
    shiftMonthKey(endMonth, -(11 - index))
  );

  return {
    snapshotType: "PROFIT_AND_LOSS_BY_MONTH",
    asOfDate: new Date(`${endMonth}-01T00:00:00.000Z`),
    rowCount: 1,
    payload: {},
    monthlyFacts: {
      statementKind: "PROFIT_AND_LOSS",
      months,
      rows: [
        {
          month: endMonth,
          accountCode: "200",
          accountId: "acc-hut",
          accountName: "Hut Fees",
          accountType: "SALES",
          accountClass: "REVENUE",
          amountCents,
          isProvisional: false,
        },
      ],
      sourceReport: "getReportProfitAndLoss",
      unresolvedRowLabels: [],
    },
  };
}

describe("buildFinanceMonthlyFactBackfillDatasets", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetMonthKey.mockReturnValue("2026-04");
    mockLoadChartContext.mockResolvedValue(chartContext);
  });

  it("registers a fresh chart pull before the two report walks", () => {
    const datasets = buildFinanceMonthlyFactBackfillDatasets({
      fromMonth: null,
      maxChunks: 30,
    });

    expect(datasets.map((dataset) => dataset.key)).toEqual([
      "xero-chart-of-accounts",
      "xero-profit-and-loss-by-month-backfill",
      "xero-balance-sheet-by-month-backfill",
    ]);
    expect(datasets[0].sync).toBe(mockSyncChart);
  });

  it("walks backwards in 12-month chunks until a year with no activity", async () => {
    mockFetchPnl.mockImplementation(
      async (_context, window: { endMonth: string }) =>
        buildChunkSnapshot(
          window.endMonth,
          window.endMonth >= "2024-05" ? 12500 : 0
        )
    );

    const datasets = buildFinanceMonthlyFactBackfillDatasets({
      fromMonth: null,
      maxChunks: 30,
    });
    const snapshots = (await datasets[1].sync(createContext())) as unknown[];

    // 2026-04 and 2025-04 chunks have activity; the 2024-04 chunk is silent
    // (pre-history) and is the last one pulled.
    expect(mockFetchPnl.mock.calls.map(([, window]) => window.endMonth)).toEqual([
      "2026-04",
      "2025-04",
      "2024-04",
    ]);
    expect(snapshots).toHaveLength(3);
    expect(mockLoadChartContext).toHaveBeenCalledTimes(1);
    expect(
      mockFetchPnl.mock.calls.every(
        ([, window]) =>
          window.chart === chartContext && window.currentMonth === "2026-04"
      )
    ).toBe(true);
  });

  it("stops once the pulled window reaches fromMonth", async () => {
    mockFetchPnl.mockImplementation(
      async (_context, window: { endMonth: string }) =>
        buildChunkSnapshot(window.endMonth, 12500)
    );

    const datasets = buildFinanceMonthlyFactBackfillDatasets({
      fromMonth: "2025-06",
      maxChunks: 30,
    });
    const snapshots = (await datasets[1].sync(createContext())) as unknown[];

    // The first chunk covers 2025-05..2026-04, which already reaches 2025-06.
    expect(mockFetchPnl).toHaveBeenCalledTimes(1);
    expect(snapshots).toHaveLength(1);
  });

  it("walks past a dormant chunk to reach an explicit fromMonth", async () => {
    mockFetchPnl.mockImplementation(
      async (_context, window: { endMonth: string }) =>
        // The 2025-04 chunk is a quiet year with no activity. Without a bound
        // the walk would stop there (pre-history); with an explicit fromMonth
        // it must keep going so a dormant year cannot block older history.
        buildChunkSnapshot(
          window.endMonth,
          window.endMonth === "2025-04" ? 0 : 12500
        )
    );

    const datasets = buildFinanceMonthlyFactBackfillDatasets({
      fromMonth: "2023-06",
      maxChunks: 30,
    });
    const snapshots = (await datasets[1].sync(createContext())) as unknown[];

    expect(mockFetchPnl.mock.calls.map(([, window]) => window.endMonth)).toEqual([
      "2026-04",
      "2025-04",
      "2024-04",
    ]);
    expect(snapshots).toHaveLength(3);
  });

  it("respects the maxChunks cap", async () => {
    mockFetchPnl.mockImplementation(
      async (_context, window: { endMonth: string }) =>
        buildChunkSnapshot(window.endMonth, 12500)
    );

    const datasets = buildFinanceMonthlyFactBackfillDatasets({
      fromMonth: null,
      maxChunks: 2,
    });
    await datasets[1].sync(createContext());

    expect(mockFetchPnl).toHaveBeenCalledTimes(2);
  });

  it("walks the balance sheet with the same chunking", async () => {
    mockFetchBalanceSheet.mockImplementation(
      async (_context, window: { endMonth: string }) =>
        buildChunkSnapshot(window.endMonth, window.endMonth === "2026-04" ? 500 : 0)
    );

    const datasets = buildFinanceMonthlyFactBackfillDatasets({
      fromMonth: null,
      maxChunks: 30,
    });
    const snapshots = (await datasets[2].sync(createContext())) as unknown[];

    expect(
      mockFetchBalanceSheet.mock.calls.map(([, window]) => window.endMonth)
    ).toEqual(["2026-04", "2025-04"]);
    expect(snapshots).toHaveLength(2);
  });
});

describe("backfillFinanceMonthlyFacts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRunFinanceSync.mockResolvedValue({ runId: "run-1", status: "SUCCEEDED" });
  });

  it("runs through the durable finance sync boundary", async () => {
    await backfillFinanceMonthlyFacts({
      requestedByMemberId: "member-1",
      fromMonth: "2020-04",
      maxChunks: 5,
    });

    expect(mockRunFinanceSync).toHaveBeenCalledWith(
      expect.objectContaining({
        workflow: FINANCE_MONTHLY_FACT_BACKFILL_WORKFLOW,
        trigger: FinanceSyncRunTrigger.BACKFILL,
        requestedByMemberId: "member-1",
        datasets: expect.arrayContaining([
          expect.objectContaining({ key: "xero-chart-of-accounts" }),
          expect.objectContaining({
            key: "xero-profit-and-loss-by-month-backfill",
          }),
          expect.objectContaining({
            key: "xero-balance-sheet-by-month-backfill",
          }),
        ]),
        metadata: expect.objectContaining({
          fromMonth: "2020-04",
          maxChunks: 5,
        }),
      })
    );
  });

  it("defaults to full-history limits", async () => {
    await backfillFinanceMonthlyFacts();

    expect(mockRunFinanceSync).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          fromMonth: null,
          maxChunks: DEFAULT_FINANCE_BACKFILL_MAX_CHUNKS,
        }),
      })
    );
  });

  it.each([
    ["fromMonth", { fromMonth: "April 2020" }, /YYYY-MM month key/],
    ["maxChunks", { maxChunks: 0 }, /positive integer/],
  ])("rejects invalid %s", async (_label, input, message) => {
    await expect(backfillFinanceMonthlyFacts(input)).rejects.toThrow(message);
    expect(mockRunFinanceSync).not.toHaveBeenCalled();
  });
});
