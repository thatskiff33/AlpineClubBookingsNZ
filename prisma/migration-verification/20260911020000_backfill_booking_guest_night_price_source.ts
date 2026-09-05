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
  migration: "20260911020000_backfill_booking_guest_night_price_source",
  intent:
    "Classify only the three migration-authored even-split populations and exact officer-repair audit evidence, leave every other historical row UNKNOWN, and preserve every priceCents value byte for byte.",
  idempotentReRun: true,
  cases: [
    {
      name: "historical backfills and officer repairs beside deceptive, zero, null, and live controls",
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
          ('ps-booking', 'price-source-owner', DATE '2026-08-01', DATE '2026-08-03',
           'CONFIRMED', 42503, 42503, TIMESTAMP '2026-01-01 00:00:00');

        INSERT INTO "BookingGuest"
          ("id", "bookingId", "firstName", "lastName", "ageTier",
           "stayStart", "stayEnd", "priceCents")
        VALUES
          ('ps-g-initial', 'ps-booking', 'Initial', 'Backfill', 'ADULT',
           DATE '2026-08-01', DATE '2026-08-03', 10001),
          ('ps-g-later', 'ps-booking', 'Later', 'Backfill', 'ADULT',
           DATE '2026-08-01', DATE '2026-08-03', 9000),
          ('ps-g-request', 'ps-booking', 'Request', 'Backfill', 'ADULT',
           DATE '2026-08-01', DATE '2026-08-03', 7001),
          ('ps-g-live', 'ps-booking', 'Live', 'Quote', 'ADULT',
           DATE '2026-08-01', DATE '2026-08-03', 10001),
          ('ps-g-v5', 'ps-booking', 'Version', 'Five', 'ADULT',
           DATE '2026-08-01', DATE '2026-08-02', 2500),
          ('ps-g-zero', 'ps-booking', 'Zero', 'Price', 'ADULT',
           DATE '2026-08-01', DATE '2026-08-02', 0),
          ('ps-g-null', 'ps-booking', 'Unknown', 'Price', 'ADULT',
           DATE '2026-08-01', DATE '2026-08-02', 0),
          ('ps-g-repaired-history', 'ps-booking', 'Historic', 'Repair', 'ADULT',
           DATE '2026-08-01', DATE '2026-08-02', 6000),
          ('ps-g-repaired-draining', 'ps-booking', 'Draining', 'Repair', 'ADULT',
           DATE '2026-08-01', DATE '2026-08-02', 8000);

        INSERT INTO "BookingGuestNight"
          ("id", "bookingGuestId", "stayDate", "priceCents", "createdAt")
        VALUES
          ('bgn_' || md5('ps-g-initial:2026-08-01'),
           'ps-g-initial', DATE '2026-08-01', 5001, TIMESTAMP '2026-01-01 00:00:00'),
          ('bgn_' || md5('ps-g-initial:2026-08-02'),
           'ps-g-initial', DATE '2026-08-02', 5000, TIMESTAMP '2026-01-01 00:00:00'),
          ('11111111-1111-4111-8111-111111111111',
           'ps-g-later', DATE '2026-08-01', 4500, TIMESTAMP '2026-01-01 00:00:00'),
          ('22222222-2222-4222-8222-222222222222',
           'ps-g-request', DATE '2026-08-01', 3501, TIMESTAMP '2026-01-01 00:00:00'),
          ('cm-live-night', 'ps-g-live', DATE '2026-08-01', 5001, TIMESTAMP '2026-01-01 00:00:00'),
          ('bgn_not-the_migration_hash', 'ps-g-live', DATE '2026-08-02', 5000, TIMESTAMP '2026-01-01 00:00:00'),
          ('55555555-5555-5555-8555-555555555555',
           'ps-g-v5', DATE '2026-08-01', 2500, TIMESTAMP '2026-01-01 00:00:00'),
          ('cm-zero-night', 'ps-g-zero', DATE '2026-08-01', 0, TIMESTAMP '2026-01-01 00:00:00'),
          ('cm-null-night', 'ps-g-null', DATE '2026-08-01', NULL, TIMESTAMP '2026-01-01 00:00:00'),
          ('33333333-3333-4333-8333-333333333333',
           'ps-g-repaired-history', DATE '2026-08-01', 6000, TIMESTAMP '2026-01-01 00:00:00'),
          ('cm-draining-repair',
           'ps-g-repaired-draining', DATE '2026-08-01', 8000, TIMESTAMP '2026-01-01 00:00:00');

        INSERT INTO "AuditLog"
          ("id", "action", "entityType", "entityId", "outcome", "metadata", "createdAt")
        VALUES
          ('ps-audit-history', 'booking-payment.stored-night-price.record',
           'BookingGuest', 'ps-g-repaired-history', 'success',
           '{"nightPrices":[{"date":"2026-08-01","priceCents":6000}]}'::jsonb,
           TIMESTAMP '2026-02-01 00:00:00'),
          ('ps-audit-draining', 'booking-payment.stored-night-price.reconcile',
           'BookingGuest', 'ps-g-repaired-draining', 'success',
           '{"nightPrices":[{"date":"2026-08-01","priceCents":8000}]}'::jsonb,
           TIMESTAMP '2026-02-01 00:00:00');

        -- The expand migration's trigger has already handled both inserts.
        -- Reset one row to model an audit committed before #3275 deployed;
        -- the target migration must replay that historical writer evidence.
        UPDATE "BookingGuestNight"
        SET "priceSource" = 'UNKNOWN'
        WHERE "bookingGuestId" = 'ps-g-repaired-history';
      `,
      expectations: [
        {
          claim:
            "only exact MD5 and version-4 UUID backfills become EVEN_SPLIT, exact repair audits become OFFICER_PRICED, and all other sources and prices stay untouched",
          sql: ALL_NIGHTS,
          rows: [
            { id: "bgn_784b6c27d365f05b66a502c937d77ad8", guest: "ps-g-initial", night: "2026-08-01", priceCents: 5001, priceSource: "EVEN_SPLIT" },
            { id: "bgn_dcc7e848731f01b903cd55028cd092a4", guest: "ps-g-initial", night: "2026-08-02", priceCents: 5000, priceSource: "EVEN_SPLIT" },
            { id: "11111111-1111-4111-8111-111111111111", guest: "ps-g-later", night: "2026-08-01", priceCents: 4500, priceSource: "EVEN_SPLIT" },
            { id: "cm-live-night", guest: "ps-g-live", night: "2026-08-01", priceCents: 5001, priceSource: "UNKNOWN" },
            { id: "bgn_not-the_migration_hash", guest: "ps-g-live", night: "2026-08-02", priceCents: 5000, priceSource: "UNKNOWN" },
            { id: "cm-null-night", guest: "ps-g-null", night: "2026-08-01", priceCents: null, priceSource: "UNKNOWN" },
            { id: "33333333-3333-4333-8333-333333333333", guest: "ps-g-repaired-history", night: "2026-08-01", priceCents: 6000, priceSource: "OFFICER_PRICED" },
            { id: "cm-draining-repair", guest: "ps-g-repaired-draining", night: "2026-08-01", priceCents: 8000, priceSource: "OFFICER_PRICED" },
            { id: "22222222-2222-4222-8222-222222222222", guest: "ps-g-request", night: "2026-08-01", priceCents: 3501, priceSource: "EVEN_SPLIT" },
            { id: "55555555-5555-5555-8555-555555555555", guest: "ps-g-v5", night: "2026-08-01", priceCents: 2500, priceSource: "UNKNOWN" },
            { id: "cm-zero-night", guest: "ps-g-zero", night: "2026-08-01", priceCents: 0, priceSource: "UNKNOWN" },
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
      name: "omit both version-4 UUID backfill populations",
      harm:
        "Rows created by the two later backfills remain indistinguishable from real quotes even though those migrations alone wrote version-4 UUID identifiers.",
      find: `WHERE bgn."id" ~
  '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';`,
      replace: "WHERE FALSE;",
    },
    {
      name: "accept UUID versions that gen_random_uuid did not write",
      harm:
        "A version-5 UUID row is falsely labelled EVEN_SPLIT even though the backfill writer could not have created it.",
      find: "-[0-9a-f]{4}-4[0-9a-f]{3}-",
      replace: "-[0-9a-f]{4}-[1-5][0-9a-f]{3}-",
    },
    {
      name: "omit historical officer-repair replay",
      harm:
        "A row repaired before provenance deployed remains falsely labelled EVEN_SPLIT instead of using its transactional officer audit evidence.",
      find: `SELECT "applyBookingGuestNightOfficerPriceSourceFromAudit"(
  audit."entityId",
  audit."metadata"->'nightPrices',
  audit."createdAt"
)`,
      replace: `SELECT NULL`,
    },
    {
      name: "change a stored price while recording provenance",
      harm:
        "The migration changes money evidence instead of only describing where it came from.",
      find: `UPDATE "BookingGuestNight" AS bgn
SET "priceSource" = 'EVEN_SPLIT'
WHERE bgn."id" =`,
      replace: `UPDATE "BookingGuestNight" AS bgn
SET "priceSource" = 'EVEN_SPLIT', "priceCents" = bgn."priceCents" + 1
WHERE bgn."id" =`,
    },
    {
      name: "classify every historical row as an even split",
      harm:
        "Live quoted rows and genuinely unproved history are relabelled from UNKNOWN as EVEN_SPLIT, manufacturing provenance from no evidence.",
      find: `WHERE bgn."id" ~
  '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';`,
      replace: "WHERE TRUE;",
    },
  ],
};

export default verification;
