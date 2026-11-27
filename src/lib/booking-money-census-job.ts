/**
 * The nightly booking money check's identity and schedule (#4910,
 * `INV-PAY-163`).
 *
 * `30 5 * * *` is a CLUB-LOCAL SCHEDULED TIME, half past five in the morning
 * where the club is, half an hour after the credit reconciliation. The zone
 * that turns it into an instant is the club's persisted one (`INV-CONFIG-002`),
 * resolved at boot by `instrumentation.node.ts`.
 *
 * The one home for the job's name (`INV-SSOT`): the scheduler records each run
 * and checks in to Sentry under it, admin cron health defines the job by it,
 * and the stuck-state dashboard reads the latest `CronJobRun` row back by it.
 * Imports nothing, because `instrumentation.node.ts` loads it at boot.
 */

export const BOOKING_MONEY_CENSUS_JOB_NAME = "booking-money-census";
export const BOOKING_MONEY_CENSUS_CRON_SCHEDULE = "30 5 * * *";

/** The operator command that prints the full report a nightly summary is cut from. */
export const BOOKING_LEDGER_CENSUS_COMMAND = "pnpm run booking-ledger:census";

/** What the admin alert says about itself, in the email and in its editor default. */
export const BOOKING_MONEY_CENSUS_ALERT_NOTE =
  "The nightly check of booking money records found something it has not reported before. Nothing was changed: the check only reads. Each finding is emailed once, and stays on the Stuck States page until it is put right.";
