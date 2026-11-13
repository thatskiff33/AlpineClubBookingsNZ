import type { DataMigrationVerification } from "./types";

const verification: DataMigrationVerification = {
  migration: "20261211020000_release_cancelled_booking_promos",
  intent: "Release cancelled bookings' promotions and recount every code by raw allocation rows, preserving live redemptions.",
  idempotentReRun: true,
  cases: [{
    name: "Two cancelled codes, a live use, a legacy zero allocation and a drifted empty code",
    seed: `
      INSERT INTO "Member" ("id", "email", "passwordHash", "firstName", "lastName", "updatedAt")
      VALUES ('promo-repair-member', 'promo-repair@example.test', 'x', 'Promo', 'Repair', TIMESTAMP '2026-07-01');
      INSERT INTO "Booking" ("id", "memberId", "checkIn", "checkOut", "status", "totalPriceCents", "finalPriceCents", "updatedAt")
      VALUES ('promo-cancelled', 'promo-repair-member', DATE '2026-08-01', DATE '2026-08-03', 'CANCELLED', 1000, 500, TIMESTAMP '2026-07-01'),
             ('promo-live', 'promo-repair-member', DATE '2026-08-04', DATE '2026-08-06', 'CONFIRMED', 1000, 500, TIMESTAMP '2026-07-01');
      INSERT INTO "PromoCode" ("id", "code", "type", "percentOff", "currentRedemptions", "updatedAt")
      VALUES ('repair-a', 'REPAIR-A', 'PERCENTAGE', 50, 99, TIMESTAMP '2026-07-01'),
             ('repair-b', 'REPAIR-B', 'PERCENTAGE', 50, 99, TIMESTAMP '2026-07-01'),
             ('repair-empty', 'REPAIR-EMPTY', 'PERCENTAGE', 50, 99, TIMESTAMP '2026-07-01');
      INSERT INTO "PromoRedemption" ("id", "promoCodeId", "bookingId", "memberId", "discountCents", "freeNightsUsed")
      VALUES ('cancel-a', 'repair-a', 'promo-cancelled', 'promo-repair-member', 500, 0),
             ('cancel-b', 'repair-b', 'promo-cancelled', 'promo-repair-member', 500, 0),
             ('live-a', 'repair-a', 'promo-live', 'promo-repair-member', 500, 0),
             ('live-zero', 'repair-b', 'promo-live', 'promo-repair-member', 0, 0);
    `,
    expectations: [{
      claim: "Only the live booking retains redemptions and cascading allocation rows",
      sql: `SELECT "id" FROM "PromoRedemption" WHERE "id" IN ('cancel-a','cancel-b','live-a','live-zero') ORDER BY "id"`,
      rows: [{ id: "live-a" }, { id: "live-zero" }],
    }, {
      claim: "Counters equal RAW allocation counts, including a zero-benefit row and a code with none",
      sql: `SELECT p."id", p."currentRedemptions", (SELECT COUNT(*)::int FROM "PromoRedemptionAllocation" a WHERE a."promoCodeId" = p."id") AS "rawCount" FROM "PromoCode" p WHERE p."id" LIKE 'repair-%' ORDER BY p."id"`,
      rows: [{ id: "repair-a", currentRedemptions: 1, rawCount: 1 }, { id: "repair-b", currentRedemptions: 1, rawCount: 1 }, { id: "repair-empty", currentRedemptions: 0, rawCount: 0 }],
    }],
  }],
  mutants: [{
    name: "Release live bookings instead of cancelled bookings",
    harm: "Members lose their active promotion while cancelled uses remain stuck.",
    find: `b."status" = 'CANCELLED'`,
    replace: `b."status" <> 'CANCELLED'`,
  }, {
    name: "Recount only beneficial allocations",
    harm: "The stored counter disagrees with its raw allocation rows.",
    find: `SET "currentRedemptions" = (\n  SELECT COUNT(*) FROM "PromoRedemptionAllocation" a WHERE a."promoCodeId" = p."id"`,
    replace: `SET "currentRedemptions" = (\n  SELECT COUNT(*) FROM "PromoRedemptionAllocation" a WHERE a."promoCodeId" = p."id" AND a."discountCents" > 0`,
  }],
};
export default verification;
