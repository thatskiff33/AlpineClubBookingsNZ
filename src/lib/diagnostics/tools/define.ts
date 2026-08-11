/**
 * AI Diagnostics — how a tool is DEFINED (AID-5, #2374; extended by AID-6A,
 * #2375; contracts in ADR-001 §2, ADR-002 §2/§4, ADR-007).
 *
 * Extracted from `registry.ts` when the first tool pack arrived, for one
 * mechanical reason: a pack module has to call `defineDiagnosticsTool`, and
 * `registry.ts` has to import the pack to assemble `DIAGNOSTICS_TOOLS`. Leaving
 * the definer in `registry.ts` would make that a module cycle whose
 * `defineDiagnosticsTool` is `undefined` at the moment a pack's module body runs.
 * So this file owns the DEFINITION contract and `registry.ts` owns the TABLE.
 * Nothing else moved, and nothing was relaxed on the way.
 *
 * THE ONE INVARIANT THAT MATTERS IS UNCHANGED: the model never supplies SQL, and
 * it never supplies an evidence source. A registry entry pairs a FIXED evidence
 * source with a FIXED projection, FIXED row/byte ceilings and a FIXED
 * admin-permission requirement. The model chooses an entry by id and supplies
 * arguments that a `.strict()` Zod schema has already accepted. There is no code
 * path — here, in `registry.ts`, or in `invoke.ts` — that concatenates caller text
 * into SQL or lets a caller nominate what is read.
 *
 * TWO EVIDENCE SOURCES, ONE GATE CHAIN (AID-6A). `source` is a closed,
 * server-declared discriminant on the entry itself — never an argument:
 *
 *  - `select_only_sql` — the AID-5 shape. One fixed parameterised statement, run
 *    as the dedicated SELECT-only role inside a READ ONLY transaction under a
 *    statement timeout and the executor's own SQL row cap.
 *  - `server_owned` — a fixed, first-party, read-only CALCULATION the application
 *    already owns and already exposes to admins (diagnostics readiness, the
 *    monthly budget/usage panel, the cron health classification, the deployed
 *    bundle's identity). It exists because #2375 requires the CANONICAL readiness
 *    answer rather than a second one that can drift from the admin screen — and
 *    because readiness has to stay reportable in exactly the case where the
 *    SELECT-only credential is itself the blocker, which a SQL entry cannot do.
 *
 * A `server_owned` entry is NOT a way around the gates. Registry lookup, loop
 * budget, fresh AND-ed authorization, `.strict()` argument parsing with the
 * reserved-key scan, the metering circuit breaker, the fixed projection with
 * redaction and per-field caps, the row/byte ceilings, truncation honesty and the
 * approved-metadata audit row all apply to it identically (`invoke.ts` gates 1-5
 * and 8-10). The only difference is WHERE the rows come from at gate 7, and the
 * only gate it skips is the SELECT-only credential check that does not govern it.
 * What it may never be is a write, a provider call, or anything that takes a
 * caller-supplied source: `readEvidence` is a server-owned function reference in
 * this repository's own source, resolved at review time, not at call time.
 */

import { z } from "zod";

import type { AdminPermissionArea } from "@/lib/admin-permissions";

import {
  DIAGNOSTICS_ARGS_HASH_REDACTED,
  DIAGNOSTICS_TOOL_BOUNDS,
  DIAGNOSTICS_TOOL_ID_PATTERN,
  type DiagnosticsToolRow,
} from "./types";

/**
 * The JSON Schema shape handed to the provider. Hand-written rather than derived
 * so the bytes sent to Anthropic are reviewable in the diff, and
 * `additionalProperties: false` is part of the type so no entry can forget it.
 */
export interface DiagnosticsToolInputSchema {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties: false;
}

/**
 * Where a registered tool's evidence comes from. Server-declared, never an
 * argument — a closed list, so a registry entry cannot invent a third kind and the
 * contract tests can assert that every entry names one of these two.
 */
export const DIAGNOSTICS_TOOL_EVIDENCE_SOURCES = [
  "select_only_sql",
  "server_owned",
] as const;

/**
 * One row of raw, unprojected evidence as a source hands it over. Identical for
 * both sources on purpose — `project` is then the SAME allowlisting step whether
 * the row came from `pg` or from a first-party calculation, so neither source has
 * a projection contract of its own to get wrong.
 */
export type DiagnosticsToolRawRow = Record<string, unknown>;

