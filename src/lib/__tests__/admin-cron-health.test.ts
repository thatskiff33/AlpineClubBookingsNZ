import { describe, expect, it } from "vitest";
import {
  buildCronHealthReport,
  getAdminCronJobDefinitions,
  type AdminCronJobDefinition,
  type AdminCronRun,
} from "@/lib/admin-cron-health";
import {
  FINANCE_SYNC_CRON_JOB_NAME,
  FINANCE_SYNC_CRON_SCHEDULE,
} from "@/lib/finance-sync-cron-config";

/**
 * CT-5 (#2869): every definition names the CLUB's persisted timezone, which the
 * caller resolves and passes in. A zone that is deliberately NOT this machine's
 * would be a stronger probe still; `Pacific/Auckland` is used because the
 * assertions below quote the strings an operator reads.
 */
const CLUB_TIME_ZONE = "Pacific/Auckland";

function cronDefinition(
  overrides: Partial<AdminCronJobDefinition> & { jobName: string }
): AdminCronJobDefinition {
  return {
    jobName: overrides.jobName,
    label: overrides.label ?? overrides.jobName,
    schedule: overrides.schedule ?? "0 10 * * *",
    timezone: overrides.timezone ?? "Pacific/Auckland",
    expectedLocalTime: overrides.expectedLocalTime ?? "10:00 NZT/NZDT daily",
    staleAfterMinutes: overrides.staleAfterMinutes ?? 60,
    enabled: overrides.enabled ?? true,
    disabledReason: overrides.disabledReason ?? null,
    recordsRuns: overrides.recordsRuns ?? true,
    note: overrides.note,
  };
}

function cronRun(
  overrides: Partial<AdminCronRun> & {
    id: string;
    jobName: string;
    status: string;
    startedAt: string;
  }
): AdminCronRun {
  return {
    completedAt: overrides.completedAt ?? overrides.startedAt,
    durationMs: overrides.durationMs ?? 1000,
    resultSummary: overrides.resultSummary ?? null,
    error: overrides.error ?? null,
    ...overrides,
  };
}

