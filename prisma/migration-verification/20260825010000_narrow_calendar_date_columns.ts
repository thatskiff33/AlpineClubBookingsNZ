import type { DataMigrationMutant, DataMigrationVerification } from "./types";

/**
 * #2872 (CT-3, epic #2988) — eleven calendar-date columns narrowed from
 * `timestamp(3)` to `date`.
 *
 * WHY THIS MIGRATION NEEDS A FIXTURE AT ALL. `Migration drift check` applies
 * every migration to an EMPTY PostgreSQL, so an `ALTER COLUMN ... SET DATA TYPE`
 * is proven to parse and proven to recast nothing. The whole risk of this change
 * lives in what the cast does to rows a club already has: the day must survive
 * it exactly, and a value that would LOSE something must stop the deploy instead
 * of being silently truncated.
 *
 * THE TWO CLAIMS, AND WHY BOTH ARE NEEDED. The type change alone is checkable
 * from `information_schema`, and the day alone is checkable from `to_char`.
 * Either on its own passes a mutant the other catches: a migration that never
 * ran keeps every day intact, and a migration that converts through a timezone
 * still ends up with a `date` column. So every case asserts both.
 *
 * `to_char(col, 'YYYY-MM-DD')` reads the same on a `timestamp` and on a `date`,
 * which is deliberate — it is a claim about the CALENDAR DAY, independent of the
 * column's type, so the "not applied at all" mutant is caught by the type
 * assertion and the day-shifting mutants are caught by this one. It is also what
 * `types.ts` requires of a timestamp read: a raw naive timestamp is resolved
 * against the CLIENT's zone and would pass in UTC CI while failing on a
 * Pacific/Auckland machine.
 */

/** Every narrowed column, as `information_schema` will report it afterwards. */
const NARROWED_COLUMNS: { table: string; column: string; type: string }[] = [
  { table: "FamilyGroupJoinRequest", column: "childDateOfBirth", type: "date" },
  {
    table: "FamilyGroupJoinRequest",
    column: "requestedDateOfBirth",
    type: "date",
  },
  { table: "GroupBooking", column: "joinDeadline", type: "date" },
  { table: "Member", column: "dateOfBirth", type: "date" },
  { table: "Member", column: "joinedDate", type: "date" },
  { table: "Member", column: "lifeMemberDate", type: "date" },
  { table: "MemberApplication", column: "applicantDateOfBirth", type: "date" },
  { table: "PromoCode", column: "bookingStartFrom", type: "date" },
  { table: "PromoCode", column: "bookingStartUntil", type: "date" },
  { table: "PromoCode", column: "validFrom", type: "date" },
  { table: "PromoCode", column: "validUntil", type: "date" },
];

/**
 * The `information_schema` read behind the type claim.
 *
 * The pairs are listed inline rather than joined against anything, so a column
 * that stops existing returns no row and the assertion fails on a short list
 * rather than passing over an absence.
 */
const NARROWED_COLUMN_TYPES_SQL = `SELECT c."table_name"::text AS "table",
       c."column_name"::text AS "column",
       c."data_type"::text AS "type"
  FROM information_schema.columns c
 WHERE c."table_schema" = 'public'
   AND (c."table_name", c."column_name") IN (
     ('FamilyGroupJoinRequest', 'childDateOfBirth'),
     ('FamilyGroupJoinRequest', 'requestedDateOfBirth'),
     ('GroupBooking', 'joinDeadline'),
     ('Member', 'dateOfBirth'),
     ('Member', 'joinedDate'),
     ('Member', 'lifeMemberDate'),
     ('MemberApplication', 'applicantDateOfBirth'),
     ('PromoCode', 'bookingStartFrom'),
     ('PromoCode', 'bookingStartUntil'),
     ('PromoCode', 'validFrom'),
     ('PromoCode', 'validUntil')
   )
 ORDER BY c."table_name" COLLATE "C", c."column_name" COLLATE "C"`;