/** What every tool author writes, whatever the entry's evidence source. */
interface DiagnosticsToolSpecBase<TArgs> {
  id: string;
  /** Operator-facing label. Server-owned; used in the evidence block and audit summary. */
  label: string;
  /** Model-facing description. Server-owned text; never operator or model input. */
  description: string;
  /** Areas required at `view`, AND-ed, re-checked fresh on every invocation. */
  requiredAreas: readonly AdminPermissionArea[];
  /**
   * `.strict()` so an unknown argument is a REJECTION, not something ignored —
   * with `RESERVED_ARGUMENT_KEYS` scanned first, at EVERY depth, because `.strict()`
   * alone lets a `JSON.parse`-created `__proto__` through by silently dropping it,
   * and it does so one nested object down just as readily as at the top level. A
   * nested or `z.record(...)` argument therefore needs no guard of its own.
   */
  argsSchema: z.ZodType<TArgs>;
  inputSchema: DiagnosticsToolInputSchema;
  /** Column allowlist, applied to every row. Must return flat scalars only. */
  project: (row: DiagnosticsToolRawRow) => DiagnosticsToolRow;
  rowLimit: number;
  byteLimit: number;
  /** True when a projected field can identify a person (ADR-004 §1 opt-in). */
  surfacesPersonalData: boolean;
  /**
   * Argument keys whose ACCEPTED value is LOW-ENTROPY — a value an offline reader
   * of the audit metadata could enumerate and match against an unkeyed digest.
   * When a parsed argument object carries any of them, the audit row records
   * `DIAGNOSTICS_ARGS_HASH_REDACTED` instead of `sha256(canonical args)`.
   *
   * WHY PER-KEY RATHER THAN PER-ENTRY. `member_search` is one entry with four
   * arms, and only three of them are enumerable: a name PREFIX is three letters, a
   * mobile is six to fifteen digits, and an email address is guessable from a name
   * and a domain, while `recordId` is a cuid with no candidate space worth walking.
   * `booking_search` splits the same way — an eight-character reference derived
   * from a cuid TIMESTAMP block and a lodge-night triple are both walkable, while
   * its two `recordId` arms are not. Redacting a whole entry would throw away the
   * digests that have audit value — "the same admin looked this same member up
   * twice" — to protect the arms that do not, so the declaration names the KEYS and
   * the redaction is decided per invocation from the arguments that were actually
   * accepted.
   *
   * A KEY WITH A SCHEMA `.default()` MUST NEVER BE DECLARED. Zod materialises a
   * defaulted key on every accepted object, so declaring one redacts every arm of
   * the entry including the high-entropy ones. `booking_search.window` is the live
   * case and the pack's contract test pins that it is not declared.
   *
   * IT IS NOT A KEYED HASH, deliberately. An HMAC would preserve correlation for
   * the low-entropy arms, but it would also introduce a secret whose rotation
   * silently breaks correlation across the rotation boundary and whose leak
   * retro-actively reverses every row ever written — a durable liability bought for
   * a nice-to-have. Omission has no key to leak.
   */
  lowEntropyArgKeys?: readonly string[];
  /**
   * Server-owned sentence naming WHAT this entry searched, rendered into the
   * evidence block above the rows (AID-6A, #2375).
   *
   * Required in spirit for any entry whose filter is NARROWER than the question an
   * operator will ask it: without it, an empty result carries the state `not_found`
   * — "Nothing matched, so there is no evidence of this to report." — which is a
   * claim about the whole domain rather than about the slice the entry actually
   * read. The correlation entries are the live case: their audit-category filters do
   * not partition the same way the admin permission areas do, so a membership
   * question can land on rows recorded under `admin` or `lodge` and come back empty.
   * Never caller text; the renderer neutralises it regardless.
   */
  evidenceScope?: string;
}

/** A tool that reads the database as the dedicated SELECT-only role. */
export interface DiagnosticsSelectOnlyToolSpec<TArgs>
  extends DiagnosticsToolSpecBase<TArgs> {
  source: "select_only_sql";
  /** One fixed statement. No semicolon — the executor wraps it in a LIMIT subquery. */
  sql: string;
  /** Parsed args to positional parameters. Must be pure and never build SQL. */
  bind: (args: TArgs) => readonly unknown[];
}

/** A tool that reads a fixed, first-party, read-only server calculation. */
export interface DiagnosticsServerOwnedToolSpec<TArgs>
  extends DiagnosticsToolSpecBase<TArgs> {
  source: "server_owned";
  /**
   * The fixed evidence source. Read-only, first-party, and named directly in this
   * repository's source — never selected by an argument, never a provider call.
   *
   * It may return MORE rows than `rowLimit`; the executor slices and reports
   * truncation exactly as it does for a SQL read, so a source cannot make a
   * partial answer look complete. It should REFUSE by rejecting (which the
   * executor reports as `evidence_unavailable`) rather than by returning a row
   * that claims something it could not establish.
   */
  readEvidence: (args: TArgs) => Promise<readonly DiagnosticsToolRawRow[]>;
}

