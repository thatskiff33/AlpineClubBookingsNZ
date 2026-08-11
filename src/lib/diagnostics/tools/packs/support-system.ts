/**
 * AI Diagnostics — AID-6A support pack, part 1: DEPLOYMENT, CONFIGURATION,
 * READINESS and OPERATIONAL HEALTH evidence (#2375, epic #2369).
 *
 * PERMISSION: every entry here requires `support:view`, and only `support:view`.
 * That is the area which already governs Admin > Support & System — setup,
 * modules, health, deliverability, audit and operational diagnostics — and
 * `/admin/ai-diagnostics` itself. #2375's owner decision is explicit that
 * `support:view` is required ONLY for this class of general system evidence, and
 * that a domain tool must NOT also demand it; the domain packs (AID-6B #2376,
 * AID-6C #2377) therefore require their own area instead, and the correlation
 * entries in `support-correlation.ts` require `support:view` AND the affected
 * domain's area.
 *
 * NO TABLE GRANT. Every entry here is `server_owned`: it reads a fixed,
 * first-party, read-only calculation the application already exposes to admins,
 * so this half of the pack adds NOTHING to the `SELECT_GRANTS` allowlist. The
 * reasoning for each source is in `support-evidence.ts`; the short version is that
 * readiness depends on encrypted credential state and on a verdict about the
 * diagnostics role's own connection, which ADR-007 puts permanently out of that
 * role's reach — and that re-deriving spend or job-staleness in SQL would be a
 * second definition of numbers the admin screens already own.
 *
 * WHAT NONE OF THESE MAY EVER RETURN (ADR-004 §2, and #2375's own list): an API
 * key, an encrypted or decrypted credential value, a database password, a
 * connection string, a role password, a credential identifier, raw privilege
 * detail the readiness contract withholds, a prompt, an answer, a tool argument, a
 * tool result, a provider payload, raw error text, a stack, an IP address, a user
 * agent, or any member/booking/payment identifier. The projections below are the
 * enforcement: a field that is not named there cannot reach the model even if a
 * source starts returning it.
 *
 * STABLE CODES, NOT PROSE. Every state field is a value from a closed server-side
 * union — `DiagnosticsBlocker`, `DiagnosticsKeyState`, `DiagnosticsDatabaseState`,
 * `DiagnosticsBudgetStatus`, the cron health status/severity, the knowledge-bundle
 * load reason — so the model can classify without parsing English, and so the
 * evidence cannot drift into a sentence that reads like an instruction.
 */

import "server-only";

import { z } from "zod";

import { defineDiagnosticsTool, type DiagnosticsToolEntry } from "../define";
import {
  readBackgroundJobHealthEvidence,
  readDiagnosticsDeploymentEvidence,
  readDiagnosticsReadinessEvidence,
  readDiagnosticsUsageHealthEvidence,
} from "./support-evidence";

/** No arguments at all: these four report the deployment's own current state. */
const NO_ARGS = z.object({}).strict();
const NO_ARGS_SCHEMA = {
  type: "object" as const,
  properties: {},
  additionalProperties: false as const,
};

/** A projected scalar that must be a string, or null. Never `undefined`. */
function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** A projected scalar that must be a finite number. */
function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export const DIAGNOSTICS_READINESS_TOOL_ID = "diagnostics.readiness";
export const DIAGNOSTICS_DEPLOYMENT_TOOL_ID = "diagnostics.deployment_evidence";
export const DIAGNOSTICS_USAGE_HEALTH_TOOL_ID = "diagnostics.usage_health";
export const DIAGNOSTICS_BACKGROUND_JOB_HEALTH_TOOL_ID =
  "diagnostics.background_job_health";

