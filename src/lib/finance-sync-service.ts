import {
  FinanceSnapshotType,
  FinanceSyncRunStatus,
  FinanceSyncRunTrigger,
  Prisma,
} from "@prisma/client";
import { XeroClient } from "xero-node";
import { createFinanceXeroClient } from "@/lib/finance-xero";
import { loadFinanceXeroTokens } from "@/lib/finance-xero-token-store";
import {
  completeFinanceSyncRun,
  createFinanceSyncRun,
  failFinanceSyncRun,
  upsertFinanceSnapshot,
} from "@/lib/finance-sync-storage";

export const DEFAULT_FINANCE_SYNC_WORKFLOW = "daily-finance-sync";

export interface FinanceSyncSnapshotInput {
  snapshotType: FinanceSnapshotType;
  asOfDate: Date;
  rowCount: number;
  payload: Prisma.InputJsonValue;
  scope?: string;
  periodStart?: Date | null;
  periodEnd?: Date | null;
  currency?: string | null;
  sourceUpdatedAt?: Date | null;
}

export interface FinanceSyncDatasetContext {
  runId: string;
  workflow: string;
  trigger: FinanceSyncRunTrigger;
  startedAt: Date;
  xeroTenantId: string;
  xero: XeroClient;
}

export interface FinanceSyncDatasetDefinition {
  key: string;
  description?: string;
  sync: (
    context: FinanceSyncDatasetContext
  ) =>
    | Promise<FinanceSyncSnapshotInput | FinanceSyncSnapshotInput[]>
    | FinanceSyncSnapshotInput
    | FinanceSyncSnapshotInput[];
}

export interface RunFinanceSyncInput {
  datasets: FinanceSyncDatasetDefinition[];
  trigger: FinanceSyncRunTrigger;
  workflow?: string;
  requestedByMemberId?: string | null;
  metadata?: Prisma.InputJsonValue;
  startedAt?: Date;
}

export interface FinanceSyncDatasetResult {
  datasetKey: string;
  snapshotCount: number;
  totalRowCount: number;
  snapshotTypes: FinanceSnapshotType[];
  errorMessage?: string;
}

export interface FinanceSyncExecutionResult {
  runId: string;
  workflow: string;
  trigger: FinanceSyncRunTrigger;
  status: FinanceSyncRunStatus;
  xeroTenantId: string | null;
  startedAt: Date;
  completedAt: Date;
  snapshotCount: number;
  totalRowCount: number;
  datasetResults: FinanceSyncDatasetResult[];
}

export interface FinanceXeroSyncConnection {
  tenantId: string;
  tokenExpiresAt: Date;
  xero: XeroClient;
}

