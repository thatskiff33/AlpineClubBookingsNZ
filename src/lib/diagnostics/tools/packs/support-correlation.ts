/**
 * AI Diagnostics — AID-6A support pack, part 2: BOUNDED, SANITIZED AUDIT
 * CORRELATION (#2375, epic #2369).
 *
 * PERMISSION, and the one rule that shapes this whole file: correlation requires
 * `support:view` AND the affected domain's own `area:view`. #2375 also forbids
 * doing that with one tool and a model-chosen `domain` argument — an argument
 * cannot decide an authorization rule, because ADR-002 authorizes BEFORE arguments
 * are parsed. So there is one FIXED entry per domain, each declaring its own area
 * set and its own closed category filter, and the executor AND-s them freshly on
 * every invocation.
 *
 *   diagnostics.system_event_correlation      support
 *   diagnostics.booking_event_correlation     support + bookings
 *   diagnostics.membership_event_correlation  support + membership
 *   diagnostics.finance_event_correlation     support + finance
 *   diagnostics.lodge_event_correlation       support + lodge
 *
 * THE CATEGORY SETS ARE NO LONGER WRITTEN OUT HERE (#2581). Each entry derives
 * its own set from `AUDIT_CATEGORY_CORRELATION_DOMAIN` in `audit-categories.ts`,
 * which maps every canonical category to exactly one of these five domains. That
 * makes disjointness and total coverage structural rather than assertions checked
 * after the fact: a new category cannot be added without classifying it, and it
 * cannot be classified into two entries. It also fixed a real hole — `family` was
 * written by 27 production sites and named in NO set here, so family evidence was
 * readable through no correlation tool at all.
 *
 * A caller holding only `support:view` is offered — and can only run — the system
 * entry. Asking for `diagnostics.finance_event_correlation` without `finance:view`
 * is denied server-side with `permission_denied` and the missing area named, and the
 * denied rows are not reachable through the entry they can run: the category sets are
 * disjoint and a row carries AT MOST ONE category, so no `payment` or `xero` row can
 * arrive through the system entry. That is the acceptance criterion "missing permission
 * is a denial, not worked around with source inference", enforced by the category
 * filters rather than by discipline.
 *
 * "AT MOST ONE" IS EXACT, AND IT COSTS COVERAGE RATHER THAN CONTAINMENT.
 * `AuditLog.category` is `String?` with no default, and `audit.ts` writes the column
 * only when a caller supplies one — so a row with NO category exists and is common. The
 * executable census of this repository's production audit writes
 * (`scripts/audit/audit-writer-census.ts`, pinned by
 * `src/lib/__tests__/audit-writer-census.test.ts`) counts 419 write sites, of which
 * 82 pass no category: 69 `logAudit`, 11 `createAuditLog`, 2 hand-built Prisma
 * writes, and none through `createStructuredAuditLog`. They include money-adjacent
 * ones — subscription-billing settings/retry/mark-family/unmark-family/reconcile, the
 * subscription charge confirm, all three member-credit adjustment steps, fee
 * configuration and the family login-holder change — plus booking-policy edits, bulk
 * communications and deletion-request decisions.
 * `WHERE "category" = ANY ($1)` is NULL for such a row, so it is returned by NONE of the
 * five entries. The containment argument is unharmed (a row nobody can reach is not a way
 * around a denial); what is harmed is any reading of an empty result as an absence, which
 * is why every `evidenceScope` and every description now names this gap in as many words.
 * See `DIAGNOSTICS_CORRELATION_CATEGORY_SETS` for why the alternative — routing the null
 * case to the system entry — is an owner decision rather than a fix. Giving those 82
 * sites a category at the source is #2581's second child; this file's job is to keep
 * the gap declared until then.
 *
 * ONE HONEST QUALIFICATION, because "the domain requirement is what stands between a
 * support-only admin and any domain evidence" would be too strong a claim. The `admin`
 * category is this platform's catch-all for ADMINISTRATOR-INITIATED operations across
 * every domain (see `AUDIT_CATEGORY_CORRELATION_DOMAIN`), so the system entry does
 * report that a member merge, a lifecycle decision or an internet-banking settings
 * change occurred — as an action code, a severity, an entity TYPE and an instant, and
 * nothing else. That is not an escalation: `support` is already the area that governs
 * `/admin/audit-log`, where the same administrator reads those same rows in full.
 * What the domain requirement buys is the DOMAIN'S OWN events — the payment, the
 * booking, the account change itself.
 *
 * THE GRANT. This is the ONLY relation AID-6A adds to the `SELECT_GRANTS` allowlist,
 * and it is granted BY COLUMN, not by table:
 *
 *   GRANT SELECT ("id","action","category","severity","outcome","entityType",
 *                 "requestId","createdAt") ON public."AuditLog"
 *
 * `AuditLog` is exactly the shape #2375 says must not be granted wholesale: it
 * carries `ipAddress`, `userAgent`, `summary`, `details`, arbitrary `metadata` JSON,
 * and three member-identifying columns. A column grant makes the projection a
 * SERVER-ENFORCED boundary rather than an application one — as the diagnostics role,
 * `SELECT "ipAddress" FROM "AuditLog"` is refused by PostgreSQL itself (42501), so a
 * future tool, a future projection bug, or a hand-written query in a psql session
 * with that credential cannot reach it. `database.ts`'s privilege probe verifies the
 * granted COLUMNS against this same allowlist and refuses the role if a wider grant
 * appears, so drift towards a table-level grant fails readiness closed.
 *
 * WHAT IS PROJECTED, and why each field is safe:
 *  - `eventRef`   the audit row's own id. #2375 lists "evidence reference" as an
 *                 approved correlation field, and it is what makes the ORDER BY
 *                 total (so the audit `resultHash` is stable for identical evidence).
 *  - `action`     the stable server-defined action code.
 *  - `category`, `severity`, `outcome`  closed server-side classifications.
 *  - `entityType` WHAT kind of record the event concerned, never WHICH one.
 *  - `requestId`  the correlation key that ties one operator action to the events it
 *                 produced. THE ONE FIELD HERE THAT IS NOT SERVER-DEFINED — see
 *                 `projectRequestId`, which is why it is re-validated on the way out.
 *  - `occurredAtUtc`  ISO-8601 UTC, formatted in SQL (a `Date` is not a flat scalar).
 *
 * WHAT IS NEVER PROJECTED, and there is no argument that can change it:
 * `entityId`, `memberId`, `actorMemberId`, `subjectMemberId`, `targetId`, `summary`,
 * `details`, `metadata`, `ipAddress`, `userAgent`. `entityId` is the deliberate one
 * to explain: it is often a member id, and this pack's permission set is
 * system-plus-domain rather than a per-record investigation with ADR-004's PII
 * opt-in. Per-record evidence — the member, the booking, the payment — is AID-6B
 * (#2376) and AID-6C (#2377) work, under their own area permission and their own
 * privacy review. So every entry here reports `surfacesPersonalData: false` and
 * means it.
 *
 * BOUNDS. One primary correlation input (an exact request id, optional) plus a fixed
 * approved window from a closed enum; newest first; twenty-two events (measured, see
 * `CORRELATION_ROW_LIMIT`); no free-text log search, no `LIKE`, no wildcard, no
 * model-chosen column, ordering or filter.
 *
 * UNTRUSTED TEXT, and one field where "server-defined code" was simply wrong. Seven
 * of the eight projected values are server-defined: the row id, the action code, the
 * three classifications, the entity type and a SQL-formatted instant. `requestId` is
 * not. `audit.ts` → `getAuditRequestContext` sets it from the request's own
 * `x-request-id` / `x-correlation-id` HEADER, with no length cap, no character class
 * and no sanitisation, and stores it verbatim — so any signed-in member can write it
 * (a profile edit or a notification-preference change is category `account`; a lodge
 * arrive/depart is `lodge`; a PIN login or a password reset is `security`, which is
 * the entry a support-only admin gets). It is therefore treated as attacker-chosen
 * text, and defended in two places:
 *
 *  1. HERE, on the way out: `projectRequestId` re-validates it against the same
 *     character class and length the tool's own INPUT accepts, and projects a stable
 *     code instead when it does not conform. That removes both the field-forgery
 *     payload and the 200-character-per-row byte cost that let a member push a
 *     correlation result over its own ceiling and deny the tool for everyone.
 *  2. IN THE RENDERER: `render.ts` neutralises every value (angle brackets and
 *     quotes stripped, wrapper token defused, whitespace collapsed) and QUOTES it, so
 *     a value cannot forge the block delimiter, an attribute, a new row, or — the gap
 *     this pack found — extra `field=value` pairs inside its own row.
 *
 * Both layers stay, deliberately: (1) is specific to this column's provenance and (2)
 * is what the later packs' free text (member names, booking notes, payment
 * narrations) will actually depend on.
 */