/**
 * CANONICAL AI Diagnostics readiness — the same answer as the admin readiness
 * screen, never a second calculation.
 *
 * `credential_state` is the metadata-only state of the DEDICATED Anthropic key
 * (`not_configured` / `saved` / `needs_reentry`). It is a state, not a value, not a
 * key id, and not a hint about the value: `saved` means a stored key decrypts,
 * `needs_reentry` means one is stored but fails GCM after an auth-secret rotation.
 *
 * `database_role_state` is the server's own verdict on the SELECT-only role
 * (`not_configured` / `misconfigured` / `unverified` / `under_provisioned` /
 * `over_privileged` / `verified`). `under_provisioned` means ONLY that declared
 * grants are absent and nothing else is wrong; a role that is short of grants AND
 * holds a privilege the allowlist no longer declares reports `over_privileged`,
 * because excess privilege is the more serious fact and must not read as merely
 * incomplete. Deliberately the state only: the underlying privilege report names
 * roles and counts relations, and the readiness contract withholds that from the
 * admin API for good reason. This channel is not the looser of the two.
 */
const readinessTool = defineDiagnosticsTool({
  id: DIAGNOSTICS_READINESS_TOOL_ID,
  source: "server_owned",
  label: "AI Diagnostics readiness",
  description:
    "Reports whether AI Diagnostics itself is fully set up, and what is still blocking it if not: whether the module is on, whether the dedicated Anthropic credential is stored and usable (state only, never the key), the configured monthly budget in cents, the verified state of the read-only diagnostics database role, and stable blocker codes. Returns no secret value of any kind. Use it when asked why diagnostics is unavailable, degraded, or refusing to run tools.",
  requiredAreas: ["support"],
  argsSchema: NO_ARGS,
  inputSchema: NO_ARGS_SCHEMA,
  readEvidence: () => readDiagnosticsReadinessEvidence(),
  project: (row) => ({
    readinessState: stringOrNull(row.readiness_state) ?? "unknown",
    moduleEnabled: row.module_enabled === true,
    credentialState: stringOrNull(row.credential_state) ?? "unknown",
    monthlyBudgetCents: numberOr(row.monthly_budget_cents, 0),
    databaseRoleState: stringOrNull(row.database_role_state) ?? "unknown",
    blockerCodes: stringOrNull(row.blocker_codes) ?? "unknown",
    blockerCount: numberOr(row.blocker_count, 0),
  }),
  rowLimit: 1,
  byteLimit: 1_024,
  surfacesPersonalData: false,
});

/**
 * DEPLOYMENT / RELEASE identity, including whether the deployed knowledge bundle
 * verified — which is what decides whether Diagnostics can explain code at all.
 *
 * A release identifier and a commit SHA are public build metadata. Nothing here is
 * derived from a credential, and the CSP nonce built from the same release id is
 * deliberately not read.
 */
const deploymentTool = defineDiagnosticsTool({
  id: DIAGNOSTICS_DEPLOYMENT_TOOL_ID,
  source: "server_owned",
  label: "Deployment and release evidence",
  description:
    "Reports which release is running and whether its deployed code-knowledge bundle verified: the release identifier and where it came from, the application version, the Node version, the runtime role (for example web-blue or web-green), how long this container has been up, and the bundle's state, commit, build instant and entry count. Returns no configuration values and no secrets. Use it when asked what version is deployed, or why code explanations are unavailable.",
  requiredAreas: ["support"],
  argsSchema: NO_ARGS,
  inputSchema: NO_ARGS_SCHEMA,
  readEvidence: () => readDiagnosticsDeploymentEvidence(),
  project: (row) => ({
    releaseId: stringOrNull(row.release_id),
    releaseIdSource: stringOrNull(row.release_id_source) ?? "unset",
    appVersion: stringOrNull(row.app_version) ?? "unknown",
    nodeVersion: stringOrNull(row.node_version) ?? "unknown",
    runtimeRole: stringOrNull(row.runtime_role) ?? "unknown",
    uptimeSeconds: numberOr(row.uptime_seconds, 0),
    knowledgeBundleState: stringOrNull(row.knowledge_bundle_state) ?? "unknown",
    knowledgeBundleCommitSha: stringOrNull(row.knowledge_bundle_commit_sha),
    knowledgeBundleCommitVerified: row.knowledge_bundle_commit_verified === true,
    knowledgeBundleObservedAtUtc: stringOrNull(
      row.knowledge_bundle_observed_at_utc,
    ),
    knowledgeBundleGenerator: stringOrNull(row.knowledge_bundle_generator),
    knowledgeBundleEntryCount: numberOr(row.knowledge_bundle_entry_count, 0),
  }),
  rowLimit: 1,
  byteLimit: 2_048,
  surfacesPersonalData: false,
  // The narrowing worth stating: this is THIS container's view, and on a blue/green
  // deployment the other slot can be running a different release.
  evidenceScope:
    "The release, runtime role and knowledge bundle of the container that answered this request. On a blue/green deployment the other slot may be running a different release.",
});

