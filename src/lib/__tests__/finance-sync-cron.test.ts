import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  FinanceSyncRunStatus,
  FinanceSyncRunTrigger,
} from "@prisma/client";

vi.mock("@sentry/nextjs", () => ({
  captureCheckIn: vi.fn(),
  captureException: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    cronJobRun: {
      create: vi.fn(),
    },
  },
}));

/**
 * CT-5 (#2869): the job's civil-time zone is the club's PERSISTED one.
 *
 * TWO THINGS HERE WERE WRONG AND BOTH MATTERED (#2869 review). The mock named
 * `@/lib/club-time-zone-settings`, which the code under test does not import —
 * it reads `readClubTimeZoneOutsideRequest` from `@/lib/club-time-zone-runtime`
 * — so the mock was never consulted at all. And it pinned `Pacific/Auckland`,
 * which is what the UNMOCKED path answers on CI anyway (no `clubTimeSettings`
 * delegate on the Prisma mock, `TZ` unset, so the documented fallback), so the
 * assertions passed on precisely the coincidence the mock's own comment claimed
 * to have removed. Measured: three of them failed the moment the host zone was
 * `America/Denver`.
 *
 * So: the module the code really imports, pinned to a zone that is neither the
 * host's nor the fallback.
 */
const CLUB_TIME_ZONE = "America/Denver";

vi.mock("@/lib/club-time-zone-runtime", () => ({
  readClubTimeZoneOutsideRequest: vi.fn(async () => CLUB_TIME_ZONE),
}));

vi.mock("@/lib/logger", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import {
  FINANCE_SYNC_CRON_JOB_NAME,
  FINANCE_SYNC_CRON_MONITOR_SLUG,
  FINANCE_SYNC_CRON_SCHEDULE,
  financeSyncCronCheckinConfig,
  registerDailyFinanceSyncCron,
  resetFinanceSyncCronRunnerForTests,
  runDailyFinanceSyncCron,
} from "@/lib/finance-sync-cron";

function createExecutionResult(status: FinanceSyncRunStatus) {
  return {
    runId: "run-1",
    workflow: "daily-finance-sync",
    trigger: FinanceSyncRunTrigger.SCHEDULED,
    status,
    xeroTenantId: "tenant-123",
    startedAt: new Date("2026-04-19T10:15:00.000Z"),
    completedAt: new Date("2026-04-19T10:16:00.000Z"),
    snapshotCount: 0,
    totalRowCount: 0,
    datasetResults: [
      {
        datasetKey: "bootstrap",
        snapshotCount: 0,
        totalRowCount: 0,
        snapshotTypes: [],
      },
    ],
  };
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, reject, resolve };
}

