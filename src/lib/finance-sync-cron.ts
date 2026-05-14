import { FinanceSyncRunStatus, FinanceSyncRunTrigger } from "@prisma/client";
import * as Sentry from "@sentry/nextjs";
import { getFinanceSyncDatasets } from "@/lib/finance-sync-datasets";
import {
  type FinanceSyncDatasetDefinition,
  type FinanceSyncExecutionResult,
  runFinanceSync,
} from "@/lib/finance-sync-service";
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";

export const FINANCE_SYNC_CRON_JOB_NAME = "finance-daily-sync";
export const FINANCE_SYNC_CRON_MONITOR_SLUG = "finance-daily-sync";
export const FINANCE_SYNC_CRON_SCHEDULE = "15 10 * * *";
export const FINANCE_SYNC_CRON_TIMEZONE = "Pacific/Auckland";
export const FINANCE_SYNC_CRON_CHECKIN_CONFIG = {
  schedule: { type: "crontab" as const, value: FINANCE_SYNC_CRON_SCHEDULE },
  timezone: FINANCE_SYNC_CRON_TIMEZONE,
  checkinMargin: 10,
  maxRuntime: 60,
};

type CronRunStatus = "SUCCESS" | "FAILURE" | "SKIPPED";
type FinanceSyncLogger = Pick<typeof logger, "error" | "info" | "warn">;

export interface FinanceSyncCronScheduler {
  schedule: (
    expression: string,
    task: () => Promise<void> | void,
    options?: { timezone?: string }
  ) => unknown;
}

export interface RecordCronRunInput {
  jobName: string;
  startedAt: Date;
  status: CronRunStatus;
  resultSummary?: Record<string, unknown>;
  error?: string;
}

export interface FinanceSyncCronRunnerDependencies {
  getDatasets?: () =>
    | FinanceSyncDatasetDefinition[]
    | Promise<FinanceSyncDatasetDefinition[]>;
  runFinanceSync?: typeof runFinanceSync;
  recordCronRun?: (input: RecordCronRunInput) => Promise<void> | void;
  captureCheckIn?: typeof Sentry.captureCheckIn;
  captureException?: typeof Sentry.captureException;
  logger?: FinanceSyncLogger;
}

export interface FinanceSyncCronRunResult {
  cronStatus: CronRunStatus;
  financeSyncStatus?: FinanceSyncRunStatus;
  reason?: string;
  runId?: string;
}

let isFinanceSyncCronRunning = false;

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error ?? "Unknown finance sync cron error");
}

function buildFinanceCronSummary(
  result: FinanceSyncExecutionResult
): Record<string, unknown> {
  const failedDatasetCount = result.datasetResults.filter(
    (dataset) => dataset.errorMessage
  ).length;

  return {
    financeSyncRunId: result.runId,
    financeSyncStatus: result.status,
    workflow: result.workflow,
    xeroTenantId: result.xeroTenantId,
    snapshotCount: result.snapshotCount,
    totalRowCount: result.totalRowCount,
    datasetCount: result.datasetResults.length,
    failedDatasetCount,
    datasets: result.datasetResults.map((dataset) => ({
      datasetKey: dataset.datasetKey,
      snapshotCount: dataset.snapshotCount,
      totalRowCount: dataset.totalRowCount,
      snapshotTypes: dataset.snapshotTypes,
      ...(dataset.errorMessage ? { errorMessage: dataset.errorMessage } : {}),
    })),
  };
}

function buildPartialErrorMessage(result: FinanceSyncExecutionResult): string {
  const failedDatasetCount = result.datasetResults.filter(
    (dataset) => dataset.errorMessage
  ).length;

  return failedDatasetCount > 0
    ? `Finance sync completed with PARTIAL status (${failedDatasetCount} dataset(s) failed)`
    : "Finance sync completed with PARTIAL status";
}

async function defaultRecordCronRun(input: RecordCronRunInput): Promise<void> {
  const completedAt = new Date();
  const durationMs = completedAt.getTime() - input.startedAt.getTime();

  await prisma.cronJobRun.create({
    data: {
      jobName: input.jobName,
      startedAt: input.startedAt,
      completedAt,
      durationMs,
      status: input.status,
      resultSummary: input.resultSummary
        ? JSON.parse(JSON.stringify(input.resultSummary))
        : undefined,
      error: input.error ?? undefined,
    },
  });
}

async function recordCronRunSafe(
  recordCronRun: (input: RecordCronRunInput) => Promise<void> | void,
  log: FinanceSyncLogger,
  input: RecordCronRunInput
): Promise<void> {
  try {
    await recordCronRun(input);
  } catch (error) {
    log.error(
      { err: error, job: input.jobName },
      "Failed to record finance cron job run"
    );
  }
}

export function resetFinanceSyncCronRunnerForTests() {
  isFinanceSyncCronRunning = false;
}

