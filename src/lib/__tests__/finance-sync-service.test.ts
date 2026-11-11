import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  FinanceSnapshotType,
  FinanceSyncRunStatus,
  FinanceSyncRunTrigger,
} from "@prisma/client";

const {
  mockGetAuthenticatedXeroClient,
  mockCreateFinanceSyncRun,
  mockCompleteFinanceSyncRun,
  mockFailFinanceSyncRun,
  mockUpsertFinanceSnapshot,
  mockCallXeroApi,
  mockReplaceMonthlyFacts,
  mockLoadFinanceMonthlyChartContext,
} = vi.hoisted(() => ({
  mockGetAuthenticatedXeroClient: vi.fn(),
  mockCreateFinanceSyncRun: vi.fn(),
  mockCompleteFinanceSyncRun: vi.fn(),
  mockFailFinanceSyncRun: vi.fn(),
  mockUpsertFinanceSnapshot: vi.fn(),
  mockCallXeroApi: vi.fn(),
  mockReplaceMonthlyFacts: vi.fn(),
  mockLoadFinanceMonthlyChartContext: vi.fn(),
}));

vi.mock("@/lib/xero-api-client", () => ({
  getAuthenticatedXeroClient: mockGetAuthenticatedXeroClient,
  callXeroApi: (fn: () => unknown, options: unknown) =>
    mockCallXeroApi(fn, options),
}));

vi.mock("@/lib/finance-sync-storage", () => ({
  createFinanceSyncRun: mockCreateFinanceSyncRun,
  completeFinanceSyncRun: mockCompleteFinanceSyncRun,
  failFinanceSyncRun: mockFailFinanceSyncRun,
  upsertFinanceSnapshot: mockUpsertFinanceSnapshot,
}));

vi.mock("@/lib/finance-monthly-fact-store", () => ({
  replaceMonthlyFacts: mockReplaceMonthlyFacts,
  loadFinanceMonthlyChartContext: mockLoadFinanceMonthlyChartContext,
}));

import {
  createFinanceXeroSyncConnection,
  DEFAULT_FINANCE_SYNC_WORKFLOW,
  runFinanceSync,
} from "@/lib/finance-sync-service";
import { getFinanceSyncDatasets } from "@/lib/finance-sync-datasets";

function createMockXeroClient(overrides?: {
  tenantId?: string;
}) {
  return {
    initialize: vi.fn().mockResolvedValue(undefined),
    setTokenSet: vi.fn(),
    updateTenants: vi.fn().mockResolvedValue(undefined),
    tenants: overrides?.tenantId ? [{ tenantId: overrides.tenantId }] : [],
    accountingApi: {
      getReportProfitAndLoss: vi.fn(),
      getReportBalanceSheet: vi.fn(),
      getReportBankSummary: vi.fn(),
      getInvoices: vi.fn(),
      getAccounts: vi.fn(),
    },
  };
}

