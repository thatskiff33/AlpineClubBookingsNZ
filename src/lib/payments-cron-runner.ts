/**
 * The 15-minute payments cron cycle (#3663): the ONE function both the cron
 * leader (`src/instrumentation.node.ts`) and `POST /api/cron/payments` call.
 *
 * Before #3663 the leader ran only Stripe payment recovery, while expired
 * Internet Banking hold release and the waiting-invoice reaper lived only
 * behind the route — which nothing calls in the supported Compose deployment.
 * Two call sites spelling the task list twice is how they drifted, so the list
 * lives here once (INV-SSOT).
 *
 * Each task is error-isolated (one failing never stops the next) and records
 * its OWN `CronJobRun` row under its own job name, each registered in the admin
 * cron registry (`@/lib/admin-cron-health`), so a missing or failing task is
 * visible rather than hidden inside a healthy `payment-recovery` row.
 */
import {
  releaseExpiredInternetBankingHolds,
  type InternetBankingHoldReleaseResult,
} from "@/lib/internet-banking-payment-cron";
import { processPaymentRecoveryOperations } from "@/lib/payment-recovery";
import { reapStaleWaitingPaymentXeroOutboxOperations } from "@/lib/xero-waiting-invoice-reaper";
import { reannounceHeldLateCaptures } from "@/lib/late-capture-refund-hold";
import { runRecordedCronTask } from "@/lib/cron-recorded-task";
import { reportCronError } from "@/lib/observability-bridge";

export type PaymentsCronJobName =
  | "payment-recovery"
  | "internet-banking-hold-release"
  | "xero-waiting-invoice-reaper"
  | "late-capture-held-alert";

/** A task's result, or `null` when that task failed (its FAILURE row says why). */
export interface PaymentsCronCycleResult {
  recovery: Awaited<ReturnType<typeof processPaymentRecoveryOperations>> | null;
  internetBankingHoldRelease: Awaited<
    ReturnType<typeof releaseExpiredInternetBankingHolds>
  > | null;
  xeroOutboxReap: Awaited<
    ReturnType<typeof reapStaleWaitingPaymentXeroOutboxOperations>
  > | null;
  /** #3635: the held late-capture alert's re-selecting run. */
  lateCaptureHeldAlert: Awaited<ReturnType<typeof reannounceHeldLateCaptures>> | null;
}

export interface PaymentsCronFailure {
  jobName: PaymentsCronJobName;
  message: string;
}

/** Thrown after EVERY task has run, when at least one failed. */
export class PaymentsCronCycleError extends Error {
  result: PaymentsCronCycleResult;
  failures: PaymentsCronFailure[];

  constructor(result: PaymentsCronCycleResult, failures: PaymentsCronFailure[]) {
    const [onlyFailure] = failures;
    super(
      failures.length === 1 && onlyFailure
        ? onlyFailure.message
        : `Payments cron cycle failed for ${failures
            .map((failure) => failure.jobName)
            .join(", ")}`
    );
    this.name = "PaymentsCronCycleError";
    this.result = result;
    this.failures = failures;
  }
}

async function runRecordedTask<K extends keyof PaymentsCronCycleResult>(
  result: PaymentsCronCycleResult,
  failures: PaymentsCronFailure[],
  task: {
    jobName: PaymentsCronJobName;
    resultKey: K;
    failureMessage: string;
    work: () => Promise<NonNullable<PaymentsCronCycleResult[K]>>;
    summaryFor?: (taskResult: NonNullable<PaymentsCronCycleResult[K]>) => unknown;
  }
): Promise<void> {
  const outcome = await runRecordedCronTask({
    jobName: task.jobName,
    work: task.work,
    summaryFor: task.summaryFor,
    onFailure: (error) =>
      reportCronError({
        tag: task.jobName,
        err: error,
        message: task.failureMessage,
        context: { job: task.jobName },
      }),
  });
  if (outcome.ok) {
    result[task.resultKey] = outcome.result;
  } else {
    failures.push({ jobName: task.jobName, message: outcome.message });
  }
}

/**
 * A hold that throws is rolled back and retried next run, so the task itself
 * succeeds; the `warning` is what keeps a hold that fails EVERY run from
 * reading as a healthy job on admin cron health.
 */
function holdReleaseSummary(release: InternetBankingHoldReleaseResult) {
  return release.failed > 0
    ? {
        ...release,
        warning: `${release.failed} expired Internet Banking hold(s) could not be released and will be retried next run; see the application logs.`,
      }
    : release;
}

export async function runPaymentsCronCycle(): Promise<PaymentsCronCycleResult> {
  const result: PaymentsCronCycleResult = {
    recovery: null,
    internetBankingHoldRelease: null,
    xeroOutboxReap: null,
    lateCaptureHeldAlert: null,
  };
  const failures: PaymentsCronFailure[] = [];

  await runRecordedTask(result, failures, {
    jobName: "payment-recovery",
    resultKey: "recovery",
    failureMessage: "Error in payment recovery cron",
    // #3653: the cron's run also reads pending organiser child refunds back.
    work: () => processPaymentRecoveryOperations({ reconcilePendingChildRefunds: true }),
  });
  await runRecordedTask(result, failures, {
    jobName: "internet-banking-hold-release",
    resultKey: "internetBankingHoldRelease",
    failureMessage: "Failed to release expired Internet Banking payment holds",
    work: () => releaseExpiredInternetBankingHolds(),
    summaryFor: holdReleaseSummary,
  });
  await runRecordedTask(result, failures, {
    jobName: "xero-waiting-invoice-reaper",
    resultKey: "xeroOutboxReap",
    failureMessage: "Failed to reap stale WAITING_PAYMENT Xero outbox operations",
    work: () => reapStaleWaitingPaymentXeroOutboxOperations(),
  });
  await runRecordedTask(result, failures, {
    jobName: "late-capture-held-alert",
    resultKey: "lateCaptureHeldAlert",
    failureMessage: "Failed to re-announce held late-capture payments",
    work: () => reannounceHeldLateCaptures(),
  });

  if (failures.length > 0) {
    throw new PaymentsCronCycleError(result, failures);
  }

  return result;
}
