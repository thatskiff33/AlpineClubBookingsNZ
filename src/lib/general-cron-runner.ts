import { purgeExpiredBookingRequests } from "@/lib/booking-request";
import { drainHostingCoverageReevaluations } from "@/lib/adult-member-hosting-coverage-drain";
import { sendAdditionalPaymentReminders } from "@/lib/cron-additional-payment-reminders";
import { runMirrorSync } from "@/lib/club-post-mirror";
import { runClubPostCleanup } from "@/lib/club-post-retention";
import { retryPendingShares } from "@/lib/club-post-sharing";
import { confirmPendingBookings } from "@/lib/cron-confirm-pending";
import {
  recordCronJobRunSafe,
  type RecordCronJobRunInput,
} from "@/lib/cron-job-run";
import { reapStaleGroupSettlements } from "@/lib/cron-group-settlement-reaper";
import { reapExpiredPolicyExceptionHolds } from "@/lib/cron-policy-exception-hold-reaper";
import { sendPlaceholderGuestNameReminders } from "@/lib/placeholder-guest-name-reminders";
import { sendPreArrivalReminders } from "@/lib/cron-pre-arrival-reminders";
import { sendQuoteExpiryReminders } from "@/lib/cron-quote-expiry-reminders";
import { sendSchoolAttendeeConfirmationPrompts } from "@/lib/school-attendee-confirmation";
import { reportCronError } from "@/lib/observability-bridge";

const GENERAL_CRON_JOB_NAMES = [
  "additional-payment-reminders",
  "club-post-mirror-sync",
  "club-post-retention",
  "club-post-share-retry",
  "confirm-pending",
  "group-settlement-reaper",
  "hosting-coverage-reevaluation",
  "placeholder-guest-name-reminders",
  "policy-exception-hold-reaper",
  "pre-arrival-reminders",
  "purge-booking-requests",
  "quote-expiry-reminders",
  "school-attendee-confirmations",
] as const;

export type GeneralCronJobName = (typeof GENERAL_CRON_JOB_NAMES)[number];

export interface GeneralCronCycleResult {
  additionalPaymentReminders: Awaited<
    ReturnType<typeof sendAdditionalPaymentReminders>
  > | null;
  clubPostMirrorSync: Awaited<ReturnType<typeof runMirrorSync>> | null;
  clubPostRetention: Awaited<ReturnType<typeof runClubPostCleanup>> | null;
  clubPostShareRetry: Awaited<ReturnType<typeof retryPendingShares>> | null;
  confirmPending: Awaited<ReturnType<typeof confirmPendingBookings>> | null;
  groupSettlementReap: Awaited<ReturnType<typeof reapStaleGroupSettlements>> | null;
  hostingCoverageReevaluation: Awaited<
    ReturnType<typeof drainHostingCoverageReevaluations>
  > | null;
  placeholderGuestNameReminders: Awaited<
    ReturnType<typeof sendPlaceholderGuestNameReminders>
  > | null;
  policyExceptionHoldReap: Awaited<
    ReturnType<typeof reapExpiredPolicyExceptionHolds>
  > | null;
  preArrivalReminders: Awaited<ReturnType<typeof sendPreArrivalReminders>> | null;
  bookingRequestPurge: Awaited<ReturnType<typeof purgeExpiredBookingRequests>> | null;
  quoteExpiryReminders: Awaited<ReturnType<typeof sendQuoteExpiryReminders>> | null;
  schoolAttendeeConfirmations: Awaited<
    ReturnType<typeof sendSchoolAttendeeConfirmationPrompts>
  > | null;
}

type GeneralCronResultKey = keyof GeneralCronCycleResult;

type GeneralCronTask<T> = {
  jobName: GeneralCronJobName;
  resultKey: GeneralCronResultKey;
  failureMessage: string;
  work: () => Promise<T>;
};