/**
 * The column #2872 deliberately did NOT narrow, read the same way.
 *
 * `MembershipNominationSettings.gateEffectiveFrom` is a MIXED column: the admin
 * panel writes a calendar day, but the settings route stamps `new Date()` — a
 * real instant — the first time the gate is enabled with the cutoff box left
 * empty. A migration that narrowed it would truncate that instant, and on any
 * club that had used the feature that way the fail-closed preflight would RAISE
 * and stop the deploy instead. So the exclusion is not an omission, and this
 * query is what stops it silently becoming one: it fails the moment somebody
 * adds `@db.Date` back without answering the writer.
 */
const EXCLUDED_COLUMN_TYPE_SQL = `SELECT c."data_type"::text AS "type"
  FROM information_schema.columns c
 WHERE c."table_schema" = 'public'
   AND c."table_name" = 'MembershipNominationSettings'
   AND c."column_name" = 'gateEffectiveFrom'`;

/**
 * ONE REACHABILITY MUTANT PER PREFLIGHT ARM — eleven of them, not one.
 *
 * The preflight is a hand-written eleven-arm `UNION ALL`, and every case in this
 * fixture seeds values that are clean, NULL or absent. That means no case can
 * tell a firing arm from a dead one: delete an arm, or point it at the wrong
 * column, and every expectation above still passes. The single inverted-predicate
 * mutant this fixture used to carry proved reachability for `Member.dateOfBirth`
 * and for nothing else — ten arms were unproven, and the mutant that exposes it
 * is the copy-paste error the shape invites:
 *
 *     AND "validUntil" <> date_trunc('day', "validUntil")
 *  -> AND "validFrom"  <> date_trunc('day', "validFrom")
 *
 * which is semantically valid, matches exactly once, and silently stops
 * preflighting `PromoCode.validUntil` while passing every assertion here.
 *
 * Inverting an arm is the cheap general answer. The first case seeds a clean
 * non-NULL value in EVERY narrowed column, so an inverted arm matches that row,
 * `offenders` comes back non-empty and the migration must RAISE. If it does not,
 * that arm is not evaluating the table it claims to — and the only guard standing
 * between a club's stored dates and a silent truncation is decoration for that
 * column.
 *
 * Generated from `NARROWED_COLUMNS` rather than written out, so an arm cannot be
 * added to the migration and left unproven here: the same list drives the type
 * assertions, and a column missing from it fails those first.
 */
const preflightArmMutants: DataMigrationMutant[] = NARROWED_COLUMNS.map(
  ({ table, column }) => ({
    name: `invert the preflight arm for ${table}.${column}, so a clean midnight value counts as an offender`,
    harm:
      `Not a shipping hazard in itself — it is the proof that the preflight arm for ` +
      `${table}.${column} is REACHABLE and really evaluates that table. Every other ` +
      `assertion in this fixture is about the cast, and all of them pass with the whole ` +
      `DO block deleted; the first case seeds a clean value in this column, so an inverted ` +
      `arm must make the migration RAISE. If it does not, this arm is dead — deleted, or ` +
      `naming another column after a copy-paste — and a stored value carrying a time would ` +
      `be truncated onto a day nobody chose, with the evidence destroyed.`,
    find: `AND "${column}" <> date_trunc('day', "${column}")`,
    replace: `AND "${column}" = date_trunc('day', "${column}")`,
  }),
);

