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
  READ_ONLY_SEAM_EXEMPTION_IDS,
  isReadOnlySeamExemptionId,
  type DiagnosticsReadOnlySeamDeclaration,
} from "./read-only-seam-exemptions";
import {
  DIAGNOSTICS_ARGS_HASH_REDACTED,
  DIAGNOSTICS_TOOL_BOUNDS,
  DIAGNOSTICS_TOOL_ID_PATTERN,
  type DiagnosticsConsentRecordKind,
  type DiagnosticsRelatedRecordRef,
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
   * with `RESERVED_ARGUMENT_KEYS` scanned first, at EVERY depth, because zod is
   * not total on its own: a `z.record(...)` still drops a `JSON.parse`-created
   * `__proto__` silently, and so does any shape when the key is non-enumerable.
   * A nested or record-shaped argument therefore needs no guard of its own. The
   * shapes zod does and does not refuse are measured, not assumed — see
   * `NESTED_RESERVED_KEY_CASES` in `__tests__/registry.test.ts`.
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
   * The KIND of record this entry is about, when it is about exactly one and the
   * kind is the same on every invocation (AID-7a, #2785). With
   * `consentRecordArgKey` it is what lets the consent gate ask "did the operator
   * include THIS record?" rather than "is consent on at all".
   *
   * IT IS NOT ONLY FOR PERSONAL-DATA ENTRIES, and the rename from
   * `personalDataRecordKind` is the point rather than a tidy-up (#2785 review).
   * `invoke.ts` gate 4b bounds every entry that reads ONE NAMED RECORD to the
   * records this investigation covers, whether or not the row it returns carries a
   * person's details: `booking_audit_history` projects nothing but stable codes and
   * an instant, and it is still per-record evidence about an identified subject. The
   * personal-details TICK is what stays specific to `surfacesPersonalData`.
   */
  consentRecordKind?: DiagnosticsConsentRecordKind;
  /**
   * The ACCEPTED argument key that names that record — `bookingId`, `memberId`,
   * `paymentId`, `recordId`. It must be a key the entry's own `argsSchema` accepts
   * as a required exact identifier, because the consent gate reads the value out of
   * the parsed arguments; a key the schema does not produce means every invocation
   * refuses.
   */
  consentRecordArgKey?: string;
  /**
   * For an entry whose record KIND IS ITSELF AN ARGUMENT: the argument that selects
   * it, and the closed map from every value that argument accepts to the consent
   * kind that value means (#2785 review).
   *
   * Three entries need it — `finance_audit_history` and `membership_audit_history`
   * take `{subject, recordId}`, and `xero_invoice_linkage` takes
   * `{localModel, localId}` — and a single static `consentRecordKind` cannot express
   * any of them: declaring one kind would gate every subject as that kind, which
   * silently refuses the others and, worse, would check the wrong ledger entry.
   *
   * THE MAP IS EXHAUSTIVE OVER THE ARGUMENT'S OWN ENUM, and `defineDiagnosticsTool`
   * throws unless it is. A value the investigation cannot express is declared `null`
   * — a deliberate, reviewed "no consent kind covers this subject" — and gate 4b
   * REFUSES it rather than treating an unmapped value as unconstrained. That is the
   * whole reason the map is a closed declaration rather than a lookup with a
   * fallback: a new subject added to a schema fails the registry at definition time
   * until somebody decides which record kind it is.
   */
  consentRecordKindByArg?: {
    /** The accepted argument key that carries the discriminant. */
    argKey: string;
    /** Every value that key accepts, mapped to a kind or to `null` (refuse). */
    kinds: Readonly<Record<string, DiagnosticsConsentRecordKind | null>>;
  };
  /**
   * The PROJECTED fields of this entry that name a directly linked record (AID-7a,
   * #2785). The consent ledger follows exactly these and nothing else, after a
   * successful authorised call whose own record the operator selected.
   *
   * DECLARED RATHER THAN DERIVED, because deriving it from a field name would be a
   * guess about server data made at runtime. This is a statement by the tool author,
   * reviewed with the entry: this projected column carries a real identifier of this
   * kind. Only declare a column whose value is the linked record's own primary key —
   * a human-facing reference, a provider reference or a compound label is not one,
   * and would enter the ledger as a record that can never be read.
   *
   * IT REQUIRES `surfacesPersonalData` (#2785 review). Absorbing widens the set of
   * records the personal-data entries may then read, so the entry doing the widening
   * has to be one that was itself reviewed as a consent surface. An entry that
   * declared itself non-personal could otherwise seed member ids into the ledger
   * without any reviewer ever having weighed that as a consent decision.
   */
  relatedRecordRefs?: readonly DiagnosticsRelatedRecordRef[];
  /**
   * The REVIEWED reason an entry that takes a record-id-shaped required argument
   * nonetheless declares no consent record (#2785 delta review).
   *
   * `defineDiagnosticsTool` detects "this entry is asked about one identified thing"
   * from the argument schema itself (see `assertConsentRecordScopeIsDeclared`) and
   * refuses to define an entry that neither names its record, declares itself a
   * search, nor carries one of these. So the record scope no longer rests on an
   * author remembering the rule: it rests on the entry answering the question, one
   * way or another, before the registry will build.
   *
   * IT IS A REASON RATHER THAN A FLAG, because the only honest exemption is one
   * somebody argued in the diff. There is exactly one at this head, the finance
   * webhook timeline, and its argument is a PROVIDER event reference — a Stripe event
   * id, a Xero resource id or a correlation key. That is not a platform record id, not
   * something an operator can select, and not a kind the investigation ledger can
   * hold, so declaring a kind for it would refuse every invocation while pretending to
   * be a gate.
   *
   * It may not travel with a consent record (the entry would then be gated anyway,
   * and the two declarations would disagree) or with `operatorOnly` (gate 4a governs a
   * search, so there is nothing to be exempt from).
   */
  consentRecordExemption?: string;
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
   * TRUE for an entry that SEARCHES — one that takes a search term and returns a
   * bounded LIST of people, bookings or payments rather than evidence about one
   * named record (AID-7a, #2785).
   *
   * WHY IT IS A DECLARATION AND NOT A JUDGEMENT AT CALL TIME. Choosing WHICH PERSON
   * to investigate is an operator act. A search entry is the only way to turn a
   * name, a phone number or an amount into a record id, and `booking_search`'s
   * `lodge_nights` arm returns a whole lodge-window of bookings — bulk personal
   * data. The model reaches tool arguments from evidence text an attacker can write
   * (a booking note, a guest name, an internet-banking reference), so "the model
   * decides who to look up" is a capability that has to be granted, not assumed.
   *
   * WHAT IT ACTUALLY GATES, after the owner's Q2 decision (#2378, 11 Aug 2026):
   * an `operator_action` invocation always may (it would render to the operator's
   * browser and send nothing to the provider), and the MODEL may only when the
   * operator ticked the per-request people-search box. Unticked, `invoke.ts` refuses
   * with `operator_action_required`. The tick is per request and never persisted.
   * NB: the `operator_action` channel is TEST-ONLY today (AID-8 F5) — no production
   * caller passes it and the record picker it describes is not built — so in
   * practice this gate refuses whenever the model asks unticked.
   *
   * Withholding the DEFINITION from the model is courtesy on top of this, never the
   * control — `definitions.ts` is explicit that withholding "may never become the
   * only thing standing between a caller and a tool".
   */
  operatorOnly?: boolean;
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
  /**
   * HOW THIS ENTRY STANDS WITH THE READ-ONLY SEAM (#2786). Required, because the
   * whole point is that an author cannot decline to answer.
   *
   * A `select_only_sql` entry is read-only because PostgreSQL refuses it anything
   * else. A `server_owned` entry runs on the application's own full-privilege
   * connection, so it is read-only only if it reads inside
   * `withBoundedReadOnlyTransaction` — or if what it reads through is a declared
   * exemption. TypeScript refuses to compile a new `server_owned` entry that says
   * neither, and `assertReadOnlySeamDeclarationIsComplete` refuses at definition time
   * to register one whose declaration is unsatisfiable. Between them, "somebody
   * forgot" stops being a way this guarantee can be lost.
   */
  readOnlySeam: DiagnosticsReadOnlySeamDeclaration;
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
  /** See the spec fields: which record ADR-004 §1's per-invocation gate is about. */
  consentRecordKind?: DiagnosticsConsentRecordKind;
  consentRecordArgKey?: string;
  consentRecordKindByArg?: {
    argKey: string;
    kinds: Readonly<Record<string, DiagnosticsConsentRecordKind | null>>;
  };
  relatedRecordRefs?: readonly DiagnosticsRelatedRecordRef[];
  /** See the spec field: why this record-id-taking entry names no consent record. */
  consentRecordExemption?: string;
  /** See the spec field: a record SEARCH, gated on an operator act or their tick. */
  operatorOnly?: boolean;
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
  /**
   * Carried onto the entry, not left behind on the spec, so the registry contract
   * tests can assert the property across EVERY registered entry rather than across
   * the specs a test file happens to import.
   */
  readOnlySeam: DiagnosticsReadOnlySeamDeclaration;
}

export type DiagnosticsToolEntry =
  | DiagnosticsSelectOnlyToolEntry
  | DiagnosticsServerOwnedToolEntry;

/**
 * Keys that must be REFUSED before the schema runs, because zod is not total on
 * its own. Measured on zod 4.5.4 (#3313): `z.object({}).strict()` now REJECTS
 * `{"__proto__":{"x":1}}` alongside `constructor`, `prototype` and `toString` —
 * a change, since zod 4.4.3 SUCCEEDED with `data: {}` and reported no
 * unrecognized key. But `z.record(...)` still accepts and drops it
 * (`z.record(z.string(), z.string())` on `{"__proto__":"s"}` yields `{}`), at any
 * depth and inside array elements, while KEEPING `constructor` and `prototype`.
 *
 * TWO HOLES SURVIVE, not one. The record shape is the reachable one — what a
 * `filters` argument takes, and what the next tool packs need. The second is
 * that zod's new strict rejection is ENUMERABILITY-DEPENDENT: measured on 4.5.4,
 * a reserved key defined with `enumerable: false` is accepted and dropped by
 * `z.object({}).strict()` too. `JSON.parse` cannot produce one, so it is not
 * reachable from the provider path — but it is why the scan below walks
 * `Object.getOwnPropertyNames` rather than `Object.keys`, and anyone trimming
 * this guard on the strength of "zod handles strict objects now" would reopen
 * it. Both are pinned by tests; neither is inferred.
 *
 * So the guard stays TOTAL rather than trimmed to match one version: what
 * `.strict()` refuses today is not a contract zod has made about tomorrow. The
 * registry's test table is written as a measurement for the same reason, and is
 * what reported this change.
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
 *    guarantee this file claims. Measured on zod 4.5.4:
 *    `z.object({ a: z.object({ b: z.record(z.string(), z.string()) }).strict() }).strict()`
 *    accepts `JSON.parse('{"a":{"b":{"__proto__":{"polluted":"yes"},"status":"open"}}}')`
 *    and returns `{"a":{"b":{"status":"open"}}}` — so the canonical hash of the
 *    ACCEPTED arguments is byte-identical to the same call without the key, which is
 *    exactly the audit-integrity defect this guard exists to remove, reproduced three
 *    levels down. The same holds for a record inside an array. A `filters` record was
 *    the concrete nested shape considered for the AID-6B/6C packs. Scanning everything
 *    also means an author adding a nested or record-shaped argument inherits the
 *    guarantee without having to know it exists. The example is deliberately a
 *    RECORD nested in `.strict()` objects rather than the nested `.strict()` object
 *    it once was: zod 4.5 began rejecting that case itself, which left both this
 *    example and the matching test rows unable to exercise the traversal (#3313).
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
 * THE DEFINITION-TIME INVARIANT for ADR-004 §1 (AID-7a, #2785).
 *
 * It throws, at module-body time, before `DIAGNOSTICS_TOOLS` can be assembled — so a
 * registry that breaks it does not start, rather than starting with a gate that
 * silently passes. That is the right trade for this rule: every consequence of
 * getting it wrong is a personal-data read escaping the consent gate, and a
 * diagnostics feature that refuses to boot is a far better outcome than one that
 * quietly stops asking.
 *
 * THE RULE: an entry that surfaces personal data must say WHICH record it is about
 * (a kind + the accepted argument key that names it), or declare itself a SEARCH
 * (`operatorOnly`). Those are the only two shapes the gates in `invoke.ts` can
 * enforce — one is "did the operator include this record", the other is "did the
 * operator allow searching at all" — and an entry that is neither would have no gate
 * at all.
 *
 * THE KIND MAY BE STATIC OR PER-INVOCATION, and exactly one of the two (#2785
 * review). `consentRecordKind` is the same kind every time; `consentRecordKindByArg`
 * is for the entries whose subject is chosen by an argument, and it must be
 * EXHAUSTIVE over that argument's own declared enum so a subject cannot be added to
 * a schema without a consent decision being made about it. An unmapped value is not
 * a possibility left open here; it is a boot failure.
 *
 * The remaining clauses close the ways a declaration could be present and useless:
 * a related-record declaration with no record of its own has no source to derive
 * FROM, a related-record declaration on an entry nobody reviewed as a consent
 * surface would widen the ledger without that review, and an entry that is both a
 * search and a per-record read is a contradiction about which gate governs it.
 */
function assertConsentDeclarationIsComplete<TArgs>(
  spec: DiagnosticsToolSpec<TArgs>,
): void {
  const hasKind =
    spec.consentRecordKind !== undefined ||
    spec.consentRecordKindByArg !== undefined;
  const hasRecord = hasKind && spec.consentRecordArgKey !== undefined;
  const isSearch = spec.operatorOnly === true;

  // The half-declaration is checked FIRST because it is the more specific
  // diagnosis: an author who wrote one of the pair gets told which half is missing,
  // rather than the general "this entry cannot be gated" that is also true of it.
  if (hasKind !== (spec.consentRecordArgKey !== undefined)) {
    throw new Error(
      `Diagnostics tool ${spec.id} declares only half of its consent record: a record kind (consentRecordKind or consentRecordKindByArg) and consentRecordArgKey travel together.`,
    );
  }
  if (
    spec.consentRecordKind !== undefined &&
    spec.consentRecordKindByArg !== undefined
  ) {
    throw new Error(
      `Diagnostics tool ${spec.id} declares BOTH a fixed consentRecordKind and a per-argument one. An entry states its record kind exactly one way, or the gate has two answers to choose between.`,
    );
  }
  if (spec.consentRecordKindByArg !== undefined) {
    assertConsentRecordKindMapIsExhaustive(spec);
  }
  assertConsentRecordScopeIsDeclared(spec, hasRecord, isSearch);
  if (spec.surfacesPersonalData && !hasRecord && !isSearch) {
    throw new Error(
      `Diagnostics tool ${spec.id} declares surfacesPersonalData but names neither the record it is about (a record kind + consentRecordArgKey) nor operatorOnly: true. ADR-004 §1's consent gate cannot be applied to it.`,
    );
  }
  if (isSearch && hasRecord) {
    throw new Error(
      `Diagnostics tool ${spec.id} declares itself operatorOnly AND names a single consent record. A search and a per-record read are governed by different gates; an entry is one or the other.`,
    );
  }
  if (spec.relatedRecordRefs !== undefined) {
    if (!hasRecord) {
      throw new Error(
        `Diagnostics tool ${spec.id} declares relatedRecordRefs but names no record of its own, so there is nothing for the consent ledger to derive FROM.`,
      );
    }
    if (spec.relatedRecordRefs.length === 0) {
      throw new Error(
        `Diagnostics tool ${spec.id} declares an empty relatedRecordRefs. Omit it rather than declaring nothing.`,
      );
    }
    if (!spec.surfacesPersonalData) {
      throw new Error(
        `Diagnostics tool ${spec.id} declares relatedRecordRefs but not surfacesPersonalData. Absorbing widens the records the personal-data entries may read, so only an entry reviewed as a consent surface may do it.`,
      );
    }
  }
}

/**
 * THE DEFINITION-TIME INVARIANT for the read-only seam (AID-7b, #2786).
 *
 * It throws at module-body time for the same reason the consent assert does: a
 * `server_owned` entry that reaches the database outside the seam is running on the
 * application's full-privilege connection with nothing but authorship standing
 * between it and a write, and a diagnostics feature that refuses to boot is a far
 * better outcome than one that quietly stops being read-only.
 *
 * THE RULE: an entry either threads its own reads through the seam, or names the
 * declared exemptions it reads through, or both. What is refused is the entry that
 * says NEITHER — because that entry reaches the database in some third way, and the
 * third way is precisely what nobody has reviewed.
 *
 * WHY THE ID CHECK MATTERS AS MUCH AS THE PRESENCE CHECK. A declaration naming
 * `"legacy-thing"` would otherwise satisfy the rule while pointing at nothing: the
 * table would stop being a closed world the moment a typo or a deleted row made an
 * id stale, and it would fail SILENTLY, which is the failure mode this whole
 * mechanism exists to remove. So an unknown id is a boot failure that names the ids
 * that do exist.
 *
 * TYPES ARE THE FIRST GATE AND THIS IS THE SECOND. `readOnlySeam` is a required
 * field, so a new entry cannot COMPILE without an answer; this assert is what makes
 * the answer have to be a true one at runtime, including for the JavaScript callers
 * and dynamic registrations TypeScript never sees.
 *
 * THE THIRD GATE IS A SOURCE CENSUS, AND IT IS NOT OPTIONAL — say so plainly,
 * because of what this assert CANNOT do (#2786 review). It can check that an
 * exemption id exists, is not repeated, and is not an empty list; the exemption arm
 * is therefore genuinely closed, and each row names a module and symbol a test then
 * reads. It cannot check `threadsOwnReads` at all. That flag is an assertion by an
 * author about code this function never sees, and it is the arm most entries carry.
 * What can falsify it is the tree-wide census in
 * `__tests__/read-only-transaction.test.ts`, which strips comments from every module
 * in `packs/` and fails if any of them names `prisma`. Remove that census and
 * `threadsOwnReads: true` becomes an unverified claim.
 */
function assertReadOnlySeamDeclarationIsComplete<TArgs>(
  spec: DiagnosticsToolSpec<TArgs>,
): void {
  if (spec.source !== "server_owned") return;
  const declaration = spec.readOnlySeam;
  const exemptions = declaration.exemptions;

  if (exemptions !== undefined && exemptions.length === 0) {
    throw new Error(
      `Diagnostics tool ${spec.id} declares an empty readOnlySeam.exemptions. Omit it rather than declaring nothing, so "relies on no exemption" and "declared an empty list" cannot be read as the same statement.`,
    );
  }
  if (!declaration.threadsOwnReads && exemptions === undefined) {
    throw new Error(
      `Diagnostics tool ${spec.id} declares readOnlySeam.threadsOwnReads: false and names no exemption, so it claims to reach its evidence in some way neither the seam nor the exemption table covers. Thread its reads through withBoundedReadOnlyTransaction, or declare the exemption it relies on.`,
    );
  }
  for (const id of exemptions ?? []) {
    if (!isReadOnlySeamExemptionId(id)) {
      throw new Error(
        `Diagnostics tool ${spec.id} names readOnlySeam exemption "${id}", which is not in READ_ONLY_SEAM_EXEMPTIONS. Declared exemptions are: ${READ_ONLY_SEAM_EXEMPTION_IDS.join(", ")}. Add a reviewed row with its reason, or thread the read through the seam.`,
      );
    }
  }
  const duplicates = (exemptions ?? []).filter(
    (id, index) => (exemptions ?? []).indexOf(id) !== index,
  );
  if (duplicates.length > 0) {
    throw new Error(
      `Diagnostics tool ${spec.id} names readOnlySeam exemption "${duplicates[0]}" more than once. Each reliance is stated once.`,
    );
  }
}

/**
 * A record id as this schema mints one — a cuid — and a string that is emphatically
 * not one. Together they are how the assert below RECOGNISES a record-id argument
 * without trusting its name.
 *
 * The pair is the whole detector: a key whose own schema accepts the first and
 * refuses the second is a key that takes an exact identifier rather than free text,
 * a code, a date or a number. A name heuristic (`*Id`) was the alternative and is
 * strictly weaker — `eventRef`, `bookingRef`, `subjectKey` all escape it, and the
 * point of this assert is the entry nobody thought about.
 */
const CONSENT_RECORD_ID_PROBE = "clz0000000abcdefghijklmno";
const NOT_A_RECORD_ID_PROBE = "not a record id!";

/**
 * The REQUIRED arguments of this entry that take an exact identifier, or `null` when
 * the schema cannot be introspected at all.
 *
 * `required` is deliberate: an entry whose identifier is OPTIONAL is not an entry
 * about one record — it must have defined behaviour without it, which is what the
 * five audit-correlation entries have (`{window, requestId?}` reads a window of
 * events, and the request id is a correlation filter inside it, not the subject).
 * A key that is required, and whose own schema takes an identifier and nothing else,
 * is the entry saying what it is asked about.
 *
 * `null` means "this schema is not a plain object" — a union, a transform, something
 * a future entry may reach for. The caller treats that as UNKNOWN and fail-closed
 * rather than as "no record", because a detector that silently stops detecting is
 * exactly the failure this assert exists to prevent.
 */
function requiredRecordIdArgKeys<TArgs>(
  spec: DiagnosticsToolSpec<TArgs>,
): string[] | null {
  const schema: unknown = spec.argsSchema;
  if (!(schema instanceof z.ZodObject)) return null;
  const shape: unknown = schema.shape;
  if (typeof shape !== "object" || shape === null) return null;
  const keys: string[] = [];
  for (const [key, field] of Object.entries(shape)) {
    if (!(field instanceof z.ZodType)) return null;
    // Optional, defaulted or nullable: the entry works without it, so it is not the
    // record the entry is ABOUT.
    if (field.safeParse(undefined).success) continue;
    if (!field.safeParse(CONSENT_RECORD_ID_PROBE).success) continue;
    if (field.safeParse(NOT_A_RECORD_ID_PROBE).success) continue;
    keys.push(key);
  }
  return keys;
}

/**
 * AN ENTRY THAT IS ASKED ABOUT ONE IDENTIFIED THING MUST SAY SO (#2785 delta review).
 *
 * `assertConsentDeclarationIsComplete` covers the entries that surface personal data.
 * It could not cover the rest, and the rest are where the hole was: the five
 * per-record entries that return only codes, amounts and instants shipped with
 * `surfacesPersonalData: false` and no consent declaration at all, so gate 4b skipped
 * them and the model could read the refund history of a payment the ledger had just
 * refused. The fix lane bound those five by hand — and a hand fix binds the entries
 * that exist, not the next one somebody writes. Nothing failed for
 * `booking_hold_state({ bookingId })`, projecting nothing but status codes, declaring
 * neither flag: it would define cleanly, be offered on every request, and be readable
 * for any booking id the model could name. The registry census could not catch it
 * either — it filters on entries that DECLARE a record, so an entry that never had a
 * declaration never enters the comparison.
 *
 * So the rule is enforced from the ARGUMENT SCHEMA, which no author can forget to
 * write: an entry with a required argument that takes an exact identifier must either
 * name the record (a kind + `consentRecordArgKey`), declare itself a search
 * (`operatorOnly`, governed by gate 4a instead), or carry a reviewed
 * `consentRecordExemption` saying why the thing it names is not a record an operator
 * could ever have included. It throws at module-body time, before `DIAGNOSTICS_TOOLS`
 * is assembled, for the reason the sibling assert does: a diagnostics feature that
 * refuses to boot is a far better outcome than one that quietly stops asking.
 */
function assertConsentRecordScopeIsDeclared<TArgs>(
  spec: DiagnosticsToolSpec<TArgs>,
  hasRecord: boolean,
  isSearch: boolean,
): void {
  const recordIdKeys = requiredRecordIdArgKeys(spec);
  const exemption = spec.consentRecordExemption;

  if (exemption !== undefined) {
    if (typeof exemption !== "string" || exemption.trim().length === 0) {
      throw new Error(
        `Diagnostics tool ${spec.id} declares an empty consentRecordExemption. The exemption is the reviewed REASON this entry's identifier is not a record an operator could include; there is no value in a blank one.`,
      );
    }
    if (hasRecord) {
      throw new Error(
        `Diagnostics tool ${spec.id} declares BOTH a consent record and a consentRecordExemption. It is gated by the record it names, so the exemption is stale — remove it.`,
      );
    }
    if (isSearch) {
      throw new Error(
        `Diagnostics tool ${spec.id} declares operatorOnly AND a consentRecordExemption. A search is governed by the channel gate, so there is nothing for the exemption to excuse.`,
      );
    }
    if (recordIdKeys !== null && recordIdKeys.length === 0) {
      throw new Error(
        `Diagnostics tool ${spec.id} declares a consentRecordExemption but takes no required argument that accepts an exact identifier, so it is exempt from nothing. Remove it rather than leaving a declaration that stopped being true.`,
      );
    }
    return;
  }

  if (hasRecord || isSearch) return;
  if (recordIdKeys !== null && recordIdKeys.length === 0) return;

  throw new Error(
    `Diagnostics tool ${spec.id} is asked about one identified thing — ${
      recordIdKeys === null
        ? "its argument schema is not a plain object, so this cannot be checked"
        : `its required argument(s) ${recordIdKeys.join(", ")} accept an exact identifier`
    } — but names no consent record, declares no operatorOnly search, and carries no consentRecordExemption. ADR-004 §1 bounds every per-record read to the operator's investigation, whether or not the rows carry personal data, so declare a record kind + consentRecordArgKey, or say in a consentRecordExemption why what it names is not a record an operator could include.`,
  );
}

/**
 * The per-argument kind map must cover the argument's OWN declared enum, exactly
 * (#2785 review).
 *
 * It reads `inputSchema` rather than the Zod schema because `inputSchema` is the
 * hand-written JSON Schema this repository already requires to be reviewable in the
 * diff, and it is the same object the provider is handed — so "the model can send
 * this value" and "this value is mapped" are checked against one list rather than
 * two that can drift. A discriminant with no closed enum is refused outright: an
 * open-ended kind selector cannot be mapped exhaustively, so it cannot be gated.
 */
function assertConsentRecordKindMapIsExhaustive<TArgs>(
  spec: DiagnosticsToolSpec<TArgs>,
): void {
  const declaration = spec.consentRecordKindByArg;
  if (!declaration) return;
  const property: unknown = spec.inputSchema.properties[declaration.argKey];
  const values =
    typeof property === "object" &&
    property !== null &&
    "enum" in property &&
    Array.isArray((property as { enum: unknown }).enum)
      ? ((property as { enum: unknown[] }).enum.filter(
          (value): value is string => typeof value === "string",
        ) as string[])
      : null;
  if (!values || values.length === 0) {
    throw new Error(
      `Diagnostics tool ${spec.id} declares consentRecordKindByArg on "${declaration.argKey}", but that argument's inputSchema declares no closed string enum. A kind selector that is not a closed list cannot be mapped exhaustively.`,
    );
  }
  const mapped = Object.keys(declaration.kinds);
  const missing = values.filter((value) => !mapped.includes(value));
  const extra = mapped.filter((value) => !values.includes(value));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `Diagnostics tool ${spec.id} declares a consentRecordKindByArg map that does not match the accepted values of "${declaration.argKey}"${
        missing.length > 0 ? `; unmapped: ${missing.join(", ")}` : ""
      }${extra.length > 0 ? `; mapped but not accepted: ${extra.join(", ")}` : ""}. Every value the schema accepts needs a decided kind, or an explicit null.`,
    );
  }
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
  assertConsentDeclarationIsComplete(spec);
  assertReadOnlySeamDeclarationIsComplete(spec);

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
    consentRecordKind: spec.consentRecordKind,
    consentRecordArgKey: spec.consentRecordArgKey,
    consentRecordKindByArg: spec.consentRecordKindByArg,
    relatedRecordRefs: spec.relatedRecordRefs,
    consentRecordExemption: spec.consentRecordExemption,
    operatorOnly: spec.operatorOnly,
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
    readOnlySeam: spec.readOnlySeam,
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
