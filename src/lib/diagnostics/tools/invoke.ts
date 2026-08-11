/**
 * AI Diagnostics — the tool executor (AID-5, #2374).
 *
 * THE ORDER OF THE GATES IS THE CONTRACT. Each one refuses on its own terms, and
 * none of them can be reached out of order:
 *
 *   1. REGISTRY     the tool id must name a server-owned entry (ADR-001 §2). An id
 *                   that names none is refused HERE — and still costs a call.
 *   2. LOOP BUDGET  the session must have a round open and calls left (ADR-005 §3).
 *   3. AUTHORIZE    the caller's matrix re-read FRESH from the database, AND
 *                   across every area the tool declares (ADR-002 §2/§3).
 *   4. ARGUMENTS    parsed by the entry's `.strict()` schema, then bound
 *                   POSITIONALLY. No caller text ever reaches SQL.
 *   5. METERING     AID-2's circuit breaker must be closed (ADR-005 §5).
 *   6. CREDENTIAL   for a `select_only_sql` entry, the dedicated SELECT-only role
 *                   must be configured AND verified least-privilege by the server
 *                   (ADR-007).
 *   7. READ         one statement, inside BEGIN READ ONLY, under a statement
 *                   timeout, with the executor's own SQL-level row cap — or, for a
 *                   `server_owned` entry, the entry's fixed first-party read under
 *                   its own deadline.
 *   8. PROJECT      column allowlist, redaction, per-field caps (ADR-004 §2).
 *   9. SIZE         over the byte ceiling is a REFUSAL, never a silent trim.
 *  10. AUDIT        the approved-metadata row is written BEFORE any evidence is
 *                   returned; if it cannot be written the evidence is discarded
 *                   (ADR-004 §3/§4).
 *
 * AUTHORIZATION BEFORE ARGUMENTS, on purpose. Parsing first would let an
 * unauthorized caller use the difference between "invalid arguments" and
 * "permission denied" as an oracle for a tool's argument shape. Authorizing first
 * also means an unauthorized invocation never opens a database connection.
 *
 * TWO EVIDENCE SOURCES, ONE GATE CHAIN (AID-6A, #2375). `source` is a closed
 * discriminant the REGISTRY declares — never an argument, so it cannot move an
 * invocation onto a different path at call time. Gates 1-5 and 8-10 are identical
 * for both, and the AID-6A pack's own docblocks argue why its readiness, budget,
 * deployment and job-health entries could not be a `SELECT` as the least-privilege
 * role. The credential gate is SKIPPED for a `server_owned` entry because it does
 * not govern it — and skipping it is required, not merely permitted: the canonical
 * readiness answer has to stay reportable in exactly the case where that credential
 * is the thing that is broken.
 *
 * NO INJECTABLE DEPENDENCIES. This module imports its collaborators directly
 * rather than accepting them as parameters. A `deps` argument would be a seam a
 * caller could use to pass a permissive authorizer or a no-op auditor, and this
 * is the one function in the substrate where that must be impossible. Tests
 * substitute modules with `vi.mock`, which production code cannot reach.
 *
 * FAIL CLOSED EVERYWHERE: every exit below returns a result carrying NO rows.
 */

import "server-only";

import { isDiagnosticsMeteringHealthy } from "@/lib/ai-diagnostics-usage";
import type { AdminPermissionArea } from "@/lib/admin-permissions";
import { reportAiError } from "@/lib/observability-bridge";
import { redactSensitiveText } from "@/lib/redact-sensitive-json";

