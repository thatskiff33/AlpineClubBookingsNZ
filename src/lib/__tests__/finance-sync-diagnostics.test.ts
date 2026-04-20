import { beforeEach, describe, expect, it, vi } from "vitest";
import { FinanceSyncRunStatus, FinanceSyncRunTrigger } from "@prisma/client";
import {
  FINANCE_SYNC_CRON_JOB_NAME,
  FINANCE_SYNC_CRON_SCHEDULE,
  FINANCE_SYNC_CRON_TIMEZONE,
} from "@/lib/finance-sync-cron";
import { DEFAULT_FINANCE_SYNC_WORKFLOW } from "@/lib/finance-sync-service";

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    financeSyncRun: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
    },
    cronJobRun: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
    },
  },
}));

vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));

import { getFinanceSyncDiagnosticsStatus } from "@/lib/finance-sync-diagnostics";

describe("finance-sync-diagnostics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("loads the latest finance sync status and recent durable failures", async () => {
    mockPrisma.financeSyncRun.findFirst.mockResolvedValue({
      id: "run-latest",
      workflow: DEFAULT_FINANCE_SYNC_WORKFLOW,
      trigger: FinanceSyncRunTrigger.SCHEDULED,
      status: FinanceSyncRunStatus.PARTIAL,
      startedAt: new Date("2026-04-20T10:15:00.000Z"),
      completedAt: new Date("2026-04-20T10:22:00.000Z"),
      snapshotCount: 6,
      totalRowCount: 84,
      xeroTenantId: "tenant-1",
      requestedByMemberId: null,
      resultSummary: {
        datasetCount: 7,
        failedDatasetCount: 1,
        successfulDatasetCount: 6,
        datasets: [
          {
            datasetKey: "xero-balance-sheet",
            snapshotCount: 1,
            totalRowCount: 12,
            snapshotTypes: ["BALANCE_SHEET"],
          },
          {
            datasetKey: "xero-accounts-payable-invoices",
            snapshotCount: 0,
            totalRowCount: 0,
            snapshotTypes: [],
            errorMessage: "Xero timeout",
          },
        ],
      },
      errorSummary: "Finance sync failed for 1 dataset(s)",
      errorDetails: null,
    });
    mockPrisma.financeSyncRun.findMany.mockResolvedValue([
      {
        id: "run-failed",
        workflow: DEFAULT_FINANCE_SYNC_WORKFLOW,
        trigger: FinanceSyncRunTrigger.SCHEDULED,
        status: FinanceSyncRunStatus.FAILED,
        startedAt: new Date("2026-04-19T10:15:00.000Z"),
        completedAt: new Date("2026-04-19T10:16:00.000Z"),
        snapshotCount: 0,
        totalRowCount: 0,
        xeroTenantId: null,
        requestedByMemberId: null,
        resultSummary: null,
        errorSummary: "Finance Xero is not connected",
        errorDetails: {
          stage: "connect",
          message: "Finance Xero is not connected",
        },
      },
    ]);
    mockPrisma.cronJobRun.findFirst.mockResolvedValue({
      id: "cron-latest",
      jobName: FINANCE_SYNC_CRON_JOB_NAME,
      startedAt: new Date("2026-04-20T10:15:00.000Z"),
      completedAt: new Date("2026-04-20T10:22:05.000Z"),
      durationMs: 425000,
      status: "FAILURE",
      resultSummary: {
        financeSyncRunId: "run-latest",
        financeSyncStatus: FinanceSyncRunStatus.PARTIAL,
        snapshotCount: 6,
        totalRowCount: 84,
        datasetCount: 7,
        failedDatasetCount: 1,
      },
      error: "Finance sync completed with PARTIAL status (1 dataset(s) failed)",
    });
    mockPrisma.cronJobRun.findMany.mockResolvedValue([
      {
        id: "cron-failed",
        jobName: FINANCE_SYNC_CRON_JOB_NAME,
        startedAt: new Date("2026-04-19T10:15:00.000Z"),
        completedAt: new Date("2026-04-19T10:16:01.000Z"),
        durationMs: 61000,
        status: "FAILURE",
        resultSummary: {
          financeSyncRunId: "run-failed",
          financeSyncStatus: FinanceSyncRunStatus.FAILED,
        },
        error: "Finance Xero is not connected",
      },
    ]);

    const diagnostics = await getFinanceSyncDiagnosticsStatus();

    expect(mockPrisma.financeSyncRun.findFirst).toHaveBeenCalledWith({
      where: { workflow: DEFAULT_FINANCE_SYNC_WORKFLOW },
      orderBy: [{ startedAt: "desc" }, { createdAt: "desc" }],
      select: expect.any(Object),
    });
    expect(mockPrisma.financeSyncRun.findMany).toHaveBeenCalledWith({
      where: {
        workflow: DEFAULT_FINANCE_SYNC_WORKFLOW,
        status: {
          in: [FinanceSyncRunStatus.FAILED, FinanceSyncRunStatus.PARTIAL],
        },
      },
      orderBy: [{ startedAt: "desc" }, { createdAt: "desc" }],
      take: 5,
      select: expect.any(Object),
    });
    expect(mockPrisma.cronJobRun.findFirst).toHaveBeenCalledWith({
      where: { jobName: FINANCE_SYNC_CRON_JOB_NAME },
      orderBy: [{ startedAt: "desc" }, { createdAt: "desc" }],
      select: expect.any(Object),
    });
    expect(mockPrisma.cronJobRun.findMany).toHaveBeenCalledWith({
      where: {
        jobName: FINANCE_SYNC_CRON_JOB_NAME,
        status: "FAILURE",
      },
      orderBy: [{ startedAt: "desc" }, { createdAt: "desc" }],
      take: 5,
      select: expect.any(Object),
    });

    expect(diagnostics).toEqual({
      workflow: DEFAULT_FINANCE_SYNC_WORKFLOW,
      latestRun: {
        id: "run-latest",
        workflow: DEFAULT_FINANCE_SYNC_WORKFLOW,
        trigger: FinanceSyncRunTrigger.SCHEDULED,
        status: FinanceSyncRunStatus.PARTIAL,
        startedAt: "2026-04-20T10:15:00.000Z",
        completedAt: "2026-04-20T10:22:00.000Z",
        durationMs: 420000,
        xeroTenantId: "tenant-1",
        requestedByMemberId: null,
        snapshotCount: 6,
        totalRowCount: 84,
        datasetCount: 7,
        successfulDatasetCount: 6,
        failedDatasetCount: 1,
        datasets: [
          {
            datasetKey: "xero-balance-sheet",
            snapshotCount: 1,
            totalRowCount: 12,
            snapshotTypes: ["BALANCE_SHEET"],
            errorMessage: null,
          },
          {
            datasetKey: "xero-accounts-payable-invoices",
            snapshotCount: 0,
            totalRowCount: 0,
            snapshotTypes: [],
            errorMessage: "Xero timeout",
          },
        ],
        errorSummary: "Finance sync failed for 1 dataset(s)",
        failureDetails: [
          {
            stage: "dataset",
            datasetKey: "xero-accounts-payable-invoices",
            message: "Xero timeout",
          },
        ],
      },
      cron: {
        jobName: FINANCE_SYNC_CRON_JOB_NAME,
        schedule: FINANCE_SYNC_CRON_SCHEDULE,
        timezone: FINANCE_SYNC_CRON_TIMEZONE,
        latestRun: {
          id: "cron-latest",
          jobName: FINANCE_SYNC_CRON_JOB_NAME,
          status: "FAILURE",
          startedAt: "2026-04-20T10:15:00.000Z",
          completedAt: "2026-04-20T10:22:05.000Z",
          durationMs: 425000,
          financeSyncRunId: "run-latest",
          financeSyncStatus: FinanceSyncRunStatus.PARTIAL,
          snapshotCount: 6,
          totalRowCount: 84,
          datasetCount: 7,
          failedDatasetCount: 1,
          error: "Finance sync completed with PARTIAL status (1 dataset(s) failed)",
          reason: null,
        },
      },
      recentFailures: {
        syncRuns: [
          {
            id: "run-failed",
            workflow: DEFAULT_FINANCE_SYNC_WORKFLOW,
            trigger: FinanceSyncRunTrigger.SCHEDULED,
            status: FinanceSyncRunStatus.FAILED,
            startedAt: "2026-04-19T10:15:00.000Z",
            completedAt: "2026-04-19T10:16:00.000Z",
            durationMs: 60000,
            xeroTenantId: null,
            requestedByMemberId: null,
            snapshotCount: 0,
            totalRowCount: 0,
            datasetCount: 0,
            successfulDatasetCount: 0,
            failedDatasetCount: 0,
            datasets: [],
            errorSummary: "Finance Xero is not connected",
            failureDetails: [
              {
                stage: "connect",
                datasetKey: null,
                message: "Finance Xero is not connected",
              },
            ],
          },
        ],
        cronRuns: [
          {
            id: "cron-failed",
            jobName: FINANCE_SYNC_CRON_JOB_NAME,
            status: "FAILURE",
            startedAt: "2026-04-19T10:15:00.000Z",
            completedAt: "2026-04-19T10:16:01.000Z",
            durationMs: 61000,
            financeSyncRunId: "run-failed",
            financeSyncStatus: FinanceSyncRunStatus.FAILED,
            snapshotCount: null,
            totalRowCount: null,
            datasetCount: null,
            failedDatasetCount: null,
            error: "Finance Xero is not connected",
            reason: null,
          },
        ],
      },
    });
  });

  it("returns an empty diagnostics payload when no finance sync history exists", async () => {
    mockPrisma.financeSyncRun.findFirst.mockResolvedValue(null);
    mockPrisma.financeSyncRun.findMany.mockResolvedValue([]);
    mockPrisma.cronJobRun.findFirst.mockResolvedValue(null);
    mockPrisma.cronJobRun.findMany.mockResolvedValue([]);

    await expect(getFinanceSyncDiagnosticsStatus()).resolves.toEqual({
      workflow: DEFAULT_FINANCE_SYNC_WORKFLOW,
      latestRun: null,
      cron: {
        jobName: FINANCE_SYNC_CRON_JOB_NAME,
        schedule: FINANCE_SYNC_CRON_SCHEDULE,
        timezone: FINANCE_SYNC_CRON_TIMEZONE,
        latestRun: null,
      },
      recentFailures: {
        syncRuns: [],
        cronRuns: [],
      },
    });
  });
});