describe("finance-sync-service", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockCreateFinanceSyncRun.mockResolvedValue({ id: "run-1" });
    mockCompleteFinanceSyncRun.mockResolvedValue({ id: "run-1" });
    mockFailFinanceSyncRun.mockResolvedValue({ id: "run-1" });
    mockUpsertFinanceSnapshot.mockResolvedValue({ id: "snapshot-1" });
    mockReplaceMonthlyFacts.mockResolvedValue({
      monthCount: 2,
      deletedCount: 0,
      createdCount: 2,
    });
    mockLoadFinanceMonthlyChartContext.mockResolvedValue({
      accountsById: new Map([
        [
          "acc-1",
          {
            accountId: "acc-1",
            code: "200",
            name: "Hut Fees",
            type: "SALES",
            class: "REVENUE",
          },
        ],
      ]),
    });
    mockGetAuthenticatedXeroClient.mockResolvedValue({
      tenantId: "tenant-123",
      xero: createMockXeroClient(),
    });
    mockCallXeroApi.mockImplementation(async (fn: () => unknown) => fn());
  });

  it("creates a finance sync connection from the operational Xero client", async () => {
    const xeroClient = createMockXeroClient({ tenantId: "tenant-from-xero" });
    mockGetAuthenticatedXeroClient.mockResolvedValue({
      tenantId: "tenant-from-xero",
      xero: xeroClient,
    });

    const connection = await createFinanceXeroSyncConnection();

    expect(mockGetAuthenticatedXeroClient).toHaveBeenCalledTimes(1);
    expect(connection).toEqual({
      tenantId: "tenant-from-xero",
      xero: xeroClient,
    });
  });

  it("runs finance datasets through the durable sync-run and snapshot storage helpers", async () => {
    const result = await runFinanceSync({
      trigger: FinanceSyncRunTrigger.MANUAL,
      requestedByMemberId: "member-123",
      metadata: { initiatedFrom: "test" },
      datasets: [
        {
          key: "contacts",
          sync: async () => ({
            snapshotType: FinanceSnapshotType.CONTACTS,
            asOfDate: new Date("2026-04-19T00:00:00.000Z"),
            rowCount: 7,
            payload: {
              contacts: [{ id: "contact-1" }],
            },
            sourceUpdatedAt: new Date("2026-04-19T08:00:00.000Z"),
          }),
        },
        {
          key: "bank-balances",
          sync: async () => [
            {
              snapshotType: FinanceSnapshotType.BANK_BALANCES,
              asOfDate: new Date("2026-04-19T00:00:00.000Z"),
              rowCount: 2,
              scope: "primary",
              payload: {
                accounts: [{ code: "090" }],
              },
            },
          ],
        },
      ],
    });

    expect(mockCreateFinanceSyncRun).toHaveBeenCalledWith({
      workflow: DEFAULT_FINANCE_SYNC_WORKFLOW,
      trigger: FinanceSyncRunTrigger.MANUAL,
      startedAt: expect.any(Date),
      requestedByMemberId: "member-123",
      xeroTenantId: "tenant-123",
      metadata: {
        datasetKeys: ["contacts", "bank-balances"],
        input: { initiatedFrom: "test" },
      },
    });
    expect(mockUpsertFinanceSnapshot).toHaveBeenCalledTimes(2);
    expect(mockUpsertFinanceSnapshot).toHaveBeenNthCalledWith(1, {
      snapshotType: FinanceSnapshotType.CONTACTS,
      asOfDate: new Date("2026-04-19T00:00:00.000Z"),
      rowCount: 7,
      payload: {
        contacts: [{ id: "contact-1" }],
      },
      sourceUpdatedAt: new Date("2026-04-19T08:00:00.000Z"),
      syncRunId: "run-1",
    });
    expect(mockCompleteFinanceSyncRun).toHaveBeenCalledWith({
      runId: "run-1",
      completedAt: expect.any(Date),
      snapshotCount: 2,
      totalRowCount: 9,
      resultSummary: {
        datasetCount: 2,
        failedDatasetCount: 0,
        successfulDatasetCount: 2,
        datasets: [
          {
            datasetKey: "contacts",
            snapshotCount: 1,
            totalRowCount: 7,
            snapshotTypes: [FinanceSnapshotType.CONTACTS],
          },
          {
            datasetKey: "bank-balances",
            snapshotCount: 1,
            totalRowCount: 2,
            snapshotTypes: [FinanceSnapshotType.BANK_BALANCES],
          },
        ],
      },
    });
    expect(result.status).toBe(FinanceSyncRunStatus.SUCCEEDED);
    expect(result.snapshotCount).toBe(2);
    expect(result.totalRowCount).toBe(9);
  });

  it("marks the run as partial when at least one dataset succeeds and one fails", async () => {
    const result = await runFinanceSync({
      trigger: FinanceSyncRunTrigger.SCHEDULED,
      datasets: [
        {
          key: "contacts",
          sync: async () => ({
            snapshotType: FinanceSnapshotType.CONTACTS,
            asOfDate: new Date("2026-04-19T00:00:00.000Z"),
            rowCount: 3,
            payload: {
              contacts: [{ id: "contact-1" }],
            },
          }),
        },
        {
          key: "profit-and-loss",
          sync: async () => {
            throw new Error("Xero request failed");
          },
        },
      ],
    });

    expect(mockCompleteFinanceSyncRun).toHaveBeenCalledWith({
      runId: "run-1",
      status: FinanceSyncRunStatus.PARTIAL,
      completedAt: expect.any(Date),
      snapshotCount: 1,
      totalRowCount: 3,
      resultSummary: {
        datasetCount: 2,
        failedDatasetCount: 1,
        successfulDatasetCount: 1,
        datasets: [
          {
            datasetKey: "contacts",
            snapshotCount: 1,
            totalRowCount: 3,
            snapshotTypes: [FinanceSnapshotType.CONTACTS],
          },
          {
            datasetKey: "profit-and-loss",
            snapshotCount: 0,
            totalRowCount: 0,
            snapshotTypes: [],
            errorMessage: "Xero request failed",
          },
        ],
      },
      errorSummary: "Finance sync failed for 1 dataset(s)",
    });
    expect(result.status).toBe(FinanceSyncRunStatus.PARTIAL);
    expect(result.datasetResults[1]).toMatchObject({
      datasetKey: "profit-and-loss",
      errorMessage: "Xero request failed",
    });
  });

  it("runs the registered finance Xero datasets through the durable sync boundary", async () => {
    const xeroClient = createMockXeroClient();
    const report = {
      reportTitle: "Demo Finance Report",
      reportTitles: ["Demo Finance Report"],
      reportDate: "2026-04-20",
      updatedDateUTC: new Date("2026-04-20T00:05:00.000Z"),
      rows: [
        {
          rowType: "Section",
          title: "Totals",
          rows: [
            {
              rowType: "Row",
              cells: [{ value: "Total" }, { value: "1.00" }],
            },
          ],
        },
      ],
    };

    // Multi-period (periods=11) report shape served to the by-month fact
    // datasets: a header of month-end date columns plus account-attributed
    // leaf rows, matching Xero's newest-first column order.
    const multiPeriodReport = {
      reportTitle: "Demo Multi-Period Report",
      reportTitles: ["Demo Multi-Period Report"],
      reportDate: "2026-04-20",
      updatedDateUTC: new Date("2026-04-20T00:05:00.000Z"),
      rows: [
        {
          rowType: "Header",
          cells: [
            { value: "" },
            { value: "30 Apr 26" },
            { value: "31 Mar 26" },
          ],
        },
        {
          rowType: "Section",
          title: "Income",
          rows: [
            {
              rowType: "Row",
              cells: [
                {
                  value: "Hut Fees",
                  attributes: [{ id: "account", value: "acc-1" }],
                },
                { value: "1,250.00" },
                { value: "980.50" },
              ],
            },
          ],
        },
      ],
    };

    xeroClient.accountingApi.getReportProfitAndLoss.mockImplementation(
      async (
        _tenantId: string,
        _fromDate: string,
        _toDate: string,
        periods: number
      ) => ({
        body: {
          reports: [
            periods === 11
              ? {
                  ...multiPeriodReport,
                  reportID: "pnl-by-month-1",
                  reportName: "Profit and Loss",
                }
              : { ...report, reportID: "pnl-1", reportName: "Profit and Loss" },
          ],
        },
      })
    );
    xeroClient.accountingApi.getReportBalanceSheet.mockImplementation(
      async (_tenantId: string, _date: string, periods: number) => ({
        body: {
          reports: [
            periods === 11
              ? {
                  ...multiPeriodReport,
                  reportID: "bs-by-month-1",
                  reportName: "Balance Sheet",
                }
              : { ...report, reportID: "bs-1", reportName: "Balance Sheet" },
          ],
        },
      })
    );
    xeroClient.accountingApi.getReportBankSummary.mockResolvedValue({
      body: {
        reports: [{ ...report, reportID: "bank-1", reportName: "Bank Summary" }],
      },
    });
    xeroClient.accountingApi.getInvoices.mockImplementation(
      async (_tenantId: string, _ifModifiedSince: Date, where?: string) => {
        if (where?.includes('Type=="ACCREC"')) {
          return {
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
          };
        }

        return {
          body: {
            invoices: [
              {
                type: "ACCPAY",
                invoiceID: "bill-1",
                invoiceNumber: "BILL-001",
                date: "2026-04-09",
                dueDate: "2026-04-14",
                amountDue: 21,
                status: "AUTHORISED",
                currencyCode: "NZD",
                contact: {
                  contactID: "supplier-1",
                  name: "Snow Supplies",
                  contactStatus: "ACTIVE",
                },
              },
            ],
          },
        };
      }
    );
    xeroClient.accountingApi.getAccounts.mockResolvedValue({
      body: {
        accounts: [
          {
            accountID: "acc-1",
            code: "200",
            name: "Hut Fees",
            type: "REVENUE",
            _class: "REVENUE",
            status: "ACTIVE",
          },
        ],
      },
    });
    mockGetAuthenticatedXeroClient.mockResolvedValue({
      tenantId: "tenant-123",
      xero: xeroClient,
    });

    const result = await runFinanceSync({
      trigger: FinanceSyncRunTrigger.SCHEDULED,
      startedAt: new Date("2026-04-19T22:15:00.000Z"),
      datasets: getFinanceSyncDatasets(),
    });

    expect(mockUpsertFinanceSnapshot).toHaveBeenCalledTimes(10);
    expect(mockUpsertFinanceSnapshot).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        snapshotType: FinanceSnapshotType.PROFIT_AND_LOSS_MONTHLY,
        asOfDate: new Date("2026-04-20T00:00:00.000Z"),
        periodStart: new Date("2026-04-01T00:00:00.000Z"),
        periodEnd: new Date("2026-04-20T00:00:00.000Z"),
        syncRunId: "run-1",
      })
    );
    expect(mockUpsertFinanceSnapshot).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        snapshotType: FinanceSnapshotType.BALANCE_SHEET,
        asOfDate: new Date("2026-04-20T00:00:00.000Z"),
        periodStart: null,
        periodEnd: new Date("2026-04-20T00:00:00.000Z"),
        syncRunId: "run-1",
      })
    );
    expect(mockUpsertFinanceSnapshot).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        snapshotType: FinanceSnapshotType.BANK_BALANCES,
        asOfDate: new Date("2026-04-20T00:00:00.000Z"),
        periodStart: new Date("2026-04-01T00:00:00.000Z"),
        periodEnd: new Date("2026-04-20T00:00:00.000Z"),
        syncRunId: "run-1",
      })
    );
    expect(mockUpsertFinanceSnapshot).toHaveBeenNthCalledWith(
      4,
      expect.objectContaining({
        snapshotType: FinanceSnapshotType.AGED_RECEIVABLES,
        asOfDate: new Date("2026-04-20T00:00:00.000Z"),
        periodEnd: new Date("2026-04-20T00:00:00.000Z"),
        currency: "NZD",
        syncRunId: "run-1",
      })
    );
    expect(mockUpsertFinanceSnapshot).toHaveBeenNthCalledWith(
      5,
      expect.objectContaining({
        snapshotType: FinanceSnapshotType.ACCOUNTS_RECEIVABLE_INVOICES,
        asOfDate: new Date("2026-04-20T00:00:00.000Z"),
        periodEnd: new Date("2026-04-20T00:00:00.000Z"),
        currency: "NZD",
        syncRunId: "run-1",
      })
    );
    expect(mockUpsertFinanceSnapshot).toHaveBeenNthCalledWith(
      6,
      expect.objectContaining({
        snapshotType: FinanceSnapshotType.AGED_PAYABLES,
        asOfDate: new Date("2026-04-20T00:00:00.000Z"),
        periodEnd: new Date("2026-04-20T00:00:00.000Z"),
        currency: "NZD",
        syncRunId: "run-1",
      })
    );
    expect(mockUpsertFinanceSnapshot).toHaveBeenNthCalledWith(
      7,
      expect.objectContaining({
        snapshotType: FinanceSnapshotType.ACCOUNTS_PAYABLE_INVOICES,
        asOfDate: new Date("2026-04-20T00:00:00.000Z"),
        periodEnd: new Date("2026-04-20T00:00:00.000Z"),
        currency: "NZD",
        syncRunId: "run-1",
      })
    );
    expect(mockUpsertFinanceSnapshot).toHaveBeenNthCalledWith(
      8,
      expect.objectContaining({
        snapshotType: FinanceSnapshotType.CHART_OF_ACCOUNTS,
        asOfDate: new Date("2026-04-20T00:00:00.000Z"),
        periodEnd: new Date("2026-04-20T00:00:00.000Z"),
        syncRunId: "run-1",
      })
    );
    expect(mockUpsertFinanceSnapshot).toHaveBeenNthCalledWith(
      9,
      expect.objectContaining({
        snapshotType: FinanceSnapshotType.PROFIT_AND_LOSS_BY_MONTH,
        asOfDate: new Date("2026-04-01T00:00:00.000Z"),
        periodStart: new Date("2026-03-01T00:00:00.000Z"),
        periodEnd: new Date("2026-04-30T00:00:00.000Z"),
        syncRunId: "run-1",
      })
    );
    expect(mockUpsertFinanceSnapshot).toHaveBeenNthCalledWith(
      10,
      expect.objectContaining({
        snapshotType: FinanceSnapshotType.BALANCE_SHEET_BY_MONTH,
        asOfDate: new Date("2026-04-01T00:00:00.000Z"),
        periodStart: new Date("2026-03-01T00:00:00.000Z"),
        periodEnd: new Date("2026-04-30T00:00:00.000Z"),
        syncRunId: "run-1",
      })
    );
    // The snapshot rows themselves never reach the snapshot store — the
    // derived monthly facts go through replaceMonthlyFacts instead.
    expect(mockUpsertFinanceSnapshot).not.toHaveBeenCalledWith(
      expect.objectContaining({ monthlyFacts: expect.anything() })
    );
    const expectedFactRows = [
      expect.objectContaining({
        month: "2026-03",
        accountCode: "200",
        amountCents: 98050,
        isProvisional: false,
      }),
      expect.objectContaining({
        month: "2026-04",
        accountCode: "200",
        amountCents: 125000,
        isProvisional: true,
      }),
    ];
    expect(mockReplaceMonthlyFacts).toHaveBeenCalledTimes(2);
    expect(mockReplaceMonthlyFacts).toHaveBeenNthCalledWith(1, {
      statementKind: "PROFIT_AND_LOSS",
      months: ["2026-03", "2026-04"],
      rows: expectedFactRows,
      sourceReport: "getReportProfitAndLoss",
      scope: undefined,
      currency: null,
      syncRunId: "run-1",
    });
    expect(mockReplaceMonthlyFacts).toHaveBeenNthCalledWith(2, {
      statementKind: "BALANCE_SHEET",
      months: ["2026-03", "2026-04"],
      rows: expectedFactRows,
      sourceReport: "getReportBalanceSheet",
      scope: undefined,
      currency: null,
      syncRunId: "run-1",
    });
    expect(mockCompleteFinanceSyncRun).toHaveBeenCalledWith({
      runId: "run-1",
      completedAt: expect.any(Date),
      snapshotCount: 10,
      totalRowCount: 10,
      resultSummary: {
        datasetCount: 10,
        failedDatasetCount: 0,
        successfulDatasetCount: 10,
        datasets: [
          {
            datasetKey: "xero-profit-and-loss-monthly",
            snapshotCount: 1,
            totalRowCount: 1,
            snapshotTypes: [FinanceSnapshotType.PROFIT_AND_LOSS_MONTHLY],
          },
          {
            datasetKey: "xero-balance-sheet",
            snapshotCount: 1,
            totalRowCount: 1,
            snapshotTypes: [FinanceSnapshotType.BALANCE_SHEET],
          },
          {
            datasetKey: "xero-bank-balances",
            snapshotCount: 1,
            totalRowCount: 1,
            snapshotTypes: [FinanceSnapshotType.BANK_BALANCES],
          },
          {
            datasetKey: "xero-aged-receivables",
            snapshotCount: 1,
            totalRowCount: 1,
            snapshotTypes: [FinanceSnapshotType.AGED_RECEIVABLES],
          },
          {
            datasetKey: "xero-accounts-receivable-invoices",
            snapshotCount: 1,
            totalRowCount: 1,
            snapshotTypes: [FinanceSnapshotType.ACCOUNTS_RECEIVABLE_INVOICES],
          },
          {
            datasetKey: "xero-aged-payables",
            snapshotCount: 1,
            totalRowCount: 1,
            snapshotTypes: [FinanceSnapshotType.AGED_PAYABLES],
          },
          {
            datasetKey: "xero-accounts-payable-invoices",
            snapshotCount: 1,
            totalRowCount: 1,
            snapshotTypes: [FinanceSnapshotType.ACCOUNTS_PAYABLE_INVOICES],
          },
          {
            datasetKey: "xero-chart-of-accounts",
            snapshotCount: 1,
            totalRowCount: 1,
            snapshotTypes: [FinanceSnapshotType.CHART_OF_ACCOUNTS],
          },
          {
            datasetKey: "xero-profit-and-loss-by-month",
            snapshotCount: 1,
            totalRowCount: 1,
            snapshotTypes: [FinanceSnapshotType.PROFIT_AND_LOSS_BY_MONTH],
            factRowCount: 2,
            unresolvedFactRowCount: 0,
          },
          {
            datasetKey: "xero-balance-sheet-by-month",
            snapshotCount: 1,
            totalRowCount: 1,
            snapshotTypes: [FinanceSnapshotType.BALANCE_SHEET_BY_MONTH],
            factRowCount: 2,
            unresolvedFactRowCount: 0,
          },
        ],
      },
    });
    expect(xeroClient.accountingApi.getInvoices).toHaveBeenCalledTimes(2);
    expect(result.status).toBe(FinanceSyncRunStatus.SUCCEEDED);
  });

  it("persists derived monthly facts through the fact store with run provenance", async () => {
    const result = await runFinanceSync({
      trigger: FinanceSyncRunTrigger.MANUAL,
      datasets: [
        {
          key: "facts",
          sync: async () => ({
            snapshotType: FinanceSnapshotType.PROFIT_AND_LOSS_BY_MONTH,
            asOfDate: new Date("2026-04-01T00:00:00.000Z"),
            rowCount: 1,
            payload: { rows: [] },
            monthlyFacts: {
              statementKind: "PROFIT_AND_LOSS" as never,
              months: ["2026-04"],
              rows: [
                {
                  month: "2026-04",
                  accountCode: "200",
                  accountId: "acc-1",
                  accountName: "Hut Fees",
                  accountType: "SALES",
                  accountClass: "REVENUE",
                  amountCents: 125000,
                  isProvisional: true,
                },
              ],
              sourceReport: "getReportProfitAndLoss",
              unresolvedRowLabels: ["Mystery line"],
            },
          }),
        },
      ],
    });

    expect(mockReplaceMonthlyFacts).toHaveBeenCalledWith(
      expect.objectContaining({
        statementKind: "PROFIT_AND_LOSS",
        months: ["2026-04"],
        sourceReport: "getReportProfitAndLoss",
        syncRunId: "run-1",
      })
    );
    expect(result.datasetResults[0]).toMatchObject({
      datasetKey: "facts",
      factRowCount: 1,
      unresolvedFactRowCount: 1,
    });
  });

  it("fails the dataset when persisting monthly facts fails", async () => {
    mockReplaceMonthlyFacts.mockRejectedValue(new Error("facts write failed"));

    const result = await runFinanceSync({
      trigger: FinanceSyncRunTrigger.MANUAL,
      datasets: [
        {
          key: "facts",
          sync: async () => ({
            snapshotType: FinanceSnapshotType.PROFIT_AND_LOSS_BY_MONTH,
            asOfDate: new Date("2026-04-01T00:00:00.000Z"),
            rowCount: 1,
            payload: { rows: [] },
            monthlyFacts: {
              statementKind: "PROFIT_AND_LOSS" as never,
              months: ["2026-04"],
              rows: [],
              sourceReport: "getReportProfitAndLoss",
            },
          }),
        },
        {
          key: "contacts",
          sync: async () => ({
            snapshotType: FinanceSnapshotType.CONTACTS,
            asOfDate: new Date("2026-04-01T00:00:00.000Z"),
            rowCount: 1,
            payload: { contacts: [] },
          }),
        },
      ],
    });

    expect(result.status).toBe(FinanceSyncRunStatus.PARTIAL);
    expect(result.datasetResults[0]).toMatchObject({
      datasetKey: "facts",
      errorMessage: "facts write failed",
    });
    expect(result.datasetResults[1]).toMatchObject({
      datasetKey: "contacts",
      snapshotCount: 1,
    });
  });

  it("fails the run durably when the operational Xero connection cannot be established", async () => {
    mockGetAuthenticatedXeroClient.mockRejectedValue(
      new Error("Xero is not connected. Please connect via admin panel.")
    );

    await expect(
      runFinanceSync({
        trigger: FinanceSyncRunTrigger.MANUAL,
        datasets: [
          {
            key: "contacts",
            sync: async () => ({
              snapshotType: FinanceSnapshotType.CONTACTS,
              asOfDate: new Date("2026-04-19T00:00:00.000Z"),
              rowCount: 1,
              payload: { contacts: [] },
            }),
          },
        ],
      })
    ).rejects.toThrow("Xero is not connected. Please connect via admin panel.");

    expect(mockCreateFinanceSyncRun).toHaveBeenCalledTimes(1);
    expect(mockFailFinanceSyncRun).toHaveBeenCalledWith({
      runId: "run-1",
      completedAt: expect.any(Date),
      errorSummary: "Xero is not connected. Please connect via admin panel.",
      errorDetails: {
        stage: "connect",
        message: "Xero is not connected. Please connect via admin panel.",
      },
    });
    expect(mockUpsertFinanceSnapshot).not.toHaveBeenCalled();
    expect(mockCompleteFinanceSyncRun).not.toHaveBeenCalled();
  });
});
