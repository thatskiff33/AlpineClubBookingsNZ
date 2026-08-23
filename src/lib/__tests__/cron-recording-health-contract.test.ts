import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { getAdminCronJobDefinitions } from "@/lib/admin-cron-health";

// Issue #814 (high-risk invariant test gap #5):
//
// Every in-process scheduled job in src/instrumentation.node.ts records its
// outcome with recordCronRun("<jobName>", ...). For those runs to be visible to
// operators, the same jobName must have an admin cron-health definition;
// otherwise admin health classifies the job as "untracked" and a silent
// scheduler failure has no surface.
//
// We read the instrumentation source statically instead of importing it: the
// module registers real node-cron schedules at import time, which must never be
// started from a unit test. This contract test is the regression guard the #814
// review asked for — adding a recordCronRun(...) call for a new job without a
// matching health definition will fail here.

function readInstrumentationRecordedJobNames(): string[] {
  const sources = [
    "src/instrumentation.node.ts",
    "src/lib/general-cron-runner.ts",
    "src/lib/xero-cron-runner.ts",
    // #2501: the credit-sync checker owns its recorded job-name constant
    // (XERO_CREDIT_SYNC_JOB_NAME), which the Xero cron runner maps to and
    // records under; scan it so the contract discovers that job name.
    "src/lib/xero-credit-sync-checker.ts",
    "src/lib/finance-sync-cron-config.ts",
  ].map((filePath) =>
    fs.readFileSync(path.join(process.cwd(), filePath), "utf8")
  );

  const names = new Set<string>();
  const patterns = [
    /recordCronRun\(\s*"([a-z0-9-]+)"/g,
    /jobName:\s*"([a-z0-9-]+)"/g,
    /[A-Z_]+_JOB_NAME\s*=\s*"([a-z0-9-]+)"/g,
    /^\s*(?:memberships|outbox|retries|inbound|backfill|"link-cleanup"|report):\s*"([a-z0-9-]+)"/gm,
  ];

  for (const source of sources) {
    for (const pattern of patterns) {
      for (const match of source.matchAll(pattern)) {
        names.add(match[1]);
      }
    }
  }

  return [...names].sort();
}

describe("cron recording vs admin cron-health contract (issue #814)", () => {
  const recordedJobNames = readInstrumentationRecordedJobNames();
  const definitionNames = new Set(
    getAdminCronJobDefinitions("Pacific/Auckland").map((definition) => definition.jobName),
  );

  it("discovers the scheduled jobs that record CronJobRun outcomes", () => {
    // Safety net so a rename of the recordCronRun helper cannot silently make
    // the contract below pass against an empty set.
    expect(recordedJobNames.length).toBeGreaterThanOrEqual(20);
  });

  it("exposes every recorded scheduled job in admin cron-health", () => {
    const missingFromHealth = recordedJobNames.filter(
      (jobName) => !definitionNames.has(jobName),
    );

    expect(missingFromHealth).toEqual([]);
  });

  it("has an in-process recording path for every enabled tracked admin health job", () => {
    const enabledDefinitionNames = getAdminCronJobDefinitions("Pacific/Auckland", {
      CRON_ENABLED: "true",
      XERO_ENABLE_DAILY_MEMBERSHIP_REFRESH: "true",
    } as unknown as NodeJS.ProcessEnv)
      .filter((definition) => definition.enabled && definition.recordsRuns)
      .map((definition) => definition.jobName);
    const recordedNames = new Set(recordedJobNames);
    const missingRecordingPath = enabledDefinitionNames.filter(
      (jobName) => !recordedNames.has(jobName)
    );

    expect(missingRecordingPath).toEqual([]);
  });
});