/**
 * DIAGNOSTICS BUDGET AND USAGE health, in integer NZD cents throughout — the
 * platform's money rule, and the reason nothing here is a float.
 *
 * `staleReservationCount` is the operational signal #2375 asks for by name: a live
 * budget reservation whose settle never landed (a process death mid-call). The
 * reserve path reclaims expired reservations opportunistically, so a non-zero count
 * that persists means paid calls are dying before they settle.
 */
const usageHealthTool = defineDiagnosticsTool({
  id: DIAGNOSTICS_USAGE_HEALTH_TOOL_ID,
  source: "server_owned",
  label: "AI Diagnostics budget and usage health",
  description:
    "Reports this calendar month's AI Diagnostics spend and budget health in NZD cents: the configured monthly budget, settled cost, cost currently reserved by in-flight calls, remaining budget, budget status, request/roundtrip/failure counts, how many budget reservations have expired without settling, and the latest successful and failed call instants with the failure's stable code. Returns no prompt, answer, tool argument, tool result or provider error text. Use it when asked what diagnostics is costing, or why a diagnostics request was refused on budget.",
  requiredAreas: ["support"],
  argsSchema: NO_ARGS,
  inputSchema: NO_ARGS_SCHEMA,
  readEvidence: () => readDiagnosticsUsageHealthEvidence(),
  project: (row) => ({
    month: stringOrNull(row.month) ?? "unknown",
    monthlyBudgetCents: numberOr(row.monthly_budget_cents, 0),
    settledCents: numberOr(row.settled_cents, 0),
    activeReservedCents: numberOr(row.active_reserved_cents, 0),
    remainingCents: numberOr(row.remaining_cents, 0),
    budgetStatus: stringOrNull(row.budget_status) ?? "unknown",
    requestCount: numberOr(row.request_count, 0),
    roundtripCount: numberOr(row.roundtrip_count, 0),
    failedCount: numberOr(row.failed_count, 0),
    staleReservationCount: numberOr(row.stale_reservation_count, 0),
    latestSuccessAtUtc: stringOrNull(row.latest_success_at_utc),
    latestFailureAtUtc: stringOrNull(row.latest_failure_at_utc),
    latestFailureCode: stringOrNull(row.latest_failure_code),
    worstCaseRoundtripCents: numberOr(row.worst_case_roundtrip_cents, 0),
    maxToolRounds: numberOr(row.max_tool_rounds, 0),
  }),
  rowLimit: 1,
  byteLimit: 2_048,
  surfacesPersonalData: false,
  // The narrowing worth stating: one calendar month, not a lifetime total, so an
  // empty-looking month is not evidence that diagnostics has never been used.
  evidenceScope:
    "The CURRENT calendar month only. Earlier months are not included, so a low figure here is not a lifetime total.",
});

