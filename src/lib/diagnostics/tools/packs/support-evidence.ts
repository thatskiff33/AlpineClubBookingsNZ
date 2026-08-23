/**
 * AI Diagnostics — the AID-6A pack's SERVER-OWNED evidence sources (#2375).
 *
 * Four questions in this pack cannot be answered by a `SELECT` as the
 * least-privilege role, and #2375 is explicit that they must not be answered by a
 * SECOND calculation that can drift from the screen an operator already trusts:
 *
 *  1. READINESS. The canonical answer combines the module flag, the ENCRYPTED
 *     dedicated-credential state and the server-verified privilege shape of the
 *     diagnostics role itself. Two of those are structurally out of reach: ADR-007
 *     forbids granting the diagnostics role any access to credential storage, and
 *     the third is a verdict ABOUT that role's connection — which has to stay
 *     reportable in exactly the case where that connection is the blocker. So this
 *     reads `getDiagnosticsReadiness`, the same function
 *     `GET /api/admin/ai-diagnostics/readiness` renders, and projects a strict
 *     non-secret subset of it.
 *  2. DEPLOYMENT IDENTITY. The release identifier, the app version and the
 *     deployed knowledge bundle's verified state live in the image and on disk, not
 *     in the database.
 *  3. BUDGET AND USAGE HEALTH. `getDiagnosticsUsageSummary` is the admin panel's
 *     own numbers, including the live reservation total the budget gate itself
 *     sums. Re-deriving spend in SQL would be a third definition of the money.
 *  4. BACKGROUND-JOB HEALTH. `buildCronHealthReport` is the authoritative
 *     overdue/failed/skipped classification, with each job's expected cadence and
 *     staleness threshold. #2375 requires reusing it rather than handing the model
 *     raw timestamps and asking it to infer whether a nightly job is late.
 *
 * WHAT THIS FILE IS, EXACTLY, and the residual that comes with it. Every function
 * here is READ-ONLY, first-party, takes no caller-supplied source, performs no write
 * and calls no external provider. Reached THROUGH A REGISTRY ENTRY, each one sits
 * behind the whole gate chain — registry lookup, loop budget, fresh AND-ed
 * authorization, `.strict()` arguments, the metering breaker, the fixed projection
 * with redaction, the row/byte ceilings and the approved-metadata audit row (see
 * `define.ts` and `invoke.ts`).
 *
 * What would be untrue is to call this "not a second privileged data path" without
 * qualification, so here is the precise position:
 *
 *  - THE READINESS SOURCE genuinely could not be a `SELECT`. It needs encrypted
 *    credential state and a verdict about the diagnostics role's own connection, both
 *    permanently out of that role's reach by ADR-007, and it has to stay answerable in
 *    exactly the case where that credential is the blocker.
 *  - THE OTHER THREE DO QUERY APPLICATION TABLES on the application's full-privilege
 *    Prisma client: `DiagnosticsBudgetReservation` and `DiagnosticsUsageEvent` here,
 *    and whole `CronJobRun` rows via `getCronRunsForAdminHealth`. There is no
 *    `SELECT_GRANTS` entry and therefore no column grant behind them, so unlike the
 *    correlation entries — where `SELECT "ipAddress" FROM "AuditLog"` is refused by
 *    PostgreSQL itself with 42501 — the registry PROJECTION is the only boundary.
 *    Nothing leaks today: the projections are correct, and `boundedScalar` would
 *    refuse the JSON `resultSummary` outright. But `CronJobRun.error` (raw error text,
 *    often a stack) and `DiagnosticsUsageEvent.errorMessage` (provider error text) sit
 *    one field away, so EVERY EDIT TO A SOURCE OR A PROJECTION IN THIS PACK IS A
 *    SECURITY-RELEVANT CHANGE and needs the same review as a grant would.
 *    #2375's own rule is what keeps this from drifting further: a fourth source that
 *    could be a column-granted `SELECT` must be one, not another function here.
 *  - READING A SOURCE DIRECTLY IS OUTSIDE THE GUARANTEES. These functions are module
 *    exports because the pack's contract tests assert on their raw rows; a production
 *    caller that imported one would get none of the gates above. The module is
 *    `server-only`, so no such import can reach a browser bundle, and no production
 *    caller other than `support-system.ts` exists — but the guarantee is about the
 *    registry ENTRY, which exposes no handle at all, not about these functions.
 *
 * EVERY ROW IS RAW. These functions return raw rows in the same shape a SQL read
 * produces; the registry entry's `project` is what allowlists, redacts and caps
 * them. That is deliberate — one projection contract for both evidence sources —
 * and it is why the field names here are snake_case: they are a source's output,
 * not the evidence the model sees.
 *
 * TIMESTAMPS ARE ISO-8601 UTC STRINGS, never `Date` objects: a `Date` is not a
 * flat scalar and the projection would refuse the whole result (`redaction_failed`).
 * The field names say `_at_utc` so neither the model nor an operator has to guess
 * whether an instant is local NZ time.
 */