export interface GeneralCronRunnerDependencies {
  recordCronRun?: (input: RecordCronJobRunInput) => Promise<void> | void;
  tasks?: Partial<{
    sendAdditionalPaymentReminders: typeof sendAdditionalPaymentReminders;
    runClubPostCleanup: () => ReturnType<typeof runClubPostCleanup>;
    runMirrorSync: () => ReturnType<typeof runMirrorSync>;
    retryPendingShares: () => ReturnType<typeof retryPendingShares>;
    confirmPendingBookings: typeof confirmPendingBookings;
    reapStaleGroupSettlements: typeof reapStaleGroupSettlements;
    drainHostingCoverageReevaluations: () => ReturnType<
      typeof drainHostingCoverageReevaluations
    >;
    reapExpiredPolicyExceptionHolds: typeof reapExpiredPolicyExceptionHolds;
    sendPlaceholderGuestNameReminders: typeof sendPlaceholderGuestNameReminders;
    sendPreArrivalReminders: typeof sendPreArrivalReminders;
    purgeExpiredBookingRequests: typeof purgeExpiredBookingRequests;
    sendQuoteExpiryReminders: typeof sendQuoteExpiryReminders;
    sendSchoolAttendeeConfirmationPrompts: typeof sendSchoolAttendeeConfirmationPrompts;
  }>;
}

export class GeneralCronCycleError extends Error {
  result: GeneralCronCycleResult;
  failures: Array<{ jobName: GeneralCronJobName; message: string }>;

  constructor(
    result: GeneralCronCycleResult,
    failures: Array<{ jobName: GeneralCronJobName; message: string }>
  ) {
    super(
      failures.length === 1
        ? failures[0].message
        : `General cron cycle failed for ${failures
            .map((failure) => failure.jobName)
            .join(", ")}`
    );
    this.name = "GeneralCronCycleError";
    this.result = result;
    this.failures = failures;
  }
}

function toErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

async function runRecordedTask<T>({
  task,
  recordCronRun,
}: {
  task: GeneralCronTask<T>;
  recordCronRun: (input: RecordCronJobRunInput) => Promise<void> | void;
}): Promise<T> {
  const startedAt = new Date();
  try {
    const result = await task.work();
    await recordCronRun({
      jobName: task.jobName,
      startedAt,
      status: "SUCCESS",
      resultSummary: result,
    });
    return result;
  } catch (error) {
    const message = toErrorMessage(error);
    // Top-level cron-task FAILURE: log at error AND page Sentry via the scoped
    // bridge (deduped per job). Per-item best-effort failures inside tasks stay
    // log-only.
    reportCronError({
      tag: task.jobName,
      err: error,
      message: task.failureMessage,
      context: { job: task.jobName },
    });
    await recordCronRun({
      jobName: task.jobName,
      startedAt,
      status: "FAILURE",
      error: message,
    });
    throw new Error(message);
  }
}