export type DiagnosticsToolSpec<TArgs> =
  | DiagnosticsSelectOnlyToolSpec<TArgs>
  | DiagnosticsServerOwnedToolSpec<TArgs>;

/**
 * The parse-and-bind step, exposed as ONE function so the executor can never
 * reach an evidence source with arguments the schema did not accept. `args` is the
 * parsed, canonical object — used only to compute the audit `argsHash`, never
 * stored.
 *
 * The success arms carry the SAME discriminant as the entry, so the executor
 * cross-checks the two rather than assuming they agree (see `invoke.ts` gate 7).
 */
export type DiagnosticsToolArgsBinding =
  | {
      ok: true;
      source: "select_only_sql";
      args: unknown;
      params: readonly unknown[];
    }
  | {
      ok: true;
      source: "server_owned";
      args: unknown;
      /** The evidence read, already closed over the ACCEPTED arguments. */
      read: () => Promise<readonly DiagnosticsToolRawRow[]>;
    }
  | { ok: false };

interface DiagnosticsToolEntryBase {
  id: string;
  label: string;
  description: string;
  requiredAreas: readonly AdminPermissionArea[];
  inputSchema: DiagnosticsToolInputSchema;
  parseArgs: (raw: unknown) => DiagnosticsToolArgsBinding;
  project: (row: DiagnosticsToolRawRow) => DiagnosticsToolRow;
  rowLimit: number;
  byteLimit: number;
  surfacesPersonalData: boolean;
  /** See the spec field: keys whose accepted value must not reach a durable digest. */
  lowEntropyArgKeys?: readonly string[];
  evidenceScope?: string;
}

/**
 * A registered SELECT-only tool as the executor sees it. `sql` stays readable
 * because the contract tests and the executor both need it; the only way to obtain
 * PARAMETERS is `parseArgs`, which closes over the typed schema and the typed
 * `bind` together.
 */
export interface DiagnosticsSelectOnlyToolEntry extends DiagnosticsToolEntryBase {
  source: "select_only_sql";
  sql: string;
}

/**
 * A registered server-owned tool as the executor sees it.
 *
 * THE ENTRY exposes no handle on its evidence source at all — deliberately, and
 * stricter than the SQL arm, which keeps `sql` readable: the only way to read
 * through a registry entry is the closure `parseArgs` returns, so an entry cannot be
 * used to reach a source with unparsed input or with no authorization behind it. A
 * contract test pins `"readEvidence" in entry === false`.
 *
 * WHAT THAT DOES NOT SAY, because an earlier version of this comment overstated it:
 * the source FUNCTIONS themselves are ordinary module exports in
 * `packs/support-evidence.ts` — the pack's own contract tests assert on their raw
 * rows, which is where the "every row is raw, the projection allowlists it" property
 * is actually proved. So a future server-side caller could import one and read it
 * with none of the ten gates. Two things keep that honest rather than latent: the
 * pack modules are marked `server-only`, so no such import can reach a browser
 * bundle, and `support-evidence.ts` states in its own docblock that reading a source
 * directly is outside the substrate's guarantees. The guarantee here is about the
 * ENTRY, not about the reachability of the function.
 */
export interface DiagnosticsServerOwnedToolEntry
  extends DiagnosticsToolEntryBase {
  source: "server_owned";
}

export type DiagnosticsToolEntry =
  | DiagnosticsSelectOnlyToolEntry
  | DiagnosticsServerOwnedToolEntry;

