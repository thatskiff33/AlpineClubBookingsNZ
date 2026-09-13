/**
 * The #2581 third-child backfill's CONTRACT: the migration's literal
 * (action, category) list and the reviewed map in the census manifest must
 * name the same pairs, in both directions; every pair must be provable from
 * the tree; and the member-boundary column the owner decides on must be
 * DERIVED from the real reader code rather than typed by hand.
 *
 * WHY THIS FILE EXISTS. `AuditLog.category` is stored on the row and never
 * re-derived, so this migration rewrites 1,885 rows on an append-only table on
 * the strength of `HISTORICAL_NULL_CATEGORY_MAP_2581`. Nothing mechanical ties
 * a `VALUES` list in SQL to a `Record` in TypeScript — the census reads the
 * TREE and can never see a stored row, and the migration is one-shot SQL that
 * only its verification fixture executes. So the pairing would be prose, and
 * prose is how #2400 built the option the owner rejected.
 *
 * WHAT IT CATCHES, concretely:
 *
 *  - a pair in the migration that the map does not carry, or the reverse — a
 *    row rewritten on the strength of nothing reviewed, or a reviewed decision
 *    the migration never applies;
 *  - a pair whose category is not what the CURRENT WRITER of that exact action
 *    records (the map's tier-1 evidence), re-measured from `scanAuditWriterCensus()`
 *    on every run, so a later reclassification of a writer is a named failure
 *    here rather than a new split;
 *  - a `history` entry whose action has quietly acquired a writer again;
 *  - a pair placed in the wrong block: the migration's `base` arm may hold only
 *    actions that cross no member-visibility line, and its
 *    `member_boundary_crossings` arm only the ones that do — evaluated against
 *    `buildMemberVisibleAuditLogWhere` itself, because INV-OPS-012 makes that
 *    crossing the owner's decision and a mis-filed pair would take it silently;
 *  - the exact-list rule replaced by a prefix match, or a second column named
 *    in a SET clause;
 *  - the four-row exception drifting from the owner's list.
 *
 * WHAT IT IS NOT. It cannot see the live table. The 83 actions and their row
 * counts were measured read-only on 13 September 2026 and recorded on the
 * issue; a fork with a different history holds different nulls, which the
 * migration leaves null and the guide discloses.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  AUDIT_CATEGORIES,
  AUDIT_CATEGORY_CORRELATION_DOMAIN,
  AUDIT_CORRELATION_DOMAINS,
  AUDIT_CORRELATION_DOMAIN_AREAS,
  auditCategoriesForCorrelationDomain,
  isAuditCategory,
  type AuditCategory,
} from "../audit-categories";
import {
  buildAuditCategoryWhere,
  buildMemberVisibleAuditLogWhere,
} from "../audit-query";
import {
  literalActionNamesAt,
  scanAuditWriterCensus,
  type AuditWriteSite,
  type AuditWriterCensus,
} from "../../../scripts/audit/audit-writer-census";
import {
  HISTORICAL_NON_CANONICAL_CATEGORY_CORRECTIONS_2581,
  HISTORICAL_NULL_CATEGORY_MAP_2581,
  MEMBER_RECORD_ADMIN_ACTIONS_2755,
  WITHHELD_HISTORICAL_NULL_ACTIONS_2581,
} from "../../../scripts/audit/audit-writer-census-manifest";
import { stripSqlComments } from "../../../prisma/migration-verification/split-statements";

const BACKFILL_MIGRATION = "20260923010000_backfill_historical_audit_categories";

/** Distinct exact actions carried by null-category rows on 13 Sep 2026. */
const MEASURED_NULL_ACTIONS = 83;

const migrationSql = readFileSync(
  path.join(process.cwd(), "prisma", "migrations", BACKFILL_MIGRATION, "migration.sql"),
  "utf8",
);

/**
 * The SQL with comments blanked, so header prose cannot read as a pair. The
 * same stripper the census uses (`INV-SSOT`), not a per-line regex.
 */