export async function runGeneralCronCycle(
  dependencies: GeneralCronRunnerDependencies = {}
): Promise<GeneralCronCycleResult> {
  const recordCronRun = dependencies.recordCronRun ?? recordCronJobRunSafe;
  const taskDependencies = dependencies.tasks ?? {};
  const result: GeneralCronCycleResult = {
    additionalPaymentReminders: null,
    clubPostMirrorSync: null,
    clubPostRetention: null,
    clubPostShareRetry: null,
    confirmPending: null,
    groupSettlementReap: null,
    hostingCoverageReevaluation: null,
    placeholderGuestNameReminders: null,
    policyExceptionHoldReap: null,
    preArrivalReminders: null,
    bookingRequestPurge: null,
    quoteExpiryReminders: null,
    schoolAttendeeConfirmations: null,
  };
  const failures: Array<{ jobName: GeneralCronJobName; message: string }> = [];
  const tasks: GeneralCronTask<unknown>[] = [
    {
      jobName: "additional-payment-reminders",
      resultKey: "additionalPaymentReminders",
      failureMessage: "Additional payment reminder cron error",
      work:
        taskDependencies.sendAdditionalPaymentReminders ??
        sendAdditionalPaymentReminders,
    },
    {
      // Epic #2992. The POLLING BACKSTOP for the mirror: the central server
      // pushes a doorbell when something changes, and this pass is what
      // guarantees the mirror converges even if every push is lost. Skips
      // itself when the integration is not configured.
      jobName: "club-post-mirror-sync",
      resultKey: "clubPostMirrorSync",
      failureMessage: "Club post mirror sync cron error",
      work: taskDependencies.runMirrorSync ?? runMirrorSync,
    },
    {
      // #2999. Deletes club message board posts past the club's retention
      // window. Idempotent and self-limiting: the window defaults to "keep
      // everything", the pass takes a single-flight claim so it cannot race the
      // admin screen's button, and a run with nothing to delete is a no-op.
      jobName: "club-post-retention",
      resultKey: "clubPostRetention",
      failureMessage: "Club post retention cron error",
      work: taskDependencies.runClubPostCleanup ?? runClubPostCleanup,
    },
    {
      // Epic #2992. Carries board posts whose share to the central server has
      // not succeeded yet. The BACKSTOP, not the main path: an ordinary share
      // is attempted the moment the member posts, and this exists so an outage
      // at the far end delays a post rather than losing it.
      jobName: "club-post-share-retry",
      resultKey: "clubPostShareRetry",
      failureMessage: "Club post share retry cron error",
      work: taskDependencies.retryPendingShares ?? retryPendingShares,
    },
    {
      jobName: "confirm-pending",
      resultKey: "confirmPending",
      failureMessage: "Pending confirmation cron error",
      work:
        taskDependencies.confirmPendingBookings ??
        confirmPendingBookings,
    },
    {
      jobName: "group-settlement-reaper",
      resultKey: "groupSettlementReap",
      failureMessage: "Group settlement reaper cron error",
      work:
        taskDependencies.reapStaleGroupSettlements ??
        reapStaleGroupSettlements,
    },
    {
      jobName: "placeholder-guest-name-reminders",
      resultKey: "placeholderGuestNameReminders",
      failureMessage: "Placeholder guest-name reminder cron error",
      work:
        taskDependencies.sendPlaceholderGuestNameReminders ??
        sendPlaceholderGuestNameReminders,
    },
    {
      // #2576 §8. The BACKSTOP for the same-owner coverage queue, and the
      // authority on completion. Escalating change paths record their bounded
      // re-evaluation work inside their own transaction and drain it inline after
      // commit; this sweep catches everything that inline attempt could not
      // finish — a process that died mid-drain, a redeployment, a transient email
      // failure — so an uncovered booking can never sit with nobody told.
      // Idempotent by construction, so re-running costs nothing when the queue is
      // empty (one indexed read that returns no rows).
      jobName: "hosting-coverage-reevaluation",
      resultKey: "hostingCoverageReevaluation",
      failureMessage: "Same-owner hosting coverage re-evaluation cron error",
      work:
        taskDependencies.drainHostingCoverageReevaluations ??
        (() => drainHostingCoverageReevaluations()),
    },
    {
      jobName: "policy-exception-hold-reaper",
      resultKey: "policyExceptionHoldReap",
      failureMessage: "Policy-exception hold reaper cron error",
      work:
        taskDependencies.reapExpiredPolicyExceptionHolds ??
        reapExpiredPolicyExceptionHolds,
    },
    {
      jobName: "pre-arrival-reminders",
      resultKey: "preArrivalReminders",
      failureMessage: "Pre-arrival reminder cron error",
      work:
        taskDependencies.sendPreArrivalReminders ??
        sendPreArrivalReminders,
    },
    {
      jobName: "purge-booking-requests",
      resultKey: "bookingRequestPurge",
      failureMessage: "Booking request retention purge cron error",
      work:
        taskDependencies.purgeExpiredBookingRequests ??
        purgeExpiredBookingRequests,
    },
    {
      jobName: "quote-expiry-reminders",
      resultKey: "quoteExpiryReminders",
      failureMessage: "Quote expiry reminder cron error",
      work:
        taskDependencies.sendQuoteExpiryReminders ??
        sendQuoteExpiryReminders,
    },
    {
      jobName: "school-attendee-confirmations",
      resultKey: "schoolAttendeeConfirmations",
      failureMessage: "School attendee confirmation cron error",
      work:
        taskDependencies.sendSchoolAttendeeConfirmationPrompts ??
        sendSchoolAttendeeConfirmationPrompts,
    },
  ];

  for (const task of tasks) {
    try {
      const taskResult = await runRecordedTask({
        task,
        recordCronRun,
      });
      (result as Record<GeneralCronResultKey, unknown>)[task.resultKey] =
        taskResult;
    } catch (error) {
      failures.push({
        jobName: task.jobName,
        message: toErrorMessage(error),
      });
    }
  }

  if (failures.length > 0) {
    throw new GeneralCronCycleError(result, failures);
  }

  return result;
}
