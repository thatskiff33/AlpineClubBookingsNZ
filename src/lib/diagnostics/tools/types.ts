/**
 * AI Diagnostics — SELECT-only tool substrate: shared types and bounds (AID-5,
 * epic #2369, issue #2374).
 *
 * THE ONE INVARIANT THAT MATTERS: the model never supplies SQL. A tool is a
 * server-owned pairing of a fixed SQL text, a fixed projection, a fixed row/byte
 * ceiling, and a fixed admin-permission requirement. The model may only choose
 * WHICH registered tool to call and supply arguments that a `.strict()` Zod
 * schema has already accepted; those arguments become positional query
 * parameters and nothing else. There is no string interpolation into SQL
 * anywhere in this substrate, and no code path that accepts SQL from a caller.
 *
 * SECURITY POSTURE (do not weaken without an owner decision on #2370):
 *  - ADR-001: read-only. No mutation tool, no model SQL, no raw credentials, no
 *    raw provider payloads. The only writes this substrate performs are its own
 *    approved-metadata audit rows, on the APPLICATION connection — never the
 *    SELECT-only one.
 *  - ADR-002: every invocation re-reads the caller's permission matrix FRESH
 *    from the database-joined access roles and requires `view` on EVERY area the
 *    tool declares (AND, never OR). Withholding a tool definition from the model
 *    is a courtesy; the server-side check is the control, and it runs on every
 *    invocation whether the definition was offered or not.
 *  - ADR-003: a tool result is UNTRUSTED, prompt-injection-capable evidence with
 *    an observed-at instant. It carries no system authority.
 *  - ADR-004: an audit row carries tool id, auth outcome, row/byte/timing counts
 *    and non-reversible hashes — never raw arguments, never raw results.
 *  - ADR-007: the queries run as a dedicated non-superuser SELECT-only role
 *    (`AI_DIAGNOSTICS_DATABASE_URL`), inside a READ ONLY transaction, under a
 *    statement timeout, with a SQL-level row cap the executor imposes itself.
 *
 * FAIL CLOSED EVERYWHERE. Unknown tool, malformed arguments, exhausted round
 * budget, unhealthy metering, denied authorization, missing or mis-privileged
 * database role, timeout, oversized result, failed redaction, failed audit write
 * — every one of them returns a result carrying NO rows.
 */

import type { AdminPermissionArea } from "@/lib/admin-permissions";

/**
 * Result/registry format version. A consumer pins the exact value so it can
 * never silently read a shape it does not understand (same discipline as the
 * knowledge bundle in AID-3 and the page context in AID-4).
 */
export const DIAGNOSTICS_TOOL_SCHEMA_VERSION = 1 as const;

/**
 * Every ceiling the substrate enforces. They are deliberately small: a
 * diagnostics tool exists to answer "what does the deployed system currently say
 * about X", not to move data. A tool that wants more than this is a report, and
 * a report belongs in the admin UI where it is already governed.
 *
 * `maxRows`/`maxResultBytes` are HARD CEILINGS on top of each tool's own
 * declared limit — a registry entry may be stricter, never looser, and
 * `registry.ts`'s contract test refuses a looser one.
 */
