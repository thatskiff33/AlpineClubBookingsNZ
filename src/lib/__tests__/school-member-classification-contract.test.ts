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
  classifySchoolMember,
  isSameSchoolNameClaim,
  provesOrganisation,
  provesPerson,
} from "@/lib/school-member-classification";
import {
  foldOrganisationName,
  schoolNameClaimSql,
  schoolNameFoldSql,
} from "@/lib/school-organisations";

const MIGRATIONS_DIR = path.join(process.cwd(), "prisma", "migrations");
const BACKFILL_SQL_PATH = path.join(
  MIGRATIONS_DIR,
  "20260922020000_backfill_school_bookings_to_organisations",
  "migration.sql",
);
/** Every #3369 file that folds a school name, so none of them can drift alone. */
const NAME_FOLDING_SQL_FILES = [
  BACKFILL_SQL_PATH,
  path.join(
    MIGRATIONS_DIR,
    "20260922020000_backfill_school_bookings_to_organisations",
    "rollback.sql",
  ),
] as const;

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

describe("#3369: the name fold has exactly one home, in both languages", () => {
  // The blocker this suite was extended for. The migration's member side folded
  // as btrim-then-collapse, and PostgreSQL's one-argument btrim strips ONLY the
  // space character while `\s` also matches a tab — so a school whose stored
  // name began with a tab kept it through the trim, had it turned into a space
  // by the collapse, and then matched nothing. The backfill minted a record
  // whose name began with a space, failed to resolve that record back, and
  // raised its unresolved-organisation exception in the middle of the
  // maintenance window. Collapse first and a trim removes it.

  it("folds a leading tab away, in TypeScript", () => {
    expect(foldOrganisationName("\tTokoroa Primary School")).toBe(
      "Tokoroa Primary School",
    );
    expect(foldOrganisationName("Tokoroa\tPrimary\nSchool  ")).toBe(
      "Tokoroa Primary School",
    );
  });

  it("is idempotent, which is what lets a folded name be folded again", () => {
    // The backfill stores a folded name in `Organisation.name` and then folds
    // that stored name again to find the record it has just written. A fold
    // that were not idempotent would not find it.
    for (const raw of [
      "\t Tokoroa   Primary School ",
      `${"x".repeat(199)} ${"y".repeat(40)}`,
      "St. Peter's College",
    ]) {
      expect(foldOrganisationName(foldOrganisationName(raw))).toBe(
        foldOrganisationName(raw),
      );
    }
  });

  it("caps at the 200 characters the column holds, and trims what the cut left", () => {
    const long = `${"a".repeat(199)} b`;
    expect(foldOrganisationName(long)).toBe("a".repeat(199));
  });

  it("EVERY fold in the #3369 SQL is the generated one — no hand-written copy", () => {
    // The strong form. Counting the generated strings alone would pass while a
    // fifth, hand-written fold sat beside them; this fails unless every
    // `regexp_replace(` in those files is part of an expression generated here.
    // The claim form is the fold wrapped in `lower(...)`, so counting the bare
    // fold accounts for both spellings without double-counting either.
    const generated = [
      schoolNameFoldSql('m."firstName"'),
      schoolNameFoldSql('o."name"'),
    ];
    for (const file of NAME_FOLDING_SQL_FILES) {
      const sql = readFileSync(file, "utf8");
      const total = sql.split("regexp_replace(").length - 1;
      const accountedFor = generated.reduce(
        (sum, expression) => sum + (sql.split(expression).length - 1),
        0,
      );
      expect(
        total,
        `${path.basename(path.dirname(file))}/${path.basename(file)} folds a school name ` +
          `${total} time(s) but only ${accountedFor} of those are the fold in ` +
          "src/lib/school-organisations.ts. A second spelling of the fold is how " +
          "one school's name comes to mean two things (`INV-SSOT`).",
      ).toBe(accountedFor);
      expect(total).toBeGreaterThan(0);
      // And the COMPARISON spelling is the generated one too, so a hand-rolled
      // `lower(...)` around the right fold cannot slip past the count above.
      expect(sql).toContain(schoolNameClaimSql('o."name"'));
    }
  });

  it("FAILS when a SQL fold reverts to the btrim-first order (mutation proof)", () => {
    const sql = readFileSync(BACKFILL_SQL_PATH, "utf8");
    const mutated = sql.replace(
      schoolNameFoldSql('m."firstName"'),
      `left(regexp_replace(btrim(m."firstName"), '\\s+', ' ', 'g'), 200)`,
    );
    expect(mutated, "the mutation must actually change the file").not.toBe(sql);
    // The claim form is the fold wrapped in `lower(...)`, so counting the bare
    // fold accounts for both spellings without double-counting either.
    const generated = [
      schoolNameFoldSql('m."firstName"'),
      schoolNameFoldSql('o."name"'),
    ];
    const total = mutated.split("regexp_replace(").length - 1;
    const accountedFor = generated.reduce(
      (sum, expression) => sum + (mutated.split(expression).length - 1),
      0,
    );
    expect(accountedFor).toBeLessThan(total);
  });
});