/**
 * Keys that must be REFUSED before the schema runs, because `.strict()` is not
 * total on its own. Measured against this repo's zod 4.4.3:
 * `z.object({}).strict().safeParse(JSON.parse('{"__proto__":{"x":1}}'))` succeeds
 * with `data: {}` — the key is silently STRIPPED and no unrecognized-key issue is
 * reported. `constructor`, `prototype`, `toString` and friends are all correctly
 * rejected; only `__proto__` slips, because `JSON.parse` defines it as an ordinary
 * own property and zod's own key walk never surfaces it.
 *
 * Silently repairing an argument is the contract breach, not the pollution: the
 * arguments reaching here are the model's `tool_use` input, and `argsHash` is
 * ADR-004's durable record of what was ACCEPTED. A dropped key makes a call that
 * sent `{"__proto__": …}` hash byte-identically to one that sent `{}`, so the audit
 * row cannot tell them apart — and a tool with a `z.record(...)` filters field
 * would silently run a different query than the model asked for.
 *
 * AID-4 refuses the same keys, at the same point, for the same reason
 * (`page-context/parse.ts` → `RESERVED_KEYS`). That list is module-private there
 * deliberately — exporting it would offer callers a second door into a parser whose
 * contract is total rejection — so this is a second, deliberate declaration rather
 * than a shared import. The two channels agree on the verdict — a reserved key is a
 * REJECTION, never something to strip — and this one is the stricter of the two in
 * how far it looks: AID-4 scans the top level and the `filters` object it knows its
 * own payload carries, whereas the scan below is TOTAL over every depth of whatever
 * arrives (see `hasReservedArgumentKey`).
 */
const RESERVED_ARGUMENT_KEYS: readonly string[] = [
  "__proto__",
  "constructor",
  "prototype",
];

/**
 * Own-property scan of the RAW arguments, before the schema runs — the only point
 * at which `__proto__` is still visible. TOTAL by construction, for four reasons
 * worth stating because each one was a way to get this wrong:
 *
 *  - EVERY DEPTH, arrays included. A top-level-only scan does not deliver the
 *    guarantee this file claims. Measured on zod 4.4.3:
 *    `z.object({ filters: z.object({ status: z.string().optional() }).strict() }).strict()`
 *    accepted `JSON.parse('{"filters":{"__proto__":{"polluted":"yes"},"status":"open"}}')`
 *    and returned `{"filters":{"status":"open"}}` — so the canonical hash of the
 *    ACCEPTED arguments was byte-identical to the same call without the key, which is
 *    exactly the audit-integrity defect this guard exists to remove, reproduced one
 *    level down. A `filters` object is not a hypothetical shape either: it is the one
 *    the later tool packs (AID-6B/6C) need. Scanning everything also means an author
 *    adding a nested or record-shaped argument inherits the guarantee without having
 *    to know it exists.
 *  - `Object.getOwnPropertyNames`, not `for…in`: it sees a non-enumerable own
 *    property too, and it does not walk a prototype chain.
 *  - ITERATIVE, not recursive. The arguments are provider-deserialised JSON whose
 *    nesting depth the caller chose, and a recursive walk would turn a deep payload
 *    into a stack overflow inside a security guard.
 *  - `getOwnPropertyDescriptor` rather than a property read, and a `WeakSet` of
 *    visited objects. `raw` is typed `unknown`: a getter must never be INVOKED by the
 *    guard that is meant to vet the value, and a cyclic object (which JSON cannot
 *    carry, but a caller can build) must terminate rather than spin.
 */
function hasReservedArgumentKey(raw: unknown): boolean {
  const pending: unknown[] = [raw];
  const seen = new WeakSet<object>();
  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value !== "object" || value === null) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    for (const key of Object.getOwnPropertyNames(value)) {
      if (RESERVED_ARGUMENT_KEYS.includes(key)) return true;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor && "value" in descriptor) pending.push(descriptor.value);
    }
  }
  return false;
}

/**
 * Erase one typed spec into a registry entry. The single `as TArgs` inside is
 * sound because it is applied to the OUTPUT of `argsSchema.safeParse`, i.e. to a
 * value the schema itself has just validated — and it is applied ONCE, in the one
 * place both arms share, so neither `bind` nor `readEvidence` can be reached with
 * anything else.
 */
export function defineDiagnosticsTool<TArgs>(
  spec: DiagnosticsToolSpec<TArgs>,
): DiagnosticsToolEntry {
  const shared = {
    id: spec.id,
    label: spec.label,
    description: spec.description,
    requiredAreas: spec.requiredAreas,
    inputSchema: spec.inputSchema,
    project: spec.project,
    rowLimit: spec.rowLimit,
    byteLimit: spec.byteLimit,
    surfacesPersonalData: spec.surfacesPersonalData,
    lowEntropyArgKeys: spec.lowEntropyArgKeys,
    evidenceScope: spec.evidenceScope,
  };

  /** The one gate both arms go through before their own source is reachable. */
  const accept = (raw: unknown): { ok: true; args: TArgs } | { ok: false } => {
    if (hasReservedArgumentKey(raw)) return { ok: false };
    const parsed = spec.argsSchema.safeParse(raw);
    if (!parsed.success) return { ok: false };
    return { ok: true, args: parsed.data as TArgs };
  };

  if (spec.source === "select_only_sql") {
    return {
      ...shared,
      source: "select_only_sql",
      sql: spec.sql,
      parseArgs: (raw) => {
        const accepted = accept(raw);
        if (!accepted.ok) return { ok: false };
        return {
          ok: true,
          source: "select_only_sql",
          args: accepted.args,
          params: spec.bind(accepted.args),
        };
      },
    };
  }

  return {
    ...shared,
    source: "server_owned",
    parseArgs: (raw) => {
      const accepted = accept(raw);
      if (!accepted.ok) return { ok: false };
      return {
        ok: true,
        source: "server_owned",
        args: accepted.args,
        // Closed over the ACCEPTED arguments, so the source cannot be reached with
        // anything the schema refused — and not invoked here, so an authorization
        // failure downstream still costs no read.
        read: () => spec.readEvidence(accepted.args),
      };
    },
  };
}

