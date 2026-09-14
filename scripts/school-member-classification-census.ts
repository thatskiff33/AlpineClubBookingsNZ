/**
 * WHICH OF THESE SCHOOL-SHAPED ROWS IS A SCHOOL? The operator's census (#3369,
 * stage 4 of programme #2912). `INV-OPS-014`, `INV-SSOT`.
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

import { SchoolMemberClassificationKind } from "@prisma/client";

import {
  CENSUS_DECIDED_BY,
  censusEvidenceFor,
  censusSql,
  classifySchoolMember,
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
    process.stdout.write(`${censusSql()}\n`);
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

  const rows =
    await prisma.$queryRawUnsafe<SchoolMemberCandidate[]>(censusSql());

  const verdicts = rows.map((row) => ({
    row,
    verdict: classifySchoolMember(row),
  }));
  const organisations = verdicts.filter((v) => v.verdict === "ORGANISATION");
  const people = verdicts.filter((v) => v.verdict === "PERSON");
  const cannotTell = verdicts.filter((v) => v.verdict === "CANNOT_TELL");
  const unrecorded = verdicts.filter(({ row }) => row.recorded === null);
  const contradicted = verdicts.filter(
    ({ row, verdict }) =>
      row.recorded !== null && verdict !== "CANNOT_TELL" && row.recorded !== verdict,
  );

  if (args.recordProved) {
    let written = 0;
    for (const { row, verdict } of verdicts) {
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
      written += 1;
    }
    process.stdout.write(
      `Recorded ${written} proved row(s). A row a person had already decided is never overwritten.\n\n`,
    );
  }

  process.stdout.write(
    [
      "SCHOOL MEMBER CLASSIFICATION CENSUS (#3369)",
      "",
      `Candidates (a Role.SCHOOL member that owns at least one booking): ${rows.length}`,
      `  proved to be a SCHOOL      : ${organisations.length}`,
      `  proved to be a PERSON      : ${people.length}`,
      `  CANNOT TELL                : ${cannotTell.length}`,
      "",
      `Already recorded in SchoolMemberClassification: ${rows.length - unrecorded.length}`,
      `Still unrecorded, so still blocking the cutover: ${unrecorded.length}`,
      "",
    ].join("\n"),
  );

  if (contradicted.length > 0) {
    process.stdout.write(
      [
        "RECORDED DECISIONS THAT CONTRADICT THE PROOFS",
        "A person may well be right and the proof wrong — they can see the club's own",
        "records and this program cannot. It is listed so the disagreement is seen",
        "before the window rather than discovered after it.",
        "",
        ...contradicted.map(
          ({ row, verdict }) =>
            `  ${pad(row.id, 27)} recorded ${row.recorded} by ${row.recordedBy}; proof says ${verdict}`,
        ),
        "",
      ].join("\n"),
    );
  }

  if (cannotTell.length > 0) {
    process.stdout.write(
      [
        "ROWS A PERSON HAS TO DECIDE",
        "Nothing below can be proved either way from what the club has recorded.",
        "Both proofs holding at once counts as CANNOT TELL too: contradictory",
        "evidence is a question, not a tie-break.",
        "",
        ...cannotTell.map(({ row }) => `  ${describeForAPerson(row)}`),
        "",
        "Record each one with, for example:",
        "  npm run db:school-classification-census -- \\",
        "    --classify <memberId> --as ORGANISATION \\",
        "    --by \"<your name>\" --because \"<what you checked>\"",
        "",
      ].join("\n"),
    );
  }

  const blocking = unrecorded.length;
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
