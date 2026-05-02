import { FinanceSyncRunStatus, FinanceSyncRunTrigger } from "@prisma/client";
import { getFinanceSyncDatasets } from "@/lib/finance-sync-datasets";
import {
  DEFAULT_FINANCE_SYNC_WORKFLOW,
  type FinanceSyncExecutionResult,
  runFinanceSync,
} from "@/lib/finance-sync-service";
import { getLatestFinanceSyncRun } from "@/lib/finance-sync-storage";
import logger from "@/lib/logger";

export interface ManualFinanceSyncInput {
  requestedByMemberId: string;
}

export interface ManualFinanceSyncAlreadyRunningResult {
  outcome: "already-running";
  runId: string;
  startedAt: Date;
}

export interface ManualFinanceSyncFinishedResult {
  outcome: "finished";
  execution: FinanceSyncExecutionResult;
}

export type ManualFinanceSyncResult =
  | ManualFinanceSyncAlreadyRunningResult
  | ManualFinanceSyncFinishedResult;

export async function runManualFinanceSync(
  input: ManualFinanceSyncInput
): Promise<ManualFinanceSyncResult> {
  const latestRun = await getLatestFinanceSyncRun(DEFAULT_FINANCE_SYNC_WORKFLOW);

  if (latestRun?.status === FinanceSyncRunStatus.RUNNING) {
    logger.info(
      {
        runId: latestRun.id,
        workflow: DEFAULT_FINANCE_SYNC_WORKFLOW,
        requestedByMemberId: input.requestedByMemberId,
      },
      "Manual finance sync request skipped because a sync is already running"
    );

    return {
      outcome: "already-running",
      runId: latestRun.id,
      startedAt: latestRun.startedAt,
    };
  }

  const execution = await runFinanceSync({
    workflow: DEFAULT_FINANCE_SYNC_WORKFLOW,
    trigger: FinanceSyncRunTrigger.MANUAL,
    requestedByMemberId: input.requestedByMemberId,
    datasets: getFinanceSyncDatasets(),
    metadata: {
      source: "manual",
      initiatedFrom: "/finance",
    },
  });

  logger.info(
    {
      runId: execution.runId,
      workflow: execution.workflow,
      status: execution.status,
      requestedByMemberId: input.requestedByMemberId,
      snapshotCount: execution.snapshotCount,
      totalRowCount: execution.totalRowCount,
    },
    "Manual finance sync completed"
  );

  return {
    outcome: "finished",
    execution,
  };
}
