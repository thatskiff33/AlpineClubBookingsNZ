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
  const source = fs.readFileSync(
    path.join(process.cwd(), "src/instrumentation.node.ts"),
    "utf8",
  );

  const names = new Set<string>();
  for (const match of source.matchAll(/recordCronRun\(\s*"([a-z0-9-]+)"/g)) {
    names.add(match[1]);
  }

  return [...names].sort();
}

describe("cron recording vs admin cron-health contract (issue #814)", () => {
  const recordedJobNames = readInstrumentationRecordedJobNames();
  const definitionNames = new Set(
    getAdminCronJobDefinitions().map((definition) => definition.jobName),
  );

  it("discovers the scheduled jobs that record CronJobRun outcomes", () => {
    // Safety net so a rename of the recordCronRun helper cannot silently make
    // the contract below pass against an empty set.
    expect(recordedJobNames.length).toBeGreaterThanOrEqual(15);
  });

  it("exposes every recorded scheduled job in admin cron-health", () => {
    const missingFromHealth = recordedJobNames.filter(
      (jobName) => !definitionNames.has(jobName),
    );

    expect(missingFromHealth).toEqual([]);
  });
});
