/**
 * WHICH OF THESE SCHOOL-SHAPED ROWS IS A SCHOOL? The operator's census (#3369,
 * stage 4 of programme #2912). `INV-OPS-002`/`INV-OPS-010`, `INV-SSOT`.
 *
 * Before this programme a school was a `Member` row with the school's name in
 * `firstName` and a blank surname, and the real teacher was a second row that
 * looks the same from outside. Stage 4 moves each school's bookings onto its
 * `Organisation` and leaves each teacher's alone — so somebody has to say,
 * before the maintenance window opens, which is which.
 *
 * This is that somebody's tool. It sorts every candidate into ORGANISATION,
 * PERSON or CANNOT TELL, and **the cutover requires zero CANNOT TELL rows**.
 *
 * ## READ-ONLY BY DEFAULT, AND IT NEVER GUESSES
 *
 * Run with no arguments it writes nothing at all: it reports. The two ways it
 * can write are both explicit and both narrow:
 *
 *   --record-proved      record the rows the proofs settle, as `census`
 *   --classify <id> --as ORGANISATION|PERSON --by <who> --because "<why>"
 *                        record ONE row a person decided
 *
 * There is no bulk classify of unproved rows and there is no default. A row the
 * proofs cannot settle goes back to a person, which is the #2912 rule: no fuzzy
 * merge, no invented surname, no silent ambiguous fallback, cutover blocked
 * rather than guessed.
 *
 * ## THE NUMBERS ARE REPRODUCIBLE
 *
 * The classification rule is `src/lib/school-member-classification.ts` and
 * nothing here has an opinion of its own — the same two proofs, in the same
 * SQL, that `docs/guides/school-organisation-cutover.md` documents. `--sql`
 * prints the exact statement so an officer can run it against a read-only
 * replica and get the same answer without trusting this program.
 *
 * ## SAFE USAGE — a copy first, then the real database read-only
 *
 *   DATABASE_URL='postgresql://user:pass@host:5432/club' \
 *     npm run db:school-classification-census
 *
 * Reading production is the point of the exercise and is safe; the write flags
 * are what an officer runs deliberately, after reading.
 */
import "dotenv/config";
import process from "node:process";

import { BookingRequestType, SchoolMemberClassificationKind } from "@prisma/client";

import {
  CENSUS_DECIDED_BY,
  SCHOOL_CLASSIFICATION_CANDIDATE_SQL,
  SCHOOL_MEMBER_CANDIDATE_SELECT,
  SCHOOL_MEMBER_CANDIDATE_WHERE,
  censusEvidenceFor,
  classifySchoolMember,
  provesOrganisation,
  provesPerson,
  summariseSchoolCensus,
  type SchoolMemberCandidate,
} from "../src/lib/school-member-classification";
import { prisma } from "../src/lib/prisma";

type Args = {
  sql: boolean;
  recordProved: boolean;
  classify: string | null;
  as: string | null;
  by: string | null;
  because: string | null;
};

function parseArgs(argv: string[]): Args {
  const value = (flag: string): string | null => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] ?? null : null;
  };
  return {
    sql: argv.includes("--sql"),
    recordProved: argv.includes("--record-proved"),
    classify: value("--classify"),
    as: value("--as"),
    by: value("--by"),
    because: value("--because"),
  };
}

/**
 * THE READ. Typed Prisma, not a hand-written statement.
 *
 * Two queries rather than one join, and that is the cheaper shape as well as
 * the clearer one: the candidate set is small (one row per school-shaped member
 * that ever booked), and the second query fetches the converted `SCHOOL`
 * requests for exactly those ids.
 *
 * The name comparison happens in TypeScript, through the one folding
 * `resolveOrCreateSchoolOrganisation` uses. A copy of that folding in SQL is how
 * the census and the runtime would come to disagree about which record a name
 * claims (`INV-SSOT`).
 */
