/**
 * The daily finance-sync job's identity and schedule (CT-5, #2869).
 *
 * `15 10 * * *` is a CLUB-LOCAL SCHEDULED TIME — quarter past ten in the
 * morning, where the club is — and the zone that turns it into an instant is the
 * club's persisted one (`INV-CONFIG-002`), resolved at boot by
 * `instrumentation.node.ts` and passed to `node-cron` there. This module used to
 * export `FINANCE_SYNC_CRON_TIMEZONE = APP_TIME_ZONE`, which is the CONTAINER's
 * zone: a deployment moved to another region moved the club's finance snapshot
 * with it, and the admin cron-health page then described the job in a zone the
 * club had not chosen.
 *
 * The Sentry monitor definition needs the same zone and is therefore built
 * rather than frozen, for the same reason.
 */

export const FINANCE_SYNC_CRON_JOB_NAME = "finance-daily-sync";
export const FINANCE_SYNC_CRON_MONITOR_SLUG = "finance-daily-sync";
export const FINANCE_SYNC_CRON_SCHEDULE = "15 10 * * *";

/** The Sentry cron monitor definition, in the club's civil time. */
export function financeSyncCronCheckinConfig(clubTimeZone: string) {
  return {
    schedule: { type: "crontab" as const, value: FINANCE_SYNC_CRON_SCHEDULE },
    timezone: clubTimeZone,
    checkinMargin: 10,
    maxRuntime: 60,
  };
}