const narrowCalendarDateColumns: DataMigrationVerification = {
  migration: "20260825010000_narrow_calendar_date_columns",
  intent:
    "Eleven columns that hold a CALENDAR DAY — three dates of birth, a membership start date, a life-membership date, two family-request dates of birth, four promo-window edges and a group-booking join deadline — become PostgreSQL `date` instead of `timestamp(3)`. Every stored day must survive the cast unchanged, every NULL must stay NULL, no neighbouring column may move, and a stored value that carries a TIME must stop the migration rather than be silently truncated onto a day nobody chose. A twelfth candidate, MembershipNominationSettings.gateEffectiveFrom, is deliberately left as `timestamp(3)` because it has a clock writer, and it must still be a timestamp afterwards.",
  cases: [
    {
      name: "a club holding a value in all eleven columns, every one already a clean calendar day — plus a real instant in the column that is NOT narrowed",
      seed: `
        INSERT INTO "Member" (
          "id", "email", "passwordHash", "firstName", "lastName",
          "dateOfBirth", "joinedDate", "lifeMemberDate", "ageTier", "updatedAt"
        )
        VALUES (
          'cd-member', 'cd-member@example.test', 'hash', 'Ada', 'Calendar',
          TIMESTAMP '1985-06-15 00:00:00', TIMESTAMP '2019-02-01 00:00:00',
          TIMESTAMP '2024-12-31 00:00:00', 'ADULT', TIMESTAMP '2026-08-25 09:41:07.123'
        );

        INSERT INTO "MemberApplication" (
          "id", "applicantFirstName", "applicantLastName", "applicantEmail",
          "applicantDateOfBirth", "nominator1Email", "nominator2Email", "updatedAt"
        )
        VALUES (
          'cd-application', 'Bo', 'Applicant', 'cd-applicant@example.test',
          TIMESTAMP '2001-01-01 00:00:00', 'n1@example.test', 'n2@example.test',
          TIMESTAMP '2026-08-25 09:41:07.123'
        );

        INSERT INTO "FamilyGroup" ("id", "name", "updatedAt")
        VALUES ('cd-family', 'Calendar family', TIMESTAMP '2026-08-25 09:41:07.123');

        INSERT INTO "FamilyGroupJoinRequest" (
          "id", "familyGroupId", "requesterId", "type",
          "childFirstName", "childLastName", "childDateOfBirth"
        )
        VALUES (
          'cd-child-request', 'cd-family', 'cd-member', 'CHILD_REQUEST',
          'Cy', 'Calendar', TIMESTAMP '2019-01-15 00:00:00'
        );

        INSERT INTO "FamilyGroupJoinRequest" (
          "id", "familyGroupId", "requesterId", "type",
          "requestedFirstName", "requestedLastName", "requestedDateOfBirth"
        )
        VALUES (
          'cd-adult-request', 'cd-family', 'cd-member', 'ADULT_REQUEST',
          'Di', 'Calendar', TIMESTAMP '1990-03-08 00:00:00'
        );

        INSERT INTO "PromoCode" (
          "id", "code", "type", "percentOff",
          "validFrom", "validUntil", "bookingStartFrom", "bookingStartUntil",
          "updatedAt"
        )
        VALUES (
          'cd-promo', 'CDPROMO', 'PERCENTAGE', 10,
          TIMESTAMP '2026-04-01 00:00:00', TIMESTAMP '2026-09-30 00:00:00',
          TIMESTAMP '2026-06-01 00:00:00', TIMESTAMP '2026-08-31 00:00:00',
          TIMESTAMP '2026-08-25 09:41:07.123'
        );

        INSERT INTO "MembershipNominationSettings" (
          "id", "gateEnabled", "gateEffectiveFrom", "updatedAt"
        )
        VALUES ('default', true, TIMESTAMP '2026-06-15 21:00:00', TIMESTAMP '2026-08-25 09:41:07.123');

        INSERT INTO "Booking" (
          "id", "memberId", "checkIn", "checkOut",
          "totalPriceCents", "finalPriceCents", "updatedAt"
        )
        VALUES (
          'cd-booking', 'cd-member', DATE '2026-09-04', DATE '2026-09-06',
          0, 0, TIMESTAMP '2026-08-25 09:41:07.123'
        );

        INSERT INTO "GroupBooking" (
          "id", "organiserBookingId", "organiserMemberId", "joinCode",
          "paymentMode", "joinDeadline", "updatedAt"
        )
        VALUES (
          'cd-group', 'cd-booking', 'cd-member', 'CDJOIN',
          'EACH_PAYS_OWN', TIMESTAMP '2026-08-30 00:00:00',
          TIMESTAMP '2026-08-25 09:41:07.123'
        );
      `,
      expectations: [
        {
          claim:
            "all eleven columns are PostgreSQL `date` afterwards. This is the claim that fails when the migration is not applied at all — every day assertion below would pass over an untouched `timestamp` column, because to_char reads the same either way",
          sql: NARROWED_COLUMN_TYPES_SQL,
          rows: NARROWED_COLUMNS,
        },
        {
          claim:
            "the member's three days are the days that were stored: 15 June 1985, 1 February 2019, 31 December 2024. A cast that went through a timezone would move at least one of them, and 31 December is the one that would also move the YEAR",
          sql: `SELECT to_char("dateOfBirth", 'YYYY-MM-DD') AS "dateOfBirth",
                       to_char("joinedDate", 'YYYY-MM-DD') AS "joinedDate",
                       to_char("lifeMemberDate", 'YYYY-MM-DD') AS "lifeMemberDate"
                  FROM "Member" WHERE "id" = 'cd-member'`,
          rows: [
            {
              dateOfBirth: "1985-06-15",
              joinedDate: "2019-02-01",
              lifeMemberDate: "2024-12-31",
            },
          ],
        },
        {
          claim:
            "nothing else on the member row moved. A table rewrite touches every row, so the columns NOT being narrowed have to be shown to come back byte-identical — `ageTier` in particular, because it is what the member is charged on, and `updatedAt`, because a moved timestamp would make every member look as though somebody had just edited them",
          sql: `SELECT "firstName", "lastName", "ageTier",
                       to_char("updatedAt", 'YYYY-MM-DD HH24:MI:SS.MS') AS "updatedAt"
                  FROM "Member" WHERE "id" = 'cd-member'`,
          rows: [
            {
              firstName: "Ada",
              lastName: "Calendar",
              ageTier: "ADULT",
              updatedAt: "2026-08-25 09:41:07.123",
            },
          ],
        },
        {
          claim:
            "the application's date of birth is still 1 January 2001 — a New Year's Day value, which is the one a westward zone conversion sends into the previous year",
          sql: `SELECT to_char("applicantDateOfBirth", 'YYYY-MM-DD') AS "applicantDateOfBirth"
                  FROM "MemberApplication" WHERE "id" = 'cd-application'`,
          rows: [{ applicantDateOfBirth: "2001-01-01" }],
        },
        {
          claim:
            "both family-request dates of birth survive: the child's 15 January 2019 and the requested adult's 8 March 1990",
          sql: `SELECT "id",
                       to_char("childDateOfBirth", 'YYYY-MM-DD') AS "childDateOfBirth",
                       to_char("requestedDateOfBirth", 'YYYY-MM-DD') AS "requestedDateOfBirth"
                  FROM "FamilyGroupJoinRequest" WHERE "familyGroupId" = 'cd-family'
                 ORDER BY "id" COLLATE "C"`,
          rows: [
            {
              id: "cd-adult-request",
              childDateOfBirth: null,
              requestedDateOfBirth: "1990-03-08",
            },
            {
              id: "cd-child-request",
              childDateOfBirth: "2019-01-15",
              requestedDateOfBirth: null,
            },
          ],
        },
        {
          claim:
            "all four promo-window edges survive. These are money: `bookingStartFrom`/`bookingStartUntil` gate on a booking's check-in, so an edge that moved by a day would price a stay the club never meant to discount, or refuse one it did",
          sql: `SELECT to_char("validFrom", 'YYYY-MM-DD') AS "validFrom",
                       to_char("validUntil", 'YYYY-MM-DD') AS "validUntil",
                       to_char("bookingStartFrom", 'YYYY-MM-DD') AS "bookingStartFrom",
                       to_char("bookingStartUntil", 'YYYY-MM-DD') AS "bookingStartUntil"
                  FROM "PromoCode" WHERE "id" = 'cd-promo'`,
          rows: [
            {
              validFrom: "2026-04-01",
              validUntil: "2026-09-30",
              bookingStartFrom: "2026-06-01",
              bookingStartUntil: "2026-08-31",
            },
          ],
        },
        {
          claim:
            "the group booking's join deadline survives. An off-by-one here closes group joining a day early, so the last member to try is refused a booking the organiser had left open",
          sql: `SELECT to_char("joinDeadline", 'YYYY-MM-DD') AS "joinDeadline"
                  FROM "GroupBooking" WHERE "id" = 'cd-group'`,
          rows: [{ joinDeadline: "2026-08-30" }],
        },
        {
          claim:
            "the nomination gate's cutoff is still a `timestamp`, because #2872 deliberately did not narrow it — it has a clock writer. A pull request that adds `@db.Date` back without answering that writer fails here",
          sql: EXCLUDED_COLUMN_TYPE_SQL,
          rows: [{ type: "timestamp without time zone" }],
        },
        {
          claim:
            "and it keeps its TIME. This row seeds 21:00, which is the shape the settings route's `new Date()` writes when an admin enables the gate without typing a cutoff. A migration that narrowed the column would truncate that instant here, and on a real club it would instead make the fail-closed preflight RAISE and stop the deploy",
          sql: `SELECT to_char("gateEffectiveFrom", 'YYYY-MM-DD HH24:MI:SS') AS "gateEffectiveFrom"
                  FROM "MembershipNominationSettings" WHERE "id" = 'default'`,
          rows: [{ gateEffectiveFrom: "2026-06-15 21:00:00" }],
        },
        {
          claim:
            "the booking's own lodge nights are untouched. `Booking.checkIn`/`checkOut` were ALREADY `@db.Date` and are the model this migration copies, so a change here would mean the migration had reached past its eleven columns",
          sql: `SELECT to_char("checkIn", 'YYYY-MM-DD') AS "checkIn",
                       to_char("checkOut", 'YYYY-MM-DD') AS "checkOut"
                  FROM "Booking" WHERE "id" = 'cd-booking'`,
          rows: [{ checkIn: "2026-09-04", checkOut: "2026-09-06" }],
        },
      ],
    },
    {
      name: "a club that has never filled any of these in — every narrowed column NULL",
      seed: `
        INSERT INTO "Member" (
          "id", "email", "passwordHash", "firstName", "lastName", "updatedAt"
        )
        VALUES (
          'cd-empty-member', 'cd-empty@example.test', 'hash', 'Eli', 'Empty',
          TIMESTAMP '2026-08-25 09:41:07.123'
        );

        INSERT INTO "PromoCode" ("id", "code", "type", "percentOff", "updatedAt")
        VALUES ('cd-empty-promo', 'CDEMPTY', 'PERCENTAGE', 5, TIMESTAMP '2026-08-25 09:41:07.123');
      `,
      expectations: [
        {
          claim:
            "the columns are still narrowed. A preflight that refused an all-NULL table would block the upgrade of every club that has never used these fields, which is most of them",
          sql: NARROWED_COLUMN_TYPES_SQL,
          rows: NARROWED_COLUMNS,
        },
        {
          claim:
            "a NULL stays NULL. A cast that coalesced would invent a birthday, and an invented birthday hands that member an age tier and therefore a price",
          sql: `SELECT "dateOfBirth", "joinedDate", "lifeMemberDate"
                  FROM "Member" WHERE "id" = 'cd-empty-member'`,
          rows: [{ dateOfBirth: null, joinedDate: null, lifeMemberDate: null }],
        },
        {
          claim: "the promo code's four NULL window edges stay NULL — a promo with no window is unrestricted, and inventing an edge would silently stop it applying",
          sql: `SELECT "validFrom", "validUntil", "bookingStartFrom", "bookingStartUntil"
                  FROM "PromoCode" WHERE "id" = 'cd-empty-promo'`,
          rows: [
            {
              validFrom: null,
              validUntil: null,
              bookingStartFrom: null,
              bookingStartUntil: null,
            },
          ],
        },
      ],
    },
    {
      name: "a fresh install with nothing in any of these tables — the shape the migration meets on most deployments",
      seed: "",
      expectations: [
        {
          claim:
            "the eleven columns narrow with no rows present at all. This is the case that would pass vacuously on its own, which is exactly why it asserts the TYPE rather than a value",
          sql: NARROWED_COLUMN_TYPES_SQL,
          rows: NARROWED_COLUMNS,
        },
      ],
    },
  ],
  mutants: [
    ...preflightArmMutants,
    {
      name: "convert Member.dateOfBirth through the club's timezone instead of casting it",
      harm:
        "The single most likely wrong implementation, and it looks conscientious: 'the value is a New Zealand day, so read it in New Zealand time'. It is exactly backwards. The stored value is UTC midnight, so reading it as NZ local and converting to UTC lands at midday on the PREVIOUS day, and the cast then keeps that previous day. Every date of birth in the club moves back one day, permanently, and a member whose birthday sits on a season-start anniversary silently changes age tier — which changes what they are charged and whether they may host. Nothing afterwards could tell a shifted row from a correct one.",
      find: `ALTER TABLE "Member" ALTER COLUMN "dateOfBirth" SET DATA TYPE DATE;`,
      replace: `ALTER TABLE "Member" ALTER COLUMN "dateOfBirth" SET DATA TYPE DATE USING (("dateOfBirth" AT TIME ZONE 'Pacific/Auckland' AT TIME ZONE 'UTC')::date);`,
    },
    {
      name: "shift the group booking's join deadline back a day while casting it",
      harm:
        "An off-by-one on a deadline closes group joining a day early, so the last member to try is refused a booking the organiser had left open for them. It is here as well as the date-of-birth mutant because the two columns are on different tables and only one of the eleven ALTERs is being tested by that one: a fixture whose teeth are all in a single statement would pass while the other ten did the wrong thing.",
      find: `ALTER TABLE "GroupBooking" ALTER COLUMN "joinDeadline" SET DATA TYPE DATE;`,
      replace: `ALTER TABLE "GroupBooking" ALTER COLUMN "joinDeadline" SET DATA TYPE DATE USING (("joinDeadline" - INTERVAL '1 day')::date);`,
    },
    {
      name: "forget one of the eleven columns — Member.lifeMemberDate is never narrowed",
      harm:
        "The quiet failure of a migration that lists its columns by hand. The schema file would declare `@db.Date` while the database still held `timestamp(3)`, so `Migration drift check` would fail on the next pull request rather than this one, and in the meantime every reader that assumed the adapter's date binding would be wrong about that column alone. It is caught here by the type assertion, which is the reason every case asserts the type as well as the day.",
      find: `ALTER TABLE "Member" ALTER COLUMN "lifeMemberDate" SET DATA TYPE DATE;`,
      replace: `SELECT 1;`,
    },
  ],
  // NOT CLAIMED, and deliberately so. Replaying the file would re-run the
  // preflight against columns that are now `date` rather than `timestamp(3)`,
  // where `date_trunc('day', ...)` resolves through a different overload and the
  // comparison becomes session-zone dependent. It would very probably still hold
  // — both sides get the same treatment — but "very probably" is not the standard
  // for a claim the runner would then take as proven, and nothing needs the
  // property: Prisma never re-applies a migration it has recorded, and this file
  // rewrites no club data for a replay to double.
  idempotentReRun: false,
};

export default narrowCalendarDateColumns;