import { canonicalStringify, sha256Hex } from "../knowledge/hash";
import { recordDiagnosticsToolAudit } from "./audit";
import { authorizeDiagnosticsToolCall } from "./authorize";
import { getDiagnosticsDatabase, runDiagnosticsReadOnlyQuery } from "./database";
import {
  diagnosticsAuditArgsHash,
  isValidDiagnosticsToolId,
  type DiagnosticsToolEntry,
  type DiagnosticsToolRawRow,
} from "./define";
import { findDiagnosticsTool } from "./registry";
import type { DiagnosticsToolSession } from "./session";
import {
  DIAGNOSTICS_TOOL_BOUNDS,
  DIAGNOSTICS_TOOL_FAILURE_MESSAGES,
  DIAGNOSTICS_TOOL_SCHEMA_VERSION,
  type DiagnosticsToolAudit,
  type DiagnosticsToolFailure,
  type DiagnosticsToolFailureReason,
  type DiagnosticsToolResult,
  type DiagnosticsToolRow,
  type DiagnosticsToolSuccess,
} from "./types";

export interface InvokeDiagnosticsToolInput {
  /** UNTRUSTED: the tool id the model asked for. Looked up, never trusted. */
  toolId: string;
  /** UNTRUSTED: the arguments the model supplied. Parsed, never interpolated. */
  args: unknown;
  /** The admin asking. Their permissions are re-read here, not taken on trust. */
  actingMemberId: string;
  /** The per-question bounded loop. One session per operator question. */
  session: DiagnosticsToolSession;
  /** Server-owned surface label for the audit row. */
  surface?: string;
  /**
   * The invocation instant. Injected so results are deterministic under test;
   * production callers omit it.
   */
  observedAt?: Date;
}

const DEFAULT_SURFACE = "ai-diagnostics-tools";

/** Thrown by the projection step; caught and mapped to `redaction_failed`. */
class ProjectionContractError extends Error {}

/**
 * Redact and bound one projected scalar. A string is redacted through the shared
 * secret/PII scrubber and then capped; a non-finite number, a nested object, an
 * array, a Date, a bigint or an undefined is a PROJECTION BUG and throws — the
 * whole result is then discarded rather than partially shipped, because "we sent
 * the model something we could not model" is not a state to recover from.
 */
function boundedScalar(
  key: string,
  value: unknown,
): DiagnosticsToolRow[string] {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new ProjectionContractError(
        `projected field ${key} is not a finite number`,
      );
    }
    return value;
  }
  if (typeof value === "string") {
    const redacted = redactSensitiveText(value);
    const max = DIAGNOSTICS_TOOL_BOUNDS.fieldValueMaxChars;
    if (redacted.length <= max) return redacted;
    // `max - 1` leaves room for the ellipsis, so the result is exactly `max`
    // characters. Clamped at 0 because a `slice(0, -1)` would drop a character and
    // still add the ellipsis, returning a string LONGER than a (hypothetically
    // tiny) cap — the one way this bound could fail open.
    return `${redacted.slice(0, Math.max(max - 1, 0))}…`;
  }
  throw new ProjectionContractError(
    `projected field ${key} is not a flat scalar`,
  );
}

/**
 * Apply the entry's column allowlist to every raw row, then redact and bound
 * every value. The row's SHAPE comes from the registry, so a column the entry did
 * not name cannot survive this step even if the query returned it.
 *
 * A "FIXED projection" also means fixed ACROSS rows. The first row defines the
 * shape and every later row must match it exactly, so a projection that drops a
 * field for some rows (a `??`-less nullable column, a conditional spread) is a
 * refusal rather than a result whose rows silently disagree about what they
 * contain. Comparing against the first row rather than a declared field list keeps
 * the registry entry as the single source of the shape.
 */
function projectRows(
  tool: DiagnosticsToolEntry,
  rawRows: Record<string, unknown>[],
): DiagnosticsToolRow[] {
  let shape: string | null = null;
  return rawRows.map((raw) => {
    const projected = tool.project(raw);
    const keys = Object.keys(projected);
    if (keys.length > DIAGNOSTICS_TOOL_BOUNDS.maxFieldsPerRow) {
      throw new ProjectionContractError(
        `projection returned ${keys.length} fields, over the per-row cap`,
      );
    }
    const rowShape = [...keys].sort().join(",");
    if (shape === null) {
      shape = rowShape;
    } else if (rowShape !== shape) {
      throw new ProjectionContractError(
        "projection returned rows with differing field sets",
      );
    }
    const bounded: DiagnosticsToolRow = {};
    for (const key of keys) {
      bounded[key] = boundedScalar(key, projected[key]);
    }
    return bounded;
  });
}