describe("#3369: the two proofs, and the one folding they share", () => {
  it("proves a school only from writer-authored evidence, not from a shape", () => {
    // Blank surname and cannot sign in are necessary but NOT sufficient: the
    // converted request naming this very row under the same school name is
    // what makes it a proof rather than a guess about how a name looks.
    const shapeOnly = {
      firstName: "Tokoroa Primary School",
      lastName: "",
      canLogin: false,
      convertedSchoolRequestNames: [] as string[],
    };
    expect(provesOrganisation(shapeOnly)).toBe(false);
    expect(
      provesOrganisation({
        ...shapeOnly,
        convertedSchoolRequestNames: ["Tokoroa Primary School"],
      }),
    ).toBe(true);
  });

  it("refuses the proof for a row that can sign in, or that has a surname", () => {
    const proved = {
      firstName: "Tokoroa Primary School",
      lastName: "",
      canLogin: false,
      convertedSchoolRequestNames: ["Tokoroa Primary School"],
    };
    expect(provesOrganisation({ ...proved, canLogin: true })).toBe(false);
    expect(provesOrganisation({ ...proved, lastName: "Ngata" })).toBe(false);
  });

  it("proves a person from any one of the three teacher marks", () => {
    const none = {
      lastName: "",
      canLogin: false,
      isSchoolBookingHutLeader: false,
    };
    expect(provesPerson(none)).toBe(false);
    expect(provesPerson({ ...none, canLogin: true })).toBe(true);
    expect(provesPerson({ ...none, lastName: "Ngata" })).toBe(true);
    expect(provesPerson({ ...none, isSchoolBookingHutLeader: true })).toBe(true);
  });

  it("folds a name the way the CLAIM does, and no more coarsely", () => {
    // Trim, collapse whitespace, ignore case — the same question
    // `schoolOrganisationNameClaim()` asks Postgres. Coarser folding would let
    // one school's name prove another school's row, which is a near-miss merge
    // by another route and #2912 forbids one.
    expect(isSameSchoolNameClaim("  Tokoroa   Primary School ", "tokoroa primary school")).toBe(true);
    // A tab is whitespace too, and `btrim` in SQL is not (see the fold suite).
    expect(isSameSchoolNameClaim("\tTokoroa Primary School", "tokoroa primary school")).toBe(true);
    // The cap the claim filter applies. Without it this helper called itself
    // "the ONE folding" while answering a question the claim would not.
    expect(
      isSameSchoolNameClaim("a".repeat(200), `${"a".repeat(200)}b`),
    ).toBe(true);
    expect(isSameSchoolNameClaim("Tokoroa Primary", "Tokoroa Primary School")).toBe(false);
    expect(isSameSchoolNameClaim("St. Peter's College", "St Peters College")).toBe(false);
    expect(isSameSchoolNameClaim("", "Anything")).toBe(false);
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
