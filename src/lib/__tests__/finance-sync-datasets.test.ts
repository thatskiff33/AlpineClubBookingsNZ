import { beforeEach, describe, expect, it, vi } from "vitest";
import { FinanceSnapshotType } from "@prisma/client";

const { mockRecordFinanceXeroApiUsage } = vi.hoisted(() => ({
  mockRecordFinanceXeroApiUsage: vi.fn(),
}));
const { MockXeroDailyLimitError, mockCallXeroApi } = vi.hoisted(() => {
  class TestXeroDailyLimitError extends Error {
    retryAfterSec: number;

    constructor(retryAfterSec: number) {
      super(`Retry after ${retryAfterSec} seconds`);
      this.name = "XeroDailyLimitError";
      this.retryAfterSec = retryAfterSec;
    }
  }

  return {
    MockXeroDailyLimitError: TestXeroDailyLimitError,
    mockCallXeroApi: vi.fn(),
  };
});

vi.mock("@/lib/finance-xero-api-usage", () => ({
  recordFinanceXeroApiUsage: mockRecordFinanceXeroApiUsage,
}));
vi.mock("@/lib/xero", () => ({
  XeroDailyLimitError: MockXeroDailyLimitError,
  callXeroApi: (fn: () => unknown, options: unknown) =>
    mockCallXeroApi(fn, options),
}));