function buildAudit(input: {
  toolId: string;
  areasChecked: readonly AdminPermissionArea[];
  authOutcome: "allowed" | "denied";
  failureReason: DiagnosticsToolFailureReason | null;
  argsHash: string | null;
  resultHash: string | null;
  rowCount: number;
  byteCount: number;
  durationMs: number;
  roundIndex: number;
  observedAt: string;
}): DiagnosticsToolAudit {
  return {
    toolId: input.toolId,
    areasChecked: [...input.areasChecked],
    authOutcome: input.authOutcome,
    failureReason: input.failureReason,
    argsHash: input.argsHash,
    resultHash: input.resultHash,
    rowCount: input.rowCount,
    byteCount: input.byteCount,
    durationMs: input.durationMs,
    roundIndex: input.roundIndex,
    observedAt: input.observedAt,
  };
}

/**
 * Persist the audit row for a FAILED or DENIED invocation. A failure to write it
 * is reported but does not change the outcome: the invocation is already
 * returning no evidence, and replacing its real reason with `audit_unavailable`
 * would hide the denial from the operator and from the reader of this code.
 */
async function auditDenial(
  actingMemberId: string,
  surface: string,
  audit: DiagnosticsToolAudit,
): Promise<void> {
  try {
    await recordDiagnosticsToolAudit({ actingMemberId, surface, audit });
  } catch (err) {
    reportAiError({
      tag: "diagnostics-tool-audit",
      message: "Failed to audit a denied or failed diagnostics tool invocation",
      err,
      context: { toolId: audit.toolId, failureReason: audit.failureReason },
    });
  }
}

/**
 * The sentinel for "no evidence" — a REJECTION and a DEADLINE alike. Declared at
 * module scope so TypeScript infers a `unique symbol` and the race's result narrows;
 * a `const` inside the function is typed as plain `symbol`, which does not.
 */
const NO_EVIDENCE: unique symbol = Symbol(
  "diagnostics-server-evidence-unavailable",
);

/**
 * Read a `server_owned` entry's evidence under a hard deadline (AID-6A, #2375).
 *
 * A first-party calculation is not a query the database will cancel for us, so the
 * deadline lives here. Three properties, each of them a way this could have gone
 * wrong:
 *
 *  - A REJECTION AND A TIMEOUT ARE THE SAME OUTCOME to the caller: no rows, and
 *    `evidence_unavailable`. A source that cannot establish something must not be
 *    able to return a row claiming it did.
 *  - THE LOSING PROMISE IS STILL HANDLED. `Promise.race` does not cancel the loser,
 *    so a source that rejects AFTER the deadline would otherwise surface as an
 *    unhandled rejection and, depending on the runtime, take the process with it.
 *    The `.catch` below is attached to the source promise itself, before the race.
 *  - THE TIMER IS ALWAYS CLEARED, so a fast read does not hold an open handle for
 *    fifteen seconds and keep a serverless invocation alive.
 *
 * It never throws: a source that throws SYNCHRONOUSLY (before returning a promise)
 * is caught here too, because the executor's contract is a typed refusal.
 */
async function readServerOwnedEvidence(
  toolId: string,
  read: () => Promise<readonly DiagnosticsToolRawRow[]>,
): Promise<
  | { ok: true; rows: readonly DiagnosticsToolRawRow[]; durationMs: number }
  | { ok: false; durationMs: number }
