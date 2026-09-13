import {
  HISTORICAL_NON_CANONICAL_CATEGORY_CORRECTIONS_2581,
  HISTORICAL_NULL_CATEGORY_MAP_2581,
} from "../../scripts/audit/audit-writer-census-manifest";
import type { DataMigrationVerification } from "./types";

/**
 * #2581 (third child) — the audit rows written before the category became
 * mandatory.
 *
 * `AuditLog` is append-only by convention and this migration REWRITES stored
 * rows, so there is no undo and nothing about it may be taken on trust. Every
 * property the issue's safety argument rests on is asserted here against a real
 * PostgreSQL, because none of them is reachable from the empty tables
 * `Migration drift check` uses (#2418).
 *
 * WHAT THE CASES ARE FOR, one property each:
 *
 *  - every one of the 83 mapped actions moves from NULL to exactly the category
 *    the map names — per action, so a swapped pair fails, not just a count;
 *  - a null row whose action is NOT on the list stays null, including two
 *    prefix look-alikes of listed actions (the shortcut the issue forbids);
 *  - a row already carrying a canonical category is untouched even when its
 *    action is on the list — the same value, AND a different one;
 *  - exactly the four non-canonical rows the owner named change, and a
 *    `membership`/`EMAIL` row on any OTHER action does not;
 *  - every other column on a rewritten row is byte-identical, and in
 *    particular `retentionClass` and `expiresAt` stay NULL — the rows were
 *    written with no retention and this migration deliberately derives none;
 *  - the record's measured and derived counts match an independently measured
 *    post-state;
 *  - an install with nothing to move records nothing (the post-cutover replay).
 *
 * THE SEEDS ARE DERIVED FROM `HISTORICAL_NULL_CATEGORY_MAP_2581`, not typed out
 * again: the map is the reviewed decision (every crossing owner-decided on 13
 * Sep 2026, the bulk pair rerouted to `account`), and if the map ever moves
 * this fixture follows, while the contract test
 * (`src/lib/__tests__/historical-audit-category-backfill.test.ts`) holds the
 * migration's own literal list equal to the map. The mutants below edit the
 * SQL, never the map, so a map/SQL disagreement is caught there and a broken
 * statement is caught here.
 *
 * `AuditLog` carries no foreign keys, so every seed is a plain insert on the
 * real schema with no parent rows to invent.
 */

const MAPPED = Object.entries(HISTORICAL_NULL_CATEGORY_MAP_2581)
  .map(([action, mapping]) => ({ action, category: mapping.category }))
  .sort((a, b) => (a.action < b.action ? -1 : a.action > b.action ? 1 : 0));

/** Deterministic ids so the assertions can read rows back by name. */
const seedId = (index: number) => `seed-map-${String(index).padStart(2, "0")}`;

/** One NULL-category row per mapped action, one minute apart. */
const oneNullRowPerMappedAction = MAPPED.map(
  ({ action }, index) => `(
    '${seedId(index)}',
    '${action}',
    NULL,
    TIMESTAMP '2026-05-01 09:00:00' + (${index} * interval '1 minute')
  )`,
).join(",\n  ");

/** The (id, category) pairs the post-state must show, as a SQL VALUES list. */
const expectedPairs = MAPPED.map(
  ({ category }, index) => `('${seedId(index)}', '${category}')`,
).join(",\n                   ");

const expectedByCategory = MAPPED.reduce<Record<string, number>>(
  (counts, { category }) => {
    counts[category] = (counts[category] ?? 0) + 1;
    return counts;
  },
  {},
);

/**
 * The rows that must NOT move, each one a different way of getting this wrong.
 *
 *  - `seed-same-canonical`   a mapped action already carrying the mapped value;
 *  - `seed-other-canonical`  a mapped action carrying a DIFFERENT canonical
 *                            value — decision 6, "never rewritten";
 *  - `seed-unmapped-null`    a null row of an action on no list (#2751's
 *                            population, rewritten by that migration on a real
 *                            install, but a fork could hold one);
 *  - `seed-lookalike-null`   / `seed-lookalike-null-2`  null rows whose action
 *                            EXTENDS a listed one — a prefix match would take
 *                            them;
 *  - `seed-email-other`      the exception action carrying a canonical value,
 *                            which the `= 'EMAIL'` predicate must not touch;
 *  - `seed-membership-other` `membership` on an action the owner did NOT name;
 *  - `seed-bulk-post-2755`   a bulk deactivation the post-#2755 runtime wrote
 *                            as `admin`. The historical NULL twins go to
 *                            `account` by owner decision (13 Sep 2026); this
 *                            row must stay `admin` — the operator-side date
 *                            split #2763 accepted, preserved rather than
 *                            unified by a rewrite nobody decided.
 */
