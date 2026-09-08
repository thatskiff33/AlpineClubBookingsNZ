import type { DataMigrationVerification } from "./types";

/**
 * #3276 (stage 2 of programme #3272). This migration rewrites no data — the
 * PR-time gate classifies it shape-only and demands no fixture. It is
 * registered anyway because three of its properties are semantic and an empty
 * schema diff cannot see them: a night row that predates the column must read
 * UNKNOWN (that is the whole blue/green honesty argument), a row must name
 * exactly one target, and a row must not outlive the promotion it decomposes.
 */
const verification: DataMigrationVerification = {
  migration: "20260912010000_add_booking_guest_night_adjustment",
  intent:
    "Add the night adjustment build-up table and the adjustmentsState column without touching any stored amount; pre-existing nights read UNKNOWN, a row names exactly one target, and rows cascade with their redemption.",
  idempotentReRun: false,
  cases: [
    {
      name: "a booking priced before the column existed, then one promo build-up written after it",
      seed: `
        INSERT INTO "Member"
          ("id", "email", "passwordHash", "firstName", "lastName", "updatedAt")
        VALUES
          ('adj-owner', 'adj-owner@example.test', 'x', 'Adjust', 'Owner',
           TIMESTAMP '2026-01-01 00:00:00');

        INSERT INTO "Booking"
          ("id", "memberId", "checkIn", "checkOut", "status",
           "totalPriceCents", "finalPriceCents", "updatedAt")
        VALUES
          ('adj-booking', 'adj-owner', DATE '2026-08-01', DATE '2026-08-03',
           'CONFIRMED', 9000, 8100, TIMESTAMP '2026-01-01 00:00:00');

        INSERT INTO "BookingGuest"
          ("id", "bookingId", "firstName", "lastName", "ageTier",
           "stayStart", "stayEnd", "priceCents")
        VALUES
          ('adj-guest', 'adj-booking', 'Adjust', 'Guest', 'ADULT',
           DATE '2026-08-01', DATE '2026-08-03', 9000);

        INSERT INTO "BookingGuestNight"
          ("id", "bookingGuestId", "stayDate", "priceCents", "priceSource", "createdAt")
        VALUES
          ('adj-night-1', 'adj-guest', DATE '2026-08-01', 4500, 'SOLD',
           TIMESTAMP '2026-01-01 00:00:00'),
          ('adj-night-2', 'adj-guest', DATE '2026-08-02', 4500, 'SOLD',
           TIMESTAMP '2026-01-01 00:00:00');

        INSERT INTO "PromoCode"
          ("id", "code", "type", "percentOff", "updatedAt")
        VALUES
          ('adj-promo', 'ADJUST10', 'PERCENTAGE', 10, TIMESTAMP '2026-01-01 00:00:00');

        INSERT INTO "PromoRedemption"
          ("id", "promoCodeId", "bookingId", "memberId", "discountCents", "priceAdjustmentCents")
        VALUES
          ('adj-redemption', 'adj-promo', 'adj-booking', 'adj-owner', 900, -900);
      `,
      afterMigration: `
        INSERT INTO "BookingGuestNightAdjustment"
          ("id", "kind", "amountCents", "bookingGuestNightId", "bookingGuestId",
           "bookingId", "promoRedemptionId", "promoCodeId", "beneficiaryMemberId")
        VALUES
          ('adj-row-night', 'PROMO', -450, 'adj-night-1', NULL,
           'adj-booking', 'adj-redemption', 'adj-promo', 'adj-owner'),
          ('adj-row-guest', 'PROMO', -450, NULL, 'adj-guest',
           'adj-booking', 'adj-redemption', 'adj-promo', 'adj-owner');

        UPDATE "BookingGuestNight"
        SET "adjustmentsState" = 'RECORDED'
        WHERE "id" = 'adj-night-1';

        -- A second booking whose promotion is then removed: its rows must go
        -- with the redemption, and nothing else may.
        INSERT INTO "Booking"
          ("id", "memberId", "checkIn", "checkOut", "status",
           "totalPriceCents", "finalPriceCents", "updatedAt")
        VALUES
          ('adj-booking-2', 'adj-owner', DATE '2026-09-01', DATE '2026-09-02',
           'CONFIRMED', 4500, 4050, TIMESTAMP '2026-01-01 00:00:00');
        INSERT INTO "BookingGuest"
          ("id", "bookingId", "firstName", "lastName", "ageTier",
           "stayStart", "stayEnd", "priceCents")
        VALUES
          ('adj-guest-2', 'adj-booking-2', 'Adjust', 'Second', 'ADULT',
           DATE '2026-09-01', DATE '2026-09-02', 4500);
        INSERT INTO "BookingGuestNight"
          ("id", "bookingGuestId", "stayDate", "priceCents", "priceSource")
        VALUES
          ('adj-night-3', 'adj-guest-2', DATE '2026-09-01', 4500, 'SOLD');
        INSERT INTO "PromoRedemption"
          ("id", "promoCodeId", "bookingId", "memberId", "discountCents", "priceAdjustmentCents")
        VALUES
          ('adj-redemption-2', 'adj-promo', 'adj-booking-2', 'adj-owner', 450, -450);
        INSERT INTO "BookingGuestNightAdjustment"
          ("id", "kind", "amountCents", "bookingGuestNightId", "bookingGuestId",
           "bookingId", "promoRedemptionId", "promoCodeId", "beneficiaryMemberId")
        VALUES
          ('adj-row-gone', 'PROMO', -450, 'adj-night-3', NULL,
           'adj-booking-2', 'adj-redemption-2', 'adj-promo', 'adj-owner');
        DELETE FROM "PromoRedemption" WHERE "id" = 'adj-redemption-2';
      `,
      expectations: [
        {
          claim:
            "a night row written before the column existed reads UNKNOWN, and nothing about its price moved; the row the new colour marked reads RECORDED",
          sql: `
            SELECT "id", "priceCents", "priceSource"::text AS "priceSource",
                   "adjustmentsState"::text AS "adjustmentsState"
            FROM "BookingGuestNight"
            WHERE "bookingGuestId" = 'adj-guest'
            ORDER BY "id"
          `,
          rows: [
            { id: "adj-night-1", priceCents: 4500, priceSource: "SOLD", adjustmentsState: "RECORDED" },
            { id: "adj-night-2", priceCents: 4500, priceSource: "SOLD", adjustmentsState: "UNKNOWN" },
          ],
        },
        {
          claim:
            "the column default is UNKNOWN, so a draining-colour insert that omits the column reads honestly",
          sql: `
            SELECT column_default AS "columnDefault", is_nullable AS "isNullable"
            FROM information_schema.columns
            WHERE table_name = 'BookingGuestNight' AND column_name = 'adjustmentsState'
          `,
          rows: [
            {
              columnDefault: `'UNKNOWN'::"BookingGuestNightAdjustmentsState"`,
              isNullable: "NO",
            },
          ],
        },
        {
          claim: "a night-scope row and a guest-scope row both exist, each naming exactly one target",
          sql: `
            SELECT "id", "amountCents",
                   ("bookingGuestNightId" IS NOT NULL) AS "hasNight",
                   ("bookingGuestId" IS NOT NULL) AS "hasGuest"
            FROM "BookingGuestNightAdjustment"
            ORDER BY "id"
          `,
          rows: [
            { id: "adj-row-guest", amountCents: -450, hasNight: false, hasGuest: true },
            { id: "adj-row-night", amountCents: -450, hasNight: true, hasGuest: false },
          ],
        },
        {
          claim: "the exactly-one-target CHECK is present with the intended definition",
          sql: `
            SELECT pg_get_constraintdef(oid) AS "definition"
            FROM pg_constraint
            WHERE conname = 'BookingGuestNightAdjustment_exactly_one_target'
          `,
          rows: [
            {
              definition:
                `CHECK ((("bookingGuestNightId" IS NULL) <> ("bookingGuestId" IS NULL)))`,
            },
          ],
        },
        {
          claim:
            "a row cannot outlive its redemption: removing the second booking's promotion took its row and left its night and the first booking's rows alone",
          sql: `
            SELECT (SELECT count(*) FROM "PromoRedemption")::int AS "redemptions",
                   (SELECT count(*) FROM "BookingGuestNight")::int AS "nights",
                   (SELECT count(*) FROM "BookingGuestNightAdjustment"
                     WHERE "bookingId" = 'adj-booking-2')::int AS "rowsOnSecondBooking"
          `,
          rows: [{ redemptions: 1, nights: 3, rowsOnSecondBooking: 0 }],
        },
      ],
    },
  ],
  mutants: [
    {
      name: "default the state to RECORDED",
      harm:
        "Every night the draining colour inserts, and every historical night, would claim its build-up was recorded when nobody recorded anything — the magic-zero defect wearing an enum.",
      find: `NOT NULL DEFAULT 'UNKNOWN'`,
      replace: `NOT NULL DEFAULT 'RECORDED'`,
    },
    {
      name: "let a row name both targets or neither",
      harm:
        "A row attached to a night AND a guest would be counted twice by a reader summing either grain, and a row attached to nothing would be money that belongs nowhere.",
      find: `CHECK (("bookingGuestNightId" IS NULL) <> ("bookingGuestId" IS NULL))`,
      replace: `CHECK (TRUE)`,
    },
    {
      name: "let rows survive their redemption",
      harm:
        "Removing a promotion from a booking would leave rows asserting a promo amount that no promotion backs.",
      find: `REFERENCES "PromoRedemption"("id") ON DELETE CASCADE ON UPDATE CASCADE`,
      replace: `REFERENCES "PromoRedemption"("id") ON DELETE NO ACTION ON UPDATE CASCADE`,
    },
  ],
};

export default verification;