async function readCandidates(): Promise<SchoolMemberCandidate[]> {
  const members = await prisma.member.findMany({
    where: SCHOOL_MEMBER_CANDIDATE_WHERE,
    select: SCHOOL_MEMBER_CANDIDATE_SELECT,
    orderBy: [{ firstName: "asc" }, { id: "asc" }],
  });
  if (members.length === 0) return [];

  const convertedRequests = await prisma.bookingRequest.findMany({
    where: {
      type: BookingRequestType.SCHOOL,
      convertedMemberId: { in: members.map((member) => member.id) },
      schoolName: { not: null },
    },
    select: { convertedMemberId: true, schoolName: true },
  });
  const namesByMemberId = new Map<string, string[]>();
  for (const request of convertedRequests) {
    if (!request.convertedMemberId || !request.schoolName) continue;
    const names = namesByMemberId.get(request.convertedMemberId) ?? [];
    names.push(request.schoolName);
    namesByMemberId.set(request.convertedMemberId, names);
  }

  return members.map((member) => ({
    id: member.id,
    firstName: member.firstName,
    lastName: member.lastName,
    email: member.email,
    bookingCount: member._count.bookings,
    xeroContactId: member.xeroContactId,
    organisationProof: provesOrganisation({
      firstName: member.firstName,
      lastName: member.lastName,
      canLogin: member.canLogin,
      convertedSchoolRequestNames: namesByMemberId.get(member.id) ?? [],
    }),
    personProof: provesPerson({
      lastName: member.lastName,
      canLogin: member.canLogin,
      isSchoolBookingHutLeader: member.hutLeaderAssignments.length > 0,
    }),
    recorded: member.schoolClassification?.classification ?? null,
    recordedBy: member.schoolClassification?.decidedBy ?? null,
  }));
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

/** What a person needs in front of them to decide a row the proofs could not. */
function describeForAPerson(row: SchoolMemberCandidate): string {
  const facts = [
    row.lastName.trim() === "" ? "no surname" : `surname "${row.lastName}"`,
    `${row.bookingCount} booking${row.bookingCount === 1 ? "" : "s"}`,
    row.xeroContactId ? "holds a Xero customer" : "no Xero customer",
    row.organisationProof ? "school proof HOLDS" : "school proof does not hold",
    row.personProof ? "person proof HOLDS" : "person proof does not hold",
  ];
  return `${pad(row.id, 27)} ${pad(row.firstName, 36)} ${row.email}\n      ${facts.join("; ")}`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.sql) {
    // The POPULATION, as an officer can run it against a read-only replica.
    // The two proofs are applied in TypeScript — see `readCandidates` — so what
    // this prints is the candidate set the migration itself demands a decision
    // for, which is the number that decides whether the cutover can proceed.
    process.stdout.write(
      `SELECT m."id", m."firstName", m."lastName", m."email"\n` +
        `  FROM "Member" m\n` +
        ` WHERE ${SCHOOL_CLASSIFICATION_CANDIDATE_SQL}\n` +
        ` ORDER BY m."firstName", m."id";\n`,
    );
    return;
  }

  if (args.classify) {
    if (
      args.as !== SchoolMemberClassificationKind.ORGANISATION &&
      args.as !== SchoolMemberClassificationKind.PERSON
    ) {
      throw new Error(
        "--classify needs --as ORGANISATION or --as PERSON. There is no third value: a row nobody can decide stays undecided and blocks the cutover, which is the point.",
      );
    }
    if (!args.by?.trim()) {
      throw new Error(
        "--classify needs --by <who decided>. A decision nobody signed is not a decision.",
      );
    }
    if (!args.because?.trim()) {
      throw new Error(
        "--classify needs --because \"<the evidence>\". Recording why is not paperwork: months from now it is the only thing that can answer whether this was right.",
      );
    }
    await prisma.schoolMemberClassification.upsert({
      where: { memberId: args.classify },
      create: {
        memberId: args.classify,
        classification: args.as,
        evidence: args.because.trim().slice(0, 500),
        decidedBy: args.by.trim().slice(0, 200),
      },
      update: {
        classification: args.as,
        evidence: args.because.trim().slice(0, 500),
        decidedBy: args.by.trim().slice(0, 200),
      },
    });
    process.stdout.write(
      `Recorded ${args.classify} as ${args.as}, decided by ${args.by.trim()}.\n`,
    );
    return;
  }

  const rows = await readCandidates();

  if (args.recordProved) {
    let written = 0;
    for (const row of rows) {
      const verdict = classifySchoolMember(row);
      if (verdict === "CANNOT_TELL") continue;
      if (row.recorded !== null) continue;
      await prisma.schoolMemberClassification.create({
        data: {
          memberId: row.id,
          classification: verdict,
          evidence: censusEvidenceFor(verdict),
          decidedBy: CENSUS_DECIDED_BY,
        },
      });
      // The row has just BEEN recorded, so say so. Every figure below comes
      // from `summariseSchoolCensus(rows)`, which reads exactly this field —
      // so marking it here is what stops the report contradicting the writes
      // it has just made.
      row.recorded = verdict;
      row.recordedBy = CENSUS_DECIDED_BY;
      written += 1;
    }
    process.stdout.write(
      `Recorded ${written} proved row(s). A row a person had already decided is never overwritten.\n\n`,
    );
  }

  // ONE home for every figure, read AFTER the writes above. The census used to
  // compute these first and print them after, so `--record-proved` reported
  // "Recorded 21 proved row(s)" immediately above "still blocking the cutover:
  // 23" and then exited non-zero on the pre-write count.
  const summary = summariseSchoolCensus(rows);

  process.stdout.write(
    [
      "SCHOOL MEMBER CLASSIFICATION CENSUS (#3369)",
      "",
      `Candidates (a Role.SCHOOL member that owns at least one booking): ${summary.candidates}`,
      `  proved to be a SCHOOL      : ${summary.organisations}`,
      `  proved to be a PERSON      : ${summary.people}`,
      `  CANNOT TELL                : ${summary.cannotTell}`,
      "",
      `Already recorded in SchoolMemberClassification: ${summary.recorded}`,
      `Still unrecorded, so still blocking the cutover: ${summary.blocking}`,
      "",
    ].join("\n"),
  );

  if (summary.contradicted.length > 0) {
    process.stdout.write(
      [
        "RECORDED DECISIONS THAT CONTRADICT THE PROOFS",
        "A person may well be right and the proof wrong — they can see the club's own",
        "records and this program cannot. It is listed so the disagreement is seen",
        "before the window rather than discovered after it.",
        "",
        ...summary.contradicted.map(
          ({ row, verdict }) =>
            `  ${pad(row.id, 27)} recorded ${row.recorded} by ${row.recordedBy}; proof says ${verdict}`,
        ),
        "",
      ].join("\n"),
    );
  }

  // WHICH ROWS ARE ABOUT TO BECOME ONE RECORD.
  //
  // The backfill folds the school's name and collapses every member row that
  // folds the same way onto ONE Organisation — one record, one email, one Xero
  // customer. That is what makes a school recorded twice come out right, and it
  // is also what would silently merge two genuinely different schools that
  // happen to share a name. Nothing warned an operator which groups were about
  // to collapse, and it is the same collapse that makes the reverse lossy.
  //
  // This PRINTS the groups and changes nothing about the merge itself: whether
  // that merge is wanted is a decision for the club, put to the owner
  // separately. Confirming each group is a step in
  // docs/guides/school-organisation-cutover.md.
  if (summary.mergeGroups.length > 0) {
    process.stdout.write(
      [
        "ROWS THAT WILL BECOME ONE RECORD",
        "Each group below folds to the same school name, so the backfill will give",
        "them ONE Organisation, one email address and one Xero customer. Read every",
        "group and confirm it really is one school. Two genuinely different schools",
        "sharing a name would be merged here with nothing to say it happened, and",
        "the reverse scripts cannot separate them again.",
        "",
        ...summary.mergeGroups.flatMap(({ folded, members }) => [
          `  "${folded}" — ${members.length} rows, becoming one record:`,
          ...members.map(
            (row) =>
              `      ${pad(row.id, 27)} ${pad(JSON.stringify(row.firstName), 40)} ${row.email}` +
              `${row.xeroContactId ? "  [holds a Xero customer]" : ""}`,
          ),
          "",
        ]),
        "The record keeps the name, address and Xero customer of the FIRST row by id;",
        "a second Xero customer stays on its own row for an officer to merge in Xero.",
        "",
      ].join("\n"),
    );
  }

  const cannotTellRows = rows.filter(
    (row) => classifySchoolMember(row) === "CANNOT_TELL",
  );
  if (cannotTellRows.length > 0) {
    process.stdout.write(
      [
        "ROWS A PERSON HAS TO DECIDE",
        "Nothing below can be proved either way from what the club has recorded.",
        "Both proofs holding at once counts as CANNOT TELL too: contradictory",
        "evidence is a question, not a tie-break.",
        "",
        ...cannotTellRows.map((row) => `  ${describeForAPerson(row)}`),
        "",
        "Record each one with, for example:",
        "  npm run db:school-classification-census -- \\",
        "    --classify <memberId> --as ORGANISATION \\",
        "    --by \"<your name>\" --because \"<what you checked>\"",
        "",
      ].join("\n"),
    );
  }

  const blocking = summary.blocking;
  process.stdout.write(
    blocking === 0
      ? "READY: every candidate is recorded, so the backfill will run.\n"
      : `NOT READY: ${blocking} candidate(s) are unrecorded. The backfill will refuse and write nothing.\n`,
  );
  process.exitCode = blocking === 0 ? 0 : 1;
}

main()
  .catch((error: unknown) => {
    process.stderr.write(`${String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
