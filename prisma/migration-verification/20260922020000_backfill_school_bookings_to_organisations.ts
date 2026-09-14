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
            lower(regexp_replace(btrim(o."name"), '\\s+', ' ', 'g'))), 1, 22)) AS "idIsDerived"
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
  migration: "20260922020000_backfill_school_bookings_to_organisations",
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
          ('sc-school-b', 'admin@tps.test', 'x', '  Tokoroa   Primary School ', '',
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
              firstName: "  Tokoroa   Primary School ",
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
      find: `left(regexp_replace(btrim(m."firstName"), '\\s+', ' ', 'g'), 200) AS school_name`,
      replace: `left(regexp_replace(btrim(m."firstName"), '\\s+', ' ', 'g'), 20) AS school_name`,
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