const untouchableRows = `(
    'seed-bulk-post-2755', 'member.bulk-deactivate', 'admin',
    TIMESTAMP '2026-08-20 09:00:00'
  ),
  (
    'seed-same-canonical', 'booking.cancel', 'booking',
    TIMESTAMP '2026-06-10 09:00:00'
  ),
  (
    'seed-other-canonical', 'member.setup-invite-sent', 'admin',
    TIMESTAMP '2026-06-11 09:00:00'
  ),
  (
    'seed-unmapped-null', 'BED_ALLOCATION_MANUAL_SET', NULL,
    TIMESTAMP '2026-06-12 09:00:00'
  ),
  (
    'seed-lookalike-null', 'booking.cancel.later_added', NULL,
    TIMESTAMP '2026-06-13 09:00:00'
  ),
  (
    'seed-lookalike-null-2', 'XERO_LINK_V2', NULL,
    TIMESTAMP '2026-06-14 09:00:00'
  ),
  (
    'seed-email-other', 'EMAIL_SUPPRESSION_CLEARED', 'admin',
    TIMESTAMP '2026-06-15 09:00:00'
  ),
  (
    'seed-membership-other', 'membership_application.created_by_admin', 'membership',
    TIMESTAMP '2026-06-16 09:00:00'
  )`;

/** The four rows the owner named, seeded with the non-canonical string each carried. */
const exceptionRows = HISTORICAL_NON_CANONICAL_CATEGORY_CORRECTIONS_2581.flatMap(
  ({ action, from, rowsMeasured }) =>
    Array.from({ length: rowsMeasured }, (_, index) => `(
    'seed-exc-${from.toLowerCase()}-${action.replace(/[^A-Za-z0-9]/g, "_")}-${index}',
    '${action}',
    '${from}',
    TIMESTAMP '2026-06-2${index} 09:00:00'
  )`),
).join(",\n  ");

const expectedExceptionRows = HISTORICAL_NON_CANONICAL_CATEGORY_CORRECTIONS_2581.flatMap(
  ({ action, from, to, rowsMeasured }) =>
    Array.from({ length: rowsMeasured }, (_, index) => ({
      id: `seed-exc-${from.toLowerCase()}-${action.replace(/[^A-Za-z0-9]/g, "_")}-${index}`,
      category: to,
    })),
).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

const EXCEPTION_ROW_COUNT = expectedExceptionRows.length;
/** The three deliberately unmapped null rows above. */
const UNMAPPED_NULL_SEEDS = 3;

