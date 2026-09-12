import type { DataMigrationVerification } from "./types";

/**
 * #3366 (stage 1 of programme #2912, child of MAD epic #2725). This migration
 * rewrites no data — the PR-time gate classifies it shape-only and demands no
 * fixture. It is registered anyway, for the same reason the sibling
 * `20260913010000` was: the issue's own acceptance criteria ask for "the
 * migration against a realistic pre-state", and the claims this stage rests on
 * are about a POPULATED database, which neither `Migration drift check` (empty
 * tables) nor the client-shape contract
 * (`src/lib/__tests__/organisation-record-inert-contract.test.ts`, which reads
 * the generated client and never a database) can see:
 *
 *   1. a booking and a booking request a club already holds come through the
 *      migration unchanged, with the new link NULL;
 *   2. exactly ONE column arrives on each table, nullable and with no default —
 *      which is the whole old-code-compatibility argument, because the draining
 *      colour's INSERTs omit it;
 *   3. a write by the draining colour, naming only pre-epic columns, still
 *      succeeds afterwards;
 *   4. the two new tables arrive EMPTY, because nothing in this release writes
 *      them; and
 *   5. the deletion rules mean what the schema comments say — a school a
 *      booking names cannot be deleted out from under it, a school nothing
 *      names takes its associations with it, a person leaving takes their
 *      association and not the school, and one person holds at most one
 *      association per school.
 *
 * (5) is proved by BEHAVIOUR rather than by reading `pg_constraint`: each
 * refusal runs inside a PL/pgSQL block that catches the error and records the
 * verdict as a row, so "refused" is an observation, and a mutant that permits
 * the write is a row mismatch rather than a crash.
 */
