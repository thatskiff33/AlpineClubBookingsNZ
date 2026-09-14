/**
 * WHAT A HISTORICAL SCHOOL-SHAPED MEMBER ROW ACTUALLY IS (#3369, stage 4 of
 * programme #2912). `INV-SSOT`, `INV-OPS-002`/`INV-OPS-010`.
 *
 * ## The question, and why it cannot be answered by looking at the name
 *
 * Before this programme a school was a `Member` row: the school's name in
 * `firstName`, a blank `lastName`, `role: SCHOOL`, and the booking hung off it.
 * The real teacher was a second `role: SCHOOL` row. Stage 4 moves the school's
 * bookings onto its `Organisation` and leaves the teacher's alone — so before
 * the cutover somebody has to say, of every one of those rows, which it is.
 *
 * The binding rule on #2912 is that the answer comes from EVIDENCE or from a
 * PERSON, and never from a fallback:
 *
 * > No fuzzy merge, no invented surname, no silent ambiguous fallback. If
 * > ambiguity cannot be safely resolved, cutover is blocked.
 *
 * So this module holds two proofs and no guess. A row that satisfies neither —
 * or, just as importantly, BOTH — is `CANNOT_TELL`, and a `CANNOT_TELL` row is
 * not a classification. It is a question for the club, and the backfill will
 * not run while one is open.
 *
 * ## Where the answer is stored, and who writes it
 *
 * `SchoolMemberClassification`, one row per member, written by
 * `scripts/school-member-classification-census.ts`:
 *
 * - rows the proofs below settle are written with `decidedBy = "census"` and
 *   the proof recorded verbatim in `evidence`;
 * - every other row is printed for a person, who records it one at a time under
 *   their own name with their own reason. There is no bulk classify.
 *
 * The backfill migration `20260922020000` READS that table and derives nothing.
 * That separation is the point: a migration that worked out the answer while it
 * ran would be making the judgement in the dark, at the least reversible moment
 * there is.
 *
 * ## The one thing the migration and this module BOTH have to agree on
 *
 * Which rows are candidates at all. If the migration's idea of a candidate were
 * wider than the census's, the census would report "nothing left to decide"
 * about a row the migration then demands a decision for. So the candidate
 * predicate is written ONCE, here, and
 * `src/lib/__tests__/school-member-classification-contract.test.ts` fails if the
 * migration's copy has drifted from it (`INV-SSOT`).
 *
 * The PROOFS are deliberately not shared with the migration, because the
 * migration never applies them.
 */

import { SchoolMemberClassificationKind } from "@prisma/client";

/**
 * Fold a school name the way {@link normaliseOrganisationName} does, in SQL:
 * trim, collapse internal whitespace, ignore case.
 *
 * This is the CLAIM, the same question `schoolOrganisationNameClaim()` asks
 * Postgres — not the coarser Xero-search folding used to PROVE that a provider
 * contact belongs where the provider said. See the "Two questions" section of
 * `school-organisations.ts`. Coarser folding here would let one school's name
 * prove another school's row, which is a near-miss merge by another route.
 */
export function foldSchoolNameSql(column: string): string {
  return `lower(regexp_replace(btrim(${column}), '\\s+', ' ', 'g'))`;
}

/**
 * WHICH ROWS THE CUTOVER NEEDS AN ANSWER FOR. Aliased `m` on `"Member"`.
 *
 * A member with `role = 'SCHOOL'` that owns at least one booking. Both halves
 * matter:
 *
 * - `role = 'SCHOOL'` is the only marker the old writer left. It covers the
 *   invented school row, the teacher row `approveSchoolBookingRequest` created
 *   beside it, and the login-capable `AccessRole.ORG` rows whose legacy role is
 *   derived as `SCHOOL` — all three, deliberately, because all three look alike
 *   from outside and the census is what tells them apart.
 * - **owning a booking** is what makes the row the cutover's business. A school
 *   row with no booking has no ownership to move; classifying it would be
 *   asking the club a question with no consequence, and a census that asks
 *   pointless questions is a census people stop answering.
 *
 * THIS EXACT TEXT IS EMBEDDED IN `20260922020000_backfill_school_bookings.sql`
 * and the contract test compares them. Changing it here without changing the
 * migration is a drift the test fails on.
 */
export const SCHOOL_CLASSIFICATION_CANDIDATE_SQL = `m."role" = 'SCHOOL' AND EXISTS (SELECT 1 FROM "Booking" b WHERE b."memberId" = m."id")`;

/**
 * PROOF THAT A ROW IS A SCHOOL, not a person. Aliased `m` on `"Member"`.
 *
 * All three of:
 *
 * 1. a blank surname — the shape the old writer produced, and the shape a real
 *    person never has, because the club records one;
 * 2. `canLogin = false` — nobody has ever signed in as this row;
 * 3. a `SCHOOL` booking request that names this very row as the member it
 *    converted to, carrying the same school name the row holds in `firstName`.
 *
 * The third is the one that makes this a proof rather than a shape test. It is
 * writer-authored evidence: `approveSchoolBookingRequest` set
 * `convertedMemberId` to the member it had just created out of `schoolName`, in
 * the same transaction. Nothing else in the system writes that pair, so a row
 * satisfying it was created as a school by a code path we can read.
 *
 * Names are compared under the claim folding, not raw, because a request typed
 * `  Tokoroa  Primary School ` produced a member named `Tokoroa Primary School`.
 * Neither side is truncated: `"Member"."firstName"` and
 * `"BookingRequest"."schoolName"` are TEXT and VARCHAR(200) respectively, and no
 * school name in the column exceeds either.
 */