export const DIAGNOSTICS_TOOL_BOUNDS = {
  /** Registry key, e.g. `diagnostics.substrate_probe`. */
  toolIdMaxChars: 64,
  /** Hard ceiling on rows any tool may return, imposed in SQL by the executor. */
  maxRows: 200,
  /** Hard ceiling on the UTF-8 byte length of one tool's projected result. */
  maxResultBytes: 32_768,
  /** Cap on any single free-text value inside a projected row, after redaction. */
  fieldValueMaxChars: 200,
  /** Cap on the number of projected columns one row may carry. */
  maxFieldsPerRow: 24,
  /** `statement_timeout` for the tool's read-only transaction. */
  statementTimeoutMs: 5_000,
  /** `lock_timeout` — a diagnostics read must never queue behind a writer. */
  lockTimeoutMs: 2_000,
  /** `idle_in_transaction_session_timeout` — a wedged read frees its backend. */
  idleInTransactionTimeoutMs: 10_000,
  /** Tool calls allowed inside ONE provider round. */
  maxToolCallsPerRound: 4,
  /** Tool calls allowed across a whole diagnostics session. */
  maxToolCallsPerSession: 16,
  /** Connections the dedicated SELECT-only pool may open. */
  maxPoolConnections: 3,
  /**
   * CLIENT-side deadline on any single query the diagnostics pool sends (pg's
   * `query_timeout`), deliberately LONGER than `statementTimeoutMs`.
   *
   * The layering is the point, and the order matters. `statement_timeout` is the
   * SERVER cancelling and replying, which is the control that produces SQLSTATE
   * 57014 and the honest "that read took too long" answer — so it must win. This
   * one only fires when no reply can travel back at all (a black-holed route, a
   * wedged pooler holding the socket open), which pg otherwise leaves unbounded:
   * `connectionTimeoutMillis` covers acquiring a client, never the round trip.
   */
  queryTimeoutMs: 10_000,
  /**
   * How long the SERVER's verdict on the diagnostics role stays good for. The
   * probe is one round trip; caching it for the life of the process meant a role
   * escalated by hand was reported `verified` until the container restarted.
   */
  rolePrivilegeTtlMs: 60_000,
  /**
   * Hard deadline on that probe, above `queryTimeoutMs` for the same
   * server-control-wins reason: an unanswered probe must become the `unverified`
   * refusal this substrate promises, never a readiness request that hangs.
   */
  privilegeProbeTimeoutMs: 12_000,
  /**
   * Deadline on ONE `server_owned` evidence read (AID-6A, #2375) — the fixed
   * first-party calculations a tool may read instead of the SELECT-only database
   * (readiness, budget/usage, cron health, deployed-bundle identity).
   *
   * Above `privilegeProbeTimeoutMs` on purpose. The canonical readiness answer
   * INCLUDES the role-privilege probe, so a deadline at or below the probe's own
   * would turn "the role could not be reached, and readiness says so" — the exact
   * answer an operator needs — into a timeout that says nothing. This bound is the
   * backstop for a calculation that hangs on something with no deadline of its own,
   * and it fails closed: an expired read returns `evidence_unavailable` and no rows.
   */
  serverEvidenceTimeoutMs: 15_000,
  /** Hard cap on the rendered evidence block handed to the model. */
  renderedBlockMaxChars: 8_000,
} as const;

/**
 * A registered tool id. Lowercase dotted segments only — a closed server-side
 * table key, never a pathname or anything else with prefix semantics.
 */
export const DIAGNOSTICS_TOOL_ID_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;

/**
 * Why an invocation produced no rows. Every value is a stable machine code; the
 * operator-facing sentence travels beside it so neither the UI nor the model has
 * to invent one.
 *
 * `unknown_tool` and `permission_denied` are deliberately DISTINCT even though
 * both deny: conflating them would make a misconfigured registry and an
 * authorization anomaly the same audit row.
 */
export type DiagnosticsToolFailureReason =
  /** No such registry key. */
  | "unknown_tool"
  /** Arguments failed the tool's `.strict()` schema. Details are never echoed. */
  | "invalid_args"
  /** The session's per-round or per-session tool-call budget is spent. */
  | "call_budget_exhausted"
  /** Diagnostics usage can no longer be metered (AID-2 circuit breaker). */
  | "metering_unavailable"
  /** The acting member row does not exist (a stale or forged acting member id). */
  | "actor_unresolved"
  /**
   * The acting member exists but their account is locked out of the admin surface
   * — deactivated, or under a forced password change. Distinct from
   * `actor_read_failed` because an administratively locked-out admin is not a
   * database fault, and distinct from `permission_denied` because it is not a
   * per-area outcome: there is no authorized actor here at all. AID-4's page
   * context reports the same cause as `actor_blocked`, and the two evidence
   * channels must not disagree about what happened.
   */
  | "actor_blocked"
  /** The fresh role read itself failed — kept distinct from `actor_unresolved`. */
  | "actor_read_failed"
  /** The caller lacks `view` on at least one area the tool declares. */
  | "permission_denied"
  /** `AI_DIAGNOSTICS_DATABASE_URL` is absent, malformed, or reuses the app role. */
  | "database_not_configured"
  /** The connected role is NOT the least-privilege shape ADR-007 requires. */
  | "database_role_unsafe"
  /** The role is otherwise safe but lacks one or more declared SELECT grants. */
  | "database_grants_missing"
  /** The read failed, or the statement timeout cancelled it. */
  | "query_failed"
  /**
   * A `server_owned` evidence source (AID-6A, #2375) refused or did not answer
   * inside `serverEvidenceTimeoutMs`. Deliberately DISTINCT from `query_failed`:
   * that one means the SELECT-only database read failed, and an operator's next
   * step for it (check the diagnostics role, ask a narrower question) is not the
   * next step here (the first-party calculation this tool reads is unavailable —
   * usually because the application's own database is unreachable). Conflating
   * them would send an operator to the wrong credential.
   */
  | "evidence_unavailable"
  /** The projected result exceeded the tool's byte ceiling. Never truncated. */
  | "result_too_large"
  /** A projection or redaction step threw. Evidence is discarded, not partial. */
  | "redaction_failed"
  /** The approved-metadata audit row could not be written. Rows are discarded. */
  | "audit_unavailable"
  /**
   * A collaborator threw where its contract says it returns a typed refusal.
   * That is a bug, and the executor still has to fail closed rather than let the
   * exception escape and lose the audit trail — so it is a reason of its own
   * rather than being disguised as one of the specific ones above.
   */
  | "internal_error";