import "server-only";

import { z } from "zod";

import type { AdminPermissionArea } from "@/lib/admin-permissions";
import {
  AUDIT_CORRELATION_DOMAIN_AREAS,
  auditCategoriesForCorrelationDomain,
  type AuditCategory,
} from "@/lib/audit-categories";

import { defineDiagnosticsTool, type DiagnosticsToolEntry } from "../define";

/**
 * The approved correlation windows, and the minutes each means. A closed enum
 * rather than a number, so "one primary input and a fixed approved window" is a
 * type, not a validation rule someone can loosen. 7 days is the maximum #2375 sets.
 */
const CORRELATION_WINDOWS = {
  "15m": 15,
  "1h": 60,
  "6h": 360,
  "24h": 1_440,
  "7d": 10_080,
} as const;

type CorrelationWindow = keyof typeof CORRELATION_WINDOWS;

const CORRELATION_WINDOW_KEYS = Object.keys(
  CORRELATION_WINDOWS,
) as [CorrelationWindow, ...CorrelationWindow[]];

/** The default when the model does not choose: #2375's recommended 1 hour. */
const DEFAULT_CORRELATION_WINDOW: CorrelationWindow = "1h";

/**
 * An exact request/trace identifier. EXACT, never a pattern: the predicate is `=`,
 * so there is no `LIKE`, no wildcard and nothing to enumerate with, whatever this
 * accepts. The shape is deliberately permissive about WHICH id scheme (cuid, uuid,
 * and a handful of hand-set references all appear in `AuditLog.requestId`) and
 * strict about length and character class, so a blank, a huge blob, or anything
 * carrying whitespace or quotes is refused before it becomes an audit `argsHash`.
 */