const verification: DataMigrationVerification = {
  migration: "20260923010000_backfill_historical_audit_categories",
  intent:
    "Set `category` on exactly the NULL-category audit rows whose action is on the reviewed exact-action list, to the category the map names for that action; correct the four rows carrying the non-canonical strings `EMAIL` and `membership` on the three named actions; change no other column on any row, no row already carrying a canonical category, and no null row of an unlisted action; and record the before/after counts as one AUDIT_CATEGORY_BACKFILLED row, only when something moved.",
  idempotentReRun: true,
  cases: [
    {
      name: "a club holding one uncategorised row per mapped action, the four non-canonical rows, and every row that must not move",
      seed: `
        INSERT INTO "AuditLog" ("id", "action", "category", "createdAt")
        VALUES
          ${oneNullRowPerMappedAction},
          ${untouchableRows},
          ${exceptionRows};
      `,
      expectations: [
        {
          claim: `every one of the ${MAPPED.length} mapped actions now carries exactly the category the map names — checked per row, so a swapped pair fails rather than a total`,
          sql: `SELECT count(*)::int AS "matching"
                  FROM "AuditLog" a
                  JOIN (VALUES
                   ${expectedPairs}
                  ) AS e ("id", "category") ON e."id" = a."id"
                 WHERE a."category" = e."category"`,
          rows: [{ matching: MAPPED.length }],
        },
        {
          claim:
            "and none of them is left behind on NULL or on a different value — the count above could be satisfied by a partial rewrite",
          sql: `SELECT a."id", a."action", a."category"
                  FROM "AuditLog" a
                  LEFT JOIN (VALUES
                   ${expectedPairs}
                  ) AS e ("id", "category") ON e."id" = a."id"
                 WHERE a."id" LIKE 'seed-map-%'
                   AND (a."category" IS NULL OR a."category" IS DISTINCT FROM e."category")
                 ORDER BY a."id"`,
          rows: [],
        },
        {
          claim:
            "every row that must not move still holds exactly what it was written with: a mapped action already canonical (same value and a different one), a post-#2755 bulk deactivation already `admin`, a null row of an unlisted action, two prefix look-alikes, the exception action under a canonical value, and `membership` on an action the owner did not name",
          sql: `SELECT "id", "category" FROM "AuditLog"
                 WHERE "id" IN ('seed-same-canonical', 'seed-other-canonical',
                                'seed-bulk-post-2755',
                                'seed-unmapped-null', 'seed-lookalike-null',
                                'seed-lookalike-null-2', 'seed-email-other',
                                'seed-membership-other')
                 ORDER BY "id"`,
          rows: [
            { id: "seed-bulk-post-2755", category: "admin" },
            { id: "seed-email-other", category: "admin" },
            { id: "seed-lookalike-null", category: null },
            { id: "seed-lookalike-null-2", category: null },
            { id: "seed-membership-other", category: "membership" },
            { id: "seed-other-canonical", category: "admin" },
            { id: "seed-same-canonical", category: "booking" },
            { id: "seed-unmapped-null", category: null },
          ],
        },
        {
          claim:
            "exactly the four rows the owner named on 13 September 2026 are corrected, each to the canonical value its current writer records",
          sql: `SELECT "id", "category" FROM "AuditLog"
                 WHERE "id" LIKE 'seed-exc-%' ORDER BY "id"`,
          rows: expectedExceptionRows,
        },
        {
          claim:
            "no row anywhere still carries a category string outside the taxonomy on the named actions, and the one on an unnamed action is untouched — decision 6 stands except for the listed four",
          sql: `SELECT count(*) FILTER (WHERE "category" = 'EMAIL')::int AS "emailLeft",
                       count(*) FILTER (WHERE "category" = 'membership')::int AS "membershipLeft"
                  FROM "AuditLog"`,
          rows: [{ emailLeft: 0, membershipLeft: 1 }],
        },
        {
          claim:
            "exactly one AUDIT_CATEGORY_BACKFILLED row is written, in the support-only `admin` category with an explicit seven-year retention class, because raw SQL bypasses the audit boundary that would have derived one",
          sql: `SELECT "action", "category", "severity", "outcome", "entityType",
                       "entityId", "retentionClass",
                       "metadata" ->> 'source' AS "source",
                       ("metadata" ->> 'issue')::int AS "issue"
                  FROM "AuditLog" WHERE "action" = 'AUDIT_CATEGORY_BACKFILLED'`,
          rows: [
            {
              action: "AUDIT_CATEGORY_BACKFILLED",
              category: "admin",
              severity: "important",
              outcome: "success",
              entityType: "AuditLog",
              entityId: null,
              retentionClass: "critical",
              source: "migration:20260923010000_backfill_historical_audit_categories",
              issue: 2581,
            },
          ],
        },
        {
          claim: `the MEASURED counts are really recorded: ${MAPPED.length + UNMAPPED_NULL_SEEDS} null rows before, ${MAPPED.length} of them on a listed action, ${MAPPED.length} rewritten, ${EXCEPTION_ROW_COUNT} non-canonical rows corrected by prior string`,
          sql: `SELECT ("metadata" -> 'measured' ->> 'nullBefore')::int AS "nullBefore",
                       ("metadata" -> 'measured' ->> 'mappedNullBefore')::int AS "mappedNullBefore",
                       ("metadata" -> 'measured' ->> 'rewritten')::int AS "rewritten",
                       ("metadata" -> 'measured' -> 'correctedNonCanonical' ->> 'EMAIL')::int AS "emailCorrected",
                       ("metadata" -> 'measured' -> 'correctedNonCanonical' ->> 'membership')::int AS "membershipCorrected"
                  FROM "AuditLog" WHERE "action" = 'AUDIT_CATEGORY_BACKFILLED'`,
          rows: [
            {
              nullBefore: MAPPED.length + UNMAPPED_NULL_SEEDS,
              mappedNullBefore: MAPPED.length,
              rewritten: MAPPED.length,
              emailCorrected: 2,
              membershipCorrected: 2,
            },
          ],
        },
        {
          claim:
            "the per-category and per-action breakdowns in the record are exactly the map's distribution — one row per action, so every action appears once",
          sql: `SELECT ("metadata" -> 'measured' -> 'rewrittenByCategory')::text AS "byCategory",
                       (SELECT count(*)::int FROM jsonb_each("metadata" -> 'measured' -> 'rewrittenByAction')) AS "actionsNamed",
                       (SELECT bool_and(value::int = 1) FROM jsonb_each_text("metadata" -> 'measured' -> 'rewrittenByAction')) AS "eachOnce"
                  FROM "AuditLog" WHERE "action" = 'AUDIT_CATEGORY_BACKFILLED'`,
          rows: [
            {
              // jsonb renders object keys sorted by length then bytes, so build
              // the expected text through PostgreSQL's own rules rather than
              // JSON.stringify: compare it as a parsed object instead.
              byCategory: expect_jsonb(expectedByCategory),
              actionsNamed: MAPPED.length,
              eachOnce: true,
            },
          ],
        },
        {
          claim:
            "the DERIVED figures match an independently measured post-state: the three unlisted null rows are all that is left null, and nothing is left on `EMAIL` or on the named `membership` rows",
          sql: `SELECT
                    (log."metadata" -> 'derived' ->> 'nullAfter')::int AS "loggedNullAfter",
                    (log."metadata" -> 'derived' ->> 'unmappedNullRemaining')::int AS "loggedUnmappedRemaining",
                    (log."metadata" -> 'derived' ->> 'emailAfter')::int AS "loggedEmailAfter",
                    (log."metadata" -> 'derived' ->> 'membershipAfter')::int AS "loggedMembershipAfter",
                    measured."nullAfter",
                    measured."emailAfter",
                    measured."membershipAfter"
                  FROM "AuditLog" log
                  CROSS JOIN (
                    SELECT
                      count(*) FILTER (WHERE "category" IS NULL)::int AS "nullAfter",
                      count(*) FILTER (WHERE "category" = 'EMAIL')::int AS "emailAfter",
                      count(*) FILTER (WHERE "category" = 'membership')::int AS "membershipAfter"
                    FROM "AuditLog"
                  ) measured
                  WHERE log."action" = 'AUDIT_CATEGORY_BACKFILLED'`,
          rows: [
            {
              loggedNullAfter: UNMAPPED_NULL_SEEDS,
              loggedUnmappedRemaining: UNMAPPED_NULL_SEEDS,
              loggedEmailAfter: 0,
              // The record counts the `membership` rows it CORRECTED; the one
              // on an unnamed action was never counted and is measured below.
              loggedMembershipAfter: 1,
              nullAfter: UNMAPPED_NULL_SEEDS,
              emailAfter: 0,
              membershipAfter: 1,
            },
          ],
        },
        {
          claim:
            "the record's own retention is the seven years `classifyAuditRetention` would have derived, stated rather than left NULL because raw SQL bypasses the audit boundary",
          sql: `SELECT to_char("expiresAt", 'YYYY-MM-DD HH24:MI:SS.MS')
                         = to_char("createdAt" + interval '7 years',
                                   'YYYY-MM-DD HH24:MI:SS.MS')
                         AS "expiresSevenYearsAfterItWasWritten"
                  FROM "AuditLog" WHERE "action" = 'AUDIT_CATEGORY_BACKFILLED'`,
          rows: [{ expiresSevenYearsAfterItWasWritten: true }],
        },
      ],
    },
    {
      name: "one rewritten row carrying every other field a real pre-#2581 audit row carries — including NO retention",
      seed: `
        INSERT INTO "AuditLog" (
          "id", "action", "memberId", "targetId", "details", "ipAddress",
          "createdAt", "actorMemberId", "subjectMemberId", "entityType",
          "entityId", "category", "severity", "outcome", "summary", "metadata",
          "requestId", "userAgent", "retentionClass", "expiresAt", "archivedAt",
          "incidentPreserved"
        )
        VALUES (
          'seed-full-row', 'member.setup-invite-sent', 'member-officer',
          'member-invited', 'Setup invite sent to Jane Doe',
          '203.0.113.7', TIMESTAMP '2026-05-04 21:15:32.123', NULL,
          NULL, NULL, NULL, NULL, NULL, NULL, NULL,
          '{"emailSent": true}'::jsonb,
          'req-abc', 'Mozilla/5.0', NULL, NULL, NULL, false
        );
      `,
      expectations: [
        {
          claim:
            "only `category` changed. Every other column is byte-identical — and `retentionClass`/`expiresAt` in particular stay NULL, because this row was written with no retention and deriving `critical`/seven years from the new category is a separate retention decision the migration must not take",
          sql: `SELECT "action", "memberId", "targetId", "details", "ipAddress",
                       to_char("createdAt", 'YYYY-MM-DD HH24:MI:SS.MS') AS "createdAt",
                       "actorMemberId", "subjectMemberId", "entityType", "entityId",
                       "category", "severity", "outcome", "summary",
                       "metadata"::text AS "metadata", "requestId", "userAgent",
                       "retentionClass", "expiresAt", "archivedAt", "incidentPreserved"
                  FROM "AuditLog" WHERE "id" = 'seed-full-row'`,
          rows: [
            {
              action: "member.setup-invite-sent",
              memberId: "member-officer",
              targetId: "member-invited",
              details: "Setup invite sent to Jane Doe",
              ipAddress: "203.0.113.7",
              createdAt: "2026-05-04 21:15:32.123",
              actorMemberId: null,
              subjectMemberId: null,
              entityType: null,
              entityId: null,
              category: "security",
              severity: null,
              outcome: null,
              summary: null,
              metadata: '{"emailSent": true}',
              requestId: "req-abc",
              userAgent: "Mozilla/5.0",
              retentionClass: null,
              expiresAt: null,
              archivedAt: null,
              incidentPreserved: false,
            },
          ],
        },
      ],
    },
    {
      name: "an install with nothing to move — the shape a replay after cutover meets",
      seed: `
        INSERT INTO "AuditLog" ("id", "action", "category", "createdAt")
        VALUES
          ('seed-replay-security', 'member.setup-invite-sent', 'security',
           TIMESTAMP '2026-08-20 09:00:00'),
          ('seed-replay-admin', 'MEMBER_MERGE_EXECUTED', 'admin',
           TIMESTAMP '2026-08-21 09:00:00'),
          ('seed-replay-unmapped-null', 'BED_ALLOCATION_MANUAL_SET', NULL,
           TIMESTAMP '2026-01-05 09:00:00');
      `,
      expectations: [
        {
          claim:
            "nothing moved, so NO backfill row is appended. An unconditional insert would append one saying `rewritten: 0` on every replay, which is a change — and would make the whole migration non-idempotent",
          sql: `SELECT count(*)::int AS "backfillRows" FROM "AuditLog"
                 WHERE "action" = 'AUDIT_CATEGORY_BACKFILLED'`,
          rows: [{ backfillRows: 0 }],
        },
        {
          claim: "and the three seeded rows are exactly as they were, the unlisted null row included",
          sql: `SELECT "id", "category" FROM "AuditLog"
                 WHERE "id" LIKE 'seed-replay-%' ORDER BY "id"`,
          rows: [
            { id: "seed-replay-admin", category: "admin" },
            { id: "seed-replay-security", category: "security" },
            { id: "seed-replay-unmapped-null", category: null },
          ],
        },
      ],
    },
  ],
  mutants: [
    {
      name: "drop the `category IS NULL` predicate, keeping only the exact-action join",
      harm:
        "Rewrites a listed action's row in EVERY category, not only the uncategorised ones: a `member.setup-invite-sent` row deliberately filed `admin` becomes `security`. That is decision 6 broken — an existing explicit category rewritten — and it republishes rows to a different permission gate than the one they were classified into, on an append-only table.",
      find: `  WHERE a."category" IS NULL
    AND a."action" = m."action"`,
      replace: `  WHERE a."action" = m."action"`,
    },
    {
      name: "match the action by prefix instead of exact equality",
      harm:
        "The shortcut the issue explicitly forbids (decision 4). `booking.cancel.later_added` and `XERO_LINK_V2` — actions nobody reviewed — are swept into `booking` and `xero`, and every future action that happens to extend a listed name is rewritten on the strength of nothing.",
      find: `    AND a."action" = m."action"`,
      replace: `    AND a."action" LIKE m."action" || '%'`,
    },
    {
      name: "swap one pair's category in the literal list",
      harm:
        "Files 515 credential-delivery rows under `account` — member-visible and membership-gated — instead of `security`, the category their writer records and the census pins. A per-category total would still add up; only a per-action check sees it, and the reader who then sees those rows is a different reader.",
      find: `    ('member.setup-invite-sent', 'security'),`,
      replace: `    ('member.setup-invite-sent', 'account'),`,
    },
    {
      name: "also derive retentionClass and expiresAt from the new category",
      harm:
        "Turns 1,885 kept-forever rows into rows that are deleted seven years after they were written — some of them in 2033 — as a side effect of a category tidy-up nobody framed as a retention decision. The issue body forbids exactly this (\"do not rewrite historical retention fields as a side effect\"), and there is no undo on an append-only table.",
      find: `  SET "category" = m."category"`,
      replace: `  SET "category" = m."category",
      "retentionClass" = 'critical',
      "expiresAt" = timezone('UTC', statement_timestamp()) + interval '7 years'`,
    },
    {
      name: "correct EMAIL_SUPPRESSION_CLEARED whatever category it carries",
      harm:
        "Widens the four-row exception the owner listed into a rewrite of every row of that action, including one deliberately filed elsewhere — decision 6 broken for rows the owner never named.",
      find: `  WHERE "category" = 'EMAIL'
    AND "action" = 'EMAIL_SUPPRESSION_CLEARED'`,
      replace: `  WHERE "action" = 'EMAIL_SUPPRESSION_CLEARED'`,
    },
    {
      name: "correct every `membership` row, not only the two named actions",
      harm:
        "The owner named two actions by exact name. Dropping the action list makes the correction a category-wide sweep that would also rewrite a `membership` row on an action nobody reviewed — the census test measured that cost on #2765/#2777 and the decision was taken on it.",
      find: `  WHERE "category" = 'membership'
    AND "action" IN (
      'membership_application.nominator_replaced',
      'membership_application.nomination_workflow_refreshed'
    )`,
      replace: `  WHERE "category" = 'membership'`,
    },
    {
      name: "write the backfill audit row unconditionally",
      harm:
        "Breaks idempotency in the one direction that matters for the post-cutover replay the runbook asks for: every re-run appends another AUDIT_CATEGORY_BACKFILLED row claiming a rewrite that did not happen, so the club's own record of what the upgrade did becomes a pile of zero-row entries.",
      find: `WHERE (SELECT count(*) FROM rewritten)
    + (SELECT count(*) FROM corrected_email)
    + (SELECT count(*) FROM corrected_membership) > 0;`,
      replace: `;`,
    },
    {
      name: "log the null total as it was before the rewrite",
      harm:
        "The issue's postflight asks for mapped rows remaining null after = 0. A stale `nullAfter` makes the record say nothing moved, which is exactly the number an operator would use to decide whether the backfill needs running again after cutover.",
      find: `'nullAfter', before_counts."nullBefore" - (SELECT count(*)::int FROM rewritten)`,
      replace: `'nullAfter', before_counts."nullBefore"`,
    },
  ],
};

/**
 * PostgreSQL renders a jsonb object with keys sorted by length then bytes, and
 * the runner compares rows with `deepStrictEqual` on values — so a `::text`
 * projection of an object cannot be predicted from `JSON.stringify`. Render the
 * expected object the way PostgreSQL will: shorter keys first, ties by byte
 * order, `": "` and `", "` separators.
 */
function expect_jsonb(value: Record<string, number>): string {
  const keys = Object.keys(value).sort((a, b) =>
    a.length !== b.length ? a.length - b.length : a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${keys.map((key) => `"${key}": ${value[key]}`).join(", ")}}`;
}

export default verification;
