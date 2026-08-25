/**
 * The #2751 backfill's CONTRACT: the migration's literal action list and the
 * writers #2730 reclassified must name the same events, in both directions.
 *
 * WHY THIS FILE EXISTS. `AuditLog.category` is stored on the row at write time
 * and never re-derived, so a reclassification splits that event's history at the
 * release boundary until a backfill moves the rows already written. #2730 moved
 * 22 writers and no rows; #2751 moved the rows. Nothing mechanical connected the
 * two — the audit-writer census reads the TREE and can never see a stored row,
 * and the migration is one-shot SQL that no test executed against real data
 * until its verification fixture existed. So the pairing was prose, and the next
 * bed-allocation writer added to `REVIEWED_ADMIN_CATEGORIES_2730` would have
 * re-opened the split with nothing failing.
 *
 * WHAT IT CATCHES, concretely:
 *
 *  - a 23rd site added to `REVIEWED_ADMIN_CATEGORIES_2730` whose action the
 *    backfill does not name (the split re-opens for that event);
 *  - an action name in the backfill that no reviewed site writes (a row rewritten
 *    on the strength of nothing reviewed — the direction that cannot be undone);
 *  - the exact-list rule being replaced by a prefix match, since a `LIKE` pattern
 *    parses to no literal names at all and fails here by name.
 *
 * WHAT IT IS NOT. It is not a general "every reclassification ships a backfill"
 * gate, and INV-OPS-012 says plainly why one is not available: the census pins
 * only 127 of 454 write sites per-site by design, so a reclassification of any
 * other site is invisible to any check that has no per-site baseline to compare
 * against. This is the enforceable half — the population the rule was invented
 * on — and the rest of INV-OPS-012 is a rule a reviewer applies.
 *
 * That figure is not transcribed twice by hand any more: it went stale after
 * #2755 (3 low) and again after #2765 (16 low), so `audit-writer-census.test.ts`
 * now counts the union of the four per-site maps and asserts 127 pinned / 328
 * unpinned. If this sentence and INV-OPS-012 disagree with each other, that test
 * is the one that measured it.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  scanAuditWriterCensus,
  type AuditWriteSite,
} from "../../../scripts/audit/audit-writer-census";
import { REVIEWED_ADMIN_CATEGORIES_2730 } from "../../../scripts/audit/audit-writer-census-manifest";

const BACKFILL_MIGRATION = "20260810020000_backfill_bed_allocation_audit_category";

const migrationSql = readFileSync(
  path.join(
    process.cwd(),
    "prisma",
    "migrations",
    BACKFILL_MIGRATION,
    "migration.sql",
  ),
  "utf8",
);

/**
 * The action names the migration's `UPDATE` really matches.
 *
 * Parsed out of the statement rather than restated here, because a second copy
 * of the list in this file would keep passing after the two drifted apart —
 * which is the exact failure mode the whole test is about. The `UPDATE`'s own
 * `IN` list is taken (not the identical one in the `before_counts` CTE) because
 * that is the predicate that decides which rows are rewritten.
 */
function actionsTheMigrationRewrites(): string[] {
  const updateClause = migrationSql.match(
    /UPDATE "AuditLog"\s+SET "category" = 'lodge'\s+WHERE "category" = 'admin'\s+AND "action" IN \(([^)]*)\)/,
  );
  if (!updateClause) {
    throw new Error(
      `${BACKFILL_MIGRATION}: could not find the exact-action UPDATE. Either the ` +
        "statement was rewritten — in which case re-read this test before " +
        "changing the regex, because a prefix match or an interpolated list is " +
        "the thing it exists to refuse — or the migration was renamed.",
    );
  }
  const names = [...updateClause[1].matchAll(/'([^']+)'/g)].map(
    (match) => match[1],
  );
  if (names.length === 0) {
    throw new Error(
      `${BACKFILL_MIGRATION}: the UPDATE matches no literal action names. A ` +
        "prefix or pattern match cannot be reviewed against the census and " +
        "would sweep up actions added later (#2751).",
    );
  }
  return names;
}

/**
 * Every action name a site could write, including the one dynamic site.
 *
 * `moveBedAllocationsSameDateWithLocksHeld.moveUnderLock#0` picks between
 * `BED_ALLOCATION_BULK_SET` and `BED_ALLOCATION_MANUAL_SET` from a boolean, so
 * the census reports it as `(dynamic) …` with both literals inside. Both are
 * real action names this site writes and both must be in the backfill, so the
 * literals are extracted rather than the site skipped — and a dynamic action
 * that resolves to NO literal throws, because silently contributing nothing
 * would let a whole writer fall out of the comparison.
 */
function actionNamesWrittenAt(site: AuditWriteSite): string[] {
  if (!site.action.startsWith("(dynamic)")) {
    return [site.action];
  }
  const literals = [...site.action.matchAll(/"([A-Za-z0-9_.\-]+)"/g)].map(
    (match) => match[1],
  );
  if (literals.length === 0) {
    throw new Error(
      `${site.id}: its action is computed and names no string literal, so this ` +
        "gate cannot tell whether the #2751 backfill covers it. Name the " +
        "actions at the site, or extend this helper deliberately.",
    );
  }
  return literals;
}

