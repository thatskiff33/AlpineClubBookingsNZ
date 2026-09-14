/**
 * THE CENSUS AND THE MIGRATION ASK THE SAME QUESTION (#3369, `INV-SSOT`).
 *
 * `src/lib/school-member-classification.ts` decides which member rows the
 * cutover needs an answer for. The backfill migration decides which rows it
 * refuses to run without one. If those two ever differ, the census reports
 * "nothing left to decide" about a row the migration then demands a decision
 * for — and that discovery happens inside a maintenance window, with the club
 * offline, which is the worst possible moment to find it.
 *
 * SQL cannot import TypeScript, so the predicate is written once in the module
 * and copied into the migration, and this test is what keeps the copy honest.
 * It compares under whitespace normalisation: a re-indented copy is the same
 * program, and demanding byte equality would fail on a reformat while catching
 * nothing extra.
 *
 * This file also pins the properties of the classification rule that a reader
 * of the module might reasonably assume and that must not quietly change: that
 * contradictory evidence is a question rather than a tie-break, and that the
 * fail-closed check really is the first thing the migration does.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  SCHOOL_CLASSIFICATION_CANDIDATE_SQL,
  SCHOOL_CLASSIFICATION_ORGANISATION_PROOF_SQL,
  SCHOOL_CLASSIFICATION_PERSON_PROOF_SQL,
  censusSql,
  classifySchoolMember,
  foldSchoolNameSql,
} from "@/lib/school-member-classification";

const BACKFILL_SQL_PATH = path.join(
  process.cwd(),
  "prisma",
  "migrations",
  "20260922020000_backfill_school_bookings_to_organisations",
  "migration.sql",
);

/** Runs of whitespace are not part of the program. Nothing else is folded. */
function normalise(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

const backfillSql = readFileSync(BACKFILL_SQL_PATH, "utf8");

describe("#3369: the candidate predicate has exactly one home", () => {
  it("appears in the backfill migration, twice and only where it belongs", () => {
    const haystack = normalise(backfillSql);
    const needle = normalise(SCHOOL_CLASSIFICATION_CANDIDATE_SQL);
    const occurrences = haystack.split(needle).length - 1;
    expect(
      occurrences,
      "The migration must ask the census's question, verbatim: once in the " +
        "fail-closed check that refuses an unclassified row, and once when it " +
        "builds the map of rows to re-parent. If this fails, the module and " +
        "the migration have drifted — fix the migration rather than loosening " +
        "this test (`INV-SSOT`).",
    ).toBe(2);
  });

  it("FAILS when the migration's copy drifts (mutation proof)", () => {
    // Without this the assertion above could be satisfied by a substring that
    // happens to appear for another reason, and nobody could tell.
    const mutated = backfillSql.replace(
      `m."role" = 'SCHOOL'`,
      `m."role" IN ('SCHOOL', 'NON_MEMBER')`,
    );
    expect(mutated, "the mutation must actually change the file").not.toBe(
      backfillSql,
    );
    const occurrences =
      normalise(mutated).split(normalise(SCHOOL_CLASSIFICATION_CANDIDATE_SQL))
        .length - 1;
    expect(occurrences).toBeLessThan(2);
  });

  it("the fail-closed refusal is the migration's first statement", () => {
    // It has to be. A refusal after the first UPDATE would still roll back —
    // the file is one transaction — but "writes nothing" is much easier to
    // believe, and much cheaper to keep true, when nothing has been attempted.
    const firstStatement = backfillSql
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("--"))
      .join("\n")
      .replace(/^\s*BEGIN\s*;/i, "")
      .trimStart();
    expect(firstStatement.startsWith("DO $fail_closed$")).toBe(true);
    expect(firstStatement).toContain("school_member_classification_incomplete");
  });

  it("the refusal carries no member id, school name or count", () => {
    // Error privacy. The operator is sent to the census, which is where the
    // list belongs — a maintenance-window stack trace is not.
    const failClosed = backfillSql.slice(
      backfillSql.indexOf("DO $fail_closed$"),
      backfillSql.indexOf("$fail_closed$;"),
    );
    expect(failClosed).not.toMatch(/USING\s+DETAIL/i);
    expect(failClosed).not.toMatch(/count\s*\(/i);
    expect(failClosed).not.toMatch(/"firstName"|"email"/);
  });
});

describe("#3369: the census query is built from the shared proofs", () => {
  const sql = censusSql();

  it("embeds both proofs and the candidate predicate", () => {
    for (const fragment of [
      SCHOOL_CLASSIFICATION_CANDIDATE_SQL,
      SCHOOL_CLASSIFICATION_ORGANISATION_PROOF_SQL,
      SCHOOL_CLASSIFICATION_PERSON_PROOF_SQL,
    ]) {
      expect(normalise(sql)).toContain(normalise(fragment));
    }
  });

  it("folds a school name the way the claim does, not the way Xero's search does", () => {
    // Coarser folding here would let one school's name prove another school's
    // row, which is a near-miss merge by another route (#2912 forbids one).
    expect(foldSchoolNameSql('m."firstName"')).toBe(
      `lower(regexp_replace(btrim(m."firstName"), '\\s+', ' ', 'g'))`,
    );
  });
});

describe("#3369: contradictory evidence is a question, not a tie-break", () => {
  it("settles a row only when exactly one proof holds", () => {
    expect(
      classifySchoolMember({ organisationProof: true, personProof: false }),
    ).toBe("ORGANISATION");
    expect(
      classifySchoolMember({ organisationProof: false, personProof: true }),
    ).toBe("PERSON");
  });

  it("returns CANNOT_TELL when neither proof holds", () => {
    expect(
      classifySchoolMember({ organisationProof: false, personProof: false }),
    ).toBe("CANNOT_TELL");
  });

  it("returns CANNOT_TELL when BOTH proofs hold", () => {
    // The one a priority order would quietly get wrong. A row with a blank
    // surname, a converted school request naming it AND a teacher's hut-leader
    // assignment is telling two stories about itself; picking a winner would be
    // the silent ambiguous fallback #2912 forbids, wearing a rule as a disguise.
    expect(
      classifySchoolMember({ organisationProof: true, personProof: true }),
    ).toBe("CANNOT_TELL");
  });
});
