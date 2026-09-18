import { isEffectiveModuleEnabled } from "@/lib/admin-modules";
import {
  recordCronJobRunSafe,
  type CronJobRunStatus,
  type RecordCronJobRunInput,
} from "@/lib/cron-job-run";
import logger from "@/lib/logger";
import { isXeroDailyMembershipRefreshEnabled } from "@/lib/xero-feature-flags";
import {
  backfillHistoricalXeroObjectLinks,
  cleanupStaleCanonicalXeroObjectLinks,
  sendXeroReconciliationReport,
} from "@/lib/xero-hardening";
import { runXeroInboundReconciliationCycle } from "@/lib/xero-inbound-reconciliation";
import {
  reconcileXeroCreditSync,
  XERO_CREDIT_SYNC_JOB_NAME,
} from "@/lib/xero-credit-sync-checker";
import { processQueuedXeroOutboxOperations } from "@/lib/xero-operation-outbox";
import { processQueuedXeroOperationRetries } from "@/lib/xero-operation-queue";
import { refreshAllMembershipStatuses } from "@/lib/xero-membership-sync";
import { isXeroConnected } from "@/lib/xero-token-store";

const XERO_CRON_TASKS = [
  "memberships",
  "outbox",
  "retries",
  "inbound",
  "backfill",
  "link-cleanup",
  "report",
  "credit-sync",
] as const;

export type XeroCronTask = (typeof XERO_CRON_TASKS)[number];
export type XeroCronTaskSelection = XeroCronTask | "all";

const XERO_CRON_JOB_NAMES: Record<XeroCronTask, string> = {
  memberships: "xero-membership-refresh",
  outbox: "xero-outbox",
  retries: "xero-operation-replay",
  inbound: "xero-inbound-reconcile",
  backfill: "xero-link-backfill",
  "link-cleanup": "xero-link-cleanup",
  report: "xero-reconciliation-report",
  "credit-sync": XERO_CREDIT_SYNC_JOB_NAME,
};

export interface XeroCronRunnerPayload {
  message: string;
  task: string;
  connected: boolean;
  membershipRefresh: unknown | null;
  queuedOutboxOperations: unknown | null;
  queuedRetries: unknown | null;
  inboundReconciliation: unknown | null;
  linkBackfill: unknown | null;
  linkCleanup: unknown | null;
  reconciliationReport: unknown | null;
  creditSyncCheck: unknown | null;
}

export interface XeroCronRunnerDependencies {
  recordCronRun?: (input: RecordCronJobRunInput) => Promise<void> | void;
  isModuleEnabled?: typeof isEffectiveModuleEnabled;
  isConnected?: typeof isXeroConnected;
  isDailyMembershipRefreshEnabled?: typeof isXeroDailyMembershipRefreshEnabled;
  log?: Pick<typeof logger, "error">;
  tasks?: Partial<{
    refreshAllMembershipStatuses: typeof refreshAllMembershipStatuses;
    processQueuedXeroOutboxOperations: typeof processQueuedXeroOutboxOperations;
    processQueuedXeroOperationRetries: typeof processQueuedXeroOperationRetries;
    runXeroInboundReconciliationCycle: typeof runXeroInboundReconciliationCycle;
    backfillHistoricalXeroObjectLinks: typeof backfillHistoricalXeroObjectLinks;
    cleanupStaleCanonicalXeroObjectLinks: typeof cleanupStaleCanonicalXeroObjectLinks;
    sendXeroReconciliationReport: typeof sendXeroReconciliationReport;
    reconcileXeroCreditSync: typeof reconcileXeroCreditSync;
  }>;
  includeLinkCleanupForBackfill?: boolean;
}

export class XeroCronRunnerError extends Error {
  payload: XeroCronRunnerPayload;
  failures: Array<{ task: XeroCronTask; message: string }>;

  constructor(
    payload: XeroCronRunnerPayload,
    failures: Array<{ task: XeroCronTask; message: string }>
  ) {
    // One failure reports its own message; none or several report the task
    // list, which is what the length check chose between (#2800).
    const [soleFailure, ...extraFailures] = failures;
    super(
      soleFailure !== undefined && extraFailures.length === 0
        ? soleFailure.message
        : `Xero cron failed for ${failures
            .map((failure) => failure.task)
            .join(", ")}`
    );
    this.name = "XeroCronRunnerError";
    this.payload = payload;
    this.failures = failures;
  }
}