/**
 * BACKGROUND-JOB health, worst severity first.
 *
 * THE ROW CEILING IS BELOW THE NUMBER OF REGISTERED JOBS, deliberately. There are
 * more than thirty scheduled jobs (34 at the time of writing, and the number only
 * grows) and the whole registry does not fit the substrate's 8 000-character evidence
 * block. So the source orders by severity (error, warning, info, ok) and then by job
 * name, the executor keeps the first EIGHTEEN and SAYS it truncated, and no healthy job
 * can displace an unhealthy one. Each row also carries `registeredJobCount`, so
 * "eighteen of thirty-four" is never mistaken for "eighteen jobs exist".
 *
 * EIGHTEEN RATHER THAN TWENTY, measured. Twenty rows of this twelve-field shape render
 * to 7 999 characters once every job has both a latest success and an older failure —
 * the steady state of a mature deployment — which is one character inside the cap, so
 * the block would routinely have to drop its last row. The renderer is honest when
 * that happens (it drops whole rows and says how many of how many it listed), but a
 * ceiling that never needs it is the better contract: eighteen rows render to about
 * 7 300 characters with real headroom, and the two rows given up are by construction
 * the healthiest of the eighteen.
 *
 * THE BYTE CEILING WAS WRONG, and it is worth recording what it cost because the
 * failure was silent. `byteLimit` was 8 192, and gate 9 REFUSES the whole result when
 * the projected rows exceed it. Measured against the real definitions, the real
 * source and this entry's own projection: on an ordinary deployment where every job
 * has simply run at least once — so `latestRunAtUtc`, `latestRunStatus` and
 * `latestSuccessAtUtc` are populated — twenty rows serialised to 8 272 bytes and the
 * executor refused them all with `result_too_large`, telling an operator to narrow a
 * question that TAKES NO ARGUMENTS. The all-populated case reached 8 712. The ceiling
 * is now 16 384 (half the substrate's hard 32 768), and two contract tests now
 * serialise this entry's own projected shape at its own row limit and fail if the
 * ceiling is unachievable — the assertion that was missing, because the registry
 * contract only checked `byteLimit <= maxResultBytes` and never that an entry's own
 * limit was reachable at its own row limit.
 *
 * WHY 16 384 RATHER THAN JUST ENOUGH. At today's real job names, 18 rows serialise to
 * 8 103 bytes, which 8 192 does technically clear — by 89 bytes. That is the same knife
 * edge that broke this entry the first time, and `job_name` is open-ended: any pull
 * request may register a longer one. So the ceiling is measured against a job name at
 * `fieldValueMaxChars` (200), where 18 rows cost 11 127 bytes, and the registry contract
 * measures it that way too. A ceiling has to survive the next job, not just this
 * release's.
 */
const backgroundJobHealthTool = defineDiagnosticsTool({
  id: DIAGNOSTICS_BACKGROUND_JOB_HEALTH_TOOL_ID,
  source: "server_owned",
  label: "Background job health",
  description:
    "Reports the health of the scheduled background jobs, worst problems first: each job's name, classified status (current, stale, failed, skipped, missing, disabled or untracked), severity, whether it is enabled, its cron schedule, its staleness threshold in minutes, and the instants of its latest run, latest success and latest failure. Whether cron scheduling is enabled reflects this container's own configuration. Returns no job error text and no job result payloads. Use it when asked whether a scheduled job is running, late or failing.",
  requiredAreas: ["support"],
  argsSchema: NO_ARGS,
  inputSchema: NO_ARGS_SCHEMA,
  readEvidence: () => readBackgroundJobHealthEvidence(),
  project: (row) => ({
    jobName: stringOrNull(row.job_name) ?? "unknown",
    status: stringOrNull(row.status) ?? "unknown",
    severity: stringOrNull(row.severity) ?? "unknown",
    enabled: row.enabled === true,
    schedule: stringOrNull(row.schedule) ?? "unknown",
    // A job with no staleness threshold projects `null`, which is the honest
    // reading — not a zero that would look like "stale immediately".
    staleAfterMinutes:
      typeof row.stale_after_minutes === "number" &&
      Number.isFinite(row.stale_after_minutes)
        ? row.stale_after_minutes
        : null,
    latestRunAtUtc: stringOrNull(row.latest_run_at_utc),
    latestRunStatus: stringOrNull(row.latest_run_status),
    latestSuccessAtUtc: stringOrNull(row.latest_success_at_utc),
    latestFailureAtUtc: stringOrNull(row.latest_failure_at_utc),
    cronSchedulingEnabled: row.cron_scheduling_enabled === true,
    registeredJobCount: numberOr(row.registered_job_count, 0),
  }),
  rowLimit: 18,
  byteLimit: 16_384,
  surfacesPersonalData: false,
  evidenceScope:
    "The eighteen worst-severity scheduled jobs of all the jobs this release registers; the true total is on every row as registeredJobCount, and the jobs not listed are the healthiest ones. Whether cron scheduling is enabled reflects THIS container's configuration, not the cron-leader container's.",
});

/** The AID-6A system half, in presentation order. */
export const DIAGNOSTICS_SUPPORT_SYSTEM_TOOLS: readonly DiagnosticsToolEntry[] = [
  readinessTool,
  deploymentTool,
  usageHealthTool,
  backgroundJobHealthTool,
];
