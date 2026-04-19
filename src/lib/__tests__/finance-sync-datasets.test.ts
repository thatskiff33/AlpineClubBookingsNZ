import { beforeEach, describe, expect, it, vi } from "vitest";
import { FinanceSnapshotType } from "@prisma/client";

const { mockRecordFinanceXeroApiUsage } = vi.hoisted(() => ({
  mockRecordFinanceXeroApiUsage: vi.fn(),
}));
const { mockCallXeroApi } = vi.hoisted(() => ({
  mockCallXeroApi: vi.fn(),
}));

vi.mock("@/lib/finance-xero-api-usage", () => ({
  recordFinanceXeroApiUsage: mockRecordFinanceXeroApiUsage,
}));
vi.mock("@/lib/xero", () => ({
  callXeroApi: (fn: () => unknown, options: unknown) =>
    mockCallXeroApi(fn, options),
}));

import {
  FINANCE_SYNC_XERO_BALANCE_SHEET_DATASET_KEY,
  FINANCE_SYNC_XERO_BANK_BALANCES_DATASET_KEY,
  FINANCE_SYNC_XERO_PROFIT_AND_LOSS_MONTHLY_DATASET_KEY,
  buildFinanceReportSnapshot,
  syncFinanceBalanceSheetSnapshot,
  syncFinanceBankBalancesSnapshot,
  syncFinanceProfitAndLossMonthlySnapshot,
} from "@/lib/finance-sync-xero-datasets";
import { getFinanceSyncDatasets } from "@/lib/finance-sync-datasets";

function createFinanceSyncContext() {
  return {
    runId: "run-1",
    workflow: "daily-finance-sync",
    trigger: "SCHEDULED" as const,
    startedAt: new Date("2026-04-19T22:15:00.000Z"),
    xeroTenantId: "tenant-123",
    xero: {
      accountingApi: {
        getReportProfitAndLoss: vi.fn(),
        getReportBalanceSheet: vi.fn(),
        getReportBankSummary: vi.fn(),
      },
    },
  };
}

function createReport(overrides?: {
  reportID?: string;
  reportName?: string;
  reportType?: string;
  reportDate?: string;
  updatedDateUTC?: Date;
}) {
  return {
    reportID: overrides?.reportID ?? "report-1",
    reportName: overrides?.reportName ?? "Profit and Loss",
    reportType: overrides?.reportType ?? "ProfitLoss",
    reportTitle: "Demo Finance Report",
    reportTitles: ["Demo Finance Report", "Tokoroa Alpine Club", "April 2026"],
    reportDate: overrides?.reportDate ?? "2026-04-20",
    updatedDateUTC:
      overrides?.updatedDateUTC ?? new Date("2026-04-20T00:05:00.000Z"),
    fields: [
      {
        fieldID: "period",
        description: "Period",
        value: "April 2026",
      },
    ],
    rows: [
      {
        rowType: "Section",
        title: "Income",
        rows: [
          {
            rowType: "Row",
            cells: [{ value: "Accommodation income" }, { value: "1250.00" }],
          },
          {
            rowType: "SummaryRow",
            cells: [{ value: "Total Income" }, { value: "1250.00" }],
          },
        ],
      },
    ],
  };
}