export async function runDailyFinanceSyncCron(
  dependencies: FinanceSyncCronRunnerDependencies = {}
): Promise<FinanceSyncCronRunResult> {
  const log = dependencies.logger ?? logger;
  const captureCheckIn = dependencies.captureCheckIn ?? Sentry.captureCheckIn;
  const captureException =
    dependencies.captureException ?? Sentry.captureException;
  const recordCronRun = dependencies.recordCronRun ?? defaultRecordCronRun;
  const startedAt = new Date();
  const checkInId = captureCheckIn(
    { monitorSlug: FINANCE_SYNC_CRON_MONITOR_SLUG, status: "in_progress" },
    FINANCE_SYNC_CRON_CHECKIN_CONFIG
  );

  if (isFinanceSyncCronRunning) {
    const reason = "Another finance sync cron run is already active in this process";

    log.info({ job: FINANCE_SYNC_CRON_JOB_NAME, reason }, "Already running, skipping");
    await recordCronRunSafe(recordCronRun, log, {
      jobName: FINANCE_SYNC_CRON_JOB_NAME,
      startedAt,
      status: "SKIPPED",
      resultSummary: { reason },
    });
    captureCheckIn({
      checkInId,
      monitorSlug: FINANCE_SYNC_CRON_MONITOR_SLUG,
      status: "ok",
    });

    return {
      cronStatus: "SKIPPED",
      reason,
    };
  }

  isFinanceSyncCronRunning = true;

  try {
    const datasets =
      (await (dependencies.getDatasets ?? getFinanceSyncDatasets)()) ?? [];

    if (datasets.length === 0) {
      const reason = "No finance sync datasets are registered";

      log.info({ job: FINANCE_SYNC_CRON_JOB_NAME, reason }, "Finance sync skipped");
      await recordCronRunSafe(recordCronRun, log, {
        jobName: FINANCE_SYNC_CRON_JOB_NAME,
        startedAt,
        status: "SKIPPED",
        resultSummary: { reason },
      });
      captureCheckIn({
        checkInId,
        monitorSlug: FINANCE_SYNC_CRON_MONITOR_SLUG,
        status: "ok",
      });

      return {
        cronStatus: "SKIPPED",
        reason,
      };
    }

    const result = await (dependencies.runFinanceSync ?? runFinanceSync)({
      trigger: FinanceSyncRunTrigger.SCHEDULED,
      datasets,
      metadata: {
        source: "cron",
        jobName: FINANCE_SYNC_CRON_JOB_NAME,
        schedule: FINANCE_SYNC_CRON_SCHEDULE,
      },
    });

    const summary = buildFinanceCronSummary(result);

    if (result.status === FinanceSyncRunStatus.SUCCEEDED) {
      log.info(
        {
          job: FINANCE_SYNC_CRON_JOB_NAME,
          runId: result.runId,
          snapshotCount: result.snapshotCount,
          totalRowCount: result.totalRowCount,
        },
        "Finance sync cron complete"
      );
      await recordCronRunSafe(recordCronRun, log, {
        jobName: FINANCE_SYNC_CRON_JOB_NAME,
        startedAt,
        status: "SUCCESS",
        resultSummary: summary,
      });
      captureCheckIn({
        checkInId,
        monitorSlug: FINANCE_SYNC_CRON_MONITOR_SLUG,
        status: "ok",
      });

      return {
        cronStatus: "SUCCESS",
        financeSyncStatus: result.status,
        runId: result.runId,
      };
    }

    const errorMessage = buildPartialErrorMessage(result);

    log.warn(
      {
        job: FINANCE_SYNC_CRON_JOB_NAME,
        runId: result.runId,
        snapshotCount: result.snapshotCount,
        failedDatasetCount: summary.failedDatasetCount,
      },
      "Finance sync cron completed with partial dataset failures"
    );
    await recordCronRunSafe(recordCronRun, log, {
      jobName: FINANCE_SYNC_CRON_JOB_NAME,
      startedAt,
      status: "FAILURE",
      resultSummary: summary,
      error: errorMessage,
    });
    captureCheckIn({
      checkInId,
      monitorSlug: FINANCE_SYNC_CRON_MONITOR_SLUG,
      status: "error",
    });

    return {
      cronStatus: "FAILURE",
      financeSyncStatus: result.status,
      reason: errorMessage,
      runId: result.runId,
    };
  } catch (error) {
    const message = toErrorMessage(error);

    log.error({ err: error, job: FINANCE_SYNC_CRON_JOB_NAME }, "Error running finance sync cron");
    captureException(error);
    await recordCronRunSafe(recordCronRun, log, {
      jobName: FINANCE_SYNC_CRON_JOB_NAME,
      startedAt,
      status: "FAILURE",
      error: message,
    });
    captureCheckIn({
      checkInId,
      monitorSlug: FINANCE_SYNC_CRON_MONITOR_SLUG,
      status: "error",
    });
    throw error;
  } finally {
    isFinanceSyncCronRunning = false;
  }
}

export function registerDailyFinanceSyncCron(
  scheduler: FinanceSyncCronScheduler,
  dependencies: FinanceSyncCronRunnerDependencies = {}
) {
  const log = dependencies.logger ?? logger;

  scheduler.schedule(
    FINANCE_SYNC_CRON_SCHEDULE,
    async () => {
      await runDailyFinanceSyncCron(dependencies);
    },
    { timezone: FINANCE_SYNC_CRON_TIMEZONE }
  );

  log.info(
    {
      job: FINANCE_SYNC_CRON_JOB_NAME,
      schedule: FINANCE_SYNC_CRON_SCHEDULE,
      timezone: FINANCE_SYNC_CRON_TIMEZONE,
    },
    "Scheduled daily finance sync"
  );
}
