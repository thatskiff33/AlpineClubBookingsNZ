/**
 * THE BACKFILL REFUSES, AND WRITES NOTHING, WHILE ANY ROW IS UNCLASSIFIED
 * (#3369, stage 4 of programme #2912). `INV-OPS-002`, `INV-OPS-010`.
 *
 * ## Why this is a separate suite from the verification fixture
 *
 * `data-migration-verification.realdb.test.ts` proves what the migration DOES to
 * a pre-state it can migrate. The property this issue turns on is the opposite
 * one — what it does NOT do to a pre-state it must not migrate — and the fixture
 * framework has no way to say "this case must raise": a case that errors is
 * counted as a failure, which is exactly right for every fixture it runs.
 *
 * So the refusal is proved here instead, in the only way that is worth anything:
 * by seeding a real club's rows into a real PostgreSQL, running the real
 * `migration.sql` byte for byte, and reading the tables back afterwards.
 *
 * Note for whoever adds a capability later: `epic/3271-parent-partner-exclusivity`
 * extends `prisma/migration-verification/types.ts` with `expectedError` and an
 * `isolated_database` execution mode, which between them would express this. It
 * was deliberately NOT copied here — importing another epic's in-flight runner
 * rewrite into this branch would make this stage's proof depend on code neither
 * branch has merged. When that epic lands, this suite can fold into a fixture
 * case.
 *
 * ## What it proves, in order
 *
 * 1. An unclassified member that owns a booking makes the whole migration raise
 *    a stable, id-free error.
 * 2. After that refusal the database is untouched: the booking still belongs to
 *    the member, no school record was created, and the member still holds its
 *    Xero customer. "Fails closed" means nothing was written, not that it
 *    stopped early.
 * 3. Record the missing decision and the same migration then does the work.
 *
 * Point 2 is the one that needs a real database. The migration opens its own
 * transaction, so the refusal has to roll back writes that several statements
 * had already made in it, and nothing but PostgreSQL can be asked whether it
 * really did.
 *
 * RUN IT LOCALLY (any throwaway database; the suite creates and drops its own):
 *
 *   DATA_MIGRATION_VERIFICATION_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres \
 *     npx vitest run src/lib/__tests__/school-organisation-backfill-fail-closed.realdb.test.ts
 */
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { jobBlock } from "./helpers/ci-workflow";
import { splitSqlStatements } from "../../../prisma/migration-verification/split-statements";

const REPO_ROOT = process.cwd();
const MIGRATIONS_DIR = path.join(REPO_ROOT, "prisma", "migrations");
const WORKFLOW_PATH = path.join(REPO_ROOT, ".github", "workflows", "ci.yml");
const THIS_SUITE =
  "src/lib/__tests__/school-organisation-backfill-fail-closed.realdb.test.ts";
const DATABASE_URL_ENV = "DATA_MIGRATION_VERIFICATION_DATABASE_URL";
const CI_JOB_ID = "data-migration-verification";

const SHAPE_MIGRATION = "20260928020000_booking_owner_optional_member";
const BACKFILL_MIGRATION =
  "20260928030000_backfill_school_bookings_to_organisations";

const databaseUrl = process.env[DATABASE_URL_ENV];