import "server-only";

import {
  buildCronHealthReport,
  getAdminCronJobDefinitions,
} from "@/lib/admin-cron-health";
import { getCronRunsForAdminHealth } from "@/lib/admin-cron-runs";
import {
  getDiagnosticsReadiness,
  readDiagnosticsModuleFlag,
} from "@/lib/ai-diagnostics-config";
import {
  DIAGNOSTICS_MAX_TOOL_ROUNDS,
  WORST_CASE_ROUNDTRIP_CENTS,
  getDiagnosticsUsageSummary,
} from "@/lib/ai-diagnostics-usage";

import { loadKnowledgeBundle } from "../../knowledge/load";
import { isVerifiedCommitSha } from "../../knowledge/verify";
import type { DiagnosticsToolRawRow } from "../define";
import { withBoundedReadOnlyTransaction } from "../read-only-transaction";
import { readClubTimeZoneOutsideRequest } from "@/lib/club-time-zone-runtime";
import { readCronRuntimeZone } from "@/lib/cron-runtime-zone";

/** The stable "nothing to report" code, so an empty list is never an empty string. */
export const NO_CODES = "none";

/** ISO-8601 UTC, or null. The one place a `Date` becomes a projectable scalar. */
function isoOrNull(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * CANONICAL readiness, as one row.
 *
 * The projected subset is fixed by #2375: overall state, module flag, dedicated
 * credential STATE (never a value, never a key id), configured budget, the
 * server-verified diagnostics-role state, and the ordered stable blocker codes. It
 * deliberately carries no privilege detail beyond that state — the readiness
 * contract withholds it from the admin API for the same reason (it is JSON an
 * admin browser receives), and this channel must not be the looser of the two.
 *
 * `getDiagnosticsReadiness` never throws: a fault resolves to `ready: false` with a
 * `resolve_error` blocker, which is the honest evidence an operator needs.
 *
 * NEITHER READ MAY BECOME A REJECTION (#2803). The module flag is read through
 * `readDiagnosticsModuleFlag`, which uses the STRICT loader and catches, so a narrow
 * failure of that one query reports `module_enabled: null` beside a
 * `module_flags_unreadable` blocker — an answer an operator can tell apart from a
 * club that genuinely switched diagnostics off. It is deliberately NOT an
 * `evidence_unavailable`: this entry has to keep answering in exactly the case where
 * the application database is the fault, which is the whole reason it is
 * `server_owned` and carries the `readiness-module-flags-fault-tolerant` exemption.
 */
export async function readDiagnosticsReadinessEvidence(): Promise<
  readonly DiagnosticsToolRawRow[]
> {
  const readiness = await getDiagnosticsReadiness({
    aiDiagnostics: await readDiagnosticsModuleFlag(),
  });

  return [
    {
      readiness_state: readiness.ready ? "ready" : "not_ready",
      // `null` when the flags could not be read — NEVER coerced to a boolean here.
      // `blocker_codes` carries `module_flags_unreadable` beside it.
      module_enabled: readiness.moduleEnabled,
      credential_state: readiness.keyState,
      monthly_budget_cents: readiness.monthlyBudgetCents,
      database_role_state: readiness.databaseState,
      blocker_codes:
        readiness.blockers.length > 0 ? readiness.blockers.join(",") : NO_CODES,
      blocker_count: readiness.blockers.length,
    },
  ];
}

/**
 * The deployed knowledge bundle's verified state, cached.
 *
 * Verification is an O(entries) hash over the whole artifact, and the artifact is
 * baked into the image — it cannot change while the container runs. Re-verifying on
 * every tool call would burn CPU on the request path to re-derive a constant. The
 * TTL is short enough that a bundle written after start-up (a non-standard layout,
 * or a test overriding `KNOWLEDGE_BUNDLE_PATH`) is still picked up, and the cache
 * holds only the four non-secret metadata fields, never the entries.
 */
const BUNDLE_STATE_TTL_MS = 5 * 60 * 1000;

interface KnowledgeBundleStateEvidence {
  state: string;
  commitSha: string | null;
  commitVerified: boolean;
  observedAtUtc: string | null;
  generator: string | null;
  entryCount: number;
}

let cachedBundleState: {
  readAt: number;
  evidence: KnowledgeBundleStateEvidence;
} | null = null;

/** Test seam: drop the cached bundle metadata so the next read re-verifies. */
export function resetDiagnosticsDeploymentEvidenceCacheForTests(): void {
  cachedBundleState = null;
}

async function readKnowledgeBundleState(
  now: number,
): Promise<KnowledgeBundleStateEvidence> {
  if (cachedBundleState && now - cachedBundleState.readAt < BUNDLE_STATE_TTL_MS) {
    return cachedBundleState.evidence;
  }

  const load = await loadKnowledgeBundle();
  const evidence: KnowledgeBundleStateEvidence = load.ok
    ? {
        state: "verified",
        commitSha: load.bundle.meta.commitSha,
        commitVerified: isVerifiedCommitSha(load.bundle.meta.commitSha),
        observedAtUtc: isoOrNull(load.bundle.meta.observedAt),
        generator: load.bundle.meta.generator,
        entryCount: load.bundle.meta.entryCount,
      }
    : {
        // A stable failure code from the loader's own closed union. The loader's
        // `detail` — which can quote a parse error or a path — is deliberately
        // dropped: ADR-003 keeps raw error text out of the evidence channel.
        state: load.reason,
        commitSha: null,
        commitVerified: false,
        observedAtUtc: null,
        generator: null,
        entryCount: 0,
      };

  cachedBundleState = { readAt: now, evidence };
  return evidence;
}

/**
 * DEPLOYMENT / RELEASE evidence, as one row.
 *
 * The release identifier is a git SHA or a release tag — public build metadata, not
 * a secret — and it is the field that answers "is the code I am looking at the code
 * that is running?". `release_id_source` is reported because the fallback chain
 * matters operationally: a deployment that reached `commit-sha` did not have
 * `RELEASE_ID` wired, and one that reached neither cannot be identified at all.
 *
 * No environment variable is read except the three named here, and no value from
 * any other variable is projected. The public-website CSP nonce derived from the
 * release id (`release-nonce.ts`) is deliberately NOT read or reported: it is a
 * different concern, and a tool that returned it would be inviting the model to
 * treat a per-release value as interesting.
 */
export async function readDiagnosticsDeploymentEvidence(
  now: Date = new Date(),
): Promise<readonly DiagnosticsToolRawRow[]> {
  const bundle = await readKnowledgeBundleState(now.getTime());
  const releaseId = process.env.RELEASE_ID?.trim();
  const commitSha = process.env.GIT_COMMIT_SHA?.trim();

  return [
    {
      release_id: releaseId || commitSha || null,
      release_id_source: releaseId
        ? "release-id"
        : commitSha
          ? "commit-sha"
          : "unset",
      app_version: process.env.npm_package_version?.trim() || "unknown",
      node_version: process.version,
      runtime_role: process.env.APP_RUNTIME_ROLE?.trim() || "unknown",
      // `Math.round` so the value is an integer scalar rather than a float that
      // differs on every call for no diagnostic benefit.
      uptime_seconds: Math.round(process.uptime()),
      knowledge_bundle_state: bundle.state,
      knowledge_bundle_commit_sha: bundle.commitSha,
      knowledge_bundle_commit_verified: bundle.commitVerified,
      knowledge_bundle_observed_at_utc: bundle.observedAtUtc,
      knowledge_bundle_generator: bundle.generator,
      knowledge_bundle_entry_count: bundle.entryCount,
    },
  ];
}

/**
 * DIAGNOSTICS BUDGET AND USAGE health, as one row.
 *
 * The money comes from `getDiagnosticsUsageSummary` — the admin panel's own
 * numbers, including the live reservation total the budget gate sums before it
 * admits a paid call — so this channel cannot disagree with that screen about
 * spend. `remaining_cents` is derived from those same three numbers rather than
 * from a fourth definition of the budget rule, and it is reported honestly: a
 * deployment whose reservations exceed a lowered budget shows a negative figure
 * instead of a clamped zero that hides the condition.
 *
 * The three fields the summary does not compute are read here, bounded: the count
 * of EXPIRED reservations (the crash-safety backstop's own signal that a settle
 * never landed), and the latest settled success and failure instants with the
 * failure's stable code.
 *
 * WHAT IS NEVER PROJECTED, and why: `DiagnosticsUsageEvent.errorMessage`. It is
 * already redacted and truncated at write time, but it is still provider error TEXT,
 * and #2375 restricts this evidence to stable codes. `errorCode` carries the
 * diagnosable part.
 */
export async function readDiagnosticsUsageHealthEvidence(
  now: Date = new Date(),
): Promise<readonly DiagnosticsToolRawRow[]> {
  // THE SUMMARY RUNS BEFORE THE SEAM OPENS, and that ordering is the decision
  // (#2786, exemption `usage-summary-no-tx-client`). `getDiagnosticsUsageSummary`
  // is the admin usage panel's OWN shared calculation: it reads the global client
  // and accepts no transaction client, so threading it would mean changing a
  // non-diagnostics surface to satisfy a diagnostics contract. Calling it first
  // rather than inside the callback is what keeps its reads from being a second
  // statement inside a transaction that has already begun — the transaction stays
  // as short as the reads it actually bounds.
  //
  // WHAT THAT COSTS, SAID PLAINLY: the summary's instant and the three reads below
  // are not the same instant, so `stale_reservation_count` can be measured a moment
  // after `active_reserved_cents`. It is the honest residual of an exemption rather
  // than a hidden one, and it is narrow — these are monitoring counters about
  // spend, not a reconciliation identity anyone acts on the difference of.
  const summary = await getDiagnosticsUsageSummary(now);
  const month = summary.month.month;

  const [staleReservationCount, latestSuccess, latestFailure] =
    await withBoundedReadOnlyTransaction((tx) =>
      Promise.all([
        tx.diagnosticsBudgetReservation.count({
          where: { month, expiresAt: { lte: now } },
        }),
        tx.diagnosticsUsageEvent.findFirst({
          where: { month, success: true },
          orderBy: { createdAt: "desc" },
          select: { createdAt: true },
        }),
        tx.diagnosticsUsageEvent.findFirst({
          where: { month, success: false },
          orderBy: { createdAt: "desc" },
          select: { createdAt: true, errorCode: true },
        }),
      ]),
    );

  return [
    {
      month,
      monthly_budget_cents: summary.budget.limitCents,
      settled_cents: summary.month.settledCents,
      active_reserved_cents: summary.month.activeReservedCents,
      remaining_cents:
        summary.budget.limitCents -
        summary.month.settledCents -
        summary.month.activeReservedCents,
      budget_status: summary.month.budgetStatus,
      request_count: summary.month.requestCount,
      roundtrip_count: summary.month.roundtripCount,
      failed_count: summary.month.failedCount,
      stale_reservation_count: staleReservationCount,
      latest_success_at_utc: isoOrNull(latestSuccess?.createdAt ?? null),
      latest_failure_at_utc: isoOrNull(latestFailure?.createdAt ?? null),
      latest_failure_code: latestFailure?.errorCode ?? null,
      worst_case_roundtrip_cents: WORST_CASE_ROUNDTRIP_CENTS,
      max_tool_rounds: DIAGNOSTICS_MAX_TOOL_ROUNDS,
    },
  ];
}

/**
 * Severity rank, worst first. The ORDER of these rows is a safety property, not a
 * presentation choice: the tool's row ceiling is below the number of registered
 * jobs, so whatever is cut has to be the healthy tail. Sorting by severity and then
 * by the unique job name makes the order TOTAL — required for a stable audit
 * `resultHash` — and guarantees every unhealthy job is inside the returned prefix.
 */
const CRON_SEVERITY_RANK: Record<string, number> = {
  error: 0,
  warning: 1,
  info: 2,
  ok: 3,
};

/**
 * BACKGROUND-JOB health, one row per registered job.
 *
 * The classification is `buildCronHealthReport`'s, unchanged — the same
 * authoritative overdue/failed/skipped verdict Admin > Health shows, over the same
 * rows (`getCronRunsForAdminHealth`, shared with that route since #2375).
 *
 * ONE HONEST DIFFERENCE, stated in the tool's own description as well: the admin
 * screen asks the cron-leader container whether scheduling is enabled, over HTTP.
 * A diagnostics tool must not make an outbound call, so `cron_scheduling_enabled`
 * here reflects THIS container's configuration. On a blue/green web slot that is
 * the web role's own view, so a job can read `disabled` here and `enabled` on the
 * screen. Reported as its own field rather than folded into each job's status, so
 * the difference is visible instead of silently changing a verdict.
 *
 * WHAT IS NEVER PROJECTED: `CronJobRun.error` (raw error text, often a stack) and
 * `resultSummary` (arbitrary JSON). ADR-003 keeps both out of the evidence channel
 * entirely; the classified status and the timestamps are the diagnosable part.
 *
 * THE READ IS BOUNDED IN CONCURRENCY AND IN TIME, which the substrate cannot do for
 * it. `select_only_sql` entries get `BEGIN READ ONLY`, a 5-second `statement_timeout`
 * and a 2-second `lock_timeout` from the executor; a first-party calculation gets none
 * of that, and the executor's outer race abandons a slow read without cancelling
 * it. So this passes `getCronRunsForAdminHealth` a batch width and a deadline of its
 * own, set below the executor's so the refusal comes from here — where it is a clean
 * throw the executor reports as `evidence_unavailable` — rather than from a race whose
 * loser keeps running. A deadline REFUSES rather than returning fewer runs, because a
 * partial run set would make the classifier report a healthy job as `missing`.
 */
const JOB_HEALTH_READ_BUDGET_MS = 10_000;

export async function readBackgroundJobHealthEvidence(
  now: Date = new Date(),
): Promise<readonly DiagnosticsToolRawRow[]> {
  /*
    Scheduled jobs are described in the CLUB's civil time (CT-5, #2869), and
    the zone they RUN on is the one the scheduler pinned at boot — not the
    persisted setting, which a running job only adopts on restart. Prefer the
    running zone when this process registered the jobs, so the evidence never
    states an hour no job will fire at; fall back to the configured one and
    report the mismatch as its own field rather than silently.
  */
  const configuredClubTimeZone = await readClubTimeZoneOutsideRequest();
  const runningClubTimeZone = readCronRuntimeZone();
  const clubTimeZone = runningClubTimeZone ?? configuredClubTimeZone;
  const definitions = getAdminCronJobDefinitions(clubTimeZone);
  const runs = await getCronRunsForAdminHealth(definitions, {
    deadlineAtMs: Date.now() + JOB_HEALTH_READ_BUDGET_MS,
  });
  const report = buildCronHealthReport({
    definitions,
    runs,
    now,
    clubTimeZone: configuredClubTimeZone,
    runningTimeZone: runningClubTimeZone,
  });

  return [...report.jobs]
    .sort((left, right) => {
      const leftRank = CRON_SEVERITY_RANK[left.severity] ?? 9;
      const rightRank = CRON_SEVERITY_RANK[right.severity] ?? 9;
      if (leftRank !== rightRank) return leftRank - rightRank;
      return left.jobName.localeCompare(right.jobName);
    })
    .map((job) => ({
      job_name: job.jobName,
      status: job.status,
      severity: job.severity,
      enabled: job.enabled,
      schedule: job.schedule,
      stale_after_minutes: job.staleAfterMinutes,
      latest_run_at_utc: isoOrNull(job.latestRunAt),
      latest_run_status: job.latestRunStatus,
      latest_success_at_utc: isoOrNull(job.latestSuccessAt),
      latest_failure_at_utc: isoOrNull(job.latestFailureAt),
      cron_scheduling_enabled: report.cronEnabled,
      registered_job_count: report.jobs.length,
    }));
}
