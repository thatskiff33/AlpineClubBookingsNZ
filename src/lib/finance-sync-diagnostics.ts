import { FinanceSyncRunStatus, Prisma } from "@prisma/client";
import {
  FINANCE_SYNC_CRON_JOB_NAME,
  FINANCE_SYNC_CRON_SCHEDULE,
  FINANCE_SYNC_CRON_TIMEZONE,
} from "@/lib/finance-sync-cron";
import { DEFAULT_FINANCE_SYNC_WORKFLOW } from "@/lib/finance-sync-service";
import { prisma } from "@/lib/prisma";

const DEFAULT_RECENT_FAILURE_LIMIT = 5;

const financeSyncRunDiagnosticsSelect =
  Prisma.validator<Prisma.FinanceSyncRunSelect>()({
    id: true,
    workflow: true,
    trigger: true,
    status: true,
    startedAt: true,
    completedAt: true,
    snapshotCount: true,
    totalRowCount: true,
    xeroTenantId: true,
    requestedByMemberId: true,
    resultSummary: true,
    errorSummary: true,
    errorDetails: true,
  });

const cronJobRunDiagnosticsSelect =
  Prisma.validator<Prisma.CronJobRunSelect>()({
    id: true,
    jobName: true,
    startedAt: true,
    completedAt: true,
    durationMs: true,
    status: true,
    resultSummary: true,
    error: true,
  });

type FinanceSyncRunDiagnosticsRecord = Prisma.FinanceSyncRunGetPayload<{
  select: typeof financeSyncRunDiagnosticsSelect;
}>;

type CronJobRunDiagnosticsRecord = Prisma.CronJobRunGetPayload<{
  select: typeof cronJobRunDiagnosticsSelect;
}>;

export interface FinanceSyncDiagnosticsDatasetSummary {
  datasetKey: string;
  snapshotCount: number;
  totalRowCount: number;
  snapshotTypes: string[];
  errorMessage: string | null;
}

export interface FinanceSyncDiagnosticsFailureDetail {
  stage: string | null;
  datasetKey: string | null;
  message: string;
}

export interface FinanceSyncDiagnosticsRunSummary {
  id: string;
  workflow: string;
  trigger: string;
  status: string;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  xeroTenantId: string | null;
  requestedByMemberId: string | null;
  snapshotCount: number;
  totalRowCount: number;
  datasetCount: number;
  successfulDatasetCount: number;
  failedDatasetCount: number;
  datasets: FinanceSyncDiagnosticsDatasetSummary[];
  errorSummary: string | null;
  failureDetails: FinanceSyncDiagnosticsFailureDetail[];
}

export interface FinanceSyncDiagnosticsCronRunSummary {
  id: string;
  jobName: string;
  status: string;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  financeSyncRunId: string | null;
  financeSyncStatus: string | null;
  snapshotCount: number | null;
  totalRowCount: number | null;
  datasetCount: number | null;
  failedDatasetCount: number | null;
  error: string | null;
  reason: string | null;
}

export interface FinanceSyncDiagnosticsStatus {
  workflow: string;
  latestRun: FinanceSyncDiagnosticsRunSummary | null;
  cron: {
    jobName: string;
    schedule: string;
    timezone: string;
    latestRun: FinanceSyncDiagnosticsCronRunSummary | null;
  };
  recentFailures: {
    syncRuns: FinanceSyncDiagnosticsRunSummary[];
    cronRuns: FinanceSyncDiagnosticsCronRunSummary[];
  };
}

