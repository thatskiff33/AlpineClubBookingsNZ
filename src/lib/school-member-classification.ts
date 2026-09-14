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

import {
  HutLeaderAssignmentSource,
  Prisma,
  Role,
  SchoolMemberClassificationKind,
} from "@prisma/client";

import { normaliseOrganisationName } from "@/lib/school-organisations";

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
 * THIS EXACT TEXT IS EMBEDDED IN
 * `20260922020000_backfill_school_bookings_to_organisations/migration.sql`, and
 * `school-member-classification-contract.test.ts` compares them. The migration
 * has to ask the same question in SQL because it runs as SQL; the census asks
 * it through Prisma, typed, which is why this constant is documentation AND the
 * migration's source rather than something the census executes.
 */
export const SCHOOL_CLASSIFICATION_CANDIDATE_SQL = `m."role" = 'SCHOOL' AND EXISTS (SELECT 1 FROM "Booking" b WHERE b."memberId" = m."id")`;

/**
 * What the census reads about one candidate, and how it reads it.
 *
 * TYPED, NOT RAW (`INV-OPS-001`, "lock raw, read typed"). An earlier draft of
 * this tool ran one hand-written statement through `$queryRaw`. That is the
 * shape #2289 was filed about: a mistyped column arrives as `undefined`, and
 * `undefined` here would read as "this row has no proof" — handing an officer a
 * question that was already answered, which is the exact failure this whole
 * programme exists to stop. It also meant the name folding existed twice, once
 * in SQL and once in `school-organisations.ts`, which is how two spellings of
 * "the same school" drift apart.
 */
export const SCHOOL_MEMBER_CANDIDATE_SELECT = {
  id: true,
  firstName: true,
  lastName: true,
  email: true,
  canLogin: true,
  xeroContactId: true,
  _count: { select: { bookings: true } },
  hutLeaderAssignments: {
    where: { source: HutLeaderAssignmentSource.SCHOOL_BOOKING },
    select: { id: true },
    take: 1,
  },
  schoolClassification: { select: { classification: true, decidedBy: true } },
} satisfies Prisma.MemberSelect;

/** The candidate set, as the same question the migration asks in SQL. */
export const SCHOOL_MEMBER_CANDIDATE_WHERE = {
  role: Role.SCHOOL,
  bookings: { some: {} },
} satisfies Prisma.MemberWhereInput;

/**
 * PROOF THAT A ROW IS A SCHOOL, not a person.
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
 * Names are compared through {@link isSameSchoolNameClaim}, which is the ONE
 * folding — the same one `resolveOrCreateSchoolOrganisation` uses to decide
 * which record a name claims. A second copy here is how "Tokoroa Primary
 * School" and "Tokoroa  Primary School" would come to mean different things in
 * the census and in the runtime.
 */
export function provesOrganisation(candidate: {
  firstName: string;
  lastName: string;
  canLogin: boolean;
  convertedSchoolRequestNames: readonly string[];
}): boolean {
  if (candidate.lastName.trim() !== "") return false;
  if (candidate.canLogin) return false;
  return candidate.convertedSchoolRequestNames.some((schoolName) =>
    isSameSchoolNameClaim(schoolName, candidate.firstName),
  );
}

/**
 * PROOF THAT A ROW IS A PERSON.
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
export function provesPerson(candidate: {
  lastName: string;
  canLogin: boolean;
  isSchoolBookingHutLeader: boolean;
}): boolean {
  return (
    candidate.canLogin ||
    candidate.lastName.trim() !== "" ||
    candidate.isSchoolBookingHutLeader
  );
}

/**
 * Does this free text name the same school as that record, for the CLAIM?
 *
 * Trim, collapse internal whitespace, ignore case — `normaliseOrganisationName`
 * plus a case fold, which is exactly what `schoolOrganisationNameClaim()` asks
 * Postgres. Deliberately NOT the coarser Xero-search folding, which exists to
 * PROVE a provider contact belongs where the provider said: coarser here would
 * let one school's name prove another school's row, which is a near-miss merge
 * by another route and #2912 forbids one.
 */
export function isSameSchoolNameClaim(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  const a = normaliseOrganisationName(left ?? "").toLowerCase();
  const b = normaliseOrganisationName(right ?? "").toLowerCase();
  if (!a || !b) return false;
  return a === b;
}

/** What the census can say about one candidate row. */
export type SchoolMemberClassificationVerdict =
  | SchoolMemberClassificationKind
  | "CANNOT_TELL";

/** One candidate row, as the census resolved it. */
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