const REQUEST_ID = z
  .string()
  .min(3)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);

const correlationArgsSchema = z
  .object({
    window: z.enum(CORRELATION_WINDOW_KEYS).default(DEFAULT_CORRELATION_WINDOW),
    requestId: REQUEST_ID.optional(),
  })
  .strict();

type CorrelationArgs = z.infer<typeof correlationArgsSchema>;

const correlationInputSchema = {
  type: "object" as const,
  properties: {
    window: {
      type: "string",
      enum: [...CORRELATION_WINDOW_KEYS],
      description:
        "How far back to look, ending now. Defaults to 1h. 7d is the maximum.",
    },
    requestId: {
      type: "string",
      description:
        "Optional. An exact request or trace identifier to correlate on. Must still fall inside the window.",
    },
  },
  additionalProperties: false as const,
};

/**
 * The window predicate is ALWAYS applied, including when a request id is supplied,
 * and that is a performance control rather than a policy one: `AuditLog` has no
 * index on `requestId`, so a request-id-only predicate would be a sequential scan
 * of the platform's whole access trail against a 5-second statement timeout. Every
 * category this pack filters on IS indexed together with `createdAt`
 * (`@@index([category, createdAt])`), so the window is what keeps the read cheap.
 * The consequence is documented in the tool descriptions: widen the window if the
 * event you are correlating is older than an hour.
 *
 * `$3::text IS NULL OR "requestId" = $3::text` keeps the entry to ONE statement with
 * a fixed parameter arity — the alternative (two SQL texts chosen by an argument)
 * would be a query shape the caller selects, which is the thing this substrate
 * exists to refuse.
 *
 * EVERY TIME EXPRESSION IS TIMEZONE-INDEPENDENT, deliberately. `AuditLog."createdAt"`
 * is a naive `timestamp` holding UTC, so `now()` (a `timestamptz`) is converted to a
 * UTC `timestamp` with `AT TIME ZONE 'UTC'` before the comparison, and `to_char` is
 * applied to the plain column rather than to a `timestamptz`. Both matter: comparing
 * `timestamp` against `timestamptz` directly, or formatting a `timestamptz`, is
 * resolved using the SESSION's `TimeZone`, so on a deployment that sets
 * `Pacific/Auckland` the window would shift by 12-13 hours and the projected instant
 * would be local time labelled `Z`. The executor also pins `TimeZone` to UTC per
 * transaction; this statement does not rely on that.
 *
 * ONE SQL TEXT FOR ALL FIVE ENTRIES, and the category set travels as a BOUND
 * PARAMETER (`$1::text[]`) rather than being formatted into the statement. The
 * category lists are module constants, not caller text, so interpolating them would
 * not have been an injection — but this file would then be the one place in the
 * substrate that builds SQL with string concatenation, and "it is safe because of
 * where the values come from" is an argument a future edit can quietly invalidate.
 * `bind` closes over the ENTRY's own categories, never over an argument, so the
 * permission set and the category filter remain fixed together at review time.
 */
const CORRELATION_SQL = `SELECT
  a."id" AS event_ref,
  a."action" AS action_code,
  a."category" AS category,
  a."severity" AS severity,
  a."outcome" AS outcome,
  a."entityType" AS entity_type,
  a."requestId" AS request_id,
  pg_catalog.to_char(a."createdAt", 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS occurred_at_utc
FROM public."AuditLog" a
WHERE a."category" = ANY ($1::text[])
  AND a."createdAt" >= (pg_catalog.now() AT TIME ZONE 'UTC') - (($2)::int * INTERVAL '1 minute')
  AND ($3::text IS NULL OR a."requestId" = $3::text)
ORDER BY a."createdAt" DESC, a."id" ASC`;