function normalizeRequiredText(value: string, fieldName: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${fieldName} is required`);
  }

  return trimmed;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error ?? "Unknown finance sync error");
}

function normalizeSnapshots(
  result: FinanceSyncSnapshotInput | FinanceSyncSnapshotInput[]
): FinanceSyncSnapshotInput[] {
  return Array.isArray(result) ? result : [result];
}

function buildDatasetMetadata(
  inputMetadata: Prisma.InputJsonValue | undefined,
  datasets: FinanceSyncDatasetDefinition[]
): Prisma.InputJsonValue {
  return {
    datasetKeys: datasets.map((dataset) => dataset.key),
    input: inputMetadata ?? null,
  };
}

function buildDatasetResult(
  datasetKey: string,
  snapshots: FinanceSyncSnapshotInput[],
  errorMessage?: string
): FinanceSyncDatasetResult {
  return {
    datasetKey,
    snapshotCount: snapshots.length,
    totalRowCount: snapshots.reduce((sum, snapshot) => sum + snapshot.rowCount, 0),
    snapshotTypes: Array.from(
      new Set(snapshots.map((snapshot) => snapshot.snapshotType))
    ),
    ...(errorMessage ? { errorMessage } : {}),
  };
}

function buildRunErrorSummary(failedDatasetCount: number): string {
  return `Finance sync failed for ${failedDatasetCount} dataset(s)`;
}

function buildRunResultSummary(input: {
  datasetCount: number;
  failedDatasetCount: number;
  datasetResults: FinanceSyncDatasetResult[];
}): Prisma.InputJsonObject {
  const datasets: Prisma.InputJsonArray = input.datasetResults.map(
    (dataset): Prisma.InputJsonObject => ({
      datasetKey: dataset.datasetKey,
      snapshotCount: dataset.snapshotCount,
      totalRowCount: dataset.totalRowCount,
      snapshotTypes: dataset.snapshotTypes.map((snapshotType) => snapshotType),
      ...(dataset.errorMessage ? { errorMessage: dataset.errorMessage } : {}),
    })
  );

  return {
    datasetCount: input.datasetCount,
    failedDatasetCount: input.failedDatasetCount,
    successfulDatasetCount: input.datasetCount - input.failedDatasetCount,
    datasets,
  };
}

function assertDatasets(datasets: FinanceSyncDatasetDefinition[]): void {
  if (datasets.length === 0) {
    throw new Error("At least one finance sync dataset is required");
  }

  for (const dataset of datasets) {
    normalizeRequiredText(dataset.key, "dataset key");
  }
}

export async function createFinanceXeroSyncConnection(): Promise<FinanceXeroSyncConnection> {
  const tokens = await loadFinanceXeroTokens();

  if (!tokens) {
    throw new Error("Finance Xero is not connected");
  }

  const xero = createFinanceXeroClient();
  await xero.initialize();
  xero.setTokenSet({
    access_token: tokens.accessToken,
    refresh_token: tokens.refreshToken,
    token_type: "Bearer",
  });
  await xero.updateTenants();

  const tenantId = tokens.tenantId ?? xero.tenants[0]?.tenantId;

  if (!tenantId) {
    throw new Error("Finance Xero tenant is not available");
  }

  return {
    tenantId,
    tokenExpiresAt: tokens.expiresAt,
    xero,
  };
}

export async function runFinanceSync(
  input: RunFinanceSyncInput
): Promise<FinanceSyncExecutionResult> {
  assertDatasets(input.datasets);

  const workflow = normalizeRequiredText(
    input.workflow ?? DEFAULT_FINANCE_SYNC_WORKFLOW,
    "workflow"
  );
  const startedAt = input.startedAt ?? new Date();

  let connection: FinanceXeroSyncConnection | null = null;
  let connectionError: unknown = null;

  try {
    connection = await createFinanceXeroSyncConnection();
  } catch (error) {
    connectionError = error;
  }

  const run = await createFinanceSyncRun({
    workflow,
    trigger: input.trigger,
    startedAt,
    requestedByMemberId: input.requestedByMemberId ?? null,
    xeroTenantId: connection?.tenantId ?? null,
    metadata: buildDatasetMetadata(input.metadata, input.datasets),
  });

  if (connectionError || !connection) {
    const completedAt = new Date();
    const errorSummary = toErrorMessage(connectionError);

    await failFinanceSyncRun({
      runId: run.id,
      completedAt,
      errorSummary,
      errorDetails: {
        stage: "connect",
        message: errorSummary,
      },
    });

    throw new Error(errorSummary);
  }

  const datasetResults: FinanceSyncDatasetResult[] = [];
  const failedDatasets: Array<{ datasetKey: string; errorMessage: string }> = [];
  let snapshotCount = 0;
  let totalRowCount = 0;

  const context: FinanceSyncDatasetContext = {
    runId: run.id,
    workflow,
    trigger: input.trigger,
    startedAt,
    xeroTenantId: connection.tenantId,
    xero: connection.xero,
  };

  for (const dataset of input.datasets) {
    try {
      const snapshots = normalizeSnapshots(await dataset.sync(context));

      for (const snapshot of snapshots) {
        await upsertFinanceSnapshot({
          ...snapshot,
          syncRunId: run.id,
        });
      }

      const datasetResult = buildDatasetResult(dataset.key, snapshots);
      datasetResults.push(datasetResult);
      snapshotCount += datasetResult.snapshotCount;
      totalRowCount += datasetResult.totalRowCount;
    } catch (error) {
      const errorMessage = toErrorMessage(error);
      failedDatasets.push({
        datasetKey: dataset.key,
        errorMessage,
      });
      datasetResults.push(buildDatasetResult(dataset.key, [], errorMessage));
    }
  }

  const completedAt = new Date();
  const resultSummary = buildRunResultSummary({
    datasetCount: input.datasets.length,
    failedDatasetCount: failedDatasets.length,
    datasetResults,
  });

  if (failedDatasets.length === 0) {
    await completeFinanceSyncRun({
      runId: run.id,
      completedAt,
      snapshotCount,
      totalRowCount,
      resultSummary,
    });

    return {
      runId: run.id,
      workflow,
      trigger: input.trigger,
      status: FinanceSyncRunStatus.SUCCEEDED,
      xeroTenantId: connection.tenantId,
      startedAt,
      completedAt,
      snapshotCount,
      totalRowCount,
      datasetResults,
    };
  }

  const errorSummary = buildRunErrorSummary(failedDatasets.length);

  if (snapshotCount === 0) {
    await failFinanceSyncRun({
      runId: run.id,
      completedAt,
      snapshotCount,
      totalRowCount,
      errorSummary,
      errorDetails: {
        stage: "datasets",
        failures: failedDatasets,
      },
    });

    throw new Error(errorSummary);
  }

  await completeFinanceSyncRun({
    runId: run.id,
    status: FinanceSyncRunStatus.PARTIAL,
    completedAt,
    snapshotCount,
    totalRowCount,
    resultSummary,
    errorSummary,
  });

  return {
    runId: run.id,
    workflow,
    trigger: input.trigger,
    status: FinanceSyncRunStatus.PARTIAL,
    xeroTenantId: connection.tenantId,
    startedAt,
    completedAt,
    snapshotCount,
    totalRowCount,
    datasetResults,
  };
}