const sqlWithoutComments = stripSqlComments(migrationSql);

type Pair = { action: string; category: string };

/**
 * The (action, category) pairs the migration's `mapping` CTE really carries,
 * per arm, parsed out of the statement rather than restated here — a second
 * copy in this file would keep passing after the two drifted apart.
 */
function pairsTheMigrationRewrites(): Record<string, Pair[]> {
  const opener = 'WITH mapping ("action", "category") AS (';
  const start = sqlWithoutComments.indexOf(opener);
  if (start < 0) {
    throw new Error(
      `${BACKFILL_MIGRATION}: could not find the mapping CTE. Either the statement ` +
        "was restructured — re-read this test before changing the opener, because " +
        "a prefix match or an interpolated list is the thing it exists to refuse — " +
        "or the migration was renamed.",
    );
  }
  let depth = 1;
  let index = start + opener.length;
  while (index < sqlWithoutComments.length && depth > 0) {
    const char = sqlWithoutComments[index];
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    index += 1;
  }
  const body = sqlWithoutComments.slice(start + opener.length, index - 1);

  const arms: Record<string, Pair[]> = {};
  for (const arm of body.split(/UNION ALL/)) {
    const alias = arm.match(/\)\s+AS\s+(\w+)\s+\("action",\s*"category"\)/)?.[1];
    if (!alias) {
      throw new Error(`${BACKFILL_MIGRATION}: a mapping arm has no alias:\n${arm}`);
    }
    const pairs = [...arm.matchAll(/\('([^']+)',\s*'([^']+)'\)/g)].map((match) => ({
      action: match[1],
      category: match[2],
    }));
    if (pairs.length === 0) {
      throw new Error(
        `${BACKFILL_MIGRATION}: arm \`${alias}\` names no literal pairs. A pattern ` +
          "match cannot be reviewed against the census (#2581 decision 4).",
      );
    }
    arms[alias] = pairs;
  }
  return arms;
}

const byAction = (a: Pair, b: Pair) => (a.action < b.action ? -1 : a.action > b.action ? 1 : 0);

/**
 * Every literal action a census site can write. This test SCANS all 480-odd
 * sites for corroboration, and a dynamic site that names no literal
 * (`(dynamic) auditAction`) simply cannot corroborate anything — so it asks the
 * shared helper for `empty` rather than the default throw, deliberately.
 */
function actionNamesWrittenAt(site: AuditWriteSite): string[] {
  return literalActionNamesAt(site, { onNone: "empty" });
}

function literalCategory(site: AuditWriteSite): string | null {
  return site.category.kind === "literal" ? site.category.value : null;
}

// ---------------------------------------------------------------------------
// A small evaluator for the Prisma `where` shapes the two reader builders
// produce, so the member-boundary and filter questions are answered by the REAL
// builders against a synthetic row rather than by a hand-written truth table.
// It throws on any operator it does not know, so a new operator in
// `audit-query.ts` fails here loudly instead of evaluating to false.
// ---------------------------------------------------------------------------

type Row = {
  action: string;
  category: string | null;
  subjectMemberId: string | null;
  memberId: string | null;
  actorMemberId: string | null;
  targetId: string | null;
  entityType: string | null;
  entityId: string | null;
};