/**
 * The one field on this row that is not a server-defined code, re-validated on the
 * way out and replaced by a stable code when it does not conform.
 *
 * `AuditLog.requestId` is verbatim `x-request-id` header text (see this file's
 * docblock), `String?` with no cap in the schema, and nothing normalises it on the
 * way in. Projecting it raw cost two things, both measured on this branch:
 *
 *  - FIELD FORGERY. The evidence renderer joins `key=value` pairs with `"; "`. A
 *    member sending `req-1; severity=critical; outcome=failure;
 *    action=payment.refund_failed` produced a row line carrying two `severity=`, two
 *    `outcome=` and two `action=` assignments — the second naming a payment event
 *    that never happened, inside a membership-correlation result. `render.ts` now
 *    quotes every value, which closes it generally; this closes it at the source as
 *    well, because a correlation identifier has a known shape and a value that is not
 *    one is not evidence.
 *  - A DENIAL OF THE EVIDENCE. `boundedScalar` caps a projected string at 200
 *    characters, so ~28 planted rows of 200-character ids pushed a full result past
 *    its byte ceiling and the executor refused the lot with `result_too_large` — for
 *    every admin, for that domain and window, with no argument to narrow.
 *
 * The class and the 128-character cap are the SAME ones `REQUEST_ID` accepts as
 * input, which is what makes the trade lossless: an id this rejects is an id an
 * operator could never have supplied to filter on. The sentinel deliberately contains
 * characters the class forbids, so no real identifier can collide with it.
 */
const PROJECTABLE_REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

/**
 * Exported so the contract test can prove the one property that makes it safe: the
 * tool's own input schema REFUSES this string, so it can never collide with a real
 * identifier and a model cannot turn round and correlate on it.
 */
export const DIAGNOSTICS_UNPARSEABLE_REQUEST_ID = "(unparseable)";

function projectRequestId(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value);
  return PROJECTABLE_REQUEST_ID.test(text)
    ? text
    : DIAGNOSTICS_UNPARSEABLE_REQUEST_ID;
}

/**
 * Twenty-two events, not the fifty #2375 allows as a maximum, and not the thirty an
 * earlier revision claimed rendered whole. MEASURED, because the arithmetic that
 * justified thirty was wrong in both directions:
 *
 *  - The evidence block is capped at 8 000 characters and carries ~1 000 characters
 *    of fixed framing (opening tag, the untrusted-data header, the evidence-state
 *    line, the tool line, the scope line, the notices and the rows header) before a
 *    single row. Real action codes in this repository run to 60 characters
 *    (`booking_request.member_whole_lodge_approve_idempotent_replay`), so a row line
 *    of this shape is ~260-280 characters, not the 230 the old comment assumed.
 *    Thirty rows rendered to exactly 8 000 characters with three rows silently gone
 *    and a fourth cut mid-field.
 *
 *    TWENTY-TWO, AND MEASURED WITH THE `scope:` LINE THIS TIME. Two revisions of this
 *    comment claimed twenty-four rendered "whole with room to spare"; both measured a
 *    block this pack never emits, because the executor attaches every entry's
 *    `evidenceScope` to every result (`invoke.ts`) and those lines run to 627
 *    characters. Re-measured per entry WITH them, at a 24-character request id: the
 *    system entry lists 22 of 24 at a mix of today's real action codes, and every entry
 *    lists 22 of 24 when each row carries the longest real 60-character code
 *    (`booking_request.member_whole_lodge_approve_idempotent_replay`). At 22 all five
 *    render whole in both cases — the worst of them at 7 718 of the 8 000 characters.
 *
 *    THE CEILING IS THEREFORE A MEASUREMENT, NOT A PREFERENCE, and it moves when the
 *    framing does: it dropped from 24 to 22 when the absent-category disclosure was
 *    added to every scope line, which is the correct direction of travel. What it does
 *    NOT have to survive is a hostile width — a member can plant 128-character request
 *    ids and clip any ceiling. That case is safe because the renderer reports its own
 *    clip in the machine-readable state as well as the prose
 *    (`renderToolResultEvidence`): a cap that reads as a flag is acceptable, a cap that
 *    reads as a complete answer is not.
 *  - `canonicalStringify` is `JSON.stringify(value, null, 2)`, so a projected row
 *    costs ~310 bytes rather than ~230. The ceiling below is the measured cost of
 *    twenty-four rows at the widest values this projection can now produce (a
 *    128-character request id, a 200-character action code), with margin.
 *
 * The renderer is honest either way now — it drops whole rows and says how many of
 * how many it listed — so this ceiling is about giving an operator a complete answer
 * rather than about preventing a silent loss.
 */