/**
 * The durable `argsHash` for one invocation: the digest, or the redaction
 * sentinel when the ACCEPTED arguments carry a key the entry declared
 * low-entropy (ADR-004 §4 — a durable hash must be NON-REVERSIBLE).
 *
 * IT LIVES HERE, BESIDE THE DECLARATION, so the decision cannot drift from the
 * field that drives it, and `invoke.ts` has one call rather than a condition it
 * could later evaluate on the wrong side of a branch.
 *
 * PRESENCE, NOT TRUTHINESS. The test is `key in args` — an explicitly supplied
 * empty or falsy term still went through the schema and still narrows the
 * candidate space, so redaction must not depend on the VALUE. A non-object
 * argument (no entry has one today) redacts as well: a bare string argument is
 * the low-entropy case by construction, so the fail-closed answer is the safe
 * default rather than "no keys found, hash it".
 */
export function diagnosticsAuditArgsHash(
  entry: Pick<DiagnosticsToolEntry, "lowEntropyArgKeys">,
  args: unknown,
  digest: (args: unknown) => string,
): string {
  const lowEntropyKeys = entry.lowEntropyArgKeys ?? [];
  if (lowEntropyKeys.length === 0) return digest(args);
  if (typeof args !== "object" || args === null) {
    return DIAGNOSTICS_ARGS_HASH_REDACTED;
  }
  const present = Object.getOwnPropertyNames(args);
  const carriesLowEntropyTerm = lowEntropyKeys.some((key) =>
    present.includes(key),
  );
  return carriesLowEntropyTerm ? DIAGNOSTICS_ARGS_HASH_REDACTED : digest(args);
}

/**
 * SQL fragments a registry entry may never contain. This is a CONTRACT TEST
 * helper, not a runtime sanitiser — the runtime guarantee is that the SQL is
 * server-owned and the role cannot write. It exists so a future entry that
 * pastes in a `DELETE`, a `pg_read_file` or a locking clause fails `npm test` at
 * the point of review rather than at a deployment.
 */
export const FORBIDDEN_TOOL_SQL_PATTERNS: readonly RegExp[] = [
  /\binsert\b/i,
  /\bupdate\b/i,
  /\bdelete\b/i,
  /\btruncate\b/i,
  /\bdrop\b/i,
  /\bcreate\b/i,
  /\balter\b/i,
  /\bgrant\b/i,
  /\brevoke\b/i,
  /\bcopy\b/i,
  /\bvacuum\b/i,
  /\bpg_read_file\b/i,
  /\bpg_read_binary_file\b/i,
  /\bpg_ls_dir\b/i,
  /\blo_import\b/i,
  /\blo_export\b/i,
  /\bpg_sleep\b/i,
  /\bpg_advisory/i,
  /\bdblink\b/i,
  /\bfor\s+update\b/i,
  /\bfor\s+share\b/i,
  /\bset\s+(?:local|session)\b/i,
  // A COMMENT would break the executor's LIMIT wrapper, not bypass it: `--` at the
  // end of an entry's SQL comments out the wrapper's own
  // `) AS diagnostics_tool_result LIMIT ($n)` and the statement fails to parse. It
  // is banned here so that failure is caught at review time rather than the first
  // time an operator asks the question that reaches the tool.
  /--/,
  /\/\*/,
];

/** True when the id is a well-formed registry key. */
export function isValidDiagnosticsToolId(toolId: string): boolean {
  return (
    toolId.length > 0 &&
    toolId.length <= DIAGNOSTICS_TOOL_BOUNDS.toolIdMaxChars &&
    DIAGNOSTICS_TOOL_ID_PATTERN.test(toolId)
  );
}