function evalWhere(where: unknown, row: Row): boolean {
  if (where === null || where === undefined) return true;
  if (Array.isArray(where)) return where.every((part) => evalWhere(part, row));
  const clause = where as Record<string, unknown>;
  return Object.keys(clause).every((key) => {
    const value = clause[key];
    const list = Array.isArray(value) ? value : [value];
    if (key === "AND") return list.every((part) => evalWhere(part, row));
    if (key === "OR") return list.some((part) => evalWhere(part, row));
    if (key === "NOT") return !list.some((part) => evalWhere(part, row));
    if (!(key in row)) throw new Error(`evalWhere: unknown column ${key}`);
    const actual = row[key as keyof Row];
    if (value === null) return actual === null;
    if (typeof value === "string") return actual === value;
    if (typeof value === "object" && value !== null) {
      const op = value as Record<string, unknown>;
      if ("in" in op) return (op.in as unknown[]).includes(actual);
      if ("startsWith" in op)
        return typeof actual === "string" && actual.startsWith(op.startsWith as string);
      if ("contains" in op)
        return typeof actual === "string" && actual.includes(op.contains as string);
      if ("equals" in op) return actual === op.equals;
      throw new Error(`evalWhere: unhandled operator ${JSON.stringify(op)} on ${key}`);
    }
    throw new Error(`evalWhere: unhandled value ${JSON.stringify(value)} on ${key}`);
  });
}

const MEMBER = "member-under-test";

/** A row of `action` that concerns MEMBER through the subject leg. */
function rowOf(action: string, category: string | null): Row {
  return {
    action,
    category,
    subjectMemberId: MEMBER,
    memberId: null,
    actorMemberId: null,
    targetId: null,
    entityType: null,
    entityId: null,
  };
}

function memberVisible(row: Row): boolean {
  return evalWhere(buildMemberVisibleAuditLogWhere(MEMBER), row);
}

const mapEntries = Object.entries(HISTORICAL_NULL_CATEGORY_MAP_2581);

let cachedCensus: AuditWriterCensus | undefined;
function census(): AuditWriterCensus {
  cachedCensus ??= scanAuditWriterCensus();
  return cachedCensus;
}

