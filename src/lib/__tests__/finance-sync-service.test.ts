import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  FinanceSnapshotType,
  FinanceSyncRunStatus,
  FinanceSyncRunTrigger,
} from "@prisma/client";

const {
  mockCreateFinanceXeroClient,
  mockLoadFinanceXeroTokens,
  mockCreateFinanceSyncRun,
  mockCompleteFinanceSyncRun,
  mockFailFinanceSyncRun,
  mockUpsertFinanceSnapshot,
  mockRecordFinanceXeroApiUsage,
} = vi.hoisted(() => ({
  mockCreateFinanceXeroClient: vi.fn(),
  mockLoadFinanceXeroTokens: vi.fn(),
  mockCreateFinanceSyncRun: vi.fn(),
  mockCompleteFinanceSyncRun: vi.fn(),
  mockFailFinanceSyncRun: vi.fn(),
  mockUpsertFinanceSnapshot: vi.fn(),
  mockRecordFinanceXeroApiUsage: vi.fn(),
}));

vi.mock("@/lib/finance-xero", () => ({
  createFinanceXeroClient: mockCreateFinanceXeroClient,
}));

vi.mock("@/lib/finance-xero-token-store", () => ({
  loadFinanceXeroTokens: mockLoadFinanceXeroTokens,
}));

vi.mock("@/lib/finance-sync-storage", () => ({
  createFinanceSyncRun: mockCreateFinanceSyncRun,
  completeFinanceSyncRun: mockCompleteFinanceSyncRun,
  failFinanceSyncRun: mockFailFinanceSyncRun,
  upsertFinanceSnapshot: mockUpsertFinanceSnapshot,
}));

vi.mock("@/lib/finance-xero-api-usage", () => ({
  recordFinanceXeroApiUsage: mockRecordFinanceXeroApiUsage,
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
    },
  };
}

describe("finance-sync-service", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockLoadFinanceXeroTokens.mockResolvedValue({
      id: "finance-token-1",
      accessToken: "access-token",
      refreshToken: "refresh-token",
      expiresAt: new Date("2026-04-20T00:00:00.000Z"),
      tenantId: "tenant-123",
    });

    mockCreateFinanceSyncRun.mockResolvedValue({ id: "run-1" });
    mockCompleteFinanceSyncRun.mockResolvedValue({ id: "run-1" });
    mockFailFinanceSyncRun.mockResolvedValue({ id: "run-1" });
    mockUpsertFinanceSnapshot.mockResolvedValue({ id: "snapshot-1" });
    mockCreateFinanceXeroClient.mockReturnValue(createMockXeroClient());
  });

  it("creates a finance Xero sync connection from the finance-only token boundary", async () => {
    const xeroClient = createMockXeroClient({ tenantId: "tenant-from-xero" });
    mockLoadFinanceXeroTokens.mockResolvedValue({
      id: "finance-token-1",
      accessToken: "access-token",
      refreshToken: "refresh-token",
      expiresAt: new Date("2026-04-20T00:00:00.000Z"),
      tenantId: undefined,
    });
    mockCreateFinanceXeroClient.mockReturnValue(xeroClient);

    const connection = await createFinanceXeroSyncConnection();

    expect(xeroClient.initialize).toHaveBeenCalledTimes(1);
    expect(xeroClient.setTokenSet).toHaveBeenCalledWith({
      access_token: "access-token",
      refresh_token: "refresh-token",
      token_type: "Bearer",
    });
    expect(xeroClient.updateTenants).toHaveBeenCalledTimes(1);
    expect(connection.tenantId).toBe("tenant-from-xero");
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

    xeroClient.accountingApi.getReportProfitAndLoss.mockResolvedValue({
      body: {
        reports: [{ ...report, reportID: "pnl-1", reportName: "Profit and Loss" }],
      },
    });
    xeroClient.accountingApi.getReportBalanceSheet.mockResolvedValue({
      body: {
        reports: [{ ...report, reportID: "bs-1", reportName: "Balance Sheet" }],
      },
    });
    xeroClient.accountingApi.getReportBankSummary.mockResolvedValue({
      body: {
        reports: [{ ...report, reportID: "bank-1", reportName: "Bank Summary" }],
      },
    });
    mockCreateFinanceXeroClient.mockReturnValue(xeroClient);

    const result = await runFinanceSync({
      trigger: FinanceSyncRunTrigger.SCHEDULED,
      startedAt: new Date("2026-04-19T22:15:00.000Z"),
      datasets: getFinanceSyncDatasets(),
    });

    expect(mockUpsertFinanceSnapshot).toHaveBeenCalledTimes(3);
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
    expect(mockCompleteFinanceSyncRun).toHaveBeenCalledWith({
      runId: "run-1",
      completedAt: expect.any(Date),
      snapshotCount: 3,
      totalRowCount: 3,
      resultSummary: {
        datasetCount: 3,
        failedDatasetCount: 0,
        successfulDatasetCount: 3,
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
        ],
      },
    });
    expect(result.status).toBe(FinanceSyncRunStatus.SUCCEEDED);
    expect(mockRecordFinanceXeroApiUsage).toHaveBeenCalledTimes(3);
  });

  it("fails the run durably when the finance Xero connection cannot be established", async () => {
    mockLoadFinanceXeroTokens.mockResolvedValue(null);

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
    ).rejects.toThrow("Finance Xero is not connected");

    expect(mockCreateFinanceSyncRun).toHaveBeenCalledTimes(1);
    expect(mockFailFinanceSyncRun).toHaveBeenCalledWith({
      runId: "run-1",
      completedAt: expect.any(Date),
      errorSummary: "Finance Xero is not connected",
      errorDetails: {
        stage: "connect",
        message: "Finance Xero is not connected",
      },
    });
    expect(mockUpsertFinanceSnapshot).not.toHaveBeenCalled();
    expect(mockCompleteFinanceSyncRun).not.toHaveBeenCalled();
  });
});
