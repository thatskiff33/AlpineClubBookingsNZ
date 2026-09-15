import type { DataMigrationVerification } from "./types";

/**
 * Who owns every booking, and through which organisation. The LEFT JOIN is what
 * makes a booking that lost its member without gaining an organisation visible
 * as a row rather than as an absence.
 */
const OWNERSHIP = `
  SELECT b."id" AS "booking",
         b."memberId" AS "member",
         o."name" AS "organisation"
    FROM "Booking" b
    LEFT JOIN "Organisation" o ON o."id" = b."organisationId"
   ORDER BY b."id"
`;

/** Every school record the migration left behind, with what it inherited. */
const ORGANISATIONS = `
  SELECT o."name" AS "name",
         o."email" AS "email",
         o."xeroContactId" AS "xero",
         (o."id" = 'org' || substr(md5('school-organisation:' ||
            lower(btrim(left(btrim(regexp_replace(o."name", '\\s+', ' ', 'g')), 200)))), 1, 22)) AS "idIsDerived"
    FROM "Organisation" o
   ORDER BY o."name"
`;

/** What became of the invented people and of everybody else. */
const MEMBERS = `
  SELECT m."id" AS "member",
         m."firstName" AS "firstName",
         m."lastName" AS "lastName",
         m."xeroContactId" AS "xero"
    FROM "Member" m
   ORDER BY m."id"
`;

/**
 * The promo rows, amounts included. The amounts are here precisely because they
 * must NOT move: this migration changes who a booking belongs to and nothing
 * about what it cost.
 */
const PROMO = `
  SELECT r."bookingId" AS "booking",
         r."memberId" AS "redemptionMember",
         r."discountCents" AS "redemptionDiscount",
         a."memberId" AS "allocationMember",
         a."discountCents" AS "allocationDiscount",
         (SELECT count(*) FROM "PromoRedemptionAllocation" x
           WHERE x."promoRedemptionId" = r."id") AS "allocationRows"
    FROM "PromoRedemption" r
    LEFT JOIN "PromoRedemptionAllocation" a ON a."promoRedemptionId" = r."id"
   ORDER BY r."bookingId", a."id"
`;

/** Which requests now name the school they were always about. */
const REQUESTS = `
  SELECT r."id" AS "request",
         o."name" AS "organisation"
    FROM "BookingRequest" r
    LEFT JOIN "Organisation" o ON o."id" = r."organisationId"
   ORDER BY r."id"
`;

