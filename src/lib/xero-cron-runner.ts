import { isEffectiveModuleEnabled } from "@/lib/admin-modules";
import {
  recordCronJobRunSafe,
  type CronJobRunStatus,
  type RecordCronJobRunInput,
} from "@/lib/cron-job-run";
import { runRecordedCronTask } from "@/lib/cron-recorded-task";
import logger from "@/lib/logger";
import { isXeroDailyMembershipRefreshEnabled } from "@/lib/xero-feature-flags";
import {
  backfillHistoricalXeroObjectLinks,
  cleanupStaleCanonicalXeroObjectLinks,
  sendXeroReconciliationReport,
} from "@/lib/xero-hardening";
import { canonicalLinkCleanupFailureMessage } from "@/lib/xero-hardening-shared";
import { runXeroInboundReconciliationCycle } from "@/lib/xero-inbound-reconciliation";
import {
  bankRefundVoidFollowUpFailureMessage,
  runBankRefundVoidFollowUp,
} from "@/lib/bank-refund-void-follow-up";
import {
  reconcileXeroCreditSync,
  XERO_CREDIT_SYNC_JOB_NAME,
} from "@/lib/xero-credit-sync-checker";
import { CREDIT_NOTE_MIRROR_JOB_NAME } from "@/lib/xero-credit-note-mirror";
import { runCreditNoteMirrorSweep } from "@/lib/xero-credit-note-mirror-sweep";
import { processQueuedXeroOutboxOperations } from "@/lib/xero-operation-outbox";
import { processQueuedXeroOperationRetries } from "@/lib/xero-operation-queue";
import { refreshAllMembershipStatuses } from "@/lib/xero-membership-sync";
import { isXeroConnected } from "@/lib/xero-token-store";
import { clubFormatValues } from "@/lib/club-format-server";

const XERO_CRON_TASKS = [
  "memberships",
  "outbox",
  "retries",
  "inbound",
  "backfill",
  "link-cleanup",
  // #4162: after the link cleanup, whose #4161 heal turns voided mirrors off.
  "bank-refund-voids",
  "report",
  "credit-sync",
  // #4270: after the inbound cycle, whose webhook path mirrors a note as it changes.
  "credit-note-mirror",
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
  "bank-refund-voids": "xero-bank-refund-void-follow-up",
  report: "xero-reconciliation-report",
  "credit-sync": XERO_CREDIT_SYNC_JOB_NAME,
  "credit-note-mirror": CREDIT_NOTE_MIRROR_JOB_NAME,
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
  bankRefundVoidFollowUp: unknown | null;
  reconciliationReport: unknown | null;
  creditSyncCheck: unknown | null;
  creditNoteMirror: unknown | null;
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
    runBankRefundVoidFollowUp: typeof runBankRefundVoidFollowUp;
    sendXeroReconciliationReport: typeof sendXeroReconciliationReport;
    reconcileXeroCreditSync: typeof reconcileXeroCreditSync;
    runCreditNoteMirrorSweep: typeof runCreditNoteMirrorSweep;
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
  statusFor = cronStatusForResult,
  errorFor,
}: {
  task: XeroCronTask;
  work: () => Promise<T> | T;
  recordCronRun: (input: RecordCronJobRunInput) => Promise<void> | void;
  statusFor?: (result: T) => CronJobRunStatus;
  errorFor?: (result: T) => string | null;
}): Promise<T> {
  const outcome = await runRecordedCronTask({
    jobName: XERO_CRON_JOB_NAMES[task],
    work,
    recordCronRun,
    statusFor,
    errorFor,
    summaryFor: resultSummaryFor,
  });
  if (!outcome.ok) throw outcome.error;
  return outcome.result;
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
    bankRefundVoidFollowUp: null,
    reconciliationReport: null,
    creditSyncCheck: null,
    creditNoteMirror: null,
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
    case "credit-note-mirror":
      return "Credit notes spent or un-spent in Xero mirrored into the credit ledger";
    case "backfill":
      return "Historical Xero link maintenance completed";
    case "link-cleanup":
      return "Stale Xero canonical links cleaned up";
    case "bank-refund-voids":
      return "Voided bank-transfer refund notes followed up";
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

  // The club's format (#3565), resolved once per run and passed to the three
  // tasks that render money — the retry worker, the reconciliation report and
  // the credit-sync check — never per row.
  const format = await clubFormatValues();
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
                  processQueuedXeroOperationRetries)(undefined, format)
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
        // #4161: a cleanup whose refund-note heals partly failed returns its
        // result rather than throwing; the run is recorded FAILURE with that
        // summary and reported like any other task failure.
        const linkCleanup = await runRecordedXeroTask({
          task,
          recordCronRun,
          work:
            taskDependencies.cleanupStaleCanonicalXeroObjectLinks ??
            cleanupStaleCanonicalXeroObjectLinks,
          statusFor: (result) => (canonicalLinkCleanupFailureMessage(result) ? "FAILURE" : "SUCCESS"),
          // The health page's cron error reads this column.
          errorFor: canonicalLinkCleanupFailureMessage,
        });
        payload.linkCleanup = linkCleanup;
        const healFailure = canonicalLinkCleanupFailureMessage(linkCleanup);
        if (healFailure) {
          failures.push({ task, message: healFailure });
          (dependencies.log ?? logger).error({ task }, healFailure);
        }
      } else if (task === "bank-refund-voids") {
        // #4162: local rows only, so it runs whether or not Xero is connected.
        // Report-only unless XERO_ENABLE_BANK_REFUND_VOID_WRITES is true. A
        // note that failed is recorded FAILURE with the summary, like the heal.
        const followUp = await runRecordedXeroTask({
          task,
          recordCronRun,
          work: () => (taskDependencies.runBankRefundVoidFollowUp ?? runBankRefundVoidFollowUp)(),
          statusFor: (result) => (bankRefundVoidFollowUpFailureMessage(result) ? "FAILURE" : "SUCCESS"),
          errorFor: bankRefundVoidFollowUpFailureMessage,
        });
        payload.bankRefundVoidFollowUp = followUp;
        const followUpFailure = bankRefundVoidFollowUpFailureMessage(followUp);
        if (followUpFailure) {
          failures.push({ task, message: followUpFailure });
          (dependencies.log ?? logger).error({ task }, followUpFailure);
        }
      } else if (task === "report") {
        payload.reconciliationReport = await runRecordedXeroTask({
          task,
          recordCronRun,
          work: () =>
            (taskDependencies.sendXeroReconciliationReport ??
              sendXeroReconciliationReport)(format),
        });
      } else if (task === "credit-note-mirror") {
        // #4270: backstop for the inbound credit-note mirror. Writes the credit ledger
        // only (never Xero); a Xero that is not connected has nothing to read.
        payload.creditNoteMirror = await runRecordedXeroTask({
          task,
          recordCronRun,
          work: async () =>
            connected
              ? await (taskDependencies.runCreditNoteMirrorSweep ?? runCreditNoteMirrorSweep)()
              : { skipped: true, reason: "Xero not connected" },
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
                  reconcileXeroCreditSync)(format)
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