const CORRELATION_ROW_LIMIT = 22;

/**
 * The byte ceiling, measured rather than estimated. `canonicalStringify` is
 * `JSON.stringify(…, null, 2)`, so a row costs one indented line per field, and gate 9
 * REFUSES a result over this rather than trimming it. Measured at the 22-row ceiling of
 * this projected shape:
 *
 *  - 7 302 bytes at typical widths (a 24-character request id, today's real action
 *    codes).
 *  - 9 590 bytes with a request id at the 128-character cap this projection enforces.
 *  - 13 115 bytes at the WIDEST the projection can emit — `action_code` at
 *    `fieldValueMaxChars` (200). Nothing bounds the length of a new audit action code,
 *    and real ones already reach 60 characters, so that is the number the ceiling has
 *    to clear; a ceiling of 12 288 clears the first two and fails this one. (The same
 *    three at the old 24-row ceiling were 7 953, 10 449 and 14 307, so the ceiling was
 *    not the binding constraint on the row limit — the rendered block was.)
 *
 * Two contract tests serialise the entry's own projected shape at its own row limit and
 * fail if this is unachievable — the assertion that was missing when 30 rows of
 * 200-character request ids could exceed the old 12 288.
 */
const CORRELATION_BYTE_LIMIT = 16_384;

function defineCorrelationTool(input: {
  id: string;
  label: string;
  requiredAreas: readonly AdminPermissionArea[];
  categories: readonly AuditCategory[];
  description: string;
  /** What this entry covers, in plain English, for the block's `scope:` line. */
  scope: string;
}): DiagnosticsToolEntry {
  return defineDiagnosticsTool<CorrelationArgs>({
    id: input.id,
    source: "select_only_sql",
    label: input.label,
    description: input.description,
    requiredAreas: input.requiredAreas,
    // The searched scope, rendered above the rows. It is what keeps an empty result
    // from reading as domain-wide absence, and it has to carry BOTH ways that happens:
    //
    //  - MISMATCH. The audit `category` taxonomy is not the admin-area partition (see
    //    `DIAGNOSTICS_CORRELATION_CATEGORY_SETS`), so a membership question can
    //    legitimately return nothing here while the events sit in another entry's set.
    //  - ABSENT. A row written with no category at all is matched by no entry's filter,
    //    and 82 production call sites write that way. Naming it is the fail-closed remedy:
    //    without the sentence, a Finance Officer asking about a subscription reconcile
    //    gets zero rows, the state `not_found` ("there is no evidence of this to
    //    report"), and prose steering them to the other four entries — none of which can
    //    see the row either — so the model narrates an authoritative absence for a money
    //    event the platform did record.
    //
    // Both sentences cost block characters, which is why the per-entry prose above is
    // kept tight: the widest of these scope lines and a full result have to fit 8 000
    // characters together, and the row ceiling is set by that measurement rather than
    // the other way round (see `CORRELATION_ROW_LIMIT`).
    evidenceScope: `${input.scope} It searched only the audit categories ${input.categories.join(", ")}. Nothing matched means nothing in THOSE categories matched in the window — not that nothing happened. A row recorded with NO category is matched by no correlation tool at all, so an empty result does not rule that out either.`,
    argsSchema: correlationArgsSchema,
    inputSchema: correlationInputSchema,
    sql: CORRELATION_SQL,
    // Three parameters, always, in this order — the ENTRY's own category set (a
    // module constant, never an argument), the window in minutes (resolved from the
    // closed enum, never a caller-supplied number), and the exact request id or an
    // explicit null. The executor appends the row cap as `$4`.
    bind: (args) => [
      [...input.categories],
      CORRELATION_WINDOWS[args.window],
      args.requestId ?? null,
    ],
    project: (row) => ({
      eventRef: String(row.event_ref ?? ""),
      action: String(row.action_code ?? ""),
      category: row.category === null ? null : String(row.category ?? ""),
      severity: row.severity === null ? null : String(row.severity ?? ""),
      outcome: row.outcome === null ? null : String(row.outcome ?? ""),
      entityType: row.entity_type === null ? null : String(row.entity_type ?? ""),
      requestId: projectRequestId(row.request_id),
      occurredAtUtc: String(row.occurred_at_utc ?? ""),
    }),
    rowLimit: CORRELATION_ROW_LIMIT,
    byteLimit: CORRELATION_BYTE_LIMIT,
    surfacesPersonalData: false,
  });
}

export const DIAGNOSTICS_SYSTEM_CORRELATION_TOOL_ID =
  "diagnostics.system_event_correlation";
export const DIAGNOSTICS_BOOKING_CORRELATION_TOOL_ID =
  "diagnostics.booking_event_correlation";
