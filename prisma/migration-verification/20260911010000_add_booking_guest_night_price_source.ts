import type { DataMigrationVerification } from "./types";

const ALL_NIGHTS = `
  SELECT n."id",
         n."bookingGuestId" AS "guest",
         to_char(n."stayDate", 'YYYY-MM-DD') AS "night",
         n."priceCents" AS "priceCents",
         n."priceSource"::text AS "priceSource"
    FROM "BookingGuestNight" n
   ORDER BY n."bookingGuestId", n."stayDate", n."id"
`;

const verification: DataMigrationVerification = {
  migration: "20260911010000_add_booking_guest_night_price_source",
  intent:
    "Add honest provenance to every stored booking-guest-night price, classify only the three populations whose migration-authored identifiers prove they were even splits, leave every other historical row UNKNOWN, and preserve every priceCents value byte for byte.",
  idempotentReRun: false,
  cases: [
    {
      name: "a club holding rows from all three historical backfills beside indistinguishable live and unproved rows",
      seed: `
        INSERT INTO "Member"
          ("id", "email", "passwordHash", "firstName", "lastName", "updatedAt")
        VALUES
          ('price-source-owner', 'price-source@example.test', 'x', 'Ada', 'Source',
           TIMESTAMP '2026-01-01 00:00:00');

        INSERT INTO "Booking"
          ("id", "memberId", "checkIn", "checkOut", "status",
           "totalPriceCents", "finalPriceCents", "updatedAt")
        VALUES
          ('ps-initial', 'price-source-owner', DATE '2026-08-01', DATE '2026-08-03',
           'CONFIRMED', 10001, 10001, TIMESTAMP '2026-01-01 00:00:00'),
          ('ps-later', 'price-source-owner', DATE '2026-08-01', DATE '2026-08-03',
           'CONFIRMED', 9000, 9000, TIMESTAMP '2026-01-01 00:00:00'),
          ('ps-request', 'price-source-owner', DATE '2026-08-01', DATE '2026-08-03',
           'CONFIRMED', 7001, 7001, TIMESTAMP '2026-01-01 00:00:00'),
          ('ps-live', 'price-source-owner', DATE '2026-08-01', DATE '2026-08-03',
           'CONFIRMED', 10001, 10001, TIMESTAMP '2026-01-01 00:00:00');

        INSERT INTO "BookingGuest"
          ("id", "bookingId", "firstName", "lastName", "ageTier",
           "stayStart", "stayEnd", "priceCents")
        VALUES
          ('ps-g-initial', 'ps-initial', 'Initial', 'Backfill', 'ADULT',
           DATE '2026-08-01', DATE '2026-08-03', 10001),
          ('ps-g-later', 'ps-later', 'Later', 'Backfill', 'ADULT',
           DATE '2026-08-01', DATE '2026-08-03', 9000),
          ('ps-g-request', 'ps-request', 'Request', 'Backfill', 'ADULT',
           DATE '2026-08-01', DATE '2026-08-03', 7001),
          ('ps-g-live', 'ps-live', 'Live', 'Quote', 'ADULT',
           DATE '2026-08-01', DATE '2026-08-03', 10001);

        INSERT INTO "BookingRequest"
          ("id", "contactFirstName", "contactLastName", "contactEmail",
           "checkIn", "checkOut", "guests", "convertedBookingId", "updatedAt")
        VALUES
          ('ps-request-row', 'Ada', 'Source', 'price-source@example.test',
           DATE '2026-08-01', DATE '2026-08-03', '[]'::jsonb, 'ps-request',
           TIMESTAMP '2026-01-01 00:00:00');

        INSERT INTO "BookingGuestNight"
          ("id", "bookingGuestId", "stayDate", "priceCents")
        VALUES
          ('bgn_' || md5('ps-g-initial:2026-08-01'),
           'ps-g-initial', DATE '2026-08-01', 5001),
          ('bgn_' || md5('ps-g-initial:2026-08-02'),
           'ps-g-initial', DATE '2026-08-02', 5000),
          ('11111111-1111-4111-8111-111111111111',
           'ps-g-later', DATE '2026-08-01', 4500),
          ('22222222-2222-4222-8222-222222222222',
           'ps-g-request', DATE '2026-08-01', 3501),
          ('cm-live-night', 'ps-g-live', DATE '2026-08-01', 5001),
          ('bgn_not-the-migration-hash', 'ps-g-live', DATE '2026-08-02', 5000);
      `,
      expectations: [
        {
          claim:
            "the exact bgn plus MD5 rows from the table-creation backfill and UUID rows from both later backfills are EVEN_SPLIT, while a live cuid-like row and an unproved bgn-prefixed row remain UNKNOWN",
          sql: ALL_NIGHTS,
          rows: [
            {
              id: "bgn_784b6c27d365f05b66a502c937d77ad8",
              guest: "ps-g-initial",
              night: "2026-08-01",
              priceCents: 5001,
              priceSource: "EVEN_SPLIT",
            },
            {
              id: "bgn_dcc7e848731f01b903cd55028cd092a4",
              guest: "ps-g-initial",
              night: "2026-08-02",
              priceCents: 5000,
              priceSource: "EVEN_SPLIT",
            },
            {
              id: "11111111-1111-4111-8111-111111111111",
              guest: "ps-g-later",
              night: "2026-08-01",
              priceCents: 4500,
              priceSource: "EVEN_SPLIT",
            },
            {
              id: "cm-live-night",
              guest: "ps-g-live",
              night: "2026-08-01",
              priceCents: 5001,
              priceSource: "UNKNOWN",
            },
            {
              id: "bgn_not-the-migration-hash",
              guest: "ps-g-live",
              night: "2026-08-02",
              priceCents: 5000,
              priceSource: "UNKNOWN",
            },
            {
              id: "22222222-2222-4222-8222-222222222222",
              guest: "ps-g-request",
              night: "2026-08-01",
              priceCents: 3501,
              priceSource: "EVEN_SPLIT",
            },
          ],
        },
      ],
    },
  ],
  mutants: [
    {
      name: "omit the deterministic table-creation backfill population",
      harm:
        "Rows created when BookingGuestNight was introduced remain indistinguishable from real quotes even though their migration-authored identifiers prove they were even splits.",
      find: `WHERE bgn."id" =
  'bgn_' || md5(
    bgn."bookingGuestId" || ':' || to_char(bgn."stayDate", 'YYYY-MM-DD')
  );`,
      replace: "WHERE FALSE;",
    },
    {
      name: "omit both UUID backfill populations",
      harm:
        "Rows created by the two later backfills remain indistinguishable from real quotes even though those migrations alone wrote UUID BookingGuestNight identifiers.",
      find: `WHERE bgn."id" ~
  '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';`,
      replace: "WHERE FALSE;",
    },
    {
      name: "classify every historical row as an even split",
      harm:
        "Live quoted rows and genuinely unproved history are relabelled from UNKNOWN as EVEN_SPLIT, manufacturing provenance from no evidence.",
      find: `WHERE bgn."id" ~
  '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';`,
      replace: "WHERE TRUE;",
    },
  ],
};

export default verification;
