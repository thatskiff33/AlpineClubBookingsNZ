/**
 * Which `CronJobRun` rows a cron-health view has to read.
 *
 * Extracted from `src/app/api/admin/health/route.ts` (AID-6A, #2375) so the AI
 * Diagnostics background-job evidence tool and the Admin > Health screen classify
 * job health from the SAME rows. `admin-cron-health.ts` already owns the
 * authoritative CLASSIFICATION (current / stale / failed / skipped / missing /
 * disabled); what lived only in the route was the equally load-bearing question of
 * WHICH runs to hand it, and a second copy of that would let the two surfaces
 * disagree about whether a nightly job is overdue.
 *
 * The selection is deliberately not "the most recent N runs" alone: a
 * 15-minute job produces enough rows to push a daily job's last run out of any
 * global window, so the daily job would read as `missing` on a busy deployment.
 * Each expected job therefore also contributes its own recent history plus its
 * latest success and latest failure.
 *
 * READ-ONLY, and metadata only at the point of use: this returns the whole
 * `CronJobRun` row (the classifier needs `status` and the timestamps), and every
 * consumer projects it. The Diagnostics tool's projection drops `error` and
 * `resultSummary` — raw error text and arbitrary JSON, which ADR-003/ADR-004
 * keep out of the evidence channel entirely.
 *
 * THE FAN-OUT IS BOUNDED, and that is load-bearing rather than tidy. Three queries
 * per expected job plus one global read is 103 statements at 34 tracked jobs, and
 * issuing them all through a single `Promise.all` put 103 concurrent queries on the
 * APPLICATION connection pool per call. That was survivable as an admin page load and
 * is not survivable as a diagnostics tool: a model may spend up to
 * `maxToolCallsPerSession` calls on job health in one operator question, and each call
 * whose deadline expires abandons its queries WITHOUT cancelling them
 * (`Promise.race` does not cancel the loser, and nothing propagates a cancellation
 * into Prisma). So the per-job reads now run in bounded batches, and a caller may
 * supply a deadline after which no further batch is ISSUED — which is what actually
 * stops a slow database turning one diagnostics question into a pile of queued work.
 *
 * A DEADLINE REFUSES; IT DOES NOT RETURN LESS. Handing the classifier a partial run
 * set would silently reclassify live jobs as `missing` — a fabricated verdict, and a
 * worse outcome than no answer. So the deadline throws, and the Diagnostics executor
 * turns that into `evidence_unavailable` with no rows.
 */

import { prisma } from "@/lib/prisma";
import type {
  AdminCronJobDefinition,
  AdminCronRun,
} from "@/lib/admin-cron-health";

/** Global recent-run window, for the history table and for untracked job names. */
export const RECENT_CRON_RUN_LIMIT = 200;

/** Per-expected-job history depth, on top of the global window. */
export const EXPECTED_CRON_RUN_HISTORY_LIMIT = 5;

/**
 * How many jobs' history may be in flight at once. Each job costs three queries, so
 * this is the peak concurrent load on the application pool: four jobs is twelve
 * statements rather than the 102 an unbounded `Promise.all` issued at 34 jobs, and it
 * still finishes a 34-job report in nine sequential batches.
 */
export const CRON_RUN_FANOUT_CONCURRENCY = 4;

/** Thrown when a caller's deadline passes before every read has been issued. */
export class CronRunReadDeadlineError extends Error {
  constructor() {
    // No timing detail and no job name: this message can reach a log, and a
    // diagnostics caller turns it into a generic `evidence_unavailable` anyway.
    super("Cron run reads exceeded the caller's deadline");
    this.name = "CronRunReadDeadlineError";
  }
}

export interface CronRunReadOptions {
  /**
   * `Date.now()` value after which no further batch is issued and the read REFUSES.
   * Omit for the admin surfaces, which need a complete report and have a user
   * waiting on it rather than a bounded tool-call budget behind them.
   */
  deadlineAtMs?: number;
  /** Override the batch width. Tests use it; production callers should not. */
  concurrency?: number;
}

function getCronRunTime(run: AdminCronRun): number {
  return new Date(run.startedAt ?? run.createdAt ?? 0).getTime();
}

function dedupeCronRuns(runs: AdminCronRun[]): AdminCronRun[] {
  const byId = new Map<string, AdminCronRun>();
  for (const run of runs) {
    byId.set(run.id, run);
  }

  return [...byId.values()].sort((a, b) => getCronRunTime(b) - getCronRunTime(a));
}

/** One job's recent runs with its latest success and failure, unsorted and not de-duplicated. */
export async function getExpectedJobCronRuns(jobName: string): Promise<AdminCronRun[]> {
  const [recentRuns, latestSuccess, latestFailure] = await Promise.all([
    prisma.cronJobRun.findMany({
      where: { jobName },
      orderBy: { startedAt: "desc" },
      take: EXPECTED_CRON_RUN_HISTORY_LIMIT,
    }),
    prisma.cronJobRun.findMany({
      where: { jobName, status: "SUCCESS" },
      orderBy: { startedAt: "desc" },
      take: 1,
    }),
    prisma.cronJobRun.findMany({
      where: { jobName, status: "FAILURE" },
      orderBy: { startedAt: "desc" },
      take: 1,
    }),
  ]);

  return [...recentRuns, ...latestSuccess, ...latestFailure];
}

/**
 * The runs a cron-health report should be built from, newest first and
 * de-duplicated. Pass the same definitions the report will be built with.
 *
 * Throws `CronRunReadDeadlineError` when `options.deadlineAtMs` passes before every
 * job's history has been read — never a partial set, because the classifier would
 * turn missing rows into a `missing` verdict for a job that is running fine.
 */
export async function getCronRunsForAdminHealth(
  definitions: AdminCronJobDefinition[],
  options: CronRunReadOptions = {},
): Promise<AdminCronRun[]> {
  const expectedJobNames = [
    ...new Set(
      definitions
        .filter((definition) => definition.recordsRuns)
        .map((definition) => definition.jobName),
    ),
  ];

  const width = Math.max(1, options.concurrency ?? CRON_RUN_FANOUT_CONCURRENCY);
  const overDeadline = (): boolean =>
    options.deadlineAtMs !== undefined && Date.now() >= options.deadlineAtMs;

  if (overDeadline()) throw new CronRunReadDeadlineError();

  const recentRuns = await prisma.cronJobRun.findMany({
    orderBy: { startedAt: "desc" },
    take: RECENT_CRON_RUN_LIMIT,
  });

  const expectedJobRuns: AdminCronRun[] = [];
  for (let index = 0; index < expectedJobNames.length; index += width) {
    // Checked BEFORE each batch, so an expired deadline stops issuing work rather
    // than merely stopping us waiting for work already sent.
    if (overDeadline()) throw new CronRunReadDeadlineError();
    const batch = await Promise.all(
      expectedJobNames.slice(index, index + width).map(getExpectedJobCronRuns),
    );
    expectedJobRuns.push(...batch.flat());
  }

  return dedupeCronRuns([...recentRuns, ...expectedJobRuns]);
}