> {
  const startedAt = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    const source = Promise.resolve()
      .then(read)
      // The return annotation keeps the sentinel's `unique symbol` type through the
      // callback; an inferred return widens it to `symbol`, and the `===` below then
      // narrows nothing.
      .catch((err: unknown): typeof NO_EVIDENCE => {
        // Recorded once, here, so the reason is diagnosable even though the failure
        // the operator sees is deliberately generic. The error object is NOT
        // forwarded: a first-party calculation can wrap a driver error whose message
        // quotes a value, and `reportAiError` sends what it is given to Sentry
        // unredacted.
        reportAiError({
          tag: "diagnostics-tool-server-evidence",
          message: "A server-owned diagnostics evidence source refused",
          err: new Error(
            `Server-owned diagnostics evidence source refused (${
              err instanceof Error ? err.name : typeof err
            })`,
          ),
          context: { toolId },
        });
        return NO_EVIDENCE;
      });

    const deadline = new Promise<typeof NO_EVIDENCE>((resolve) => {
      timer = setTimeout(
        () => resolve(NO_EVIDENCE),
        DIAGNOSTICS_TOOL_BOUNDS.serverEvidenceTimeoutMs,
      );
    });

    const outcome = await Promise.race([source, deadline]);
    if (outcome === NO_EVIDENCE) {
      return { ok: false, durationMs: Date.now() - startedAt };
    }
    return { ok: true, rows: outcome, durationMs: Date.now() - startedAt };
  } catch {
    return { ok: false, durationMs: Date.now() - startedAt };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** What a failure exit supplies; every other audit field is fixed at zero/null. */
interface FailureDetail {
  toolId: string;
  areasChecked: readonly AdminPermissionArea[];
  authOutcome: "allowed" | "denied";
  argsHash?: string | null;
  durationMs?: number;
  roundIndex: number;
  missingAreas?: AdminPermissionArea[];
}

/**
 * Run one diagnostics tool. Never throws — every fault, including an unexpected
 * one from a collaborator, becomes a typed `DiagnosticsToolFailure` carrying the
 * approved audit metadata, so a caller cannot accidentally treat a thrown error
 * as "no result" and lose the audit trail.
 */
export async function invokeDiagnosticsTool(
  input: InvokeDiagnosticsToolInput,
): Promise<DiagnosticsToolResult> {
  const surface = input.surface ?? DEFAULT_SURFACE;
  const observedAt = (input.observedAt ?? new Date()).toISOString();
  const requestedId = input.toolId;

  /**
   * The round this invocation started in, read ONCE and synchronously.
   *
   * Two reasons, both bugs that were live before this was hoisted. `beginRound`
   * mutates the session's shared round index, so reading `stats()` again after an
   * await could attribute a refusal's audit row to a round a concurrent caller had
   * meanwhile opened. And the catch-all at the bottom must not call back into the
   * session at all: a malformed session whose `stats()` throws would make the very
   * wrapper that guarantees "never throws, always audits" throw and lose the audit
   * row. `-1` here means no round was ever open (see `DiagnosticsToolAudit`).
   */
  let roundIndexAtEntry = -1;
  try {
    roundIndexAtEntry = input.session.stats().roundIndex;
  } catch {
    // A session that cannot report its own state is a caller bug. Fall through
    // with `-1` and let the gates below refuse; never let it abort the audit.
  }

  /**
   * What the CATCH-ALL at the bottom must be able to report honestly. Each is
   * updated as its gate passes, so an unexpected fault after authorization is
   * audited as what it was — an allowed call that then failed — rather than as an
   * authorization block against an admin who was never blocked.
   *
   * Before these were hoisted, every `internal_error` row recorded
   * `authOutcome: "denied"`, `areasChecked: []` and `argsHash: null`, which
   * `audit.ts` turns into outcome `blocked` at severity `important`: a
   * security-category, 24-month row asserting a permission incident that never
   * happened, with the areas the call actually touched erased. `audit.ts` already
   * has `failure` for exactly this case.
   */
  let faultAreasChecked: readonly AdminPermissionArea[] = [];
  let faultAuthOutcome: "allowed" | "denied" = "denied";
  let faultArgsHash: string | null = null;
  let faultRoundIndex = roundIndexAtEntry;

  const fail = async (
    reason: DiagnosticsToolFailureReason,
    detail: FailureDetail,
  ): Promise<DiagnosticsToolFailure> => {
    const audit = buildAudit({
      toolId: detail.toolId,
      areasChecked: detail.areasChecked,
      authOutcome: detail.authOutcome,
      failureReason: reason,
      argsHash: detail.argsHash ?? null,
      resultHash: null,
      rowCount: 0,
      byteCount: 0,
      durationMs: detail.durationMs ?? 0,
      roundIndex: detail.roundIndex,
      observedAt,
    });
    await auditDenial(input.actingMemberId, surface, audit);
    const failure: DiagnosticsToolFailure = {
      schemaVersion: DIAGNOSTICS_TOOL_SCHEMA_VERSION,
      status: "error",
      toolId: detail.toolId,
      reason,
      message: DIAGNOSTICS_TOOL_FAILURE_MESSAGES[reason],
      observedAt,
      audit,
    };
    if (detail.missingAreas && detail.missingAreas.length > 0) {
      failure.missingAreas = detail.missingAreas;
    }
    return failure;
  };

  // 1. REGISTRY. An id that is not a well-formed key never even reaches the
  //    lookup, so a hostile "tool id" cannot be used as a probe string. The
  //    recorded id is the SANITISED one: a malformed id is recorded as `unknown`
  //    rather than echoed into a durable row.
  const validId = isValidDiagnosticsToolId(requestedId);
  const safeToolId = validId ? requestedId : "unknown";

  // Every collaborator called below documents itself as never-throwing, so a
  // throw would be a bug — but losing the audit trail to an escaping exception
  // would be a worse one. This wrapper is what makes "never throws" true.
  try {
    const tool = validId ? findDiagnosticsTool(requestedId) : undefined;
    if (!tool) {
      // The registry is still gate 1 — a hostile id reaches nothing else — but the
      // loop budget is CLAIMED here too, before the refusal. An unregistered id
      // used to cost nothing while still writing a durable audit row, so one
      // provider round of 60 hallucinated or injected ids produced 60
      // important-severity security rows with the session counters still reading
      // zero. "A caller cannot probe for free" has to hold for a name that is not
      // in the table as much as for one that is.
      const unknownClaim = input.session.claimToolCall();
      return await fail("unknown_tool", {
        toolId: safeToolId,
        areasChecked: [],
        authOutcome: "denied",
        roundIndex: unknownClaim.ok ? unknownClaim.roundIndex : roundIndexAtEntry,
      });
    }

    // 2. LOOP BUDGET. Claimed before anything expensive, and claimed even for a
    //    call that is about to be denied — a caller must not be able to probe
    //    authorization for free, round after round.
    // Recorded before the claim, not after: a session whose `claimToolCall` throws
    // must not erase the areas of a tool we had already identified.
    faultAreasChecked = tool.requiredAreas;
    const claim = input.session.claimToolCall();
    if (!claim.ok) {
      return await fail("call_budget_exhausted", {
        toolId: tool.id,
        areasChecked: tool.requiredAreas,
        authOutcome: "denied",
        roundIndex: roundIndexAtEntry,
      });
    }
    const roundIndex = claim.roundIndex;
    faultRoundIndex = roundIndex;

    // 3. AUTHORIZE — fresh, from the database, AND across every declared area.
    const authorization = await authorizeDiagnosticsToolCall({
      actingMemberId: input.actingMemberId,
      requiredAreas: tool.requiredAreas,
    });
    if (!authorization.ok) {
      return await fail(authorization.reason, {
        toolId: tool.id,
        areasChecked: tool.requiredAreas,
        authOutcome: "denied",
        roundIndex,
        missingAreas: authorization.missingAreas,
      });
    }
    faultAuthOutcome = "allowed";

    // 4. ARGUMENTS. Parsed by the entry's own `.strict()` schema and bound
    //    positionally by the entry's own `bind`. The hash is of the ACCEPTED
    //    arguments; input we refused is never hashed and never stored.
    const binding = tool.parseArgs(input.args);
    if (!binding.ok) {
      return await fail("invalid_args", {
        toolId: tool.id,
        areasChecked: tool.requiredAreas,
        authOutcome: "allowed",
        roundIndex,
      });
    }
    //    The hash is REDACTED rather than computed when the entry declares the
    //    accepted key low-entropy: `member_search`'s name-prefix, mobile and email
    //    arms are all enumerable offline, so an unkeyed digest of them in a durable
    //    row is the argument itself with extra steps (ADR-004 §4).
    const argsHash = diagnosticsAuditArgsHash(tool, binding.args, (accepted) =>
      sha256Hex(canonicalStringify(accepted)),
    );
    faultArgsHash = argsHash;

    // 5. METERING. Can't-record ⇒ don't-read (ADR-005 §5), the same rule AID-2
    //    applies to paid provider calls.
    if (!isDiagnosticsMeteringHealthy()) {
      return await fail("metering_unavailable", {
        toolId: tool.id,
        areasChecked: tool.requiredAreas,
        authOutcome: "allowed",
        argsHash,
        roundIndex,
      });
    }

    const rowLimit = Math.min(tool.rowLimit, DIAGNOSTICS_TOOL_BOUNDS.maxRows);

    // 6 + 7. The only gates that differ by evidence source. Both arms produce the
    //        SAME thing — raw rows and a duration — so gates 8-10 below cannot tell
    //        which source they came from and cannot treat one more leniently.
    //
    //        The branch is on the ENTRY's declared source, and the binding's own
    //        discriminant is then cross-checked rather than assumed: a mismatch
    //        would mean `defineDiagnosticsTool` and the entry disagree, which is a
    //        bug, and the honest outcome for a bug is `internal_error` with no rows
    //        — never "fall through to the other arm and hope".
    let rawRows: readonly DiagnosticsToolRawRow[];
    let readDurationMs: number;

    if (tool.source === "select_only_sql") {
      if (binding.source !== "select_only_sql") {
        return await fail("internal_error", {
          toolId: tool.id,
          areasChecked: tool.requiredAreas,
          authOutcome: "allowed",
          argsHash,
          roundIndex,
        });
      }

      // 6. CREDENTIAL. Absent, malformed, app-role-reusing, unverifiable or
      //    over-privileged all refuse here — no fallback to `DATABASE_URL`.
      const database = await getDiagnosticsDatabase();
      if (!database.ok) {
        return await fail(database.reason, {
          toolId: tool.id,
          areasChecked: tool.requiredAreas,
          authOutcome: "allowed",
          argsHash,
          roundIndex,
        });
      }

      // 7. READ. `rowLimit + 1` rows are fetched inside the executor's own SQL
      //    LIMIT so truncation can be reported honestly rather than guessed at.
      const read = await runDiagnosticsReadOnlyQuery(
        { sql: tool.sql, params: binding.params, rowLimit, toolId: tool.id },
        database.pool,
      );
      if (!read.ok) {
        return await fail("query_failed", {
          toolId: tool.id,
          areasChecked: tool.requiredAreas,
          authOutcome: "allowed",
          argsHash,
          durationMs: read.durationMs,
          roundIndex,
        });
      }
      rawRows = read.rows;
      readDurationMs = read.durationMs;
    } else {
      if (binding.source !== "server_owned") {
        return await fail("internal_error", {
          toolId: tool.id,
          areasChecked: tool.requiredAreas,
          authOutcome: "allowed",
          argsHash,
          roundIndex,
        });
      }

      // 7'. READ, from the entry's fixed first-party calculation. No SELECT-only
      //     credential is involved, so gate 6 has nothing to check — and must not
      //     block, or readiness would become unreportable exactly when the
      //     diagnostics role is the fault.
      const serverRead = await readServerOwnedEvidence(tool.id, binding.read);
      if (!serverRead.ok) {
        return await fail("evidence_unavailable", {
          toolId: tool.id,
          areasChecked: tool.requiredAreas,
          authOutcome: "allowed",
          argsHash,
          durationMs: serverRead.durationMs,
          roundIndex,
        });
      }
      rawRows = serverRead.rows;
      readDurationMs = serverRead.durationMs;
    }

    // 8. PROJECT + REDACT.
    const truncated = rawRows.length > rowLimit;
    let rows: DiagnosticsToolRow[];
    try {
      rows = projectRows(tool, rawRows.slice(0, rowLimit));
    } catch (err) {
      reportAiError({
        tag: "diagnostics-tool-projection",
        message: "Diagnostics tool projection or redaction failed",
        err,
        context: { toolId: tool.id },
      });
      return await fail("redaction_failed", {
        toolId: tool.id,
        areasChecked: tool.requiredAreas,
        authOutcome: "allowed",
        argsHash,
        durationMs: readDurationMs,
        roundIndex,
      });
    }

    // 9. SIZE. Canonical JSON so the byte count and the hash are the same bytes
    //    on every machine, and so key order cannot change either number.
    const serialized = canonicalStringify(rows);
    const byteCount = Buffer.byteLength(serialized, "utf8");
    const byteLimit = Math.min(
      tool.byteLimit,
      DIAGNOSTICS_TOOL_BOUNDS.maxResultBytes,
    );
    if (byteCount > byteLimit) {
      return await fail("result_too_large", {
        toolId: tool.id,
        areasChecked: tool.requiredAreas,
        authOutcome: "allowed",
        argsHash,
        durationMs: readDurationMs,
        roundIndex,
      });
    }

    // 10. AUDIT BEFORE EVIDENCE. The row is written first; if it cannot be
    //     written the rows are discarded. An unauditable evidence retrieval is
    //     the outcome ADR-004 exists to prevent, so it is not offered here.
    const audit = buildAudit({
      toolId: tool.id,
      areasChecked: tool.requiredAreas,
      authOutcome: "allowed",
      failureReason: null,
      argsHash,
      resultHash: sha256Hex(serialized),
      rowCount: rows.length,
      byteCount,
      durationMs: readDurationMs,
      roundIndex,
      observedAt,
    });
    try {
      await recordDiagnosticsToolAudit({
        actingMemberId: input.actingMemberId,
        surface,
        audit,
      });
    } catch (err) {
      reportAiError({
        tag: "diagnostics-tool-audit",
        message:
          "Discarding diagnostics tool evidence: the audit row could not be written",
        err,
        context: { toolId: tool.id },
      });
      return await fail("audit_unavailable", {
        toolId: tool.id,
        areasChecked: tool.requiredAreas,
        authOutcome: "allowed",
        argsHash,
        durationMs: readDurationMs,
        roundIndex,
      });
    }

    const success: DiagnosticsToolSuccess = {
      schemaVersion: DIAGNOSTICS_TOOL_SCHEMA_VERSION,
      status: "ok",
      toolId: tool.id,
      label: tool.label,
      rows,
      truncated,
      observedAt,
      audit,
    };
    // The entry's own server-owned scope sentence, carried so the renderer can say
    // what was searched (AID-6A, #2375). Copied from the REGISTRY, never from a row
    // or an argument, and omitted rather than set to an empty string when an entry
    // declares none — a blank `scope:` line would read as "we searched nothing".
    if (tool.evidenceScope) success.evidenceScope = tool.evidenceScope;
    return success;
  } catch (err) {
    reportAiError({
      tag: "diagnostics-tool-invoke",
      message: "Unexpected fault while running a diagnostics tool",
      err,
      context: { toolId: safeToolId },
    });
    return await fail("internal_error", {
      toolId: safeToolId,
      areasChecked: faultAreasChecked,
      authOutcome: faultAuthOutcome,
      argsHash: faultArgsHash,
      roundIndex: faultRoundIndex,
    });
  }
}
