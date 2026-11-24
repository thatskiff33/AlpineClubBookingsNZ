/**
 * #4165 (`INV-SSOT-006`, `INV-OPS-012`): making the audit category filters'
 * action prefixes literal moved no action between categories and changed no
 * member's timeline.
 *
 * The legacy action-name leg of `buildAuditCategoryWhere` and
 * `buildMemberVisibleAuditLogWhere` (rows whose `category` IS NULL) used bare
 * Prisma `startsWith` prefixes, which PostgreSQL reads as `LIKE`, so each `_`
 * was a wildcard. They now go through `exactPrefix`. Which rows a member sees
 * is the owner's decision, so this replays EVERY action this tree can write
 * and every action the #2581 history measured on null rows through both the
 * literal filter and the old one (`unescapeLikeOperands`), via the shared
 * `matchesWhere`, which reads `startsWith` as PostgreSQL's unescaped `LIKE`.
 * Any action whose category or member visibility differs fails here by name.
 *
 * WHAT IT READS. The audit-writer census's literal actions; the constant an
 * UPPER_SNAKE dynamic site names, resolved from its `const` in `src/`; the
 * #2581 history maps; and the `xero.` actions the census cannot name. A
 * dynamic site built from a variable or a template the census cannot resolve
 * is outside it; a review of every string literal in `src/` and the
 * migrations for #4165 found none but the `xero.` family whose old match ran
 * through a wildcard. `audit-query-exact-prefix.realdb.test.ts` proves the
 * same equality against PostgreSQL itself.
 *
 * WHAT IT DOES NOT PIN. Both sides are built from the CURRENT prefix list, so
 * this measures the escaping and nothing else: editing a prefix moves both
 * sides at once and passes here. The member-boundary of the #2581 history is
 * pinned against the real filters by `historical-audit-category-backfill.test.ts`.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { AUDIT_CATEGORIES } from "../audit-categories";
import {
  buildAuditCategoryWhere,
  buildMemberVisibleAuditLogWhere,
  isMemberVisibleAuditCategory,
} from "../audit-query";
import {
  literalActionNamesAt,
  scanAuditWriterCensus,
} from "../../../scripts/audit/audit-writer-census";
import {
  HISTORICAL_NON_CANONICAL_CATEGORY_CORRECTIONS_2581,
  HISTORICAL_NULL_CATEGORY_MAP_2581,
  WITHHELD_HISTORICAL_NULL_ACTIONS_2581,
} from "../../../scripts/audit/audit-writer-census-manifest";
import { matchesWhere } from "./support/prisma-where";
import {
  LEGACY_FILTER_OPERANDS_WITHOUT_A_DECOY,
  LEGACY_FILTER_PREFIX_WITNESSES,
  LEGACY_FILTER_WILDCARD_DECOYS,
  XERO_DOT_ACTIONS_THE_CENSUS_CANNOT_NAME,
  unescapeLikeOperands,
} from "./support/audit-legacy-filter-like";
import { AST_CENSUS_TIMEOUT_MS } from "@/test/census-timeout";

const MEMBER = "member-under-test";

/** A null-category row of `action` that concerns MEMBER through the subject leg. */
function rowOf(action: string) {
  return {
    action,
    category: null,
    subjectMemberId: MEMBER,
    memberId: null,
    actorMemberId: null,
    targetId: null,
    entityType: null,
    entityId: null,
  };
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "__tests__" ? [] : sourceFiles(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

/** `NAME` -> its string value, for every `const NAME = "…"` in `src/`. */
function stringConstants(): Map<string, string> {
  const constants = new Map<string, string>();
  for (const file of sourceFiles(join(process.cwd(), "src"))) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/\bconst\s+([A-Z][A-Z0-9_]*)\s*(?::[^=]+)?=\s*\n?\s*"([^"\n]+)"/g)) {
      constants.set(match[1], match[2]);
    }
  }
  return constants;
}

type Population = { actions: Set<string>; unresolvedConstants: string[] };

let cached: Population | undefined;
function population(): Population {
  if (cached) return cached;
  const actions = new Set<string>();
  const unresolvedConstants: string[] = [];
  const constants = stringConstants();
  for (const site of scanAuditWriterCensus().sites) {
    for (const action of literalActionNamesAt(site, { onNone: "empty" })) actions.add(action);
    const constant = /^\(dynamic\) ([A-Z][A-Z0-9_]*)$/.exec(site.action)?.[1];
    if (constant) {
      const value = constants.get(constant);
      if (value) actions.add(value);
      else unresolvedConstants.push(`${site.id}: ${constant}`);
    }
  }
  for (const action of Object.keys(HISTORICAL_NULL_CATEGORY_MAP_2581)) actions.add(action);
  for (const action of Object.keys(WITHHELD_HISTORICAL_NULL_ACTIONS_2581)) actions.add(action);
  for (const correction of HISTORICAL_NON_CANONICAL_CATEGORY_CORRECTIONS_2581) actions.add(correction.action);
  for (const action of XERO_DOT_ACTIONS_THE_CENSUS_CANNOT_NAME) actions.add(action);
  cached = { actions, unresolvedConstants };
  return cached;
}

function categoriesOf(row: ReturnType<typeof rowOf>, unescape: boolean): string[] {
  return AUDIT_CATEGORIES.filter((category) => {
    const where = buildAuditCategoryWhere(category)!;
    return matchesWhere(row, unescape ? unescapeLikeOperands(where) : where);
  });
}

function memberVisible(row: ReturnType<typeof rowOf>, unescape: boolean): boolean {
  const where = buildMemberVisibleAuditLogWhere(MEMBER);
  return matchesWhere(row, unescape ? unescapeLikeOperands(where) : where);
}