describe("finance-sync-datasets", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCallXeroApi.mockImplementation(async (fn: () => unknown) => fn());
  });

  it("registers the first concrete finance Xero datasets without the bootstrap seam", () => {
    expect(getFinanceSyncDatasets().map((dataset) => dataset.key)).toEqual([
      FINANCE_SYNC_XERO_PROFIT_AND_LOSS_MONTHLY_DATASET_KEY,
      FINANCE_SYNC_XERO_BALANCE_SHEET_DATASET_KEY,
      FINANCE_SYNC_XERO_BANK_BALANCES_DATASET_KEY,
    ]);
  });

  it("maps Xero reports into JSON-safe finance snapshot payloads", () => {
    const snapshot = buildFinanceReportSnapshot({
      snapshotType: FinanceSnapshotType.PROFIT_AND_LOSS_MONTHLY,
      asOfDate: new Date("2026-04-20T00:00:00.000Z"),
      periodStart: new Date("2026-04-01T00:00:00.000Z"),
      periodEnd: new Date("2026-04-20T00:00:00.000Z"),
      report: createReport(),
    });

    expect(snapshot).toMatchObject({
      snapshotType: FinanceSnapshotType.PROFIT_AND_LOSS_MONTHLY,
      rowCount: 2,
      sourceUpdatedAt: new Date("2026-04-20T00:05:00.000Z"),
      payload: {
        reportId: "report-1",
        reportType: "ProfitLoss",
        reportDate: "2026-04-20",
        updatedDateUTC: "2026-04-20T00:05:00.000Z",
        rows: [
          {
            rowType: "Section",
            title: "Income",
            rows: [
              {
                rowType: "Row",
                cells: [{ value: "Accommodation income" }, { value: "1250.00" }],
              },
              {
                rowType: "SummaryRow",
                cells: [{ value: "Total Income" }, { value: "1250.00" }],
              },
            ],
          },
        ],
      },
    });
  });

  it("builds profit and loss, balance sheet, and bank balance snapshots from the finance report window", async () => {
    const context = createFinanceSyncContext();
    const profitAndLossReport = createReport({
      reportID: "pnl-1",
      reportName: "Profit and Loss",
      reportType: "ProfitLoss",
    });
    const balanceSheetReport = createReport({
      reportID: "bs-1",
      reportName: "Balance Sheet",
      reportType: "BalanceSheet",
    });
    const bankSummaryReport = createReport({
      reportID: "bank-1",
      reportName: "Bank Summary",
      reportType: "BankSummary",
    });

    context.xero.accountingApi.getReportProfitAndLoss.mockResolvedValue({
      body: { reports: [profitAndLossReport] },
    });
    context.xero.accountingApi.getReportBalanceSheet.mockResolvedValue({
      body: { reports: [balanceSheetReport] },
    });
    context.xero.accountingApi.getReportBankSummary.mockResolvedValue({
      body: { reports: [bankSummaryReport] },
    });

    const [profitAndLoss, balanceSheet, bankBalances] = await Promise.all([
      syncFinanceProfitAndLossMonthlySnapshot(context as never),
      syncFinanceBalanceSheetSnapshot(context as never),
      syncFinanceBankBalancesSnapshot(context as never),
    ]);

    expect(context.xero.accountingApi.getReportProfitAndLoss).toHaveBeenCalledWith(
      "tenant-123",
      "2026-04-01",
      "2026-04-20",
      1,
      "MONTH",
      undefined,
      undefined,
      undefined,
      undefined,
      true,
      false
    );
    expect(context.xero.accountingApi.getReportBalanceSheet).toHaveBeenCalledWith(
      "tenant-123",
      "2026-04-20",
      1,
      "MONTH",
      undefined,
      undefined,
      true,
      false
    );
    expect(context.xero.accountingApi.getReportBankSummary).toHaveBeenCalledWith(
      "tenant-123",
      "2026-04-01",
      "2026-04-20"
    );
    expect(profitAndLoss).toMatchObject({
      snapshotType: FinanceSnapshotType.PROFIT_AND_LOSS_MONTHLY,
      asOfDate: new Date("2026-04-20T00:00:00.000Z"),
      periodStart: new Date("2026-04-01T00:00:00.000Z"),
      periodEnd: new Date("2026-04-20T00:00:00.000Z"),
    });
    expect(balanceSheet).toMatchObject({
      snapshotType: FinanceSnapshotType.BALANCE_SHEET,
      asOfDate: new Date("2026-04-20T00:00:00.000Z"),
      periodStart: null,
      periodEnd: new Date("2026-04-20T00:00:00.000Z"),
    });
    expect(bankBalances).toMatchObject({
      snapshotType: FinanceSnapshotType.BANK_BALANCES,
      asOfDate: new Date("2026-04-20T00:00:00.000Z"),
      periodStart: new Date("2026-04-01T00:00:00.000Z"),
      periodEnd: new Date("2026-04-20T00:00:00.000Z"),
    });
    expect(mockRecordFinanceXeroApiUsage).toHaveBeenCalledTimes(3);
    expect(mockCallXeroApi).toHaveBeenCalledTimes(3);
  });

  it("records finance Xero usage metadata when a scheduled report call fails", async () => {
    const context = createFinanceSyncContext();
    const error = {
      response: {
        statusCode: 429,
        headers: {
          "x-rate-limit-problem": "minute",
        },
      },
      message: "Minute limit reached",
    };

    context.xero.accountingApi.getReportBalanceSheet.mockRejectedValue(error);

    await expect(
      syncFinanceBalanceSheetSnapshot(context as never)
    ).rejects.toEqual(error);

    expect(mockRecordFinanceXeroApiUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "getReportBalanceSheet",
        resourceType: "REPORT",
        workflow: "daily-finance-sync",
        success: false,
        rateLimitCategory: "minute",
        statusCode: 429,
        errorMessage: "Minute limit reached",
      })
    );
    expect(mockCallXeroApi).toHaveBeenCalledTimes(1);
  });
});