const verification: DataMigrationVerification = {
  migration: "20260920010000_add_organisation_record",
  intent:
    "Add the organisation records and the two optional links without touching any existing row: each table gains exactly one nullable column with no default, the new tables start empty, the draining colour can still write, and a school a booking names cannot be deleted out from under it.",
  idempotentReRun: false,
  cases: [
    {
      name: "a club whose booking and booking request predate the organisation records",
      seed: `
        INSERT INTO "Member"
          ("id", "email", "passwordHash", "firstName", "lastName", "updatedAt")
        VALUES
          ('org-owner', 'org-owner@example.test', 'x', 'Prior', 'Owner',
           TIMESTAMP '2026-01-01 00:00:00');

        INSERT INTO "Booking"
          ("id", "memberId", "checkIn", "checkOut", "status",
           "totalPriceCents", "finalPriceCents", "notes", "updatedAt")
        VALUES
          ('org-booking', 'org-owner', DATE '2026-08-01', DATE '2026-08-03',
           'CONFIRMED', 9000, 8100, 'A note the club typed',
           TIMESTAMP '2026-01-01 00:00:00');

        INSERT INTO "BookingRequest"
          ("id", "contactFirstName", "contactLastName", "contactEmail",
           "checkIn", "checkOut", "guests", "status", "schoolName", "updatedAt")
        VALUES
          ('org-request', 'Prior', 'Teacher', 'prior.teacher@example.test',
           DATE '2026-09-01', DATE '2026-09-03', '[]', 'NEW',
           'Example School', TIMESTAMP '2026-01-01 00:00:00');
      `,
      afterMigration: `
        -- The draining colour, whose generated client has never heard of the
        -- new column, writing exactly as it does today: every column named
        -- explicitly, and the new one omitted.
        INSERT INTO "Booking"
          ("id", "memberId", "checkIn", "checkOut", "status",
           "totalPriceCents", "finalPriceCents", "updatedAt")
        VALUES
          ('org-draining-booking', 'org-owner', DATE '2026-10-01',
           DATE '2026-10-02', 'PENDING', 4500, 4500,
           TIMESTAMP '2026-01-01 00:00:00');

        INSERT INTO "BookingRequest"
          ("id", "contactFirstName", "contactLastName", "contactEmail",
           "checkIn", "checkOut", "guests", "status", "updatedAt")
        VALUES
          ('org-draining-request', 'Draining', 'Colour',
           'draining@example.test', DATE '2026-10-05', DATE '2026-10-06',
           '[]', 'NEW', TIMESTAMP '2026-01-01 00:00:00');
      `,
      expectations: [
        {
          claim:
            "the booking the club already held is unchanged in every stored value, and its new link is NULL",
          sql: `
            SELECT "id", "memberId",
                   to_char("checkIn", 'YYYY-MM-DD') AS "checkIn",
                   to_char("checkOut", 'YYYY-MM-DD') AS "checkOut",
                   "status"::text AS "status",
                   "totalPriceCents", "finalPriceCents", "notes",
                   ("organisationId" IS NULL) AS "linkIsNull"
            FROM "Booking"
            WHERE "id" = 'org-booking'
          `,
          rows: [
            {
              id: "org-booking",
              memberId: "org-owner",
              checkIn: "2026-08-01",
              checkOut: "2026-08-03",
              status: "CONFIRMED",
              totalPriceCents: 9000,
              finalPriceCents: 8100,
              notes: "A note the club typed",
              linkIsNull: true,
            },
          ],
        },
        {
          claim:
            "the booking request is unchanged too, schoolName included — the free-text school name is NOT migrated onto the new record in this stage",
          sql: `
            SELECT "id", "contactFirstName", "contactLastName", "contactEmail",
                   to_char("checkIn", 'YYYY-MM-DD') AS "checkIn",
                   "status"::text AS "status", "schoolName",
                   ("organisationId" IS NULL) AS "linkIsNull"
            FROM "BookingRequest"
            WHERE "id" = 'org-request'
          `,
          rows: [
            {
              id: "org-request",
              contactFirstName: "Prior",
              contactLastName: "Teacher",
              contactEmail: "prior.teacher@example.test",
              checkIn: "2026-09-01",
              status: "NEW",
              schoolName: "Example School",
              linkIsNull: true,
            },
          ],
        },
        {
          claim:
            "exactly one column arrived on each table: 55 to 56 on Booking, 46 to 47 on BookingRequest",
          sql: `
            SELECT (SELECT count(*)::int FROM information_schema.columns
                     WHERE table_schema = 'public' AND table_name = 'Booking')
                     AS "bookingColumns",
                   (SELECT count(*)::int FROM information_schema.columns
                     WHERE table_schema = 'public' AND table_name = 'BookingRequest')
                     AS "bookingRequestColumns"
          `,
          rows: [{ bookingColumns: 56, bookingRequestColumns: 47 }],
        },
        {
          claim:
            "both new columns are nullable with NO default, which is what lets the draining colour's INSERTs omit them",
          sql: `
            SELECT "table_name", "is_nullable",
                   ("column_default" IS NULL) AS "noDefault"
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND column_name = 'organisationId'
              AND table_name IN ('Booking', 'BookingRequest')
            ORDER BY "table_name"
          `,
          rows: [
            { table_name: "Booking", is_nullable: "YES", noDefault: true },
            {
              table_name: "BookingRequest",
              is_nullable: "YES",
              noDefault: true,
            },
          ],
        },
        {
          claim:
            "a write by the draining colour, naming only pre-epic columns, succeeded and left the link NULL",
          sql: `
            SELECT 'Booking' AS "written",
                   ("organisationId" IS NULL) AS "linkIsNull"
            FROM "Booking" WHERE "id" = 'org-draining-booking'
            UNION ALL
            SELECT 'BookingRequest', ("organisationId" IS NULL)
            FROM "BookingRequest" WHERE "id" = 'org-draining-request'
            ORDER BY 1
          `,
          rows: [
            { written: "Booking", linkIsNull: true },
            { written: "BookingRequest", linkIsNull: true },
          ],
        },
        {
          claim:
            "the two new tables arrived EMPTY — this stage writes no organisation and no association",
          sql: `
            SELECT (SELECT count(*)::int FROM "Organisation") AS "schools",
                   (SELECT count(*)::int FROM "OrganisationContact")
                     AS "associations"
          `,
          rows: [{ schools: 0, associations: 0 }],
        },
      ],
    },
    {
      name: "a school, the people who speak for it, and what happens when a school or a person goes",
      seed: `
        INSERT INTO "Member"
          ("id", "email", "passwordHash", "firstName", "lastName", "updatedAt")
        VALUES
          ('org-owner-2', 'org-owner-2@example.test', 'x', 'Prior', 'Owner',
           TIMESTAMP '2026-01-01 00:00:00');

        INSERT INTO "Booking"
          ("id", "memberId", "checkIn", "checkOut", "status",
           "totalPriceCents", "finalPriceCents", "updatedAt")
        VALUES
          ('org-booking-2', 'org-owner-2', DATE '2026-08-10',
           DATE '2026-08-12', 'CONFIRMED', 9000, 9000,
           TIMESTAMP '2026-01-01 00:00:00');
      `,
      afterMigration: `
        INSERT INTO "Member"
          ("id", "email", "passwordHash", "firstName", "lastName", "updatedAt")
        VALUES
          ('org-teacher', 'org-teacher@example.test', 'x', 'A', 'Teacher',
           TIMESTAMP '2026-01-01 00:00:00'),
          ('org-office', 'org-office@example.test', 'x', 'An', 'Office',
           TIMESTAMP '2026-01-01 00:00:00');

        INSERT INTO "Organisation" ("id", "name", "updatedAt")
        VALUES
          ('org-school', 'Example School', TIMESTAMP '2026-01-01 00:00:00'),
          ('org-unbooked', 'A School With No Booking',
           TIMESTAMP '2026-01-01 00:00:00');

        INSERT INTO "OrganisationContact"
          ("id", "organisationId", "memberId", "role", "updatedAt")
        VALUES
          ('oc-teacher', 'org-school', 'org-teacher', 'TEACHER',
           TIMESTAMP '2026-01-01 00:00:00'),
          ('oc-office', 'org-school', 'org-office', 'CONTACT',
           TIMESTAMP '2026-01-01 00:00:00'),
          ('oc-unbooked', 'org-unbooked', 'org-teacher', 'CONTACT',
           TIMESTAMP '2026-01-01 00:00:00');

        UPDATE "Booking" SET "organisationId" = 'org-school'
        WHERE "id" = 'org-booking-2';

        CREATE TEMP TABLE "OrgProbe" ("what" text, "outcome" text);

        DO $probe$
        BEGIN
          BEGIN
            DELETE FROM "Organisation" WHERE "id" = 'org-school';
            INSERT INTO "OrgProbe"
              VALUES ('delete a school a booking names', 'allowed');
          EXCEPTION WHEN foreign_key_violation THEN
            INSERT INTO "OrgProbe"
              VALUES ('delete a school a booking names', 'refused');
          END;
          BEGIN
            INSERT INTO "OrganisationContact"
              ("id", "organisationId", "memberId", "role", "updatedAt")
            VALUES
              ('oc-duplicate', 'org-school', 'org-teacher', 'CONTACT',
               TIMESTAMP '2026-01-01 00:00:00');
            INSERT INTO "OrgProbe"
              VALUES ('attach one person to one school twice', 'allowed');
          EXCEPTION WHEN unique_violation THEN
            INSERT INTO "OrgProbe"
              VALUES ('attach one person to one school twice', 'refused');
          END;
        END
        $probe$;

        -- A school no booking names goes, and takes its associations with it.
        DELETE FROM "Organisation" WHERE "id" = 'org-unbooked';

        -- A person leaving the club takes their association, not the school.
        DELETE FROM "Member" WHERE "id" = 'org-office';
      `,
      expectations: [
        {
          claim:
            "a school a booking names cannot be deleted out from under it, and one person cannot be attached to one school twice",
          sql: `SELECT "what", "outcome" FROM "OrgProbe" ORDER BY "what"`,
          rows: [
            {
              what: "attach one person to one school twice",
              outcome: "refused",
            },
            { what: "delete a school a booking names", outcome: "refused" },
          ],
        },
        {
          claim:
            "after those deletions the named school and the booking's link survive, while the unnamed school and both dropped associations are gone",
          sql: `
            SELECT (SELECT count(*)::int FROM "Organisation") AS "schools",
                   (SELECT count(*)::int FROM "OrganisationContact")
                     AS "associations",
                   (SELECT "organisationId" FROM "Booking"
                     WHERE "id" = 'org-booking-2') AS "bookingSchool",
                   (SELECT count(*)::int FROM "Member"
                     WHERE "id" IN ('org-teacher', 'org-office')) AS "people"
          `,
          rows: [
            {
              schools: 1,
              associations: 1,
              bookingSchool: "org-school",
              people: 1,
            },
          ],
        },
      ],
    },
  ],
  mutants: [
    {
      name: "null the booking's school instead of refusing the deletion",
      harm: "From stage 4 this column is the booking's OWNER. SET NULL would let a tidy-up of the organisation list silently orphan a booking, which is the one failure a deletion must not cause.",
      find: `CONSTRAINT "Booking_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE`,
      replace: `CONSTRAINT "Booking_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE SET NULL ON UPDATE CASCADE`,
    },
    {
      name: "let one person hold two associations with the same school",
      harm: "The capacity lives in the role column, so a duplicate row would give 'is this person attached to that school' two answers — and the member merge keys its collision handling on exactly that pair.",
      find: `CREATE UNIQUE INDEX "OrganisationContact_organisationId_memberId_key" ON "OrganisationContact"("organisationId", "memberId");`,
      replace: `CREATE INDEX "OrganisationContact_organisationId_memberId_key" ON "OrganisationContact"("organisationId", "memberId");`,
    },
    {
      name: "add a second, unreviewed column to BookingRequest alongside the link",
      harm: "The old-code-compatibility argument is that the draining colour's client sees exactly one extra column it never names. A second column would falsify the pinned pre-stage column lists silently.",
      find: `ALTER TABLE "BookingRequest" ADD COLUMN     "organisationId" TEXT;`,
      replace: `ALTER TABLE "BookingRequest" ADD COLUMN     "organisationId" TEXT;\n\nALTER TABLE "BookingRequest" ADD COLUMN "organisationKind" TEXT;`,
    },
    {
      name: "keep a person's association alive after the person is gone",
      harm: "The association row carries no history of its own. Refusing the cascade would leave a row asserting that someone who is no longer a member still speaks for a school, and would block the member deletion outright.",
      find: `CONSTRAINT "OrganisationContact_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE`,
      replace: `CONSTRAINT "OrganisationContact_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE`,
    },
  ],
};

export default verification;
