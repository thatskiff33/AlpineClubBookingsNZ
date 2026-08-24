import { APP_TIME_ZONE } from "@/config/operational";
import {
  FINANCE_SYNC_CRON_JOB_NAME,
  FINANCE_SYNC_CRON_SCHEDULE,
  FINANCE_SYNC_CRON_TIMEZONE,
} from "@/lib/finance-sync-cron-config";

const ADMIN_CRON_DEFAULT_TIMEZONE = APP_TIME_ZONE;

const DAILY_STALE_AFTER_MINUTES = 36 * 60;
const THREE_HOURLY_STALE_AFTER_MINUTES = 6 * 60 + 30;
const FIFTEEN_MINUTE_STALE_AFTER_MINUTES = 60;
const THIRTY_MINUTE_STALE_AFTER_MINUTES = 90;

type CronHealthStatus =
  | "current"
  | "stale"
  | "failed"
  | "skipped"
  | "missing"
  | "disabled"
  | "untracked"
  | "unknown";

type CronHealthSeverity = "ok" | "warning" | "error" | "info";

export interface AdminCronRun {
  id: string;
  jobName: string;
  startedAt: Date | string;
  completedAt: Date | string | null;
  durationMs: number | null;
  status: string;
  resultSummary: unknown | null;
  error: string | null;
  createdAt?: Date | string;
}

export interface AdminCronJobDefinition {
  jobName: string;
  label: string;
  schedule: string;
  timezone: string;
  expectedLocalTime: string;
  staleAfterMinutes: number | null;
  enabled: boolean;
  disabledReason: string | null;
  recordsRuns: boolean;
  note?: string;
}

interface CronHealthJob extends AdminCronJobDefinition {
  status: CronHealthStatus;
  severity: CronHealthSeverity;
  summary: string;
  staleThreshold: string | null;
  latestRunAt: string | null;
  latestRunStatus: string | null;
  latestSuccessAt: string | null;
  latestFailureAt: string | null;
}

export interface CronHealthReport {
  generatedAt: string;
  cronEnabled: boolean;
  defaultTimezone: string;
  jobs: CronHealthJob[];
}

function isExplicitlyEnabled(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === "true";
}

function isAdminCronSchedulingEnabled(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return (env.CRON_ENABLED ?? "true").trim().toLowerCase() === "true";
}

function formatMinutes(minutes: number): string {
  if (minutes < 60) {
    return `${minutes}m`;
  }

  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;

  return remainder === 0 ? `${hours}h` : `${hours}h ${remainder}m`;
}