export const DIAGNOSTICS_MEMBERSHIP_CORRELATION_TOOL_ID =
  "diagnostics.membership_event_correlation";
export const DIAGNOSTICS_FINANCE_CORRELATION_TOOL_ID =
  "diagnostics.finance_event_correlation";
export const DIAGNOSTICS_LODGE_CORRELATION_TOOL_ID =
  "diagnostics.lodge_event_correlation";

/**
 * The audit categories each entry may read — DERIVED, not listed (#2581).
 *
 * `AUDIT_CATEGORY_CORRELATION_DOMAIN` in `audit-categories.ts` maps every
 * canonical category to exactly one of these five domains, so the two properties
 * this pack depends on are now structural rather than checked afterwards (the
 * contract test still pins both, as a regression alarm rather than as the only
 * guarantee):
 *
 *  - DISJOINT, so a row is reachable through at most one permission set. A row carries
 *    at most one category and a category maps to one domain, so these five sets are a
 *    partition of the CATEGORISED audit trail rather than five overlapping views of it.
 *  - TOTAL, so no canonical category is silently readable by nobody. That was not true
 *    before: `family` was written by 27 production sites and named in no set here, so
 *    every family-domain audit event was invisible to Diagnostics. Adding a category to
 *    the taxonomy without classifying it here no longer compiles.
 *
 * WHAT CHANGED, AND WHO GAINS OR LOSES EVIDENCE (#2581 decisions 1, 2 and 7). Both
 * directions are real behaviour changes and are named in the changelog rather than
 * folded into a refactor:
 *
 *  - `communication` LEFT the system entry for the membership entry. Reading
 *    bulk-communication, notice-delivery and age-up-handoff evidence now needs
 *    `membership:view` as well as `support:view`. Those payloads carry recipient email
 *    addresses, and a support-only operator can read them today; that is the narrowing.
 *  - `family` JOINED the membership entry, so 27 sites' evidence moves from
 *    unreadable-by-Diagnostics to `support:view` plus `membership:view`.
 *  - The three nomination writers that wrote the invented `membership` now write
 *    `account`, and the auth-bounce writer that wrote the invented `auth` now writes
 *    `security` — so both populations move from unreadable to their domain's entry
 *    (membership-gated and support-only respectively).
 *
 * THE ABSENT CATEGORY IS THE SAME FAIL-CLOSED DEFAULT, ONE STEP FURTHER OUT, and it is
 * not hypothetical: 82 production audit write sites pass no category at all (see this
 * file's docblock for the census and the money-adjacent members of it), and the admin
 * audit-log screen already treats the null case as ordinary — `audit-query.ts` infers a
 * category from the action for display (`inferAuditCategoryFromAction`) and its category
 * filter matches `{ category: null }` against a table of legacy action patterns
 * (`buildAuditCategoryWhere`, `LEGACY_AUDIT_CATEGORY_ACTION_FILTERS`). A null row is
 * therefore an ordinary row everywhere except here, where it is invisible to all five
 * entries.
 *
 * TWO WAYS TO CLOSE THAT, AND ONLY ONE IS A REVIEWER'S TO TAKE. Declaring the gap — in
 * every `evidenceScope` and every description — is the fail-closed option and the one
 * taken here: the model is told an empty result does not rule out an uncategorised
 * record, which is the same remedy already applied to the category MISMATCH class above.
 * The alternative is to give the SYSTEM entry the null case explicitly
 * (`"category" IS NULL OR "category" = ANY(…)`), which would keep the five sets disjoint
 * and make the evidence complete — but it routes those 82 call sites' rows, including
 * booking-policy and communications events, to an entry behind `support:view` alone, and
 * it needs a fresh look at the `(category, createdAt)` index against a 5-second statement
 * timeout. The owner refused that route on #2581: the rows get a category at the SOURCE
 * instead, which is #2581's second child.
 *
 * WHAT THESE SETS ARE NOT, stated plainly because an earlier revision of this comment
 * claimed otherwise and AID-6B/6C are told to extend the taxonomy on this reasoning.
 * The audit taxonomy IS NOT THE ADMIN AREA MAP. It is an older, coarser taxonomy of its
 * own, and it does not partition the platform the way `admin-permissions.ts` does.
 * Three mismatches matter, all verified against the call sites:
 *
 *  - `admin` IS THE CROSS-DOMAIN CATCH-ALL, not a system-only category — 117
 *    production call sites, the largest of the eleven, covering admin-initiated
 *    operations in EVERY domain: member merge and member-lifecycle delete/archive
 *    (`member-merge.ts`, `member-lifecycle-actions.ts`), member import and
 *    lodge-access changes, seasonal membership assignments, the internet-banking
 *    payment settings, `booking_request.settings_updated`, chores, lockers, rooms,
 *    bed allocation and lodge settings. So the system entry, behind `support:view`
 *    alone, DOES see admin-initiated domain actions — as metadata, but it sees them.
 *    That is also why every NEW `admin` assignment needs a written justification
 *    rather than a default: it is the widest gate a category can sit behind.
 *  - `lodge` carries INDUCTION (`induction.ts`, `induction-baseline.ts`), even though
 *    `/admin/induction` is a `membership` surface.
 *  - `privacy` carries the admin ISSUE-REPORT events, even though
 *    `/admin/issue-reports` is a `support` surface. Re-mapping them to `admin` to match
 *    the surface would WIDEN them to support-only, so #2581 decision 5 keeps them here.
 *
 * WHY THAT IS NOT AN ESCALATION, and why the fix is honesty rather than a re-map.
 * `support` is already the area that governs `/admin/audit-log` and
 * `/api/admin/audit-log` (`admin-permissions.ts`), where the same administrator can
 * read these same rows IN FULL — summary, details, metadata, IP address, actor. This
 * projection is metadata-only and strictly narrower, so the correlation channel is at
 * every point at least as strict as the admin surface the same permission already
 * opens. Re-mapping is not available either: a row's category is a single string that
 * does not say which surface wrote it, so `admin` cannot be split by category, and
 * adding it to all four domain entries would break the disjointness that makes a
 * denial un-workaroundable.
 *
 * WHAT THE MISMATCH DOES COST is evidence honesty, and that is fixed rather than
 * documented: every entry declares an `evidenceScope` naming the categories it
 * searched, and its description names them too, so an empty result cannot be read as
 * "this did not happen" when the events are simply recorded under another category.
 */