/**
 * What an audit row records in place of `argsHash` when the ACCEPTED arguments
 * are LOW-ENTROPY enough that an unkeyed digest of them would be REVERSIBLE.
 *
 * ADR-004 §4 permits "a stable, NON-REVERSIBLE hash of a query key" and forbids
 * recording "raw tool arguments" or "unrestricted personal identifiers (a
 * member's name, email …)". An unkeyed SHA-256 over a three-character surname
 * prefix, a six-to-fifteen digit phone number or a guessable email address is not
 * non-reversible in any useful sense: the candidate space is small enough that a
 * reader of the audit metadata can enumerate it offline and match the digest, so
 * the hash IS the argument with extra steps.
 *
 * It is a distinct value rather than `null` because the two facts differ and a
 * reader of a durable row must be able to tell them apart: `null` means the
 * arguments never parsed (there is no canonical form of input we refused), and
 * this sentinel means the arguments parsed, ran, and were deliberately not
 * digested. Neither is ever a 64-character hex digest, so a consumer can classify
 * the field on shape alone.
 */
export const DIAGNOSTICS_ARGS_HASH_REDACTED = "low_entropy_args_redacted";

/** A projected scalar. Deliberately not `unknown`: a tool returns flat scalars. */
export type DiagnosticsToolFieldValue = string | number | boolean | null;

/** One projected row: an allowlisted, redacted, bounded set of flat scalars. */
export type DiagnosticsToolRow = Record<string, DiagnosticsToolFieldValue>;

/**
 * The APPROVED audit metadata for one invocation (ADR-004 §4). Deliberately a
 * separate object from the evidence so a caller that persists an audit row
 * cannot accidentally persist a row value: nothing here is, or is derived from,
 * a column's contents except through a non-reversible hash.
 */
export interface DiagnosticsToolAudit {
  toolId: string;
  /** The areas the tool declares, recorded even when the check denied. */
  areasChecked: AdminPermissionArea[];
  authOutcome: "allowed" | "denied";
  /** Set on every non-success exit; null on success. */
  failureReason: DiagnosticsToolFailureReason | null;
  /**
   * sha256 of the canonical JSON of the ACCEPTED arguments — never the arguments
   * themselves. Null when the arguments never parsed (there is no canonical form
   * of input we refused to understand, and hashing the raw input would put
   * operator-supplied text into a durable row).
   *
   * `DIAGNOSTICS_ARGS_HASH_REDACTED` when the accepted arguments carry a
   * low-entropy term the entry declared (see `lowEntropyArgKeys` in `define.ts`):
   * the digest would be recoverable by offline enumeration, which ADR-004 §4 does
   * not permit a durable row to carry.
   */
  argsHash: string | null;
  /** sha256 of the canonical JSON of the projected rows. Null when none were produced. */
  resultHash: string | null;
  rowCount: number;
  /** UTF-8 byte length of the projected rows as canonical JSON. */
  byteCount: number;
  /** Wall-clock milliseconds spent inside the read-only transaction. */
  durationMs: number;
  /**
   * 0-based provider round this invocation belonged to, or `-1` when it belonged
   * to no round — an invocation refused before a round was ever opened. `-1` is
   * recorded honestly rather than coerced to 0: a durable row claiming round 0 for
   * a call that never entered the loop would misrepresent the audit trail.
   */
  roundIndex: number;
  observedAt: string;
}

