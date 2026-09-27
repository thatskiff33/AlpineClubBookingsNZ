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
import { releaseExpiredInternetBankingHolds } from "@/lib/internet-banking-payment-cron";
import { processPaymentRecoveryOperations } from "@/lib/payment-recovery";
import { reapStaleWaitingPaymentXeroOutboxOperations } from "@/lib/xero-waiting-invoice-reaper";
import { recordCronJobRunSafe } from "@/lib/cron-job-run";
import { reportCronError } from "@/lib/observability-bridge";

export type PaymentsCronJobName =
  | "payment-recovery"
  | "internet-banking-hold-release"
  | "xero-waiting-invoice-reaper";

/** A task's result, or `null` when that task failed (its FAILURE row says why). */
export interface PaymentsCronCycleResult {
  recovery: Awaited<ReturnType<typeof processPaymentRecoveryOperations>> | null;
  internetBankingHoldRelease: Awaited<
    ReturnType<typeof releaseExpiredInternetBankingHolds>
  > | null;
  xeroOutboxReap: Awaited<
    ReturnType<typeof reapStaleWaitingPaymentXeroOutboxOperations>
  > | null;
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

function toErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

async function runRecordedTask<K extends keyof PaymentsCronCycleResult>(
  result: PaymentsCronCycleResult,
  failures: PaymentsCronFailure[],
  task: {
    jobName: PaymentsCronJobName;
    resultKey: K;
    failureMessage: string;
    work: () => Promise<NonNullable<PaymentsCronCycleResult[K]>>;
  }
): Promise<void> {
  const startedAt = new Date();
  try {
    const taskResult = await task.work();
    result[task.resultKey] = taskResult;
    await recordCronJobRunSafe({
      jobName: task.jobName,
      startedAt,
      status: "SUCCESS",
      resultSummary: taskResult,
    });
  } catch (error) {
    const message = toErrorMessage(error);
    reportCronError({
      tag: task.jobName,
      err: error,
      message: task.failureMessage,
      context: { job: task.jobName },
    });
    await recordCronJobRunSafe({
      jobName: task.jobName,
      startedAt,
      status: "FAILURE",
      error: message,
    });
    failures.push({ jobName: task.jobName, message });
  }
}

export async function runPaymentsCronCycle(): Promise<PaymentsCronCycleResult> {
  const result: PaymentsCronCycleResult = {
    recovery: null,
    internetBankingHoldRelease: null,
    xeroOutboxReap: null,
  };
  const failures: PaymentsCronFailure[] = [];

  await runRecordedTask(result, failures, {
    jobName: "payment-recovery",
    resultKey: "recovery",
    failureMessage: "Error in payment recovery cron",
    work: () => processPaymentRecoveryOperations(),
  });
  await runRecordedTask(result, failures, {
    jobName: "internet-banking-hold-release",
    resultKey: "internetBankingHoldRelease",
    failureMessage: "Failed to release expired Internet Banking payment holds",
    work: () => releaseExpiredInternetBankingHolds(),
  });
  await runRecordedTask(result, failures, {
    jobName: "xero-waiting-invoice-reaper",
    resultKey: "xeroOutboxReap",
    failureMessage: "Failed to reap stale WAITING_PAYMENT Xero outbox operations",
    work: () => reapStaleWaitingPaymentXeroOutboxOperations(),
  });

  if (failures.length > 0) {
    throw new PaymentsCronCycleError(result, failures);
  }

  return result;
}