function normalizeRequiredText(value: string, fieldName: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${fieldName} is required`);
  }

  return trimmed;
}

function clampRecentFailureLimit(value?: number): number {
  if (value === undefined) {
    return DEFAULT_RECENT_FAILURE_LIMIT;
  }

  if (!Number.isInteger(value) || value < 1) {
    throw new Error("recentFailureLimit must be a positive integer");
  }

  return Math.min(value, 10);
}

function isJsonObject(
  value: Prisma.JsonValue | null | undefined
): value is Prisma.JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonArray(
  value: Prisma.JsonValue | null | undefined
): value is Prisma.JsonArray {
  return Array.isArray(value);
}

function readJsonString(value: Prisma.JsonValue | null | undefined): string | null {
  return typeof value === "string" ? value : null;
}

function readJsonNumber(value: Prisma.JsonValue | null | undefined): number | null {
  return typeof value === "number" ? value : null;
}

function readJsonStringArray(
  value: Prisma.JsonValue | null | undefined
): string[] {
  if (!isJsonArray(value)) {
    return [];
  }

  return value.filter((entry): entry is string => typeof entry === "string");
}

function toIsoString(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

function calculateDurationMs(
  startedAt: Date,
  completedAt: Date | null | undefined
): number | null {
  if (!completedAt) {
    return null;
  }

  return Math.max(completedAt.getTime() - startedAt.getTime(), 0);
}

function parseDatasetSummaries(
  resultSummary: Prisma.JsonValue | null | undefined
): FinanceSyncDiagnosticsDatasetSummary[] {
  if (!isJsonObject(resultSummary) || !isJsonArray(resultSummary.datasets)) {
    return [];
  }

  const datasets: FinanceSyncDiagnosticsDatasetSummary[] = [];

  for (const dataset of resultSummary.datasets) {
    if (!isJsonObject(dataset)) {
      continue;
    }

    const datasetKey = readJsonString(dataset.datasetKey);
    if (!datasetKey) {
      continue;
    }

    datasets.push({
      datasetKey,
      snapshotCount: readJsonNumber(dataset.snapshotCount) ?? 0,
      totalRowCount: readJsonNumber(dataset.totalRowCount) ?? 0,
      snapshotTypes: readJsonStringArray(dataset.snapshotTypes),
      errorMessage: readJsonString(dataset.errorMessage),
    });
  }

  return datasets;
}

function parseFailureDetails(
  errorDetails: Prisma.JsonValue | null | undefined,
  datasets: FinanceSyncDiagnosticsDatasetSummary[]
): FinanceSyncDiagnosticsFailureDetail[] {
  const failures: FinanceSyncDiagnosticsFailureDetail[] = [];
  const seen = new Set<string>();

  const pushFailure = (
    stage: string | null,
    datasetKey: string | null,
    message: string | null
  ) => {
    if (!message) {
      return;
    }

    const key = `${stage ?? ""}|${datasetKey ?? ""}|${message}`;
    if (seen.has(key)) {
      return;
    }

    seen.add(key);
    failures.push({
      stage,
      datasetKey,
      message,
    });
  };

  for (const dataset of datasets) {
    pushFailure("dataset", dataset.datasetKey, dataset.errorMessage);
  }

  if (!errorDetails) {
    return failures;
  }

  if (isJsonObject(errorDetails)) {
    const stage = readJsonString(errorDetails.stage);
    pushFailure(stage, null, readJsonString(errorDetails.message));

    if (isJsonArray(errorDetails.failures)) {
      for (const failure of errorDetails.failures) {
        if (!isJsonObject(failure)) {
          continue;
        }

        pushFailure(
          stage,
          readJsonString(failure.datasetKey),
          readJsonString(failure.errorMessage) ?? readJsonString(failure.message)
        );
      }
    }

    return failures;
  }

  pushFailure(null, null, readJsonString(errorDetails));
  return failures;
}

function countFailedDatasets(
  datasets: FinanceSyncDiagnosticsDatasetSummary[],
  failureDetails: FinanceSyncDiagnosticsFailureDetail[]
): number {
  const datasetFailures = datasets.filter((dataset) => dataset.errorMessage).length;
  if (datasetFailures > 0) {
    return datasetFailures;
  }

  const failedDatasetKeys = new Set(
    failureDetails
      .map((failure) => failure.datasetKey)
      .filter((datasetKey): datasetKey is string => Boolean(datasetKey))
  );

  if (failedDatasetKeys.size > 0) {
    return failedDatasetKeys.size;
  }

  return 0;
}

function mapFinanceSyncRun(
  run: FinanceSyncRunDiagnosticsRecord
): FinanceSyncDiagnosticsRunSummary {
  const datasets = parseDatasetSummaries(run.resultSummary);
  const failureDetails = parseFailureDetails(run.errorDetails, datasets);
  const resultSummary = isJsonObject(run.resultSummary) ? run.resultSummary : null;
  const failedDatasetCount =
    readJsonNumber(resultSummary?.failedDatasetCount) ??
    countFailedDatasets(datasets, failureDetails);
  const datasetCount =
    readJsonNumber(resultSummary?.datasetCount) ??
    (datasets.length > 0 ? datasets.length : failedDatasetCount);
  const successfulDatasetCount =
    readJsonNumber(resultSummary?.successfulDatasetCount) ??
    Math.max(datasetCount - failedDatasetCount, 0);

  return {
    id: run.id,
    workflow: run.workflow,
    trigger: run.trigger,
    status: run.status,
    startedAt: run.startedAt.toISOString(),
    completedAt: toIsoString(run.completedAt),
    durationMs: calculateDurationMs(run.startedAt, run.completedAt),
    xeroTenantId: run.xeroTenantId,
    requestedByMemberId: run.requestedByMemberId,
    snapshotCount: run.snapshotCount,
    totalRowCount: run.totalRowCount,
    datasetCount,
    successfulDatasetCount,
    failedDatasetCount,
    datasets,
    errorSummary: run.errorSummary,
    failureDetails,
  };
}

function mapCronJobRun(
  run: CronJobRunDiagnosticsRecord
): FinanceSyncDiagnosticsCronRunSummary {
  const summary = isJsonObject(run.resultSummary) ? run.resultSummary : null;

  return {
    id: run.id,
    jobName: run.jobName,
    status: run.status,
    startedAt: run.startedAt.toISOString(),
    completedAt: toIsoString(run.completedAt),
    durationMs:
      typeof run.durationMs === "number"
        ? run.durationMs
        : calculateDurationMs(run.startedAt, run.completedAt),
    financeSyncRunId: readJsonString(summary?.financeSyncRunId),
    financeSyncStatus: readJsonString(summary?.financeSyncStatus),
    snapshotCount: readJsonNumber(summary?.snapshotCount),
    totalRowCount: readJsonNumber(summary?.totalRowCount),
    datasetCount: readJsonNumber(summary?.datasetCount),
    failedDatasetCount: readJsonNumber(summary?.failedDatasetCount),
    error: run.error,
    reason: readJsonString(summary?.reason),
  };
}

export async function getFinanceSyncDiagnosticsStatus(input?: {
  workflow?: string;
  recentFailureLimit?: number;
}): Promise<FinanceSyncDiagnosticsStatus> {
  const workflow = normalizeRequiredText(
    input?.workflow ?? DEFAULT_FINANCE_SYNC_WORKFLOW,
    "workflow"
  );
  const recentFailureLimit = clampRecentFailureLimit(input?.recentFailureLimit);

  const [latestRun, recentFailedRuns, latestCronRun, recentFailedCronRuns] =
    await Promise.all([
      prisma.financeSyncRun.findFirst({
        where: { workflow },
        orderBy: [{ startedAt: "desc" }, { createdAt: "desc" }],
        select: financeSyncRunDiagnosticsSelect,
      }),
      prisma.financeSyncRun.findMany({
        where: {
          workflow,
          status: {
            in: [FinanceSyncRunStatus.FAILED, FinanceSyncRunStatus.PARTIAL],
          },
        },
        orderBy: [{ startedAt: "desc" }, { createdAt: "desc" }],
        take: recentFailureLimit,
        select: financeSyncRunDiagnosticsSelect,
      }),
      prisma.cronJobRun.findFirst({
        where: { jobName: FINANCE_SYNC_CRON_JOB_NAME },
        orderBy: [{ startedAt: "desc" }, { createdAt: "desc" }],
        select: cronJobRunDiagnosticsSelect,
      }),
      prisma.cronJobRun.findMany({
        where: {
          jobName: FINANCE_SYNC_CRON_JOB_NAME,
          status: "FAILURE",
        },
        orderBy: [{ startedAt: "desc" }, { createdAt: "desc" }],
        take: recentFailureLimit,
        select: cronJobRunDiagnosticsSelect,
      }),
    ]);

  return {
    workflow,
    latestRun: latestRun ? mapFinanceSyncRun(latestRun) : null,
    cron: {
      jobName: FINANCE_SYNC_CRON_JOB_NAME,
      schedule: FINANCE_SYNC_CRON_SCHEDULE,
      timezone: FINANCE_SYNC_CRON_TIMEZONE,
      latestRun: latestCronRun ? mapCronJobRun(latestCronRun) : null,
    },
    recentFailures: {
      syncRuns: recentFailedRuns
        .filter((run) => run.id !== latestRun?.id)
        .map(mapFinanceSyncRun),
      cronRuns: recentFailedCronRuns
        .filter((run) => run.id !== latestCronRun?.id)
        .map(mapCronJobRun),
    },
  };
}