const SYSTEM_CATEGORIES = auditCategoriesForCorrelationDomain("system");
const BOOKING_CATEGORIES = auditCategoriesForCorrelationDomain("booking");
const MEMBERSHIP_CATEGORIES = auditCategoriesForCorrelationDomain("membership");
const FINANCE_CATEGORIES = auditCategoriesForCorrelationDomain("finance");
const LODGE_CATEGORIES = auditCategoriesForCorrelationDomain("lodge");

/** Exported for the contract test that pins disjointness and coverage. */
export const DIAGNOSTICS_CORRELATION_CATEGORY_SETS: Readonly<
  Record<string, readonly AuditCategory[]>
> = {
  [DIAGNOSTICS_SYSTEM_CORRELATION_TOOL_ID]: SYSTEM_CATEGORIES,
  [DIAGNOSTICS_BOOKING_CORRELATION_TOOL_ID]: BOOKING_CATEGORIES,
  [DIAGNOSTICS_MEMBERSHIP_CORRELATION_TOOL_ID]: MEMBERSHIP_CATEGORIES,
  [DIAGNOSTICS_FINANCE_CORRELATION_TOOL_ID]: FINANCE_CATEGORIES,
  [DIAGNOSTICS_LODGE_CORRELATION_TOOL_ID]: LODGE_CATEGORIES,
};

/**
 * The tail every description shares. It names the row cap and the fields, and — since
 * the category taxonomy is not the area map — it tells the model in as many words that
 * an empty result from one entry does not settle the question, because a related event
 * may be filed under a category another entry owns. Without that, `not_found` plus a
 * completeness flag is read as an authoritative "this never happened".
 */
const SHARED_DESCRIPTION_TAIL =
  "Returns only stable codes and timestamps: the event reference, action code, category, severity, outcome, what kind of record it concerned, the request identifier, and when it happened in UTC. It never returns which record, which member, event descriptions, stored metadata, IP addresses, user agents or error text. Newest first, at most 22 events, and the window always applies — widen it if the event you are looking for is older. It searches only the audit categories listed above: if nothing matches, say that nothing matched IN THOSE CATEGORIES rather than that the event did not happen, and consider whether a related event would have been recorded under another category by another correlation tool. The audit category is optional, and 82 production write paths still record without one — subscription billing, member credit adjustments, fee configuration, booking-policy and season and promotional-code changes, Xero settings and retries, lodge display configuration, family-group and dependent changes, membership applications, bulk communications and deletion-request decisions among them. A row with no category is invisible to every correlation tool, so never report that something did not happen on the strength of an empty correlation result; say that no categorised audit event matched, and suggest Admin > Audit Log, which lists those rows as well.";