export function isXeroCronTask(value: string): value is XeroCronTask {
  return XERO_CRON_TASKS.includes(value as XeroCronTask);
}

function tasksForSelection(
  task: XeroCronTaskSelection,
  options: { includeLinkCleanupForBackfill: boolean }
): XeroCronTask[] {
  if (task === "all") return [...XERO_CRON_TASKS];
  if (task === "backfill" && options.includeLinkCleanupForBackfill) {
    return ["backfill", "link-cleanup"];
  }
  return [task];
}

function cronStatusForResult(result: unknown): CronJobRunStatus {
  return result &&
    typeof result === "object" &&
    "skipped" in result &&
    (result as { skipped?: unknown }).skipped
    ? "SKIPPED"
    : "SUCCESS";
}

function resultSummaryFor(result: unknown) {
  return result && typeof result === "object"
    ? (result as Record<string, unknown>)
    : { result };
}

function toErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

async function recordSkippedXeroTasks({
  tasks,
  reason,
  recordCronRun,
}: {
  tasks: XeroCronTask[];
  reason: string;
  recordCronRun: (input: RecordCronJobRunInput) => Promise<void> | void;
}) {
  await Promise.all(
    tasks.map((subtask) =>
      recordCronRun({
        jobName: XERO_CRON_JOB_NAMES[subtask],
        startedAt: new Date(),
        status: "SKIPPED",
        resultSummary: { skipped: true, reason },
      })
    )
  );
}

async function runRecordedXeroTask<T>({
  task,
  work,
  recordCronRun,
}: {
  task: XeroCronTask;
  work: () => Promise<T> | T;
  recordCronRun: (input: RecordCronJobRunInput) => Promise<void> | void;
}): Promise<T> {
  const startedAt = new Date();
  try {
    const result = await work();
    await recordCronRun({
      jobName: XERO_CRON_JOB_NAMES[task],
      startedAt,
      status: cronStatusForResult(result),
      resultSummary: resultSummaryFor(result),
    });
    return result;
  } catch (error) {
    await recordCronRun({
      jobName: XERO_CRON_JOB_NAMES[task],
      startedAt,
      status: "FAILURE",
      error: toErrorMessage(error),
    });
    throw error;
  }
}

function emptyPayload(task: string, connected = false): XeroCronRunnerPayload {
  return {
    message: messageForTask(task),
    task,
    connected,
    membershipRefresh: null,
    queuedOutboxOperations: null,
    queuedRetries: null,
    inboundReconciliation: null,
    linkBackfill: null,
    linkCleanup: null,
    reconciliationReport: null,
    creditSyncCheck: null,
  };
}

function messageForTask(task: string) {
  switch (task) {
    case "all":
      return "Xero cron tasks completed";
    case "report":
      return "Xero reconciliation report completed";
    case "credit-sync":
      return "Xero credit-sync check completed";
    case "backfill":
      return "Historical Xero link maintenance completed";
    case "link-cleanup":
      return "Stale Xero canonical links cleaned up";
    case "inbound":
      return "Xero inbound reconciliation cycle completed";
    case "outbox":
      return "Queued Xero outbox operations processed";
    case "retries":
      return "Queued Xero retries processed";
    case "xero-queue":
      return "Queued Xero outbox operations and retries processed";
    default:
      return "Membership status refresh completed";
  }
}