describe("the #2751 bed-allocation category backfill (INV-OPS-012)", () => {
  it("rewrites exactly the actions #2730's reclassified writers record", () => {
    const census = scanAuditWriterCensus();
    const reviewedSites = census.sites.filter(
      (site) => site.id in REVIEWED_ADMIN_CATEGORIES_2730,
    );

    // The census walk has to have found them, or every set comparison below is
    // vacuously satisfied by two empty sets.
    expect(
      reviewedSites,
      "The census found none of the 22 writers #2730 reclassified, so this " +
        "gate would compare an empty set against an empty set.",
    ).toHaveLength(Object.keys(REVIEWED_ADMIN_CATEGORIES_2730).length);

    const writtenActions = [
      ...new Set(reviewedSites.flatMap(actionNamesWrittenAt)),
    ].sort();
    const rewrittenActions = [...new Set(actionsTheMigrationRewrites())].sort();

    expect(
      rewrittenActions,
      "The #2751 backfill and the writers #2730 reclassified no longer name the " +
        "same events. Both directions are defects and neither is a formatting " +
        "difference:\n" +
        "  * an action a reviewed writer records that the backfill does NOT " +
        "name leaves that event's history split at the release boundary — the " +
        "Category filter answers 'show me the bed allocations for that weekend' " +
        "for one side of the date only, and the lodge correlation entry returns " +
        "half a night while claiming to hold it all;\n" +
        "  * an action the backfill names that NO reviewed writer records means " +
        "the migration rewrites stored rows in an append-only table on the " +
        "strength of a decision nobody reviewed, and there is no undo.\n" +
        "If a writer was genuinely added or moved, the SAFE remedy comes first: " +
        "if this migration has shipped in ANY release, do NOT edit it. Prisma " +
        "records a checksum for every applied migration, so editing an applied " +
        "one breaks `prisma migrate deploy` on every fork that already ran it " +
        "(docs/BLUE_GREEN_MIGRATION_POLICY.md — committed migrations are not " +
        "edited retroactively). Write a NEW backfill migration covering the " +
        "added action, or file it (INV-OPS-012), and say so here. Extending the " +
        "literal list in prisma/migrations/" +
        BACKFILL_MIGRATION +
        "/migration.sql is correct ONLY while that migration is still " +
        "unreleased and unapplied anywhere.",
    ).toEqual(writtenActions);
  }, 180_000);

  it("keeps the action list literal, and keeps `category` the only column it writes", () => {
    // The two shortcuts that would defeat the review. A prefix match cannot be
    // checked against the census and sweeps up whatever is added next; naming a
    // second column in the SET clause is how a "tidy-up" would silently re-date
    // when these rows are purged, because `retentionClass` and `expiresAt` were
    // derived from the category at write time and are stored.
    expect(migrationSql).not.toMatch(/"action"\s+(NOT\s+)?LIKE/i);
    expect(migrationSql).not.toMatch(/"action"\s*~/);
    expect(migrationSql).not.toMatch(/starts_with\s*\(\s*"action"/i);

    // Anchored on the statement, not on the word `SET`: the migration's own
    // header prose says "named in the SET clause", and matching that would
    // measure a comment.
    const setClauses = [
      ...migrationSql.matchAll(
        /UPDATE "AuditLog"\s+SET\s+([\s\S]*?)\s+WHERE\s+"category"/g,
      ),
    ].map((match) => match[1]);
    expect(
      setClauses,
      "The backfill's UPDATE … SET … WHERE \"category\" statement could not be " +
        "read, so this assertion would pass without checking anything.",
    ).toHaveLength(1);
    expect(
      setClauses[0].trim(),
      "The #2751 backfill writes a column other than `category`. Every other " +
        "field on these rows — severity, retentionClass, expiresAt, createdAt, " +
        "details, metadata, entityType, entityId and every actor column — must " +
        "keep the bytes it was written with. Recomputing retention from the new " +
        "category in particular would re-date when the row is purged, five " +
        "years early, with no undo (#2751).",
    ).toBe(`"category" = 'lodge'`);
  });

  it("records what it did, and only when something moved", () => {
    // Decision B asked for the row count before and after. `prisma migrate
    // deploy` does not surface PostgreSQL notices, so the count is an audit row;
    // the fixture proves the numbers, and this proves the gate that keeps a
    // replay from appending a second row saying nothing happened.
    expect(migrationSql).toContain("'AUDIT_CATEGORY_BACKFILLED'");
    expect(migrationSql).toContain("'adminBefore'");
    expect(migrationSql).toContain("'lodgeBefore'");
    expect(migrationSql).toContain("'adminAfter'");
    expect(migrationSql).toContain("'lodgeAfter'");
    expect(
      migrationSql,
      "The backfill's own audit row is no longer gated on rows having actually " +
        "moved, so a replay after cutover — which the migration's operator note " +
        "asks for — would append a record of a rewrite that did not happen.",
    ).toContain("WHERE (SELECT count(*) FROM rewritten) > 0");
  });
});