import {
  FINANCE_SYNC_XERO_AGED_RECEIVABLES_DATASET_KEY,
  FINANCE_SYNC_XERO_BALANCE_SHEET_DATASET_KEY,
  FINANCE_SYNC_XERO_BANK_BALANCES_DATASET_KEY,
  FINANCE_SYNC_XERO_PROFIT_AND_LOSS_MONTHLY_DATASET_KEY,
  buildFinanceAgedReceivablesSnapshot,
  buildFinanceReportSnapshot,
  syncFinanceAgedReceivablesSnapshot,
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
        getInvoices: vi.fn(),
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

  it("registers the finance Xero datasets including aged receivables", () => {
    expect(getFinanceSyncDatasets().map((dataset) => dataset.key)).toEqual([
      FINANCE_SYNC_XERO_PROFIT_AND_LOSS_MONTHLY_DATASET_KEY,
      FINANCE_SYNC_XERO_BALANCE_SHEET_DATASET_KEY,
      FINANCE_SYNC_XERO_BANK_BALANCES_DATASET_KEY,
      FINANCE_SYNC_XERO_AGED_RECEIVABLES_DATASET_KEY,
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

  it("maps open receivable invoices into a currency-safe aged receivables snapshot", () => {
    const snapshot = buildFinanceAgedReceivablesSnapshot({
      asOfDate: new Date("2026-04-20T00:00:00.000Z"),
      invoices: [
        {
          type: "ACCREC",
          invoiceID: "inv-1",
          invoiceNumber: "INV-001",
          dueDate: "2026-04-10",
          date: "2026-04-01",
          amountDue: 100,
          amountPaid: 25,
          amountCredited: 0,
          total: 125,
          status: "AUTHORISED",
          currencyCode: "NZD",
          contact: {
            contactID: "contact-1",
            name: "Alice",
            contactStatus: "ACTIVE",
          },
          updatedDateUTC: new Date("2026-04-20T00:05:00.000Z"),
        },
        {
          type: "ACCREC",
          invoiceID: "inv-2",
          invoiceNumber: "INV-002",
          dueDate: "2026-03-01",
          date: "2026-03-01",
          amountDue: 50,
          status: "AUTHORISED",
          currencyCode: "NZD",
          contact: {
            contactID: "contact-1",
            name: "Alice",
            contactStatus: "ACTIVE",
          },
          updatedDateUTC: new Date("2026-04-20T00:06:00.000Z"),
        },
        {
          type: "ACCREC",
          invoiceID: "inv-3",
          invoiceNumber: "INV-003",
          dueDate: "2026-04-25",
          date: "2026-04-18",
          amountDue: 75,
          status: "SUBMITTED",
          currencyCode: "AUD",
          contact: {
            contactID: "contact-2",
            name: "Bob",
            contactStatus: "ACTIVE",
          },
          updatedDateUTC: new Date("2026-04-20T00:07:00.000Z"),
        },
        {
          type: "ACCPAY",
          invoiceID: "ignored-type",
          amountDue: 999,
        },
        {
          type: "ACCREC",
          invoiceID: "ignored-zero",
          amountDue: 0,
        },
      ],
    });

    expect(snapshot).toMatchObject({
      snapshotType: FinanceSnapshotType.AGED_RECEIVABLES,
      asOfDate: new Date("2026-04-20T00:00:00.000Z"),
      periodEnd: new Date("2026-04-20T00:00:00.000Z"),
      rowCount: 2,
      scope: "organisation",
      currency: null,
      sourceUpdatedAt: new Date("2026-04-20T00:07:00.000Z"),
      payload: {
        asOfDate: "2026-04-20",
        invoiceCount: 3,
        contactCount: 2,
        currencies: ["AUD", "NZD"],
        totalsByCurrency: [
          {
            currency: "AUD",
            invoiceCount: 1,
            contactCount: 1,
            totals: {
              current: 75,
              days1To30: 0,
              days31To60: 0,
              days61To90: 0,
              days91Plus: 0,
              overdue: 0,
              total: 75,
            },
          },
          {
            currency: "NZD",
            invoiceCount: 2,
            contactCount: 1,
            totals: {
              current: 0,
              days1To30: 100,
              days31To60: 50,
              days61To90: 0,
              days91Plus: 0,
              overdue: 150,
              total: 150,
            },
          },
        ],
        contacts: [
          {
            contactId: "contact-1",
            contactName: "Alice",
            currency: "NZD",
            invoiceCount: 2,
            oldestDueDate: "2026-03-01",
            latestDueDate: "2026-04-10",
            totals: {
              current: 0,
              days1To30: 100,
              days31To60: 50,
              days61To90: 0,
              days91Plus: 0,
              overdue: 150,
              total: 150,
            },
            invoices: [
              {
                invoiceId: "inv-2",
                invoiceNumber: "INV-002",
                amountDue: 50,
                bucket: "days31To60",
                daysOverdue: 50,
              },
              {
                invoiceId: "inv-1",
                invoiceNumber: "INV-001",
                amountDue: 100,
                bucket: "days1To30",
                daysOverdue: 10,
              },
            ],
          },
          {
            contactId: "contact-2",
            contactName: "Bob",
            currency: "AUD",
            invoiceCount: 1,
            oldestDueDate: "2026-04-25",
            latestDueDate: "2026-04-25",
            totals: {
              current: 75,
              days1To30: 0,
              days31To60: 0,
              days61To90: 0,
              days91Plus: 0,
              overdue: 0,
              total: 75,
            },
          },
        ],
      },
    });
  });

  it("builds report and aged receivables snapshots from the finance sync window", async () => {
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
    context.xero.accountingApi.getInvoices.mockResolvedValue({
      body: {
        invoices: [
          {
            type: "ACCREC",
            invoiceID: "inv-1",
            invoiceNumber: "INV-001",
            date: "2026-04-10",
            dueDate: "2026-04-15",
            amountDue: 42,
            status: "AUTHORISED",
            currencyCode: "NZD",
            contact: {
              contactID: "contact-1",
              name: "Alice",
              contactStatus: "ACTIVE",
            },
          },
        ],
      },
    });

    const [profitAndLoss, balanceSheet, bankBalances, agedReceivables] =
      await Promise.all([
        syncFinanceProfitAndLossMonthlySnapshot(context as never),
        syncFinanceBalanceSheetSnapshot(context as never),
        syncFinanceBankBalancesSnapshot(context as never),
        syncFinanceAgedReceivablesSnapshot(context as never),
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
    expect(context.xero.accountingApi.getInvoices).toHaveBeenCalledWith(
      "tenant-123",
      undefined,
      'Type=="ACCREC" AND Date <= DateTime(2026,4,20)',
      "DueDate ASC",
      undefined,
      undefined,
      undefined,
      ["AUTHORISED", "SUBMITTED"],
      1,
      false,
      false,
      undefined,
      false,
      100
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
    expect(agedReceivables).toMatchObject({
      snapshotType: FinanceSnapshotType.AGED_RECEIVABLES,
      asOfDate: new Date("2026-04-20T00:00:00.000Z"),
      periodEnd: new Date("2026-04-20T00:00:00.000Z"),
      rowCount: 1,
      currency: "NZD",
      payload: {
        invoiceCount: 1,
        contactCount: 1,
      },
    });
    expect(mockRecordFinanceXeroApiUsage).toHaveBeenCalledTimes(4);
  });

  it("records finance Xero rate-limit metadata when a retried call eventually succeeds", async () => {
    const context = createFinanceSyncContext();
    context.xero.accountingApi.getReportBalanceSheet.mockResolvedValue({
      body: { reports: [createReport({ reportID: "bs-1", reportName: "Balance Sheet" })] },
    });

    mockCallXeroApi.mockImplementation(async (fn: () => unknown, options: any) => {
      options.onRateLimit?.({
        attempt: 1,
        retryAfterSec: 30,
        rateLimitCategory: "minute",
      });
      return fn();
    });

    await syncFinanceBalanceSheetSnapshot(context as never);

    expect(mockRecordFinanceXeroApiUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "getReportBalanceSheet",
        resourceType: "REPORT",
        workflow: "daily-finance-sync",
        success: true,
        rateLimitCategory: "minute",
      })
    );
  });

  it("classifies daily limit cooldown failures for finance usage metering", async () => {
    const context = createFinanceSyncContext();
    const error = new MockXeroDailyLimitError(3600);

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
        rateLimitCategory: "day",
        errorMessage: "Retry after 3600 seconds",
      })
    );
  });
});