describe("the #2581 historical null-category backfill (INV-OPS-012, INV-PRIV-012)", () => {
  it("rewrites exactly the pairs the reviewed map records, in the block the map assigns", () => {
    const arms = pairsTheMigrationRewrites();
    expect(
      Object.keys(arms).sort(),
      "The migration must carry exactly two arms: `base` (no member-boundary " +
        "crossing) and `member_boundary_crossings` (the owner's decision). A third " +
        "arm, or a renamed one, is a pair review cannot place.",
    ).toEqual(["base", "member_boundary_crossings"]);

    const expectedBase = mapEntries
      .filter(([, mapping]) => mapping.memberBoundary === "none")
      .map(([action, mapping]) => ({ action, category: mapping.category }))
      .sort(byAction);
    const expectedCrossings = mapEntries
      .filter(([, mapping]) => mapping.memberBoundary !== "none")
      .map(([action, mapping]) => ({ action, category: mapping.category }))
      .sort(byAction);

    const disagreement =
      "The migration's literal list and HISTORICAL_NULL_CATEGORY_MAP_2581 no " +
      "longer name the same pairs. Both directions are defects: a pair the map " +
      "records that the migration does not apply leaves that event's history " +
      "uncategorised after the upgrade that claimed to fix it; a pair the " +
      "migration applies that the map does not record rewrites stored rows on an " +
      "append-only table on the strength of nothing reviewed. And a pair in the " +
      "wrong ARM takes a member-visibility decision INV-OPS-012 reserves to the " +
      "owner. If this migration has shipped in ANY release, do NOT edit it — " +
      "Prisma checksums applied migrations — write a new one.";

    expect([...arms.base].sort(byAction), disagreement).toEqual(expectedBase);
    expect([...arms.member_boundary_crossings].sort(byAction), disagreement).toEqual(
      expectedCrossings,
    );

    // No action appears twice across the arms, or the UPDATE's join would be
    // ambiguous and PostgreSQL would pick one of the two categories silently.
    const allActions = [...arms.base, ...arms.member_boundary_crossings].map((p) => p.action);
    expect(new Set(allActions).size).toBe(allActions.length);
  });

  it("names only canonical categories, and accounts for every measured action", () => {
    for (const [action, mapping] of mapEntries) {
      expect(isAuditCategory(mapping.category), `${action} -> ${mapping.category}`).toBe(true);
    }
    for (const correction of HISTORICAL_NON_CANONICAL_CATEGORY_CORRECTIONS_2581) {
      expect(isAuditCategory(correction.to), `${correction.action} -> ${correction.to}`).toBe(true);
      expect(isAuditCategory(correction.from), `${correction.from} must be OUTSIDE the taxonomy`).toBe(false);
    }

    // The 83 measured actions are either mapped or deliberately withheld —
    // never silently dropped, never both.
    const mapped = new Set(Object.keys(HISTORICAL_NULL_CATEGORY_MAP_2581));
    const withheld = Object.keys(WITHHELD_HISTORICAL_NULL_ACTIONS_2581);
    for (const action of withheld) {
      expect(mapped.has(action), `${action} is both mapped and withheld`).toBe(false);
    }
    expect(
      mapped.size + withheld.length,
      "The map and the withheld list together must account for all 83 exact " +
        "actions measured on 13 Sep 2026. An action that is in neither has been " +
        "dropped without a decision.",
    ).toBe(MEASURED_NULL_ACTIONS);

    // And a withheld action must not be in the migration at all.
    const arms = pairsTheMigrationRewrites();
    const migrated = new Set(
      [...arms.base, ...arms.member_boundary_crossings].map((pair) => pair.action),
    );
    for (const action of withheld) {
      expect(migrated.has(action), `${action} is withheld but the migration rewrites it`).toBe(false);
    }
  });

  it("is provable from the tree: every pair matches the current writer of that exact action", () => {
    const sites = census().sites;
    expect(sites.length).toBeGreaterThan(400);

    for (const [action, mapping] of mapEntries) {
      const exactSites = sites.filter((site) => site.action === action);
      const dynamicSitesNaming = sites.filter(
        (site) => site.action.startsWith("(dynamic)") && actionNamesWrittenAt(site).includes(action),
      );

      const evidence = mapping.evidence;
      switch (evidence.kind) {
        case "current-writer": {
          expect(
            exactSites.length,
            `${action}: evidence says a current writer records it as a literal, but the census finds none. ` +
              "Change the evidence kind (dynamic or history) rather than the category.",
          ).toBeGreaterThan(0);
          for (const site of [...exactSites, ...dynamicSitesNaming]) {
            expect(
              literalCategory(site),
              `${site.id} writes ${action} with a different category from the backfill. ` +
                "Either the writer was reclassified — in which case INV-OPS-012 wants a " +
                "NEW backfill for the rows this one wrote — or the map is wrong.",
            ).toBe(mapping.category);
          }
          break;
        }
        case "current-writer-dynamic": {
          const site = sites.find((candidate) => candidate.id === evidence.site);
          expect(site, `${action}: evidence names site ${evidence.site}, which the census does not find`).toBeDefined();
          expect(site!.action.startsWith("(dynamic)"), `${site!.id} is not a dynamic site`).toBe(true);
          expect(literalCategory(site!), `${site!.id} does not record ${mapping.category}`).toBe(
            mapping.category,
          );
          // A dynamic site names the literal in its action expression, or — when
          // the census reports only a variable (`(dynamic) auditAction`) — the
          // literal is assigned in the same file; or it is the fee-configuration
          // template family whose closed input set is checked below.
          const namesIt = actionNamesWrittenAt(site!).includes(action);
          const fileNamesIt = readFileSync(path.join(process.cwd(), site!.file), "utf8").includes(
            `"${action}"`,
          );
          const templateFamily = action.startsWith("fee-configuration.");
          expect(
            namesIt || fileNamesIt || templateFamily,
            `${site!.id} neither names "${action}" (in its action expression or its file) nor belongs to a template family this test verifies`,
          ).toBe(true);
          // And no OTHER site writes the action with a different answer.
          for (const other of [...exactSites, ...dynamicSitesNaming]) {
            expect(literalCategory(other), `${other.id} disagrees with the backfill on ${action}`).toBe(
              mapping.category,
            );
          }
          break;
        }
        case "history": {
          expect(
            [...exactSites, ...dynamicSitesNaming].map((site) => site.id),
            `${action} is mapped from repository history, but the tree writes it again. ` +
              "Re-derive the mapping from the new writer and change the evidence kind.",
          ).toEqual([]);
          expect(evidence.commit).toMatch(/^[0-9a-f]{40}$/);
          break;
        }
        case "superseded-writer": {
          // The one kind where the map DISAGREES with the current writer on
          // purpose: the owner decided (13 Sep 2026) that the historical bulk
          // deactivate/reactivate rows take the `account` the exact action
          // carried before #2755, not the `admin` the writer files now. Pin the
          // divergence rather than assume it: the site must exist, must record
          // exactly the category the map says it records, and the mapped
          // category must differ from it — if the writer ever moves back to
          // `account`, this entry becomes a plain `current-writer` and must say so.
          const site = sites.find((candidate) => candidate.id === evidence.site);
          expect(site, `${action}: evidence names site ${evidence.site}, which the census does not find`).toBeDefined();
          expect(literalCategory(site!), `${site!.id} no longer records ${evidence.currentCategory}`).toBe(
            evidence.currentCategory,
          );
          expect(mapping.category, `${action}: a superseded-writer entry whose category equals the writer's is a current-writer entry`).not.toBe(
            evidence.currentCategory,
          );
          expect(evidence.commit).toMatch(/^[0-9a-f]{7,40}$/);
          expect(evidence.note).toMatch(/#2763/);
          // Only the bulk pair may use this kind; anything else is a new
          // divergence between map and writer that needs its own owner decision.
          expect(MEMBER_RECORD_ADMIN_ACTIONS_2755, `${action} is not a #2755 bulk action`).toContain(action);
          expect(["member.bulk-deactivate", "member.bulk-reactivate"]).toContain(action);
          break;
        }
        default: {
          const _exhaustive: never = evidence;
          throw new Error(`unhandled evidence kind for ${action}: ${JSON.stringify(_exhaustive)}`);
        }
      }
    }

    // The evidence tally the prose used to carry by hand, pinned here instead
    // so it is measured on every run and quoted from nowhere else.
    const tally = mapEntries.reduce<Record<string, number>>((counts, [, mapping]) => {
      counts[mapping.evidence.kind] = (counts[mapping.evidence.kind] ?? 0) + 1;
      return counts;
    }, {});
    expect(tally).toEqual({
      "current-writer": 66,
      "current-writer-dynamic": 12,
      history: 3,
      "superseded-writer": 2,
    });
  }, 180_000);

  it("partitions the crossing rows the way the owner decided them", () => {
    // 13 Sep 2026: 3 officer-only LOSES (Xero), 206 GAINS of which 5 reach a
    // member other than the acting officer (set_member_billing_family x3,
    // issue.reported x2). The four corrected rows are counted SEPARATELY by the
    // migration and are outside these figures.
    const crossing = mapEntries.filter(([, m]) => m.memberBoundary !== "none");
    const rows = (entries: typeof crossing) =>
      entries.reduce((sum, [, m]) => sum + m.rowsMeasured, 0);
    const loses = crossing.filter(([, m]) => m.memberBoundary === "loses");
    const gains = crossing.filter(([, m]) => m.memberBoundary === "gains");
    const subjectGains = gains.filter(
      ([action]) => action === "fee-configuration.set_member_billing_family" || action === "issue.reported",
    );
    expect(crossing).toHaveLength(25);
    expect(rows(crossing)).toBe(209);
    expect(rows(loses)).toBe(3);
    expect(rows(gains)).toBe(206);
    expect(rows(subjectGains)).toBe(5);
    for (const [, m] of loses) expect(m.whoIsAffected).toMatch(/officer only/);
    for (const [action, m] of gains) {
      if (subjectGains.some(([a]) => a === action)) expect(m.whoIsAffected).not.toMatch(/only/);
      else expect(m.whoIsAffected).toMatch(/only/);
    }
    expect(
      HISTORICAL_NON_CANONICAL_CATEGORY_CORRECTIONS_2581.reduce((sum, c) => sum + c.rowsMeasured, 0),
    ).toBe(4);
  });

  it("keeps the UPGRADING postflight query's category list equal to the taxonomy", () => {
    // docs/UPGRADING.md → "One-off categorisation of older activity entries
    // with no category (#2581)" → "Verify it yourself" retypes the eleven
    // canonical values in a NOT IN (...) literal, because SQL has no table to
    // join them from. A twelfth category added to AUDIT_CATEGORIES would make
    // that query report every row of it as "outside the taxonomy" — so the copy
    // is pinned to the source here (`INV-SSOT`).
    const upgrading = readFileSync(path.join(process.cwd(), "docs", "UPGRADING.md"), "utf8");
    const list = upgrading.match(
      /-- Nothing left on a value outside the taxonomy[\s\S]*?NOT IN \(([^)]*)\)/,
    );
    expect(list, "docs/UPGRADING.md: the postflight NOT IN query was not found").toBeTruthy();
    const docCategories = [...list![1].matchAll(/'([a-z]+)'/g)].map((m) => m[1]).sort();
    expect(
      docCategories,
      "docs/UPGRADING.md (#2581 section, 'Verify it yourself'): the NOT IN list of " +
        "canonical categories no longer equals AUDIT_CATEGORIES. Update the doc query.",
    ).toEqual([...AUDIT_CATEGORIES].sort());
  });

  it("maps the fee-configuration template family from the route's own closed input set", () => {
    // The writer is `fee-configuration.${parsed.data.action.toLowerCase()}` over
    // a discriminated union, so the census cannot name the literals. Read them
    // from the route: the eight `z.literal(...)` discriminators, lower-cased,
    // must be exactly the eight `fee-configuration.*` actions the map carries.
    const route = readFileSync(
      path.join(process.cwd(), "src", "app", "api", "admin", "fee-configuration", "route.ts"),
      "utf8",
    );
    const fromRoute = [...route.matchAll(/action:\s*z\.literal\("([A-Z_]+)"\)/g)]
      .map((match) => `fee-configuration.${match[1].toLowerCase()}`)
      .sort();
    const fromMap = Object.keys(HISTORICAL_NULL_CATEGORY_MAP_2581)
      .filter((action) => action.startsWith("fee-configuration."))
      .sort();
    expect(fromRoute.length).toBeGreaterThan(0);
    expect(fromMap, "the map's fee-configuration.* actions are not the route's literals").toEqual(fromRoute);

    // The bulk-member pair: owner decision of 13 Sep 2026 (#2581, following
    // #2763) — `account`, the pre-#2755 category, NOT the writer's `admin`; and
    // `member.bulk-set-role` had no null rows and is not mapped.
    for (const action of ["member.bulk-deactivate", "member.bulk-reactivate"]) {
      expect(MEMBER_RECORD_ADMIN_ACTIONS_2755).toContain(action);
      expect(HISTORICAL_NULL_CATEGORY_MAP_2581[action]?.category).toBe("account");
      expect(HISTORICAL_NULL_CATEGORY_MAP_2581[action]?.evidence.kind).toBe("superseded-writer");
      expect(HISTORICAL_NULL_CATEGORY_MAP_2581[action]?.memberBoundary).toBe("none");
    }
    expect(HISTORICAL_NULL_CATEGORY_MAP_2581["member.bulk-set-role"]).toBeUndefined();
    expect(sqlWithoutComments).not.toContain("member.bulk-set-role");
  });

  it("derives the member-boundary column from the real timeline filter, not from prose", () => {
    // A null row is on a member's own timeline today ONLY through the legacy
    // action-name leg of buildMemberVisibleAuditLogWhere; a categorised row is
    // there ONLY if its category is member-visible. The map's `memberBoundary`
    // must be exactly the difference between those two answers — this is the
    // table the owner decides on, so it may not be hand-typed.
    for (const [action, mapping] of mapEntries) {
      const visibleToday = memberVisible(rowOf(action, null));
      const visibleAfter = memberVisible(rowOf(action, mapping.category));
      const derived =
        visibleToday === visibleAfter ? "none" : visibleAfter ? "gains" : "loses";
      expect(
        mapping.memberBoundary,
        `${action}: the map says "${mapping.memberBoundary}" but the real filters say ` +
          `"${derived}" (visible today: ${visibleToday}, after: ${visibleAfter}). ` +
          "INV-OPS-012 makes a crossing the owner's decision, so this column must be true.",
      ).toBe(derived);
      if (derived === "none") {
        expect(mapping.whoIsAffected, `${action} crosses nothing; drop whoIsAffected`).toBeUndefined();
      } else {
        expect(mapping.whoIsAffected, `${action} crosses the boundary; say whose timeline`).toBeTruthy();
      }
    }

    // The four corrected rows: none is member-visible today (a non-canonical
    // string satisfies neither leg), so any member-visible destination GAINS.
    for (const correction of HISTORICAL_NON_CANONICAL_CATEGORY_CORRECTIONS_2581) {
      expect(memberVisible(rowOf(correction.action, correction.from))).toBe(false);
    }
  });

  it("changes who can read each row exactly as its category says — Admin filter and Diagnostics entry", () => {
    const domainsTouched = new Set<string>();
    for (const [action, mapping] of mapEntries) {
      const category = mapping.category as AuditCategory;
      const after = rowOf(action, category);

      // Admin > Audit Log: the stored category wins over the legacy guess. The
      // row answers to its own category filter and to no other.
      expect(evalWhere(buildAuditCategoryWhere(category), after), `${action} not found under ${category}`).toBe(true);
      for (const other of AUDIT_CATEGORIES) {
        if (other === category) continue;
        expect(
          evalWhere(buildAuditCategoryWhere(other), after),
          `${action} (${category}) still answers to the ${other} filter after the backfill`,
        ).toBe(false);
      }

      // AI Diagnostics: readable by exactly one correlation entry — the one the
      // taxonomy maps the category to — and by that entry's area set.
      const domain = AUDIT_CATEGORY_CORRELATION_DOMAIN[category];
      domainsTouched.add(domain);
      expect(auditCategoriesForCorrelationDomain(domain)).toContain(category);
      for (const other of AUDIT_CORRELATION_DOMAINS) {
        if (other === domain) continue;
        expect(
          auditCategoriesForCorrelationDomain(other),
          `${action} (${category}) is readable by the ${other} entry as well as ${domain}`,
        ).not.toContain(category);
      }
      // Support alone runs only the system entry, so a row outside the system
      // domain is NOT retrievable by a support-only operator.
      const areas = AUDIT_CORRELATION_DOMAIN_AREAS[domain];
      expect(areas).toContain("support");
      if (domain !== "system") {
        expect(areas.length, `${category} needs a domain area on top of support`).toBeGreaterThan(1);
        expect(auditCategoriesForCorrelationDomain("system")).not.toContain(category);
      }
    }
    // Representative coverage across domains, as the issue's §5 asks.
    expect(domainsTouched.size).toBeGreaterThanOrEqual(4);
  });

  it("keeps the pair list literal, and keeps `category` the only column any SET clause writes", () => {
    expect(sqlWithoutComments).not.toMatch(/"action"\s+(NOT\s+)?LIKE/i);
    expect(sqlWithoutComments).not.toMatch(/"action"\s*~/);
    expect(sqlWithoutComments).not.toMatch(/starts_with\s*\(\s*(a\.)?"action"/i);
    expect(sqlWithoutComments).not.toMatch(/"action"\s+(NOT\s+)?ILIKE/i);

    const setClauses = [
      ...sqlWithoutComments.matchAll(/UPDATE "AuditLog"(?: a)?\s+SET\s+([\s\S]*?)\s+(?:FROM|WHERE)\b/g),
    ].map((match) => match[1].trim());
    expect(
      setClauses,
      "Expected exactly three UPDATEs: the mapped rewrite and the two exception corrections.",
    ).toHaveLength(3);
    for (const clause of setClauses) {
      expect(
        clause,
        "A SET clause names a column other than `category`. Every other field — and " +
          "retentionClass/expiresAt in particular, which these rows do not have and " +
          "must not be given here — keeps the bytes it was written with (#2581 §3).",
      ).toMatch(/^"category" = (m\."category"|'[a-z]+')$/);
    }
    // The mapped rewrite is NULL-only, joined on exact action.
    expect(sqlWithoutComments).toMatch(/WHERE a\."category" IS NULL\s+AND a\."action" = m\."action"/);
  });

  it("corrects exactly the four non-canonical rows the owner named, by prior string AND exact action", () => {
    const corrections = [
      ...sqlWithoutComments.matchAll(
        /UPDATE "AuditLog"\s+SET "category" = '([a-z]+)'\s+WHERE "category" = '(\w+)'\s+AND "action" (?:= '([^']+)'|IN \(([^)]*)\))/g,
      ),
    ].flatMap((match) => {
      const to = match[1];
      const from = match[2];
      const actions = match[3] ? [match[3]] : [...match[4].matchAll(/'([^']+)'/g)].map((m) => m[1]);
      return actions.map((action) => ({ action, from, to }));
    });
    const expected = HISTORICAL_NON_CANONICAL_CATEGORY_CORRECTIONS_2581.map(({ action, from, to }) => ({
      action,
      from,
      to,
    }));
    const key = (c: { action: string }) => c.action;
    expect(
      corrections.sort((a, b) => key(a).localeCompare(key(b))),
      "The migration's exception UPDATEs and HISTORICAL_NON_CANONICAL_CATEGORY_CORRECTIONS_2581 " +
        "no longer name the same rows. The owner listed exactly four on 13 Sep 2026; " +
        "decision 6 covers everything else.",
    ).toEqual(expected.sort((a, b) => key(a).localeCompare(key(b))));

    // And each correction lands on the category the action's current writer records.
    const sites = census().sites;
    for (const { action, to } of expected) {
      const writers = sites.filter((site) => site.action === action);
      expect(writers.length, `${action} has no current writer to check against`).toBeGreaterThan(0);
      for (const site of writers) {
        expect(literalCategory(site), `${site.id} records a different category from the correction`).toBe(to);
      }
    }
  }, 180_000);

  it("records what it did, and only when something moved", () => {
    expect(sqlWithoutComments).toContain("'AUDIT_CATEGORY_BACKFILLED'");
    for (const key of [
      "'nullBefore'",
      "'mappedNullBefore'",
      "'rewritten'",
      "'rewrittenByCategory'",
      "'rewrittenByAction'",
      "'correctedNonCanonical'",
      "'nullAfter'",
      "'unmappedNullRemaining'",
    ]) {
      expect(sqlWithoutComments, `the record lacks ${key}`).toContain(key);
    }
    expect(
      sqlWithoutComments.replace(/\s+/g, " "),
      "The backfill's own audit row is no longer gated on rows having actually " +
        "moved, so the post-cutover replay the runbook asks for would append a " +
        "record of a rewrite that did not happen.",
    ).toContain(
      "WHERE (SELECT count(*) FROM rewritten) + (SELECT count(*) FROM corrected_email) + (SELECT count(*) FROM corrected_membership) > 0",
    );
  });
});
