BEGIN;

-- #3826 (epic #3813, child C1; decisions on #3492): a booking may carry
-- several promo codes, one PromoRedemption per code. EXPAND ONLY — nothing is
-- read back out of a row, and no row is rewritten.
--
-- OLD-CODE COMPATIBLE, GIVEN THE SWITCH. The previously deployed release reads
-- Booking.promoRedemption as one-to-one. It stays correct because the new
-- ClubModuleSettings.multiPromoCodes switch below defaults OFF, and while it is
-- off redeemPromoCode refuses to persist a second redemption on any booking —
-- so the database never holds a booking the old release cannot represent until
-- an operator turns the switch on after cut-over. rollback.sql restores the
-- single unique, which holds for exactly as long as the switch has never been on.
--
-- LOCK IMPACT: every statement is DDL on small, cold promo tables and the
-- module-settings singleton; none touches a hot table. CREATE UNIQUE INDEX
-- takes SHARE on its table for the build (blocking writes to it, not reads),
-- ADD COLUMN with a constant default is catalog-only under ACCESS EXCLUSIVE for
-- the instant of the catalog change, and DROP INDEX takes ACCESS EXCLUSIVE on
-- PromoRedemption for the instant of the drop. The migrate service's
-- lock_timeout bounds every wait.

-- 1. The booker's order (D-3813-2). 0 for every existing, single-code booking.
ALTER TABLE "PromoRedemption" ADD COLUMN "applicationOrder" INTEGER NOT NULL DEFAULT 0;

-- 2. One redemption per CODE per booking. Built before the old unique is dropped
--    so the table is never without an index leading on "bookingId". It cannot
--    fail on existing data: the dropped index is stricter.
CREATE UNIQUE INDEX "PromoRedemption_bookingId_promoCodeId_key" ON "PromoRedemption"("bookingId", "promoCodeId");

DROP INDEX "PromoRedemption_bookingId_key";

-- 3. "A night is never discounted twice" (#3492), held by the database: one
--    adjustment of a kind per night, across ALL of a booking's redemptions.
--    The existing BookingGuestNightAdjustment_night_kind_redemption_key is
--    scoped per redemption, which said the same thing only while a booking
--    could hold one redemption.
--
--    WHY IT ALREADY HOLDS: night-adjustment-write.ts is the only writer
--    (INV-MONEY-029 census). Each write names one booking's sole redemption
--    (PromoRedemption_bookingId_key, dropped above in this same transaction)
--    and only that booking's own nights, and no path moves a guest or a night
--    between bookings — so (night, kind) was already unique. The check below
--    refuses with a count rather than letting the index build fail on an
--    opaque duplicate-key error, and either way the migration aborts whole and
--    the deploy stops before cut-over.
DO $night_kind_precheck$
DECLARE
    duplicate_pairs INTEGER;
BEGIN
    SELECT count(*) INTO duplicate_pairs
    FROM (
        SELECT 1
        FROM "BookingGuestNightAdjustment"
        WHERE "bookingGuestNightId" IS NOT NULL
        GROUP BY "bookingGuestNightId", "kind"
        HAVING count(*) > 1
    ) AS duplicated;
    IF duplicate_pairs > 0 THEN
        RAISE EXCEPTION
            '#3826: % night(s) carry more than one adjustment of the same kind; the night/kind unique index cannot be built. Investigate before re-running this migration.',
            duplicate_pairs;
    END IF;
END;
$night_kind_precheck$;

CREATE UNIQUE INDEX "BookingGuestNightAdjustment_night_kind_unique"
    ON "BookingGuestNightAdjustment" ("bookingGuestNightId", "kind")
    WHERE "bookingGuestNightId" IS NOT NULL;

-- 4. The rollout switch. Default OFF; see the header.
ALTER TABLE "ClubModuleSettings" ADD COLUMN "multiPromoCodes" BOOLEAN NOT NULL DEFAULT false;

COMMIT;