function toDate(value: Date | string | null | undefined): Date | null {
  if (!value) {
    return null;
  }

  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function toIso(value: Date | string | null | undefined): string | null {
  return toDate(value)?.toISOString() ?? null;
}

function runTime(run: AdminCronRun): number {
  return (
    toDate(run.startedAt)?.getTime() ??
    toDate(run.createdAt)?.getTime() ??
    0
  );
}

function defineCronJob(
  input: Omit<
    AdminCronJobDefinition,
    "enabled" | "disabledReason" | "recordsRuns"
  > & {
    enabled?: boolean;
    disabledReason?: string;
    recordsRuns?: boolean;
  },
  globalDisabledReason: string | null
): AdminCronJobDefinition {
  const featureEnabled = input.enabled ?? true;
  const enabled = !globalDisabledReason && featureEnabled;
  const disabledReason =
    globalDisabledReason ||
    (!featureEnabled ? input.disabledReason ?? "Cron job is disabled." : null);

  return {
    jobName: input.jobName,
    label: input.label,
    schedule: input.schedule,
    timezone: input.timezone,
    expectedLocalTime: input.expectedLocalTime,
    staleAfterMinutes: input.staleAfterMinutes,
    enabled,
    disabledReason,
    recordsRuns: input.recordsRuns ?? true,
    note: input.note,
  };
}

export function getAdminCronJobDefinitions(
  env: NodeJS.ProcessEnv = process.env
): AdminCronJobDefinition[] {
  const cronEnabled = isAdminCronSchedulingEnabled(env);
  const globalDisabledReason = cronEnabled
    ? null
    : "CRON_ENABLED is not true for this app instance.";
  const backupSchedule = env.BACKUP_CRON_SCHEDULE?.trim() || "0 3 * * *";
  const xeroMembershipRefreshEnabled = isExplicitlyEnabled(
    env.XERO_ENABLE_DAILY_MEMBERSHIP_REFRESH
  );
  const nzTimezone = ADMIN_CRON_DEFAULT_TIMEZONE;

  return [
    defineCronJob(
      {
        // Epic #2992. The mirror's polling backstop. It appears here because
        // the push path failing is designed to be SILENT (polling covers it),
        // and this entry going stale is the one signal an operator gets that
        // the covering poll itself has stopped.
        jobName: "club-post-mirror-sync",
        label: "Club message board mirror sync",
        schedule: "0 */3 * * *",
        timezone: nzTimezone,
        expectedLocalTime: "Every 3 hours at minute 0 in Pacific/Auckland",
        staleAfterMinutes: THREE_HOURLY_STALE_AFTER_MINUTES,
      },
      globalDisabledReason
    ),
    defineCronJob(
      {
        // #2999. Rides the shared general cron cycle, so it carries that
        // cycle's schedule rather than one of its own. It appears here because
        // it DELETES member content: an operator needs to see that it is still
        // running, and a stale entry is how they find out it is not.
        jobName: "club-post-retention",
        label: "Club message board retention",
        schedule: "0 */3 * * *",
        timezone: nzTimezone,
        expectedLocalTime: "Every 3 hours at minute 0 in Pacific/Auckland",
        staleAfterMinutes: THREE_HOURLY_STALE_AFTER_MINUTES,
      },
      globalDisabledReason
    ),
    defineCronJob(
      {
        // Epic #2992. Rides the shared general cron cycle. It appears here
        // because a member can tick "share with all clubs" and reasonably
        // believe it happened: if this stops running, shares queue silently and
        // a stale entry is how an operator finds out.
        jobName: "club-post-share-retry",
        label: "Club message board share retry",
        schedule: "0 */3 * * *",
        timezone: nzTimezone,
        expectedLocalTime: "Every 3 hours at minute 0 in Pacific/Auckland",
        staleAfterMinutes: THREE_HOURLY_STALE_AFTER_MINUTES,
      },
      globalDisabledReason
    ),
    defineCronJob(
      {
        jobName: "confirm-pending",
        label: "Pending booking confirmation",
        schedule: "0 */3 * * *",
        timezone: nzTimezone,
        expectedLocalTime: "Every 3 hours at minute 0 in Pacific/Auckland",
        staleAfterMinutes: THREE_HOURLY_STALE_AFTER_MINUTES,
      },
      globalDisabledReason
    ),
    defineCronJob(
      {
        jobName: "group-settlement-reaper",
        label: "Stale group settlement reaper",
        schedule: "0 */3 * * *",
        timezone: nzTimezone,
        expectedLocalTime: "Every 3 hours at minute 0 in Pacific/Auckland",
        staleAfterMinutes: THREE_HOURLY_STALE_AFTER_MINUTES,
      },
      globalDisabledReason
    ),
    defineCronJob(
      {
        // #2553: releases the beds an abandoned HOLD-mode policy-exception
        // request reserved once its hold deadline passes, and marks the request
        // EXPIRED. An operator seeing this row is how they know abandoned holds
        // are (or are not) being returned to the pool.
        jobName: "policy-exception-hold-reaper",
        label: "Policy-exception hold reaper",
        schedule: "0 */3 * * *",
        timezone: nzTimezone,
        expectedLocalTime: "Every 3 hours at minute 0 in Pacific/Auckland",
        staleAfterMinutes: THREE_HOURLY_STALE_AFTER_MINUTES,
      },
      globalDisabledReason
    ),
    defineCronJob(
      {
        jobName: "additional-payment-reminders",
        label: "Outstanding additional payment reminders",
        schedule: "0 */3 * * *",
        timezone: nzTimezone,
        expectedLocalTime: "Every 3 hours at minute 0 in Pacific/Auckland",
        staleAfterMinutes: THREE_HOURLY_STALE_AFTER_MINUTES,
      },
      globalDisabledReason
    ),
    defineCronJob(
      {
        jobName: "pre-arrival-reminders",
        label: "Pre-arrival reminders",
        schedule: "0 */3 * * *",
        timezone: nzTimezone,
        expectedLocalTime: "Every 3 hours at minute 0 in Pacific/Auckland",
        staleAfterMinutes: THREE_HOURLY_STALE_AFTER_MINUTES,
      },
      globalDisabledReason
    ),
    defineCronJob(
      {
        // #2550: chases the unnamed "Guest 1..N" party on a member whole-lodge
        // booking before check-in. Visibility only — it never withholds a stay.
        jobName: "placeholder-guest-name-reminders",
        label: "Placeholder guest-name reminders",
        schedule: "0 */3 * * *",
        timezone: nzTimezone,
        expectedLocalTime: "Every 3 hours at minute 0 in Pacific/Auckland",
        staleAfterMinutes: THREE_HOURLY_STALE_AFTER_MINUTES,
      },
      globalDisabledReason
    ),
    defineCronJob(
      {
        // #2576: the backstop for the same-owner hosting-coverage queue. Escalating
        // change paths drain it inline after their own commit; this sweep is the
        // authority on completion, so a process that died mid-drain, a redeployment
        // or a transient email failure cannot leave a confirmed booking without the
        // adult-member cover its club requires and nobody told. A silent failure
        // here is therefore invisible unless it is tracked, which is what this
        // definition is for.
        jobName: "hosting-coverage-reevaluation",
        label: "Hosting coverage re-evaluation",
        schedule: "0 */3 * * *",
        timezone: nzTimezone,
        expectedLocalTime: "Every 3 hours at minute 0 in Pacific/Auckland",
        staleAfterMinutes: THREE_HOURLY_STALE_AFTER_MINUTES,
      },
      globalDisabledReason
    ),
    defineCronJob(
      {
        jobName: "school-attendee-confirmations",
        label: "School attendee confirmations",
        schedule: "0 */3 * * *",
        timezone: nzTimezone,
        expectedLocalTime: "Every 3 hours at minute 0 in Pacific/Auckland",
        staleAfterMinutes: THREE_HOURLY_STALE_AFTER_MINUTES,
      },
      globalDisabledReason
    ),
    defineCronJob(
      {
        jobName: "quote-expiry-reminders",
        label: "Quote expiry reminders",
        schedule: "0 */3 * * *",
        timezone: nzTimezone,
        expectedLocalTime: "Every 3 hours at minute 0 in Pacific/Auckland",
        staleAfterMinutes: THREE_HOURLY_STALE_AFTER_MINUTES,
      },
      globalDisabledReason
    ),
    defineCronJob(
      {
        jobName: "purge-booking-requests",
        label: "Booking request retention purge",
        schedule: "0 */3 * * *",
        timezone: nzTimezone,
        expectedLocalTime: "Every 3 hours at minute 0 in Pacific/Auckland",
        staleAfterMinutes: THREE_HOURLY_STALE_AFTER_MINUTES,
      },
      globalDisabledReason
    ),
    defineCronJob(
      {
        jobName: "payment-recovery",
        label: "Stripe payment recovery",
        schedule: "*/15 * * * *",
        timezone: nzTimezone,
        expectedLocalTime: "Every 15 minutes in Pacific/Auckland",
        staleAfterMinutes: FIFTEEN_MINUTE_STALE_AFTER_MINUTES,
      },
      globalDisabledReason
    ),
    defineCronJob(
      {
        jobName: "xero-membership-refresh",
        label: "Xero membership refresh",
        schedule: "0 2 * * *",
        timezone: nzTimezone,
        expectedLocalTime: "02:00 NZT/NZDT daily",
        staleAfterMinutes: DAILY_STALE_AFTER_MINUTES,
        enabled: xeroMembershipRefreshEnabled,
        disabledReason:
          "Optional safety-net disabled by XERO_ENABLE_DAILY_MEMBERSHIP_REFRESH=false; leave disabled when the 15-minute Xero reconciliation jobs are healthy, or set it to true to run a full daily membership refresh.",
      },
      globalDisabledReason
    ),
    defineCronJob(
      {
        jobName: "xero-link-backfill",
        label: "Xero link backfill",
        schedule: "20 2 * * *",
        timezone: nzTimezone,
        expectedLocalTime: "02:20 NZT/NZDT daily",
        staleAfterMinutes: DAILY_STALE_AFTER_MINUTES,
      },
      globalDisabledReason
    ),
    defineCronJob(
      {
        jobName: "xero-link-cleanup",
        label: "Xero stale link cleanup",
        schedule: "25 2 * * *",
        timezone: nzTimezone,
        expectedLocalTime: "02:25 NZT/NZDT daily",
        staleAfterMinutes: DAILY_STALE_AFTER_MINUTES,
      },
      globalDisabledReason
    ),
    defineCronJob(
      {
        jobName: "xero-reconciliation-report",
        label: "Xero reconciliation report",
        schedule: "35 2 * * *",
        timezone: nzTimezone,
        expectedLocalTime: "02:35 NZT/NZDT daily",
        staleAfterMinutes: DAILY_STALE_AFTER_MINUTES,
      },
      globalDisabledReason
    ),
    defineCronJob(
      {
        jobName: "xero-credit-sync-check",
        label: "Xero credit-sync check",
        schedule: "45 2 * * *",
        timezone: nzTimezone,
        expectedLocalTime: "02:45 NZT/NZDT daily",
        staleAfterMinutes: DAILY_STALE_AFTER_MINUTES,
      },
      globalDisabledReason
    ),
    defineCronJob(
      {
        jobName: "xero-outbox",
        label: "Xero outbox processing",
        schedule: "*/15 * * * *",
        timezone: nzTimezone,
        expectedLocalTime: "Every 15 minutes in Pacific/Auckland",
        staleAfterMinutes: FIFTEEN_MINUTE_STALE_AFTER_MINUTES,
      },
      globalDisabledReason
    ),
    defineCronJob(
      {
        jobName: "xero-operation-replay",
        label: "Xero operation replay",
        schedule: "*/15 * * * *",
        timezone: nzTimezone,
        expectedLocalTime: "Every 15 minutes in Pacific/Auckland",
        staleAfterMinutes: FIFTEEN_MINUTE_STALE_AFTER_MINUTES,
      },
      globalDisabledReason
    ),
    defineCronJob(
      {
        jobName: "xero-inbound-reconcile",
        label: "Xero inbound reconcile",
        schedule: "*/15 * * * *",
        timezone: nzTimezone,
        expectedLocalTime: "Every 15 minutes in Pacific/Auckland",
        staleAfterMinutes: FIFTEEN_MINUTE_STALE_AFTER_MINUTES,
      },
      globalDisabledReason
    ),
    defineCronJob(
      {
        jobName: FINANCE_SYNC_CRON_JOB_NAME,
        label: "Finance daily sync",
        schedule: FINANCE_SYNC_CRON_SCHEDULE,
        timezone: FINANCE_SYNC_CRON_TIMEZONE,
        expectedLocalTime: "10:15 NZT/NZDT daily",
        staleAfterMinutes: DAILY_STALE_AFTER_MINUTES,
        note:
          "Runs at 10:15 local New Zealand time in Pacific/Auckland; UTC dashboards show this as 22:15 on the previous day during NZST or 21:15 during NZDT.",
      },
      globalDisabledReason
    ),
    defineCronJob(
      {
        jobName: "backup",
        label: "Database backup",
        schedule: backupSchedule,
        timezone: nzTimezone,
        expectedLocalTime:
          backupSchedule === "0 3 * * *"
            ? "03:00 NZT/NZDT daily"
            : "Custom BACKUP_CRON_SCHEDULE in Pacific/Auckland",
        staleAfterMinutes: DAILY_STALE_AFTER_MINUTES,
      },
      globalDisabledReason
    ),
    defineCronJob(
      {
        // Bidirectional Other Clubs sync with the Alpine Central Server. Listed
        // unconditionally like every other optional-module cron: the job reports
        // SKIPPED while Other Clubs sync is disabled or the server is not
        // configured, and an operator seeing the row is how they know the daily
        // reconciliation is (or is not) running.
        jobName: "alpine-server-other-lodges-sync",
        label: "Alpine Central Server Other Clubs sync",
        schedule: "0 3 * * *",
        timezone: nzTimezone,
        expectedLocalTime: "03:00 NZT/NZDT daily",
        staleAfterMinutes: DAILY_STALE_AFTER_MINUTES,
      },
      globalDisabledReason
    ),
    defineCronJob(
      {
        jobName: "data-pruning",
        label: "Data pruning",
        schedule: "30 3 * * *",
        timezone: nzTimezone,
        expectedLocalTime: "03:30 NZT/NZDT daily",
        staleAfterMinutes: DAILY_STALE_AFTER_MINUTES,
      },
      globalDisabledReason
    ),
    defineCronJob(
      {
        jobName: "draft-cleanup",
        label: "Draft cleanup",
        schedule: "0 4 * * *",
        timezone: nzTimezone,
        expectedLocalTime: "04:00 NZT/NZDT daily",
        staleAfterMinutes: DAILY_STALE_AFTER_MINUTES,
      },
      globalDisabledReason
    ),
    defineCronJob(
      {
        // "+ Add Member Guest" (#2307, epic #2305). Listed unconditionally, like
        // every other optional-module cron: the job itself reports SKIPPED while
        // the memberGuests module is off, and an operator seeing the row is how
        // they know the pending-hold expiry is (or is not) running.
        jobName: "member-guest-consent-expiry",
        label: "Member-guest consent expiry",
        schedule: "30 4 * * *",
        timezone: nzTimezone,
        expectedLocalTime: "04:30 NZT/NZDT daily",
        staleAfterMinutes: DAILY_STALE_AFTER_MINUTES,
      },
      globalDisabledReason
    ),
    defineCronJob(
      {
        jobName: "pending-deadline-alerts",
        label: "Pending deadline alerts",
        schedule: "0 8 * * *",
        timezone: nzTimezone,
        expectedLocalTime: "08:00 NZT/NZDT daily",
        staleAfterMinutes: DAILY_STALE_AFTER_MINUTES,
      },
      globalDisabledReason
    ),
    defineCronJob(
      {
        jobName: "nomination-reminders",
        label: "Membership nomination reminders",
        schedule: "15 8 * * *",
        timezone: nzTimezone,
        expectedLocalTime: "08:15 NZT/NZDT daily",
        staleAfterMinutes: DAILY_STALE_AFTER_MINUTES,
      },
      globalDisabledReason
    ),
    defineCronJob(
      {
        jobName: "checkin-reminders",
        label: "Check-in reminders",
        schedule: "0 9 * * *",
        timezone: nzTimezone,
        expectedLocalTime: "09:00 NZT/NZDT daily",
        staleAfterMinutes: DAILY_STALE_AFTER_MINUTES,
      },
      globalDisabledReason
    ),
    defineCronJob(
      {
        jobName: "capacity-warnings",
        label: "Capacity warnings",
        schedule: "0 7 * * *",
        timezone: nzTimezone,
        expectedLocalTime: "07:00 NZT/NZDT daily",
        staleAfterMinutes: DAILY_STALE_AFTER_MINUTES,
      },
      globalDisabledReason
    ),
    defineCronJob(
      {
        jobName: "admin-digest",
        label: "Admin digest",
        schedule: "30 7 * * *",
        timezone: nzTimezone,
        expectedLocalTime: "07:30 NZT/NZDT daily",
        staleAfterMinutes: DAILY_STALE_AFTER_MINUTES,
      },
      globalDisabledReason
    ),
    defineCronJob(
      {
        jobName: "email-retry",
        label: "Email retry",
        schedule: "*/30 * * * *",
        timezone: "Server local timezone",
        expectedLocalTime: "Every 30 minutes on the app server timezone",
        staleAfterMinutes: THIRTY_MINUTE_STALE_AFTER_MINUTES,
      },
      globalDisabledReason
    ),
    defineCronJob(
      {
        jobName: "complete-bookings",
        label: "Complete bookings",
        schedule: "0 1 * * *",
        timezone: nzTimezone,
        expectedLocalTime: "01:00 NZT/NZDT daily",
        staleAfterMinutes: DAILY_STALE_AFTER_MINUTES,
      },
      globalDisabledReason
    ),
    defineCronJob(
      {
        jobName: "hut-leader-auto-assign",
        label: "Hut leader auto-assign",
        schedule: "0 6 * * *",
        timezone: nzTimezone,
        expectedLocalTime: "06:00 NZT/NZDT daily",
        staleAfterMinutes: DAILY_STALE_AFTER_MINUTES,
      },
      globalDisabledReason
    ),
    defineCronJob(
      {
        jobName: "age-up",
        label: "Age-up member access",
        schedule: "30 6 * * *",
        timezone: nzTimezone,
        expectedLocalTime: "06:30 NZT/NZDT daily",
        staleAfterMinutes: DAILY_STALE_AFTER_MINUTES,
      },
      globalDisabledReason
    ),
    defineCronJob(
      {
        jobName: "email-inheritance-reconcile",
        label: "Email inheritance reconciliation",
        schedule: "45 6 * * *",
        timezone: nzTimezone,
        expectedLocalTime: "06:45 NZT/NZDT daily",
        staleAfterMinutes: DAILY_STALE_AFTER_MINUTES,
      },
      globalDisabledReason
    ),
    defineCronJob(
      {
        jobName: "credit-reconciliation",
        label: "Credit reconciliation",
        schedule: "0 5 * * *",
        timezone: nzTimezone,
        expectedLocalTime: "05:00 NZT/NZDT daily",
        staleAfterMinutes: DAILY_STALE_AFTER_MINUTES,
      },
      globalDisabledReason
    ),
    defineCronJob(
      {
        jobName: "waitlist-processor",
        label: "Waitlist processor",
        schedule: "*/30 * * * *",
        timezone: nzTimezone,
        expectedLocalTime: "Every 30 minutes in Pacific/Auckland",
        staleAfterMinutes: THIRTY_MINUTE_STALE_AFTER_MINUTES,
      },
      globalDisabledReason
    ),
  ];
}

export function groupCronRunsByJob(
  runs: AdminCronRun[],
  perJobLimit = 5
): Record<string, AdminCronRun[]> {
  const grouped: Record<string, AdminCronRun[]> = {};
  const sortedRuns = [...runs].sort((a, b) => runTime(b) - runTime(a));

  for (const run of sortedRuns) {
    if (!grouped[run.jobName]) {
      grouped[run.jobName] = [];
    }

    if (grouped[run.jobName].length < perJobLimit) {
      grouped[run.jobName].push(run);
    }
  }

  return grouped;
}

function groupAllCronRunsByJob(
  runs: AdminCronRun[]
): Record<string, AdminCronRun[]> {
  const grouped: Record<string, AdminCronRun[]> = {};
  const sortedRuns = [...runs].sort((a, b) => runTime(b) - runTime(a));

  for (const run of sortedRuns) {
    if (!grouped[run.jobName]) {
      grouped[run.jobName] = [];
    }
    grouped[run.jobName].push(run);
  }

  return grouped;
}

function createUnknownJobDefinition(jobName: string): AdminCronJobDefinition {
  return {
    jobName,
    label: jobName,
    schedule: "Unregistered",
    timezone: "Unknown",
    expectedLocalTime: "Not registered in admin cron health metadata",
    staleAfterMinutes: null,
    enabled: true,
    disabledReason: null,
    recordsRuns: true,
    note:
      "This job has CronJobRun history but is not listed in the admin cron metadata.",
  };
}

function classifyCronJob(
  definition: AdminCronJobDefinition,
  runs: AdminCronRun[],
  now: Date
): CronHealthJob {
  const latestRun = runs[0] ?? null;
  const latestSuccess = runs.find((run) => run.status === "SUCCESS") ?? null;
  const latestFailure = runs.find((run) => run.status === "FAILURE") ?? null;
  const latestRunAt = toIso(latestRun?.completedAt ?? latestRun?.startedAt);
  const latestSuccessAt = toIso(
    latestSuccess?.completedAt ?? latestSuccess?.startedAt
  );
  const latestFailureAt = toIso(
    latestFailure?.completedAt ?? latestFailure?.startedAt
  );
  const staleThreshold =
    definition.staleAfterMinutes === null
      ? null
      : formatMinutes(definition.staleAfterMinutes);
  const base = {
    ...definition,
    staleThreshold,
    latestRunAt,
    latestRunStatus: latestRun?.status ?? null,
    latestSuccessAt,
    latestFailureAt,
  };

  if (!definition.enabled) {
    return {
      ...base,
      status: "disabled",
      severity: "info",
      summary: definition.disabledReason ?? "Cron scheduling is disabled.",
    };
  }

  if (!definition.recordsRuns) {
    return {
      ...base,
      status: "untracked",
      severity: "info",
      summary: "This scheduled job does not write CronJobRun history.",
    };
  }

  if (!latestRun) {
    return {
      ...base,
      status: "missing",
      severity: "warning",
      summary: "No CronJobRun history has been recorded for this job yet.",
    };
  }

  if (latestRun.status === "FAILURE") {
    return {
      ...base,
      status: "failed",
      severity: "error",
      summary: latestRun.error
        ? `Latest run failed: ${latestRun.error}`
        : "Latest run failed.",
    };
  }

  if (definition.staleAfterMinutes !== null && latestSuccess) {
    const latestSuccessDate = toDate(
      latestSuccess.completedAt ?? latestSuccess.startedAt
    );
    if (
      latestSuccessDate &&
      now.getTime() - latestSuccessDate.getTime() >
        definition.staleAfterMinutes * 60 * 1000
    ) {
      return {
        ...base,
        status: "stale",
        severity: "warning",
        summary: `Latest successful run is older than the ${staleThreshold} freshness threshold.`,
      };
    }
  }

  if (latestRun.status === "SKIPPED") {
    return {
      ...base,
      status: "skipped",
      severity: "warning",
      summary: latestSuccess
        ? "Latest run was skipped; the most recent successful run is still within the freshness threshold."
        : "Latest run was skipped and no successful run has been recorded yet.",
    };
  }

  if (latestRun.status === "SUCCESS") {
    return {
      ...base,
      status: "current",
      severity: "ok",
      summary: staleThreshold
        ? `Latest successful run is within the ${staleThreshold} freshness threshold.`
        : "Latest successful run is current.",
    };
  }

  return {
    ...base,
    status: "unknown",
    severity: "warning",
    summary: `Latest run used unrecognised status ${latestRun.status}.`,
  };
}

export function buildCronHealthReport({
  runs,
  now = new Date(),
  definitions = getAdminCronJobDefinitions(),
}: {
  runs: AdminCronRun[];
  now?: Date;
  definitions?: AdminCronJobDefinition[];
}): CronHealthReport {
  const runsByJob = groupAllCronRunsByJob(runs);
  const knownJobNames = new Set(definitions.map((definition) => definition.jobName));
  const unknownDefinitions = Object.keys(runsByJob)
    .filter((jobName) => !knownJobNames.has(jobName))
    .sort()
    .map(createUnknownJobDefinition);

  return {
    generatedAt: now.toISOString(),
    cronEnabled: definitions.some((definition) => definition.enabled),
    defaultTimezone: ADMIN_CRON_DEFAULT_TIMEZONE,
    jobs: [...definitions, ...unknownDefinitions].map((definition) =>
      classifyCronJob(definition, runsByJob[definition.jobName] ?? [], now)
    ),
  };
}