describe("admin cron health", () => {
  it("classifies current, stale, failed, skipped, disabled, missing, and untracked jobs distinctly", () => {
    const definitions = [
      cronDefinition({ jobName: "current" }),
      cronDefinition({ jobName: "stale" }),
      cronDefinition({ jobName: "failed" }),
      cronDefinition({ jobName: "skipped" }),
      cronDefinition({
        jobName: "disabled",
        enabled: false,
        disabledReason: "Disabled by module setting.",
      }),
      cronDefinition({ jobName: "missing" }),
      cronDefinition({
        jobName: "untracked",
        recordsRuns: false,
        staleAfterMinutes: null,
      }),
    ];
    const report = buildCronHealthReport({
      now: new Date("2026-05-15T00:00:00.000Z"),
      clubTimeZone: CLUB_TIME_ZONE,
      definitions,
      runs: [
        cronRun({
          id: "current-1",
          jobName: "current",
          status: "SUCCESS",
          startedAt: "2026-05-14T23:30:00.000Z",
        }),
        cronRun({
          id: "stale-1",
          jobName: "stale",
          status: "SUCCESS",
          startedAt: "2026-05-14T21:00:00.000Z",
        }),
        cronRun({
          id: "failed-1",
          jobName: "failed",
          status: "FAILURE",
          startedAt: "2026-05-14T23:55:00.000Z",
          error: "Boom",
        }),
        cronRun({
          id: "skipped-1",
          jobName: "skipped",
          status: "SKIPPED",
          startedAt: "2026-05-14T23:50:00.000Z",
          resultSummary: { reason: "Already running" },
        }),
      ],
    });

    const statuses = Object.fromEntries(
      report.jobs.map((job) => [job.jobName, job.status])
    );

    expect(statuses).toEqual({
      current: "current",
      stale: "stale",
      failed: "failed",
      skipped: "skipped",
      disabled: "disabled",
      missing: "missing",
      untracked: "untracked",
    });
    expect(report.jobs.find((job) => job.jobName === "failed")?.severity).toBe(
      "error"
    );
    expect(report.jobs.find((job) => job.jobName === "disabled")?.summary).toBe(
      "Disabled by module setting."
    );
  });

  describe("the running zone versus the configured one (CT-5, #2869)", () => {
    /*
      `node-cron` reads a job's zone when the job is REGISTERED and never
      re-reads it, so between an admin changing the club timezone and the next
      restart the setting and the running schedule disagree. The health page was
      stating the SETTING across about forty "expected local time" sentences for
      jobs still firing on the old zone — an hour no job would fire at. The
      report now carries both and says which.
    */
    const definitions = [cronDefinition({ jobName: "current" })];

    it("states the configured zone, and no restart, when nothing can report a running one", () => {
      const report = buildCronHealthReport({
        now: new Date("2026-05-15T00:00:00.000Z"),
        clubTimeZone: "Pacific/Chatham",
        definitions,
        runs: [],
      });

      expect(report.configuredTimezone).toBe("Pacific/Chatham");
      expect(report.runningTimezone).toBeNull();
      expect(report.defaultTimezone).toBe("Pacific/Chatham");
      // Unknown is NOT "they agree": claiming a restart is outstanding when
      // nothing knows would put a permanent warning on every web slot.
      expect(report.timezoneRestartRequired).toBe(false);
    });

    it("prefers the running zone and flags the outstanding restart", () => {
      const report = buildCronHealthReport({
        now: new Date("2026-05-15T00:00:00.000Z"),
        clubTimeZone: "Pacific/Chatham",
        runningTimeZone: "America/Denver",
        definitions,
        runs: [],
      });

      expect(report.configuredTimezone).toBe("Pacific/Chatham");
      expect(report.runningTimezone).toBe("America/Denver");
      // The times on the page describe when jobs fire TODAY.
      expect(report.defaultTimezone).toBe("America/Denver");
      expect(report.timezoneRestartRequired).toBe(true);
    });

    it("flags nothing once the two agree", () => {
      const report = buildCronHealthReport({
        now: new Date("2026-05-15T00:00:00.000Z"),
        clubTimeZone: "Pacific/Chatham",
        runningTimeZone: "Pacific/Chatham",
        definitions,
        runs: [],
      });

      expect(report.timezoneRestartRequired).toBe(false);
      expect(report.defaultTimezone).toBe("Pacific/Chatham");
    });
  });

  it("documents the finance daily sync schedule in the club's own timezone", () => {
    const definitions = getAdminCronJobDefinitions(CLUB_TIME_ZONE, {
      CRON_ENABLED: "true",
    } as unknown as NodeJS.ProcessEnv);
    const finance = definitions.find(
      (definition) => definition.jobName === FINANCE_SYNC_CRON_JOB_NAME
    );

    expect(finance).toMatchObject({
      schedule: FINANCE_SYNC_CRON_SCHEDULE,
      timezone: CLUB_TIME_ZONE,
      expectedLocalTime: `10:15 daily in ${CLUB_TIME_ZONE}`,
      staleAfterMinutes: 2160,
    });
    expect(finance?.note).toContain(`10:15 in the club's own time (${CLUB_TIME_ZONE})`);
  });

  it("tracks draft cleanup as a daily CronJobRun-backed job", () => {
    const definitions = getAdminCronJobDefinitions(CLUB_TIME_ZONE, {
      CRON_ENABLED: "true",
    } as unknown as NodeJS.ProcessEnv);
    const draftCleanup = definitions.find(
      (definition) => definition.jobName === "draft-cleanup"
    );

    expect(draftCleanup).toMatchObject({
      recordsRuns: true,
      staleAfterMinutes: 2160,
    });
    expect(draftCleanup?.note).toBeUndefined();
  });

  it("tracks general cron cycle jobs with matching freshness thresholds", () => {
    const definitions = getAdminCronJobDefinitions(CLUB_TIME_ZONE, {
      CRON_ENABLED: "true",
    } as unknown as NodeJS.ProcessEnv);

    for (const jobName of [
      "confirm-pending",
      // #2550: the whole-lodge placeholder guest-name chase rides the same
      // three-hourly general cycle as its siblings.
      "placeholder-guest-name-reminders",
      // #2553: the abandoned policy-exception capacity-hold reaper rides the same
      // three-hourly general cycle, so it must share its freshness threshold —
      // otherwise an operator cannot tell a silent reaper from a healthy one.
      "policy-exception-hold-reaper",
      "pre-arrival-reminders",
      "purge-booking-requests",
      "quote-expiry-reminders",
    ]) {
      expect(
        definitions.find((definition) => definition.jobName === jobName)
      ).toMatchObject({
        schedule: "0 */3 * * *",
        expectedLocalTime: "Every 3 hours at minute 0 in Pacific/Auckland",
        staleAfterMinutes: 390,
      });
    }
  });

  it("tracks payment recovery every fifteen minutes with a matching freshness threshold", () => {
    const definitions = getAdminCronJobDefinitions(CLUB_TIME_ZONE, {
      CRON_ENABLED: "true",
    } as unknown as NodeJS.ProcessEnv);
    const paymentRecovery = definitions.find(
      (definition) => definition.jobName === "payment-recovery"
    );

    expect(paymentRecovery).toMatchObject({
      schedule: "*/15 * * * *",
      expectedLocalTime: "Every 15 minutes in Pacific/Auckland",
      staleAfterMinutes: 60,
    });
  });

  it("tracks Xero outbox and stale link cleanup as CronJobRun-backed jobs", () => {
    const definitions = getAdminCronJobDefinitions(CLUB_TIME_ZONE, {
      CRON_ENABLED: "true",
    } as unknown as NodeJS.ProcessEnv);

    expect(
      definitions.find((definition) => definition.jobName === "xero-outbox")
    ).toMatchObject({
      schedule: "*/15 * * * *",
      staleAfterMinutes: 60,
    });
    expect(
      definitions.find(
        (definition) => definition.jobName === "xero-link-cleanup"
      )
    ).toMatchObject({
      schedule: "25 2 * * *",
      staleAfterMinutes: 2160,
    });
  });

  it("describes the daily Xero membership refresh as an optional disabled safety net", () => {
    const definitions = getAdminCronJobDefinitions(CLUB_TIME_ZONE, {
      CRON_ENABLED: "true",
      XERO_ENABLE_DAILY_MEMBERSHIP_REFRESH: "false",
    } as unknown as NodeJS.ProcessEnv);
    const refresh = definitions.find(
      (definition) => definition.jobName === "xero-membership-refresh"
    );

    expect(refresh).toMatchObject({
      enabled: false,
      disabledReason:
        "Optional safety-net disabled by XERO_ENABLE_DAILY_MEMBERSHIP_REFRESH=false; leave disabled when the 15-minute Xero reconciliation jobs are healthy, or set it to true to run a full daily membership refresh.",
    });
  });
});