export const SCHOOL_CLASSIFICATION_ORGANISATION_PROOF_SQL = `btrim(m."lastName") = ''
  AND m."canLogin" = false
  AND EXISTS (
    SELECT 1 FROM "BookingRequest" r
    WHERE r."convertedMemberId" = m."id"
      AND r."type" = 'SCHOOL'
      AND r."schoolName" IS NOT NULL
      AND ${foldSchoolNameSql('r."schoolName"')} = ${foldSchoolNameSql('m."firstName"')}
  )`;

/**
 * PROOF THAT A ROW IS A PERSON. Aliased `m` on `"Member"`.
 *
 * Any one of:
 *
 * - it can sign in. An organisation never does; a person with `AccessRole.ORG`
 *   does, and that is exactly who those rows are.
 * - it has a surname. The old writer left the school's blank, and a club does
 *   not record a surname for a building.
 * - it is a school booking's hut leader. `approveSchoolBookingRequest` creates
 *   that assignment for the teacher and for nobody else.
 */
export const SCHOOL_CLASSIFICATION_PERSON_PROOF_SQL = `m."canLogin" = true
  OR btrim(m."lastName") <> ''
  OR EXISTS (
    SELECT 1 FROM "HutLeaderAssignment" h
    WHERE h."memberId" = m."id" AND h."source" = 'SCHOOL_BOOKING'
  )`;

/**
 * THE CENSUS QUERY. One statement, built from the three constants above so that
 * "what the census counted" and "what the rule says" cannot come apart.
 *
 * It lives here rather than in the script because a test has to be able to read
 * it, and importing a script that runs on import would run it.
 *
 * Read-only. Every column is either a fact the club recorded or one of the two
 * proofs evaluated by PostgreSQL; nothing is decided in SQL, so
 * {@link classifySchoolMember} stays the only place a verdict is reached.
 */
export function censusSql(): string {
  return `SELECT m."id" AS "id",
       m."firstName" AS "firstName",
       m."lastName" AS "lastName",
       m."email" AS "email",
       m."xeroContactId" AS "xeroContactId",
       (SELECT count(*) FROM "Booking" b2 WHERE b2."memberId" = m."id")::int AS "bookingCount",
       (${SCHOOL_CLASSIFICATION_ORGANISATION_PROOF_SQL}) AS "organisationProof",
       (${SCHOOL_CLASSIFICATION_PERSON_PROOF_SQL}) AS "personProof",
       c."classification"::text AS "recorded",
       c."decidedBy" AS "recordedBy"
  FROM "Member" m
  LEFT JOIN "SchoolMemberClassification" c ON c."memberId" = m."id"
 WHERE ${SCHOOL_CLASSIFICATION_CANDIDATE_SQL}
 ORDER BY m."firstName", m."id"`;
}

/** What the census can say about one candidate row. */
export type SchoolMemberClassificationVerdict =
  | SchoolMemberClassificationKind
  | "CANNOT_TELL";

/** One candidate row as the census query returns it. */
export type SchoolMemberCandidate = {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  bookingCount: number;
  xeroContactId: string | null;
  /** Did the organisation proof hold for this row? */
  organisationProof: boolean;
  /** Did the person proof hold for this row? */
  personProof: boolean;
  /** What is already recorded in `SchoolMemberClassification`, if anything. */
  recorded: SchoolMemberClassificationKind | null;
  recordedBy: string | null;
};

/**
 * The verdict, from the two proofs. The whole classification rule, in one
 * function, so nothing else is allowed to have an opinion.
 *
 * BOTH PROOFS HOLDING IS `CANNOT_TELL`, not a tie-break. A row with a blank
 * surname, a converted school request naming it, AND a teacher's hut-leader
 * assignment is telling two different stories about itself, and the honest
 * thing to do with contradictory evidence is to hand it to a person. Picking a
 * winner here would be the "silent ambiguous fallback" #2912 forbids, wearing a
 * priority order as a disguise.
 */
export function classifySchoolMember(
  candidate: Pick<SchoolMemberCandidate, "organisationProof" | "personProof">,
): SchoolMemberClassificationVerdict {
  if (candidate.organisationProof && !candidate.personProof) {
    return SchoolMemberClassificationKind.ORGANISATION;
  }
  if (candidate.personProof && !candidate.organisationProof) {
    return SchoolMemberClassificationKind.PERSON;
  }
  return "CANNOT_TELL";
}

/**
 * What the census records in `evidence` for a row it settled itself.
 *
 * Written out rather than left to a caller so the stored reason cannot drift
 * from the rule that produced it. An officer's own reason is their own words.
 */
export function censusEvidenceFor(
  verdict: SchoolMemberClassificationKind,
): string {
  return verdict === SchoolMemberClassificationKind.ORGANISATION
    ? "census proof: blank surname, cannot sign in, and a SCHOOL booking request converted to this member under the same school name"
    : "census proof: signs in, or has a surname, or is a school booking's hut leader";
}

/** Who the census records as the decider for a row it settled itself. */
export const CENSUS_DECIDED_BY = "census";