export async function runXeroCronTaskList(
  taskList: XeroCronTask[],
  dependencies: XeroCronRunnerDependencies & { taskLabel?: string } = {}
): Promise<XeroCronRunnerPayload> {
  const taskLabel = dependencies.taskLabel ?? taskList.join("+");
  const recordCronRun = dependencies.recordCronRun ?? recordCronJobRunSafe;
  const isModuleEnabled =
    dependencies.isModuleEnabled ?? isEffectiveModuleEnabled;
  const isConnected = dependencies.isConnected ?? isXeroConnected;
  const isDailyMembershipRefreshEnabled =
    dependencies.isDailyMembershipRefreshEnabled ??
    isXeroDailyMembershipRefreshEnabled;
  const taskDependencies = dependencies.tasks ?? {};
  const payload = emptyPayload(taskLabel);
  const failures: Array<{ task: XeroCronTask; message: string }> = [];

  if (!(await isModuleEnabled("xeroIntegration"))) {
    const reason = "Operational Xero effective module state is disabled";
    await recordSkippedXeroTasks({
      tasks: taskList,
      reason,
      recordCronRun,
    });
    return {
      ...payload,
      message: "Xero cron tasks skipped",
      skipped: true,
      reason,
    } as XeroCronRunnerPayload & { skipped: true; reason: string };
  }

  const connected = await isConnected();
  payload.connected = connected;

  for (const task of taskList) {
    try {
      if (task === "memberships") {
        payload.membershipRefresh = await runRecordedXeroTask({
          task,
          recordCronRun,
          work: async () =>
            !isDailyMembershipRefreshEnabled()
              ? {
                  skipped: true,
                  reason:
                    "Daily membership refresh disabled by XERO_ENABLE_DAILY_MEMBERSHIP_REFRESH",
                }
              : connected
                ? await (taskDependencies.refreshAllMembershipStatuses ??
                    refreshAllMembershipStatuses)()
                : { skipped: true, reason: "Xero not connected" },
        });
      } else if (task === "outbox") {
        payload.queuedOutboxOperations = await runRecordedXeroTask({
          task,
          recordCronRun,
          work: async () =>
            connected
              ? await (taskDependencies.processQueuedXeroOutboxOperations ??
                  processQueuedXeroOutboxOperations)()
              : { skipped: true, reason: "Xero not connected" },
        });
      } else if (task === "retries") {
        payload.queuedRetries = await runRecordedXeroTask({
          task,
          recordCronRun,
          work: async () =>
            connected
              ? await (taskDependencies.processQueuedXeroOperationRetries ??
                  processQueuedXeroOperationRetries)()
              : { skipped: true, reason: "Xero not connected" },
        });
      } else if (task === "inbound") {
        payload.inboundReconciliation = await runRecordedXeroTask({
          task,
          recordCronRun,
          work: async () =>
            connected
              ? await (taskDependencies.runXeroInboundReconciliationCycle ??
                  runXeroInboundReconciliationCycle)()
              : { skipped: true, reason: "Xero not connected" },
        });
      } else if (task === "backfill") {
        payload.linkBackfill = await runRecordedXeroTask({
          task,
          recordCronRun,
          work:
            taskDependencies.backfillHistoricalXeroObjectLinks ??
            backfillHistoricalXeroObjectLinks,
        });
      } else if (task === "link-cleanup") {
        payload.linkCleanup = await runRecordedXeroTask({
          task,
          recordCronRun,
          work:
            taskDependencies.cleanupStaleCanonicalXeroObjectLinks ??
            cleanupStaleCanonicalXeroObjectLinks,
        });
      } else if (task === "report") {
        payload.reconciliationReport = await runRecordedXeroTask({
          task,
          recordCronRun,
          work:
            taskDependencies.sendXeroReconciliationReport ??
            sendXeroReconciliationReport,
        });
      } else {
        // credit-sync (#2501): reconcile stamped applied credit against Xero's
        // live invoice allocations and warn admins on drift. A Xero read failure
        // defers rather than throwing, so a disconnected/unavailable Xero yields
        // a skipped result here rather than a task failure.
        payload.creditSyncCheck = await runRecordedXeroTask({
          task,
          recordCronRun,
          work: async () =>
            connected
              ? await (taskDependencies.reconcileXeroCreditSync ??
                  reconcileXeroCreditSync)()
              : { skipped: true, reason: "Xero not connected" },
        });
      }
    } catch (error) {
      const message = toErrorMessage(error);
      failures.push({ task, message });
      (dependencies.log ?? logger).error(
        { err: error, task },
        "Xero cron task error"
      );
    }
  }

  if (failures.length > 0) {
    throw new XeroCronRunnerError(payload, failures);
  }

  return payload;
}

export async function runXeroCronTasks(
  task: XeroCronTaskSelection,
  dependencies: XeroCronRunnerDependencies = {}
) {
  const taskList = tasksForSelection(task, {
    includeLinkCleanupForBackfill:
      dependencies.includeLinkCleanupForBackfill ?? true,
  });

  return runXeroCronTaskList(taskList, {
    ...dependencies,
    taskLabel: task,
  });
}
