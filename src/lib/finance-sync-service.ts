import {
  FinanceMonthlyStatementKind,
  FinanceSnapshotType,
  FinanceSyncRunStatus,
  FinanceSyncRunTrigger,
  Prisma,
} from "@prisma/client";
import { XeroClient } from "xero-node";
import type { FinanceMonthlyFactRowInput } from "@/lib/finance-monthly-facts";
import { replaceMonthlyFacts } from "@/lib/finance-monthly-fact-store";
import type { ClubTimeZone } from "@/lib/club-time";
import { readClubTimeZoneOutsideRequest } from "@/lib/club-time-zone-runtime";
import { getAuthenticatedXeroClient } from "@/lib/xero-api-client";
import {
  completeFinanceSyncRun,
  createFinanceSyncRun,
  failFinanceSyncRun,
  upsertFinanceSnapshot,
} from "@/lib/finance-sync-storage";

export const DEFAULT_FINANCE_SYNC_WORKFLOW = "daily-finance-sync";

/**
 * Monthly per-account fact rows derived from a snapshot's report payload.
 * When present, runFinanceSync persists them to FinanceAccountMonthlyBalance
 * (replacing the covered months) right after the snapshot itself is stored.
 */
interface FinanceSyncSnapshotMonthlyFacts {
  statementKind: FinanceMonthlyStatementKind;
  /** Month keys ("YYYY-MM") covered by the pulled report window. */
  months: string[];
  rows: FinanceMonthlyFactRowInput[];
  sourceReport: string;
  scope?: string;
  /** Leaf-row labels with amounts that could not be resolved to a GL code. */
  unresolvedRowLabels?: string[];
}

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
  monthlyFacts?: FinanceSyncSnapshotMonthlyFacts;
}

export interface FinanceSyncDatasetContext {
  runId: string;
  workflow: string;
  trigger: FinanceSyncRunTrigger;
  startedAt: Date;
  xeroTenantId: string;
  xero: XeroClient;
  /**
   * The club's civil-time authority for this run (CT-5, #2869).
   *
   * `startedAt` is an INSTANT and therefore has no calendar day of its own, and
   * every dataset needs one — the snapshot's `asOfDate`, its period start, the
   * monthly-fact month key. Resolving the persisted zone ONCE per run and
   * carrying it on the context is what keeps those answers identical across
   * every dataset in a run, keeps the read outside every database transaction,
   * and stops each dataset re-deriving the zone from `process.env.TZ`
   * (`INV-CONFIG-002`).
   */
  clubTimeZone: ClubTimeZone;
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

interface FinanceSyncDatasetResult {
  datasetKey: string;
  snapshotCount: number;
  totalRowCount: number;
  snapshotTypes: FinanceSnapshotType[];
  /** Monthly fact rows persisted from this dataset's snapshots, when any. */
  factRowCount?: number;
  /** Report rows that could not be resolved to a GL code, when facts ran. */
  unresolvedFactRowCount?: number;
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
  const factSnapshots = snapshots.filter((snapshot) => snapshot.monthlyFacts);
  const factRowCount = factSnapshots.reduce(
    (sum, snapshot) => sum + (snapshot.monthlyFacts?.rows.length ?? 0),
    0
  );
  const unresolvedFactRowCount = factSnapshots.reduce(
    (sum, snapshot) =>
      sum + (snapshot.monthlyFacts?.unresolvedRowLabels?.length ?? 0),
    0
  );

  return {
    datasetKey,
    snapshotCount: snapshots.length,
    totalRowCount: snapshots.reduce((sum, snapshot) => sum + snapshot.rowCount, 0),
    snapshotTypes: Array.from(
      new Set(snapshots.map((snapshot) => snapshot.snapshotType))
    ),
    ...(factSnapshots.length > 0 ? { factRowCount, unresolvedFactRowCount } : {}),
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
      ...(dataset.factRowCount !== undefined
        ? {
            factRowCount: dataset.factRowCount,
            unresolvedFactRowCount: dataset.unresolvedFactRowCount ?? 0,
          }
        : {}),
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

// test seam
export async function createFinanceXeroSyncConnection(): Promise<FinanceXeroSyncConnection> {
  // The finance dashboard now reads from the single operational Xero connection
  // (the same one bookings, payments and subscriptions use). The dataset
  // fetchers already meter their calls through callXeroApi, so only the
  // authenticated client needs to come from the operational token store.
  const { xero, tenantId } = await getAuthenticatedXeroClient();

  return {
    tenantId,
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
    // Read once per run, before any dataset executes and outside every
    // transaction. See the field's own note on the context type.
    //
    // The CLI-reachable reader rather than the request-scoped one: this service
    // is also the entry point of `npm run finance:backfill-monthly-facts`, and a
    // `server-only` import throws under `tsx` before the script prints anything.
    clubTimeZone: await readClubTimeZoneOutsideRequest(),
  };

  for (const dataset of input.datasets) {
    try {
      const snapshots = normalizeSnapshots(await dataset.sync(context));

      for (const snapshot of snapshots) {
        const { monthlyFacts, ...snapshotFields } = snapshot;

        await upsertFinanceSnapshot({
          ...snapshotFields,
          syncRunId: run.id,
        });

        if (monthlyFacts) {
          await replaceMonthlyFacts({
            statementKind: monthlyFacts.statementKind,
            months: monthlyFacts.months,
            rows: monthlyFacts.rows,
            sourceReport: monthlyFacts.sourceReport,
            scope: monthlyFacts.scope,
            currency: snapshot.currency ?? null,
            syncRunId: run.id,
          });
        }
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
