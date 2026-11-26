/**
 * The payments cron cycle's tasks and the `CronJobRun.jobName` each records
 * under (#5256). The one spelling of every payments-cycle job name: the runner
 * records each run under it, the scheduler checks in to Sentry under the
 * recovery name, and admin cron health reads the recorded rows back by it. A
 * raw copy anywhere else would silently stop matching on a rename, so
 * `cron-job-name-literals.test.ts` refuses one. Keys are the runner's result
 * keys, in run order; the names are stored history, so never rename one.
 *
 * To add a task: add one entry here. The compiler then demands its result slot
 * in `payments-cron-runner.ts` and its label in `admin-cron-health.ts`, and
 * `cron-payments.test.ts` fails until the runner calls `runRecordedTask` for
 * it. The literal guard needs no edit.
 *
 * Dependency-free on purpose: `instrumentation.node.ts` imports it at boot,
 * and must not pull the runner's provider and Prisma graph in to do so.
 */

export const PAYMENTS_CRON_JOB_NAMES = {
  onceEverAlertSweep: "once-ever-alert-sweep",
  recovery: "payment-recovery",
  internetBankingHoldRelease: "internet-banking-hold-release",
  xeroOutboxReap: "xero-waiting-invoice-reaper",
  lateCaptureHeldAlert: "late-capture-held-alert",
  creditReleaseAsks: "credit-release-asks",
  duplicateCaptureKeptAlert: "duplicate-capture-kept-alert",
  combinedInvoiceCoverRelease: "combined-invoice-cover-release",
} as const;

export type PaymentsCronTask = keyof typeof PAYMENTS_CRON_JOB_NAMES;

export type PaymentsCronJobName = (typeof PAYMENTS_CRON_JOB_NAMES)[PaymentsCronTask];

/** The Sentry cron monitor the scheduler checks the whole cycle in under. */
export const PAYMENTS_CRON_SENTRY_MONITOR_SLUG = PAYMENTS_CRON_JOB_NAMES.recovery;
