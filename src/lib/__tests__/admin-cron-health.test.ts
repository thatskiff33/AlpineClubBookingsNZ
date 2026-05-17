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
  FINANCE_SYNC_CRON_TIMEZONE,
} from "@/lib/finance-sync-cron-config";

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
        disabledReason: "Disabled by feature flag.",
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
      "Disabled by feature flag."
    );
  });

  it("documents the finance daily sync schedule as a Pacific/Auckland local-time job", () => {
    const definitions = getAdminCronJobDefinitions({
      CRON_ENABLED: "true",
    } as NodeJS.ProcessEnv);
    const finance = definitions.find(
      (definition) => definition.jobName === FINANCE_SYNC_CRON_JOB_NAME
    );

    expect(finance).toMatchObject({
      schedule: FINANCE_SYNC_CRON_SCHEDULE,
      timezone: FINANCE_SYNC_CRON_TIMEZONE,
      expectedLocalTime: "10:15 NZT/NZDT daily",
      staleAfterMinutes: 2160,
    });
    expect(finance?.note).toContain("10:15 local New Zealand time");
  });

  it("tracks draft cleanup as a daily CronJobRun-backed job", () => {
    const definitions = getAdminCronJobDefinitions({
      CRON_ENABLED: "true",
    } as NodeJS.ProcessEnv);
    const draftCleanup = definitions.find(
      (definition) => definition.jobName === "draft-cleanup"
    );

    expect(draftCleanup).toMatchObject({
      recordsRuns: true,
      staleAfterMinutes: 2160,
    });
    expect(draftCleanup?.note).toBeUndefined();
  });

  it("describes the daily Xero membership refresh as an optional disabled safety net", () => {
    const definitions = getAdminCronJobDefinitions({
      CRON_ENABLED: "true",
      XERO_ENABLE_DAILY_MEMBERSHIP_REFRESH: "false",
    } as NodeJS.ProcessEnv);
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