describe("finance-sync-cron", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetFinanceSyncCronRunnerForTests();
  });

  it("registers the daily finance sync schedule with the expected timezone", () => {
    const schedule = vi.fn();
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    registerDailyFinanceSyncCron({ schedule }, "Pacific/Auckland", { logger });

    expect(schedule).toHaveBeenCalledWith(
      FINANCE_SYNC_CRON_SCHEDULE,
      expect.any(Function),
      { timezone: "Pacific/Auckland" }
    );
    expect(logger.info).toHaveBeenCalledWith(
      {
        job: FINANCE_SYNC_CRON_JOB_NAME,
        schedule: FINANCE_SYNC_CRON_SCHEDULE,
        timezone: "Pacific/Auckland",
      },
      "Scheduled daily finance sync"
    );
  });

  it("runs the scheduled finance sync through the service boundary and records success", async () => {
    const dataset = { key: "bootstrap", sync: vi.fn().mockResolvedValue([]) };
    const runFinanceSyncMock = vi
      .fn()
      .mockResolvedValue(createExecutionResult(FinanceSyncRunStatus.SUCCEEDED));
    const recordCronRun = vi.fn();
    const captureCheckIn = vi.fn().mockReturnValue("check-in-1");
    const captureException = vi.fn();
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const result = await runDailyFinanceSyncCron({
      getDatasets: () => [dataset],
      runFinanceSync: runFinanceSyncMock,
      recordCronRun,
      captureCheckIn,
      captureException,
      logger,
    });

    expect(runFinanceSyncMock).toHaveBeenCalledWith({
      trigger: FinanceSyncRunTrigger.SCHEDULED,
      datasets: [dataset],
      metadata: {
        source: "cron",
        jobName: FINANCE_SYNC_CRON_JOB_NAME,
        schedule: FINANCE_SYNC_CRON_SCHEDULE,
      },
    });
    expect(recordCronRun).toHaveBeenCalledWith(
      expect.objectContaining({
        jobName: FINANCE_SYNC_CRON_JOB_NAME,
        status: "SUCCESS",
        resultSummary: expect.objectContaining({
          financeSyncRunId: "run-1",
          financeSyncStatus: FinanceSyncRunStatus.SUCCEEDED,
          datasetCount: 1,
        }),
      })
    );
    expect(captureCheckIn).toHaveBeenNthCalledWith(
      1,
      {
        monitorSlug: FINANCE_SYNC_CRON_MONITOR_SLUG,
        status: "in_progress",
      },
      financeSyncCronCheckinConfig(CLUB_TIME_ZONE)
    );
    expect(captureCheckIn).toHaveBeenNthCalledWith(2, {
      checkInId: "check-in-1",
      monitorSlug: FINANCE_SYNC_CRON_MONITOR_SLUG,
      status: "ok",
    });
    expect(captureException).not.toHaveBeenCalled();
    expect(result).toEqual({
      cronStatus: "SUCCESS",
      financeSyncStatus: FinanceSyncRunStatus.SUCCEEDED,
      runId: "run-1",
    });
  });

  it("skips cleanly when the Admin Modules effective state disables finance", async () => {
    const runFinanceSyncMock = vi.fn();
    const recordCronRun = vi.fn();
    const captureCheckIn = vi.fn().mockReturnValue("check-in-1");
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const result = await runDailyFinanceSyncCron({
      isModuleEnabled: () => false,
      runFinanceSync: runFinanceSyncMock,
      recordCronRun,
      captureCheckIn,
      captureException: vi.fn(),
      logger,
    });

    expect(runFinanceSyncMock).not.toHaveBeenCalled();
    expect(recordCronRun).toHaveBeenCalledWith(
      expect.objectContaining({
        jobName: FINANCE_SYNC_CRON_JOB_NAME,
        status: "SKIPPED",
        resultSummary: {
          reason: "Finance dashboard effective module state is disabled",
        },
      })
    );
    expect(captureCheckIn).toHaveBeenLastCalledWith({
      checkInId: "check-in-1",
      monitorSlug: FINANCE_SYNC_CRON_MONITOR_SLUG,
      status: "ok",
    });
    expect(result).toEqual({
      cronStatus: "SKIPPED",
      reason: "Finance dashboard effective module state is disabled",
    });
  });

  it("skips overlapping runs within the same process and records the skip", async () => {
    const dataset = { key: "bootstrap", sync: vi.fn().mockResolvedValue([]) };
    const deferred = createDeferred<ReturnType<typeof createExecutionResult>>();
    const runFinanceSyncMock = vi.fn().mockReturnValue(deferred.promise);
    const recordCronRun = vi.fn();
    const captureCheckIn = vi
      .fn()
      .mockReturnValueOnce("check-in-1")
      .mockReturnValueOnce("check-in-2")
      .mockReturnValueOnce(undefined);
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const firstRun = runDailyFinanceSyncCron({
      getDatasets: () => [dataset],
      runFinanceSync: runFinanceSyncMock,
      recordCronRun,
      captureCheckIn,
      captureException: vi.fn(),
      logger,
    });

    await Promise.resolve();

    const overlapResult = await runDailyFinanceSyncCron({
      getDatasets: () => [dataset],
      runFinanceSync: runFinanceSyncMock,
      recordCronRun,
      captureCheckIn,
      captureException: vi.fn(),
      logger,
    });

    expect(runFinanceSyncMock).toHaveBeenCalledTimes(1);
    expect(overlapResult).toEqual({
      cronStatus: "SKIPPED",
      reason: "Another finance sync cron run is already active in this process",
    });
    expect(recordCronRun).toHaveBeenCalledWith(
      expect.objectContaining({
        jobName: FINANCE_SYNC_CRON_JOB_NAME,
        status: "SKIPPED",
        resultSummary: {
          reason: "Another finance sync cron run is already active in this process",
        },
      })
    );

    deferred.resolve(createExecutionResult(FinanceSyncRunStatus.SUCCEEDED));
    await firstRun;
  });

  it("maps a partial finance sync to failure on the generic cron observability boundary", async () => {
    const dataset = { key: "bootstrap", sync: vi.fn().mockResolvedValue([]) };
    const runFinanceSyncMock = vi.fn().mockResolvedValue({
      ...createExecutionResult(FinanceSyncRunStatus.PARTIAL),
      datasetResults: [
        {
          datasetKey: "bootstrap",
          snapshotCount: 0,
          totalRowCount: 0,
          snapshotTypes: [],
        },
        {
          datasetKey: "contacts",
          snapshotCount: 0,
          totalRowCount: 0,
          snapshotTypes: [],
          errorMessage: "Xero request failed",
        },
      ],
    });
    const recordCronRun = vi.fn();
    const captureCheckIn = vi.fn().mockReturnValue("check-in-1");
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const result = await runDailyFinanceSyncCron({
      getDatasets: () => [dataset],
      runFinanceSync: runFinanceSyncMock,
      recordCronRun,
      captureCheckIn,
      captureException: vi.fn(),
      logger,
    });

    expect(recordCronRun).toHaveBeenCalledWith(
      expect.objectContaining({
        jobName: FINANCE_SYNC_CRON_JOB_NAME,
        status: "FAILURE",
        error:
          "Finance sync completed with PARTIAL status (1 dataset(s) failed)",
        resultSummary: expect.objectContaining({
          financeSyncStatus: FinanceSyncRunStatus.PARTIAL,
          failedDatasetCount: 1,
        }),
      })
    );
    expect(captureCheckIn).toHaveBeenLastCalledWith({
      checkInId: "check-in-1",
      monitorSlug: FINANCE_SYNC_CRON_MONITOR_SLUG,
      status: "error",
    });
    expect(logger.warn).toHaveBeenCalled();
    expect(result).toEqual({
      cronStatus: "FAILURE",
      financeSyncStatus: FinanceSyncRunStatus.PARTIAL,
      reason: "Finance sync completed with PARTIAL status (1 dataset(s) failed)",
      runId: "run-1",
    });
  });
});