export const DIAGNOSTICS_SUPPORT_CORRELATION_TOOLS: readonly DiagnosticsToolEntry[] =
  [
    defineCorrelationTool({
      id: DIAGNOSTICS_SYSTEM_CORRELATION_TOOL_ID,
      label: "System and security event correlation",
      requiredAreas: AUDIT_CORRELATION_DOMAIN_AREAS.system,
      categories: SYSTEM_CATEGORIES,
      scope:
        "System, security and ADMIN-INITIATED events. The `admin` category is the platform's catch-all for actions an administrator took in EVERY domain — member merges and lifecycle decisions, member import, seasonal assignments, payment and booking SETTINGS changes, and lodge operations settings — as metadata only. Communication events (bulk email, notices, delivery suppressions) are NOT here: they are `communication`, which the membership correlation tool covers.",
      description: `Correlates recent audit events in the categories admin, security and system, optionally for one exact request identifier. Use it to see what the platform recorded around an incident. Note that "admin" is the catch-all for administrator-initiated actions in every domain — member merges, lifecycle decisions, imports and settings changes are recorded here rather than in the domain categories — so this tool is the right one for "what did an administrator do around this time". Email and notice delivery is recorded under "communication", which the membership correlation tool covers, not this one. ${SHARED_DESCRIPTION_TAIL}`,
    }),
    defineCorrelationTool({
      id: DIAGNOSTICS_BOOKING_CORRELATION_TOOL_ID,
      label: "Booking event correlation",
      requiredAreas: AUDIT_CORRELATION_DOMAIN_AREAS.booking,
      categories: BOOKING_CATEGORIES,
      scope:
        "Member-facing and system booking events only. An administrator's change to booking SETTINGS is recorded under `admin`, which the system correlation tool covers.",
      description: `Correlates recent audit events in the booking category, optionally for one exact request identifier. Use it to see what the platform recorded around a booking problem. Administrator changes to booking settings are recorded under "admin" rather than "booking", so use the system correlation tool for those. ${SHARED_DESCRIPTION_TAIL}`,
    }),
    defineCorrelationTool({
      id: DIAGNOSTICS_MEMBERSHIP_CORRELATION_TOOL_ID,
      label: "Membership event correlation",
      requiredAreas: AUDIT_CORRELATION_DOMAIN_AREAS.membership,
      categories: MEMBERSHIP_CATEGORIES,
      scope:
        "Member self-service account events (profile edits, notification preferences, membership cancellation, member photos, membership applications), FAMILY events (family groups, partner links, login-holder changes, dependents), COMMUNICATION events (bulk email, notices, delivery suppressions, credential-email reissues) and privacy events (deletion requests, member export, issue reports). It does NOT cover member merges, member-lifecycle delete/archive decisions, member import or lodge-access changes — those are `admin` — nor induction, which is `lodge`.",
      description: `Correlates recent audit events in the categories account, family, communication and privacy, optionally for one exact request identifier. Use it to see what the platform recorded around a member's own account changes, a family-group or partner-link change, an email or notice the club sent, a deletion request or an issue report. It does NOT cover member merges, member-lifecycle delete or archive decisions, member import or lodge-access changes (recorded under "admin", see the system correlation tool) or induction (recorded under "lodge"). ${SHARED_DESCRIPTION_TAIL}`,
    }),
    defineCorrelationTool({
      id: DIAGNOSTICS_FINANCE_CORRELATION_TOOL_ID,
      label: "Finance and Xero event correlation",
      requiredAreas: AUDIT_CORRELATION_DOMAIN_AREAS.finance,
      categories: FINANCE_CATEGORIES,
      scope:
        "Payment and Xero events. An administrator's change to payment or internet-banking SETTINGS is recorded under `admin`, which the system correlation tool covers.",
      description: `Correlates recent audit events in the categories payment and xero, optionally for one exact request identifier. Use it to see what the platform recorded around a payment or invoicing problem. Administrator changes to payment or internet-banking settings are recorded under "admin" rather than "payment", so use the system correlation tool for those. ${SHARED_DESCRIPTION_TAIL}`,
    }),
    defineCorrelationTool({
      id: DIAGNOSTICS_LODGE_CORRELATION_TOOL_ID,
      label: "Lodge operations event correlation",
      requiredAreas: AUDIT_CORRELATION_DOMAIN_AREAS.lodge,
      categories: LODGE_CATEGORIES,
      scope:
        "Lodge-operations events, including INDUCTION and induction-baseline events even though the induction admin screen sits under Membership. Administrator changes to chores, lockers, rooms, bed allocation and lodge settings are `admin`, which the system correlation tool covers.",
      description: `Correlates recent audit events in the lodge category, optionally for one exact request identifier. Use it to see what the platform recorded around a rosters, guest arrival/departure, bed-allocation or induction problem. Induction events are recorded here, under "lodge", even though the induction admin screen sits under Membership. Administrator changes to chores, lockers, rooms and lodge settings are recorded under "admin", so use the system correlation tool for those. ${SHARED_DESCRIPTION_TAIL}`,
    }),
  ];