describe("the audit category filters match their action prefixes literally (#4165, INV-SSOT-006, INV-OPS-012)", { timeout: AST_CENSUS_TIMEOUT_MS }, () => {
  it("reads the population it claims to", () => {
    const { actions, unresolvedConstants } = population();
    expect(actions.size).toBeGreaterThan(500);
    expect(unresolvedConstants, "a dynamic site names a constant this test could not resolve").toEqual([]);
    // One from each source: a census literal, a resolved constant, the history,
    // and the `xero.` family the census misses.
    for (const action of [
      "MEMBERSHIP_APPLICATION_APPROVED",
      "waitlist.returned_to_waitlist",
      "xero_account_mappings_updated",
      "xero.operation.marked_failed",
      "xero.allocation.restored-booking-change-refused",
    ]) {
      expect(actions).toContain(action);
    }
    // The PostgreSQL proof seeds these as real actions; each must be one.
    expect(LEGACY_FILTER_PREFIX_WITNESSES.filter((action) => !actions.has(action))).toEqual([]);
  });

  it("puts every known action in the same categories, and on the same member timelines, as the wildcard filter did", () => {
    const moved: string[] = [];
    for (const action of population().actions) {
      const row = rowOf(action);
      const before = categoriesOf(row, true);
      const after = categoriesOf(row, false);
      if (before.join() !== after.join()) moved.push(`${action}: [${before}] -> [${after}]`);
      const visibleBefore = memberVisible(row, true);
      const visibleAfter = memberVisible(row, false);
      if (visibleBefore !== visibleAfter) {
        moved.push(`${action}: member-visible ${visibleBefore} -> ${visibleAfter}`);
      }
    }
    expect(
      moved,
      "INV-OPS-012: escaping a legacy audit prefix moved these actions. A change in which rows a member " +
        "sees is the owner's decision; a change of category needs the action named in audit-query.ts.",
    ).toEqual([]);
  });

  it("keeps the xero. family, which reached the xero filter only through the wildcard `xero_`, in it", () => {
    const xeroDot = [...population().actions].filter((action) => action.startsWith("xero."));
    expect(xeroDot.length).toBeGreaterThanOrEqual(12);
    for (const action of xeroDot) {
      expect(matchesWhere(rowOf(action), buildAuditCategoryWhere("xero")!), action).toBe(true);
    }
  });

  it("stays wired into the race harness CI runs against a real database", () => {
    // The PostgreSQL proof self-skips without the race flag; hosted CI reaches
    // it only through the harness's import.
    const harness = readFileSync(join(process.cwd(), "src/lib/__tests__/concurrency-lock-races.realdb.test.ts"), "utf8");
    expect(harness).toContain('import "./audit-query-exact-prefix.realdb.test";');
    const suite = readFileSync(join(process.cwd(), "src/lib/__tests__/audit-query-exact-prefix.realdb.test.ts"), "utf8");
    expect(suite).toContain('process.env.RUN_CONCURRENCY_RACE_TESTS === "1"');
    expect(suite).toContain("is answered by the shared matchesWhere exactly as PostgreSQL answers it");
  });

  it("has a decoy for every legacy operand whose text holds a LIKE wildcard", () => {
    // Every `startsWith` / `contains` operand in the category filters, as the
    // literal (escaped) and old (unescaped) spellings, found by walking the
    // built where objects so a new prefix is seen without being listed here.
    const operands: { operator: "startsWith" | "contains"; literal: string }[] = [];
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (typeof node !== "object" || node === null) return;
      for (const [key, value] of Object.entries(node)) {
        if ((key === "startsWith" || key === "contains") && typeof value === "string") {
          operands.push({ operator: key, literal: value });
        } else walk(value);
      }
    };
    for (const category of AUDIT_CATEGORIES) walk(buildAuditCategoryWhere(category));
    // The text a person reads: the escaped operand with its escapes removed.
    const text = (literal: string) => literal.replace(/\\(.)/gs, "$1");
    const withWildcard = operands.filter(({ literal }) => /[_%]/.test(text(literal)));
    expect(withWildcard.length, "found no operand with a `_` (the walk is broken)").toBeGreaterThan(5);
    const uncovered = withWildcard
      .filter(({ literal }) => !LEGACY_FILTER_OPERANDS_WITHOUT_A_DECOY.includes(text(literal)))
      .filter(({ operator, literal }) => {
        const old = { action: { [operator]: text(literal) } };
        const now = { action: { [operator]: literal } };
        return !LEGACY_FILTER_WILDCARD_DECOYS.some(
          ({ action }) => matchesWhere(rowOf(action), old) && !matchesWhere(rowOf(action), now),
        );
      })
      .map(({ operator, literal }) => `${operator}: ${text(literal)}`);
    expect(
      uncovered,
      "#4165: each legacy audit operand holding a `_` or `%` needs a decoy in LEGACY_FILTER_WILDCARD_DECOYS " +
        "(support/audit-legacy-filter-like.ts) that only its wildcard matches, or the escaping is unproven for it.",
    ).toEqual([]);
  });

  it("no longer files a wildcard decoy anywhere (non-vacuity)", () => {
    for (const { action, oldCategories } of LEGACY_FILTER_WILDCARD_DECOYS) {
      const row = rowOf(action);
      expect(categoriesOf(row, true), `${action} under the old filter`).toEqual(
        AUDIT_CATEGORIES.filter((category) => oldCategories.includes(category)),
      );
      expect(categoriesOf(row, false), `${action} under the literal filter`).toEqual([]);
      expect(memberVisible(row, true)).toBe(oldCategories.some((category) => isMemberVisibleAuditCategory(category)));
      expect(memberVisible(row, false)).toBe(false);
    }
  });
});
