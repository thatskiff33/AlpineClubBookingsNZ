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
import { runCreditReleaseAskSweep } from "@/lib/credit-release-ask-sweep";
import { drainOwedNewCaptureAlerts } from "@/lib/duplicate-capture-kept-alert-drain";
import { sweepVoidedCombinedGroupInvoiceCover, type CombinedCoverSweepResult } from "@/lib/member-money/doors";
import { sweepOnceEverAlerts, type OnceEverAlertSweepResult } from "@/lib/admin-alert-once-sweep";
import { runRecordedCronTask } from "@/lib/cron-recorded-task";
import { reportCronError } from "@/lib/observability-bridge";

export type PaymentsCronJobName =
  | "once-ever-alert-sweep"
  | "payment-recovery"
  | "internet-banking-hold-release"
  | "xero-waiting-invoice-reaper"
  | "late-capture-held-alert"
  | "credit-release-asks"
  | "duplicate-capture-kept-alert"
  | "combined-invoice-cover-release";

/** A task's result, or `null` when that task failed (its FAILURE row says why). */
export interface PaymentsCronCycleResult {
  /** #5255: once-ever alert claims with no email given back, and raised-once alerts re-sent. */
  onceEverAlertSweep: OnceEverAlertSweepResult | null;
  recovery: Awaited<ReturnType<typeof processPaymentRecoveryOperations>> | null;
  internetBankingHoldRelease: Awaited<
    ReturnType<typeof releaseExpiredInternetBankingHolds>
  > | null;
  xeroOutboxReap: Awaited<
    ReturnType<typeof reapStaleWaitingPaymentXeroOutboxOperations>
  > | null;
  /** #3635: the held late-capture alert's re-selecting run. */
  lateCaptureHeldAlert: Awaited<ReturnType<typeof reannounceHeldLateCaptures>> | null;
  /** #4253: the sweep that asks for credit released after a Xero offset and records its payment. */
  creditReleaseAsks: Awaited<ReturnType<typeof runCreditReleaseAskSweep>> | null;
  /** #4285 review: the owed new-capture alert's drain. */
  duplicateCaptureKeptAlert: Awaited<ReturnType<typeof drainOwedNewCaptureAlerts>> | null;
  /** #4525 review: the sweep that releases a combined group invoice's cover once its VOID ended it. */
  combinedInvoiceCoverRelease: CombinedCoverSweepResult | null;
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

/**
 * The sweep never throws, so a read that failed, a release that failed, or a
 * run that stopped at its cap carries a `warning` that keeps it from reading
 * as a healthy job.
 */
function combinedCoverSweepSummary(sweep: CombinedCoverSweepResult) {
  if (sweep.failed) {
    return { ...sweep, warning: "The combined group invoice cover sweep could not read its manifests and will try again next run; see the application logs." };
  }
  if (sweep.releaseFailures > 0) {
    return { ...sweep, warning: `The combined group invoice cover sweep could not release ${sweep.releaseFailures} voided invoice(s) and will try again next run; see the application logs.` };
  }
  if (sweep.truncated) {
    return { ...sweep, warning: "The combined group invoice cover sweep stopped at its per-run cap; later voided invoices still owed a release were not read and wait for the next run." };
  }
  return sweep;
}

/** The sweep never throws, so a run whose reads or writes failed says so here (#5255). */
function onceEverAlertSweepSummary(sweep: OnceEverAlertSweepResult) {
  return sweep.failed > 0
    ? {
        ...sweep,
        warning: `${sweep.failed} once-ever alert claim(s) or owed alert(s) could not be swept and will be retried next run; see the application logs.`,
      }
    : sweep;
}

export async function runPaymentsCronCycle(): Promise<PaymentsCronCycleResult> {
  const result: PaymentsCronCycleResult = {
    onceEverAlertSweep: null,
    recovery: null,
    internetBankingHoldRelease: null,
    xeroOutboxReap: null,
    lateCaptureHeldAlert: null,
    creditReleaseAsks: null,
    duplicateCaptureKeptAlert: null,
    combinedInvoiceCoverRelease: null,
  };
  const failures: PaymentsCronFailure[] = [];

  // #5255: first, so a claim it gives back is sent by this cycle's own tasks.
  await runRecordedTask(result, failures, {
    jobName: "once-ever-alert-sweep",
    resultKey: "onceEverAlertSweep",
    failureMessage: "Failed to sweep once-ever admin alerts",
    work: () => sweepOnceEverAlerts(),
    summaryFor: onceEverAlertSweepSummary,
  });
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
  await runRecordedTask(result, failures, {
    jobName: "credit-release-asks",
    resultKey: "creditReleaseAsks",
    failureMessage: "Failed to run the credit-release payment sweep",
    work: () => runCreditReleaseAskSweep(),
  });
  await runRecordedTask(result, failures, {
    jobName: "duplicate-capture-kept-alert",
    resultKey: "duplicateCaptureKeptAlert",
    failureMessage: "Failed to deliver owed kept-capture alerts",
    work: () => drainOwedNewCaptureAlerts(),
  });
  await runRecordedTask(result, failures, {
    jobName: "combined-invoice-cover-release",
    resultKey: "combinedInvoiceCoverRelease",
    failureMessage: "Failed to sweep the combined group invoices' cover on void invoices",
    work: () => sweepVoidedCombinedGroupInvoiceCover(),
    summaryFor: combinedCoverSweepSummary,
  });

  if (failures.length > 0) {
    throw new PaymentsCronCycleError(result, failures);
  }

  return result;
}