const verification: DataMigrationVerification = {
  migration: "20260923040000_backfill_school_bookings_to_organisations",
  intent:
    "Move the bookings of every member the club CLASSIFIED as an organisation onto that school's record, leave a real teacher's booking and an ordinary member's booking exactly as they are, carry the school's own Xero customer across without ever taking a person's, and change no amount anywhere.",
  idempotentReRun: false,
  cases: [
    {
      name: "one school recorded twice, its teacher, and an ordinary member",
      // The pre-state a club that has been running school bookings for years
      // actually holds: an invented school row per approval, so one school spelt
      // two ways, the real teacher beside them, and members who have nothing to
      // do with any of it.
      seed: `
        INSERT INTO "Member"
          ("id", "email", "passwordHash", "firstName", "lastName", "role",
           "canLogin", "xeroContactId", "updatedAt")
        VALUES
          ('sc-school-a', 'office@tps.test', 'x', 'Tokoroa Primary School', '',
           'SCHOOL', false, 'xero-tps-first', TIMESTAMP '2026-01-01 00:00:00'),
          -- A LEADING TAB, not a leading space. PostgreSQL's one-argument
          -- btrim() strips only the space character, so the first cut of this
          -- migration folded this row to a name beginning with a space, minted
          -- a record under it, then failed to resolve that record and raised
          -- inside the maintenance window. Seeding spaces alone hid it.
          ('sc-school-b', 'admin@tps.test', 'x', E'\\t Tokoroa   Primary School ', '',
           'SCHOOL', false, 'xero-tps-second', TIMESTAMP '2026-01-02 00:00:00'),
          ('sc-teacher', 'rangi@tps.test', 'x', 'Rangi', 'Teacher',
           'SCHOOL', false, 'xero-rangi', TIMESTAMP '2026-01-03 00:00:00'),
          ('sc-ordinary', 'ordinary@example.test', 'x', 'Ada', 'Ordinary',
           'USER', true, 'xero-ada', TIMESTAMP '2026-01-04 00:00:00');

        INSERT INTO "Booking"
          ("id", "memberId", "checkIn", "checkOut", "status",
           "totalPriceCents", "finalPriceCents", "updatedAt")
        VALUES
          ('sc-b-school-a', 'sc-school-a', DATE '2026-08-01', DATE '2026-08-03',
           'CONFIRMED', 120000, 114000, TIMESTAMP '2026-01-01 00:00:00'),
          ('sc-b-school-b', 'sc-school-b', DATE '2026-09-01', DATE '2026-09-03',
           'CONFIRMED', 90000, 90000, TIMESTAMP '2026-01-02 00:00:00'),
          ('sc-b-teacher', 'sc-teacher', DATE '2026-10-01', DATE '2026-10-02',
           'CONFIRMED', 8000, 8000, TIMESTAMP '2026-01-03 00:00:00'),
          ('sc-b-ordinary', 'sc-ordinary', DATE '2026-11-01', DATE '2026-11-02',
           'CONFIRMED', 6000, 6000, TIMESTAMP '2026-01-04 00:00:00');

        -- The writer-authored evidence: the approval that minted each invented
        -- member recorded itself here, in the same transaction.
        INSERT INTO "BookingRequest"
          ("id", "type", "contactFirstName", "contactLastName", "contactEmail",
           "checkIn", "checkOut", "guests", "schoolName",
           "convertedMemberId", "convertedBookingId", "updatedAt")
        VALUES
          ('sc-req-a', 'SCHOOL', 'Rangi', 'Teacher', 'rangi@tps.test',
           DATE '2026-08-01', DATE '2026-08-03', '[]'::jsonb,
           'Tokoroa Primary School', 'sc-school-a', 'sc-b-school-a',
           TIMESTAMP '2026-01-01 00:00:00'),
          ('sc-req-b', 'SCHOOL', 'Rangi', 'Teacher', 'rangi@tps.test',
           DATE '2026-09-01', DATE '2026-09-03', '[]'::jsonb,
           'Tokoroa Primary School', 'sc-school-b', 'sc-b-school-b',
           TIMESTAMP '2026-01-02 00:00:00'),
          ('sc-req-general', 'GENERAL', 'Ada', 'Ordinary', 'ordinary@example.test',
           DATE '2026-11-01', DATE '2026-11-02', '[]'::jsonb, NULL,
           'sc-ordinary', 'sc-b-ordinary', TIMESTAMP '2026-01-04 00:00:00');

        INSERT INTO "HutLeaderAssignment"
          ("id", "memberId", "startDate", "endDate", "source", "updatedAt")
        VALUES
          ('sc-hla-teacher', 'sc-teacher', DATE '2026-08-01', DATE '2026-08-03',
           'SCHOOL_BOOKING', TIMESTAMP '2026-01-01 00:00:00');

        INSERT INTO "PromoCode" ("id", "code", "type", "updatedAt")
        VALUES ('sc-promo', 'SCHOOL10', 'PERCENTAGE', TIMESTAMP '2026-01-01 00:00:00');

        -- The allocation row is NOT inserted here: the 20260527120000 trigger
        -- creates it from this redemption, which is exactly how a real club's
        -- row got there. Asserting on ONE allocation row afterwards is what
        -- proves the trigger did not mint a second when the member went NULL.
        INSERT INTO "PromoRedemption"
          ("id", "promoCodeId", "bookingId", "memberId", "discountCents",
           "priceAdjustmentCents")
        VALUES
          ('sc-redemption', 'sc-promo', 'sc-b-school-a', 'sc-school-a', 6000, 0);

        -- What the club decided, before the window opened. Two schools proved by
        -- the census, one teacher proved by the census, and nothing guessed.
        INSERT INTO "SchoolMemberClassification"
          ("memberId", "classification", "evidence", "decidedBy", "decidedAt")
        VALUES
          ('sc-school-a', 'ORGANISATION', 'census proof', 'census',
           TIMESTAMP '2026-02-01 00:00:00'),
          ('sc-school-b', 'ORGANISATION', 'census proof', 'census',
           TIMESTAMP '2026-02-01 00:00:00'),
          ('sc-teacher', 'PERSON', 'census proof', 'census',
           TIMESTAMP '2026-02-01 00:00:00');
      `,
      expectations: [
        {
          claim:
            "both school bookings belong to the one school record and to no member; the teacher's and the ordinary member's bookings are untouched",
          sql: OWNERSHIP,
          rows: [
            { booking: "sc-b-ordinary", member: "sc-ordinary", organisation: null },
            {
              booking: "sc-b-school-a",
              member: null,
              organisation: "Tokoroa Primary School",
            },
            {
              booking: "sc-b-school-b",
              member: null,
              organisation: "Tokoroa Primary School",
            },
            { booking: "sc-b-teacher", member: "sc-teacher", organisation: null },
          ],
        },
        {
          claim:
            "one record for the school however it was spelt, carrying the first row's address and Xero customer, under an id derived from its own folded name",
          sql: ORGANISATIONS,
          rows: [
            {
              name: "Tokoroa Primary School",
              email: "office@tps.test",
              xero: "xero-tps-first",
              idIsDerived: true,
            },
          ],
        },
        {
          claim:
            "only the school row whose Xero customer actually moved gives it up; the second keeps its own, and no person's contact is touched",
          sql: MEMBERS,
          rows: [
            {
              member: "sc-ordinary",
              firstName: "Ada",
              lastName: "Ordinary",
              xero: "xero-ada",
            },
            {
              member: "sc-school-a",
              firstName: "Tokoroa Primary School",
              lastName: "",
              xero: null,
            },
            {
              member: "sc-school-b",
              firstName: "\t Tokoroa   Primary School ",
              lastName: "",
              xero: "xero-tps-second",
            },
            {
              member: "sc-teacher",
              firstName: "Rangi",
              lastName: "Teacher",
              xero: "xero-rangi",
            },
          ],
        },
        {
          claim:
            "the redemption and its one allocation name no member and every cent is exactly what it was",
          sql: PROMO,
          rows: [
            {
              booking: "sc-b-school-a",
              redemptionMember: null,
              redemptionDiscount: 6000,
              allocationMember: null,
              allocationDiscount: 6000,
              allocationRows: "1",
            },
          ],
        },
        {
          claim:
            "the school's own requests name the school; a general request is left alone",
          sql: REQUESTS,
          rows: [
            { request: "sc-req-a", organisation: "Tokoroa Primary School" },
            { request: "sc-req-b", organisation: "Tokoroa Primary School" },
            { request: "sc-req-general", organisation: null },
          ],
        },
      ],
      // ---------------------------------------------------------------------
      // AND BACK AGAIN. The reverse scripts, executed against exactly this
      // post-state (#3369).
      //
      // Nothing ran these before. `validate-blue-green-migrations.sh` proves
      // the file EXISTS beside a windowed migration and stops there — so the
      // first cut of this reverse built its owner map with one member per
      // ORGANISATION, and against this very pre-state it handed both schools'
      // bookings back to `sc-school-a`, left `sc-req-b` still pointing at the
      // organisation, and then failed its own delete guard on the record it
      // claims to remove. It read correctly. Only running it says otherwise.
      // ---------------------------------------------------------------------
      reverse: {
        runs: [
          {
            name: "in the operator's order, every booking goes back to the member that actually owned it",
            scripts: [
              "20260923040000_backfill_school_bookings_to_organisations",
              "20260923030000_booking_owner_optional_member",
            ],
            expectations: [
              {
                claim:
                  "each school's booking returns to ITS OWN member — the one the converted SCHOOL request names beside it — not both to the lower-id row",
                sql: OWNERSHIP,
                rows: [
                  { booking: "sc-b-ordinary", member: "sc-ordinary", organisation: null },
                  { booking: "sc-b-school-a", member: "sc-school-a", organisation: null },
                  { booking: "sc-b-school-b", member: "sc-school-b", organisation: null },
                  { booking: "sc-b-teacher", member: "sc-teacher", organisation: null },
                ],
              },
              {
                claim:
                  "the Xero customer goes back to the member it came from, and the second school row keeps the one that never moved",
                sql: MEMBERS,
                rows: [
                  {
                    member: "sc-ordinary",
                    firstName: "Ada",
                    lastName: "Ordinary",
                    xero: "xero-ada",
                  },
                  {
                    member: "sc-school-a",
                    firstName: "Tokoroa Primary School",
                    lastName: "",
                    xero: "xero-tps-first",
                  },
                  {
                    member: "sc-school-b",
                    firstName: "\t Tokoroa   Primary School ",
                    lastName: "",
                    xero: "xero-tps-second",
                  },
                  {
                    member: "sc-teacher",
                    firstName: "Rangi",
                    lastName: "Teacher",
                    xero: "xero-rangi",
                  },
                ],
              },
              {
                claim:
                  "the minted school record is gone — which it can only be once BOTH of its requests have been unlinked",
                sql: ORGANISATIONS,
                rows: [],
              },
              {
                claim:
                  "every converted request lets go of the school again, so re-running the forward migration re-derives the links rather than finding them half-present",
                sql: REQUESTS,
                rows: [
                  { request: "sc-req-a", organisation: null },
                  { request: "sc-req-b", organisation: null },
                  { request: "sc-req-general", organisation: null },
                ],
              },
              {
                claim:
                  "the promo rows name the booking's own member again and not one cent moved in either direction",
                sql: PROMO,
                rows: [
                  {
                    booking: "sc-b-school-a",
                    redemptionMember: "sc-school-a",
                    redemptionDiscount: 6000,
                    allocationMember: "sc-school-a",
                    allocationDiscount: 6000,
                    allocationRows: "1",
                  },
                ],
              },
            ],
          },
          {
            name: "run in the WRONG order, it refuses structurally",
            // The refusal used to be three SET NOT NULL statements, which fail
            // only when a NULL member happens to exist. Measured on a freshly
            // migrated database it exited 0 and did half a rollback. This run
            // is what keeps the four sentences calling it unconditional true.
            scripts: [
              "20260923030000_booking_owner_optional_member",
              "20260923040000_backfill_school_bookings_to_organisations",
            ],
            raises: "school_reverse_wrong_order",
          },
        ],
        mutants: [
          {
            // Literally the shipped defect, restored. Two adversarial lenses
            // found it by reading; only this run finds it by running.
            name: "resolve the owner per ORGANISATION instead of per booking",
            script: "20260923040000_backfill_school_bookings_to_organisations",
            harm: "Every booking of a twice-recorded school comes back owned by whichever of its rows has the lowest id. The other school's row ends up owning nothing, its converted request keeps a link to a record the script then cannot delete, and no screen in the application shows any of it.",
            find: `    COALESCE(
        (
            SELECT r."convertedMemberId"
              FROM "BookingRequest" r
              JOIN "school_rollback_member" sm
                ON sm.member_id = r."convertedMemberId"
               AND sm.organisation_id = b."organisationId"
             WHERE r."type" = 'SCHOOL'
               AND r."convertedBookingId" = b."id"
             ORDER BY r."convertedMemberId"
             LIMIT 1
        ),
        (
            SELECT s.member_id
              FROM "school_rollback_sole_member" s
             WHERE s.organisation_id = b."organisationId"
        )
    ) AS member_id`,
            replace: `    (
        SELECT min(sm.member_id)
          FROM "school_rollback_member" sm
         WHERE sm.organisation_id = b."organisationId"
    ) AS member_id`,
          },
          {
            name: "unlink only one converted request per organisation",
            script: "20260923040000_backfill_school_bookings_to_organisations",
            harm: "A second request spelling the same school keeps pointing at a record the club has rolled back, and the delete guard that exists to stop an organisation disappearing out from under a reference then refuses — so a record the script reports as removed survives the rollback.",
            find: `  AND req."convertedMemberId" = sm.member_id;`,
            replace: `  AND req."convertedMemberId" = (SELECT min(member_id) FROM "school_rollback_member" srm WHERE srm.organisation_id = sm.organisation_id);`,
          },
          {
            name: "clear the organisation's Xero customer instead of returning it",
            script: "20260923040000_backfill_school_bookings_to_organisations",
            harm: "The school's Xero customer is dropped on the way back rather than returned to the member it came from. That provider link is the only thing tying years of invoices to the school, the member row that owns the booking again holds none, and the next invoice creates a duplicate customer.",
            find: `SET "xeroContactId" = x.organisation_xero_contact_id`,
            replace: `SET "xeroContactId" = NULL`,
          },
          {
            name: "drop the structural wrong-order guard",
            script: "20260923030000_booking_owner_optional_member",
            harm: "The two reverses can then be run in the wrong order on a club with no school bookings, which exits 0 having restored the shape without restoring the data — a half rollback reported as a success.",
            find: `        WHERE conname = 'Booking_owner_exactly_one'`,
            replace: `        WHERE conname = 'Booking_owner_exactly_one_never_added'`,
          },
        ],
      },
    },
    {
      name: "one school recorded twice with no converted requests left to say which owned what",
      // The other half of the reverse's promise. A club that deleted its old
      // booking requests — or an installation whose school bookings an officer
      // entered by hand — leaves the forward migration's collapse with no
      // evidence to undo it. The reverse must REFUSE and name the backup
      // rather than pick the lower-id row, which is what the first cut did.
      seed: `
        INSERT INTO "Member"
          ("id", "email", "passwordHash", "firstName", "lastName", "role",
           "canLogin", "updatedAt")
        VALUES
          ('nr-school-a', 'a@oas.test', 'x', 'Otorohanga Area School', '',
           'SCHOOL', false, TIMESTAMP '2026-01-01 00:00:00'),
          ('nr-school-b', 'b@oas.test', 'x', 'otorohanga area school', '',
           'SCHOOL', false, TIMESTAMP '2026-01-02 00:00:00');

        INSERT INTO "Booking"
          ("id", "memberId", "checkIn", "checkOut", "status",
           "totalPriceCents", "finalPriceCents", "updatedAt")
        VALUES
          ('nr-b-a', 'nr-school-a', DATE '2026-08-01', DATE '2026-08-03',
           'CONFIRMED', 50000, 50000, TIMESTAMP '2026-01-01 00:00:00'),
          ('nr-b-b', 'nr-school-b', DATE '2026-09-01', DATE '2026-09-03',
           'CONFIRMED', 40000, 40000, TIMESTAMP '2026-01-02 00:00:00');

        INSERT INTO "SchoolMemberClassification"
          ("memberId", "classification", "evidence", "decidedBy", "decidedAt")
        VALUES
          ('nr-school-a', 'ORGANISATION', 'officer: the school itself',
           'Jordan (treasurer)', TIMESTAMP '2026-02-01 00:00:00'),
          ('nr-school-b', 'ORGANISATION', 'officer: the same school again',
           'Jordan (treasurer)', TIMESTAMP '2026-02-01 00:00:00');
      `,
      expectations: [
        {
          claim:
            "both spellings collapse onto one record and neither booking keeps a member — the forward direction is unchanged by the reverse being stricter",
          sql: OWNERSHIP,
          rows: [
            { booking: "nr-b-a", member: null, organisation: "Otorohanga Area School" },
            { booking: "nr-b-b", member: null, organisation: "Otorohanga Area School" },
          ],
        },
      ],
      reverse: {
        runs: [
          {
            name: "refuses rather than guessing which of two rows owned which booking",
            scripts: [
              "20260923040000_backfill_school_bookings_to_organisations",
              "20260923030000_booking_owner_optional_member",
            ],
            raises: "school_backfill_rollback_unreconstructable",
          },
        ],
        mutants: [],
      },
    },
  ],
  mutants: [
    {
      name: "re-parent PERSON-classified rows as well as ORGANISATION ones",
      harm: "A real teacher's own booking is taken off them and handed to a school. They stop seeing it, the school is invoiced for it, and the club has no record that it ever belonged to a person.",
      find: `WHERE c."classification" = 'ORGANISATION'`,
      replace: `WHERE c."classification" IN ('ORGANISATION', 'PERSON')`,
    },
    {
      name: "clear every re-parented member's Xero link, not only the one that moved",
      harm: "The second row spelling the same school loses its Xero customer without anything gaining it. That provider link is the only thing tying years of invoices to the school, and nothing in the application can put it back.",
      find: `AND org."xeroContactId" = m."xeroContactId"`,
      replace: `AND true`,
    },
    {
      name: "cap the school's name at twenty characters instead of two hundred",
      harm: "Every school with a longer name gets a record under a truncated name. The next booking for that school does not match it, so the club ends up with two records and two Xero customers for one school.",
      // BOTH expressions, deliberately. Capping only `school_name` left
      // `folded_name` at two hundred, so the minted record did not resolve back
      // and the migration ABORTED — detection for free, and detection that says
      // nothing about the value written, which is exactly what this fixture's
      // own type documentation warns about. Capping both lets the migration
      // COMPLETE and the truncated name arrive in the rows a case compares,
      // which is the harm above.
      find: `    btrim(left(btrim(regexp_replace(m."firstName", '\\s+', ' ', 'g')), 200)) AS school_name,
    lower(btrim(left(btrim(regexp_replace(m."firstName", '\\s+', ' ', 'g')), 200))) AS folded_name,`,
      replace: `    btrim(left(btrim(regexp_replace(m."firstName", '\\s+', ' ', 'g')), 20)) AS school_name,
    lower(btrim(left(btrim(regexp_replace(m."firstName", '\\s+', ' ', 'g')), 20))) AS folded_name,`,
    },
    {
      name: "let the later of two spellings win the school's details",
      harm: "Which of two recorded addresses the school inherits becomes arbitrary, so a rehearsal against a copy of the database and the real run can send the school's invoices to different places.",
      find: `ORDER BY map.folded_name, map.member_id`,
      replace: `ORDER BY map.folded_name, map.member_id DESC`,
    },
  ],
};

export default verification;