function migrationNames(): string[] {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function migrationSql(name: string): string {
  // Test helper: joins the repo's own migrations directory with a name read
  // from that same directory listing; no user input.
  return readFileSync(path.join(MIGRATIONS_DIR, name, "migration.sql"), "utf8");
}

/**
 * The club's rows on the morning of the cutover.
 *
 * One school the census proved, one school it could not — a row with a blank
 * surname whose booking came from no recorded request, which is what a club
 * that imported history or repaired a row by hand actually has — and the
 * teacher. The unprovable one is the whole point: nothing about it is wrong,
 * and nothing about it can be proved either.
 */
const SEED = `
  INSERT INTO "Member"
    ("id", "email", "passwordHash", "firstName", "lastName", "role",
     "canLogin", "xeroContactId", "updatedAt")
  VALUES
    ('fc-proved', 'office@proved.test', 'x', 'Proved Primary School', '',
     'SCHOOL', false, 'xero-proved', TIMESTAMP '2026-01-01 00:00:00'),
    ('fc-unprovable', 'office@unknown.test', 'x', 'Unknown Area School', '',
     'SCHOOL', false, 'xero-unknown', TIMESTAMP '2026-01-02 00:00:00');

  INSERT INTO "Booking"
    ("id", "memberId", "checkIn", "checkOut", "status",
     "totalPriceCents", "finalPriceCents", "updatedAt")
  VALUES
    ('fc-b-proved', 'fc-proved', DATE '2026-08-01', DATE '2026-08-03',
     'CONFIRMED', 120000, 120000, TIMESTAMP '2026-01-01 00:00:00'),
    ('fc-b-unprovable', 'fc-unprovable', DATE '2026-09-01', DATE '2026-09-03',
     'CONFIRMED', 90000, 90000, TIMESTAMP '2026-01-02 00:00:00');

  INSERT INTO "BookingRequest"
    ("id", "type", "contactFirstName", "contactLastName", "contactEmail",
     "checkIn", "checkOut", "guests", "schoolName",
     "convertedMemberId", "convertedBookingId", "updatedAt")
  VALUES
    ('fc-req-proved', 'SCHOOL', 'Rangi', 'Teacher', 'rangi@proved.test',
     DATE '2026-08-01', DATE '2026-08-03', '[]'::jsonb,
     'Proved Primary School', 'fc-proved', 'fc-b-proved',
     TIMESTAMP '2026-01-01 00:00:00');

  INSERT INTO "SchoolMemberClassification"
    ("memberId", "classification", "evidence", "decidedBy", "decidedAt")
  VALUES
    ('fc-proved', 'ORGANISATION', 'census proof', 'census',
     TIMESTAMP '2026-02-01 00:00:00');
`;

const OWNERSHIP_SQL = `
  SELECT b."id" AS booking, b."memberId" AS member, b."organisationId" AS organisation
    FROM "Booking" b
   ORDER BY b."id"
`;

const describeWithDatabase = databaseUrl ? describe : describe.skip;

// ---------------------------------------------------------------------------
// Structural check. Runs with or without a database, so the CI wiring that
// makes the real proof happen cannot quietly come undone.
// ---------------------------------------------------------------------------
describe("#3369 fail-closed proof: CI wiring", () => {
  const workflow = readFileSync(WORKFLOW_PATH, "utf8");

  it("is run by a job that has a PostgreSQL and that blocks", () => {
    const job = jobBlock(workflow, CI_JOB_ID);
    expect(job, `ci.yml has no ${CI_JOB_ID} job`).not.toBe("");
    expect(job).toContain("image: postgres:16-alpine");
    expect(
      job,
      "this suite is the only proof that the backfill refuses to run on an unclassified row; a job that does not execute it is not evidence",
    ).toContain(THIS_SUITE);
    expect(job).toContain(DATABASE_URL_ENV);
    expect(job, "the executing job must not be continue-on-error").not.toContain(
      "continue-on-error",
    );
  });

  it("refuses to skip inside its own CI job: the database URL must be wired", () => {
    if (process.env.GITHUB_JOB !== CI_JOB_ID) return;
    expect(
      databaseUrl,
      `${DATABASE_URL_ENV} is not set inside the ${CI_JOB_ID} job.`,
    ).toBeTruthy();
  });
});

describeWithDatabase("#3369: the backfill fails closed", () => {
  let adminClient: Client | undefined;
  let client: Client | undefined;
  let scratchDatabase = "";

  const db = (): Client => {
    if (!client) throw new Error("database client not initialised");
    return client;
  };

  /** Apply one committed migration, statement by statement, as Prisma does. */
  async function apply(name: string): Promise<void> {
    for (const statement of splitSqlStatements(migrationSql(name))) {
      if (!statement.trim()) continue;
      await db().query(statement);
    }
  }

  beforeAll(async () => {
    adminClient = new Client({ connectionString: databaseUrl });
    await adminClient.connect();
    scratchDatabase = `fc3369_${randomUUID().replaceAll("-", "")}`;
    // Test fixture: a generated UUID-derived database name; no user input.
    await adminClient.query(`CREATE DATABASE "${scratchDatabase}"`);

    const scratchUrl = new URL(databaseUrl as string);
    scratchUrl.pathname = `/${scratchDatabase}`;
    client = new Client({ connectionString: scratchUrl.toString() });
    await client.connect();

    // Everything up to and including the shape half, which is what creates the
    // classification table the backfill reads. The backfill itself is the thing
    // under test and is NOT applied here.
    for (const name of migrationNames()) {
      await apply(name);
      if (name === SHAPE_MIGRATION) break;
    }
    await db().query(SEED);
  }, 900_000);

  afterAll(async () => {
    await client?.end().catch(() => {});
    if (adminClient && scratchDatabase) {
      await adminClient
        .query(`DROP DATABASE IF EXISTS "${scratchDatabase}" WITH (FORCE)`)
        .catch(() => {});
    }
    await adminClient?.end().catch(() => {});
  }, 120_000);

  it("refuses the whole migration while one school row is unclassified, and says so without naming anybody", async () => {
    // The file is sent exactly as PostgreSQL receives it in production,
    // including its own BEGIN/COMMIT: the refusal has to roll back a
    // transaction the migration opened itself, and replacing that envelope
    // would be testing a different program.
    const error = await db()
      .query(migrationSql(BACKFILL_MIGRATION))
      .then(() => null)
      .catch((caught: unknown) => caught as Record<string, unknown>);

    // END THE TRANSACTION THE MIGRATION OPENED. Because the file carries its own
    // `BEGIN;` — which the comment above says, correctly, must not be replaced —
    // the refusal leaves this SESSION inside an aborted transaction rather than
    // tidily back at idle. PostgreSQL then answers every later statement on this
    // connection with "current transaction is aborted, commands ignored until
    // end of transaction block", so the two tests below fail on their very first
    // query while reporting nothing about the rows they exist to check. An
    // operator's own psql session recovers the same way and for the same reason.
    // Before this line those two tests could not pass, and nothing had ever run
    // them: this file's CI step is the SECOND in the `data-migration-
    // verification` job, and the first step was failing, so the job never
    // reached it (#3369).
    await db().query("ROLLBACK").catch(() => {});

    expect(error, "the migration was expected to refuse and did not").not.toBeNull();
    expect(String(error?.message)).toContain(
      "school_member_classification_incomplete",
    );
    // Error privacy: a maintenance-window failure still must not carry who or
    // how many. The HINT names the census command and nothing else.
    const serialised = JSON.stringify(error) + String(error?.message);
    for (const secret of [
      "fc-unprovable",
      "Unknown Area School",
      "office@unknown.test",
    ]) {
      expect(
        serialised,
        `the refusal leaked ${secret}`,
      ).not.toContain(secret);
    }
  });

  it("wrote nothing at all: every row is exactly as it was", async () => {
    const ownership = await db().query(OWNERSHIP_SQL);
    expect(
      ownership.rows,
      "a refused backfill must leave every booking with the member it had",
    ).toEqual([
      { booking: "fc-b-proved", member: "fc-proved", organisation: null },
      { booking: "fc-b-unprovable", member: "fc-unprovable", organisation: null },
    ]);

    const organisations = await db().query(
      `SELECT count(*)::int AS "count" FROM "Organisation"`,
    );
    expect(
      organisations.rows,
      "the school it COULD prove must not have been half-migrated",
    ).toEqual([{ count: 0 }]);

    const contacts = await db().query(
      `SELECT m."id" AS member, m."xeroContactId" AS xero FROM "Member" m ORDER BY m."id"`,
    );
    expect(contacts.rows).toEqual([
      { member: "fc-proved", xero: "xero-proved" },
      { member: "fc-unprovable", xero: "xero-unknown" },
    ]);

    const constraint = await db().query(
      `SELECT count(*)::int AS "count" FROM pg_constraint WHERE conname = 'Booking_owner_exactly_one'`,
    );
    expect(
      constraint.rows,
      "a refused migration must not have left its constraint behind either",
    ).toEqual([{ count: 0 }]);
  });

  it("does the work once the missing decision is recorded", async () => {
    // The officer classifies the row the census could not prove, under their own
    // name and with their own reason. This is the only way a CANNOT TELL row
    // ever becomes classified.
    await db().query(
      `INSERT INTO "SchoolMemberClassification"
         ("memberId", "classification", "evidence", "decidedBy", "decidedAt")
       VALUES ('fc-unprovable', 'ORGANISATION',
               'Confirmed against the 2019 invoice file: this is the school, not its teacher.',
               'treasurer', TIMESTAMP '2026-02-02 00:00:00')`,
    );

    await db().query(migrationSql(BACKFILL_MIGRATION));

    const ownership = await db().query(`
      SELECT b."id" AS booking, b."memberId" AS member, o."name" AS organisation
        FROM "Booking" b
        LEFT JOIN "Organisation" o ON o."id" = b."organisationId"
       ORDER BY b."id"
    `);
    expect(ownership.rows).toEqual([
      {
        booking: "fc-b-proved",
        member: null,
        organisation: "Proved Primary School",
      },
      {
        booking: "fc-b-unprovable",
        member: null,
        organisation: "Unknown Area School",
      },
    ]);

    // And the constraint that makes an ownerless booking unrepresentable is now
    // in place, so the next writer cannot produce one by accident.
    const refused = await db()
      .query(
        `UPDATE "Booking" SET "organisationId" = NULL WHERE "id" = 'fc-b-proved'`,
      )
      .then(() => null)
      .catch((caught: unknown) => caught as Error);
    expect(
      String(refused?.message),
      "a booking owned by nobody must be rejected by the database",
    ).toContain("Booking_owner_exactly_one");
  });
});