/** A tool invocation that produced evidence. */
export interface DiagnosticsToolSuccess {
  schemaVersion: typeof DIAGNOSTICS_TOOL_SCHEMA_VERSION;
  status: "ok";
  toolId: string;
  /** Operator-facing label from the registry — server-owned, never model text. */
  label: string;
  rows: DiagnosticsToolRow[];
  /**
   * True when the tool's own row limit clipped the result. The model is told, so
   * it reports "the first N" rather than presenting a partial set as complete.
   */
  truncated: boolean;
  /**
   * The entry's server-owned sentence describing WHAT it searched (AID-6A, #2375).
   * Copied from the registry, never derived from a row or an argument.
   *
   * It exists because an empty result plus `not_found` reads as "there is no
   * evidence of this" — a wider claim than a tool with a narrow fixed filter is
   * entitled to make. A correlation entry, for instance, filters on a closed set of
   * audit categories that does NOT partition the same way the admin permission areas
   * do, so nothing-matched has to be qualified by the scope or the model will narrate
   * domain-wide absence from a category-shaped hole.
   */
  evidenceScope?: string;
  observedAt: string;
  audit: DiagnosticsToolAudit;
}

/** A tool invocation that produced nothing, and why. */
export interface DiagnosticsToolFailure {
  schemaVersion: typeof DIAGNOSTICS_TOOL_SCHEMA_VERSION;
  status: "error";
  toolId: string;
  reason: DiagnosticsToolFailureReason;
  /** Plain-English, safe to show an operator verbatim. NEVER echoes input. */
  message: string;
  /** Set only when the failure is a permission one (ADR-002 §3 partial answers). */
  missingAreas?: AdminPermissionArea[];
  observedAt: string;
  audit: DiagnosticsToolAudit;
}

export type DiagnosticsToolResult =
  | DiagnosticsToolSuccess
  | DiagnosticsToolFailure;

/**
 * Operator/model-facing copy for every failure reason. Centralised so the UI
 * (AID-7) and the evidence block render the SAME words the executor enforces,
 * and so no message can accidentally interpolate caller input.
 */
export const DIAGNOSTICS_TOOL_FAILURE_MESSAGES: Record<
  DiagnosticsToolFailureReason,
  string
> = {
  unknown_tool: "That diagnostics tool does not exist.",
  invalid_args:
    "The arguments for that diagnostics tool were not valid, so it was not run.",
  call_budget_exhausted:
    "This diagnostics session has used its allowance of tool calls. Ask a narrower question to start a fresh session.",
  metering_unavailable:
    "Diagnostics usage cannot be recorded at the moment, so no tool was run.",
  actor_unresolved:
    "Your account could not be found, so no diagnostics tool was run.",
  actor_blocked:
    "Your admin account is currently locked out, so no diagnostics tool was run.",
  actor_read_failed:
    "Your permissions could not be checked just now, so no diagnostics tool was run.",
  permission_denied:
    "You do not have view access to the area this diagnostics tool reads, so it was not run.",
  database_not_configured:
    "The read-only diagnostics database credential is not configured, so no tool was run.",
  database_role_unsafe:
    "The diagnostics database credential does not have the restricted, read-only privileges this feature requires, so no tool was run.",
  database_grants_missing:
    "The diagnostics database credential is missing one or more required read-only grants, so no tool was run.",
  query_failed:
    "That diagnostics read did not complete (it may have taken too long), so no results are available.",
  evidence_unavailable:
    "The system evidence that diagnostics tool reads could not be gathered just now, so no results are available.",
  result_too_large:
    "That diagnostics read returned more data than this feature is allowed to handle. Ask a narrower question.",
  redaction_failed:
    "That diagnostics read could not be safely prepared, so its results were discarded.",
  audit_unavailable:
    "That diagnostics read could not be recorded in the audit trail, so its results were discarded.",
  internal_error:
    "Something went wrong running that diagnostics read, so no results are available.",
};
