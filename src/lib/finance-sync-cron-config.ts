import { APP_TIME_ZONE } from "@/config/operational";

export const FINANCE_SYNC_CRON_JOB_NAME = "finance-daily-sync";
export const FINANCE_SYNC_CRON_MONITOR_SLUG = "finance-daily-sync";
export const FINANCE_SYNC_CRON_SCHEDULE = "15 10 * * *";
export const FINANCE_SYNC_CRON_TIMEZONE = APP_TIME_ZONE;
export const FINANCE_SYNC_CRON_CHECKIN_CONFIG = {
  schedule: { type: "crontab" as const, value: FINANCE_SYNC_CRON_SCHEDULE },
  timezone: FINANCE_SYNC_CRON_TIMEZONE,
  checkinMargin: 10,
  maxRuntime: 60,
};
