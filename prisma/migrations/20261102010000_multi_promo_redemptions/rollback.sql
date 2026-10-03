-- Reverse of 20261102010000_multi_promo_redemptions (#3826, epic #3813).
--
-- Operator-run only: Prisma never applies or checksums this file.
--
-- SAFE ONLY WHILE THE multiPromoCodes SWITCH HAS NEVER BEEN ON. While it is
-- off, redeemPromoCode refuses a second redemption on any booking, so every
-- booking holds at most one PromoRedemption and the single unique below can be
-- rebuilt. If the switch HAS been on, step 2 fails on the first booking that
-- holds two codes: find them with
--
--   SELECT "bookingId", count(*) FROM "PromoRedemption"
--   GROUP BY "bookingId" HAVING count(*) > 1;
--
-- and settle each by hand (re-price the booking down to one code through the
-- application) before re-running. Deleting a redemption row here would leak
-- its usage slot and change what the member was charged — do not.
BEGIN;

ALTER TABLE "ClubModuleSettings" DROP COLUMN IF EXISTS "multiPromoCodes";

DROP INDEX IF EXISTS "BookingGuestNightAdjustment_night_kind_unique";

CREATE UNIQUE INDEX IF NOT EXISTS "PromoRedemption_bookingId_key" ON "PromoRedemption"("bookingId");

DROP INDEX IF EXISTS "PromoRedemption_bookingId_promoCodeId_key";

ALTER TABLE "PromoRedemption" DROP COLUMN IF EXISTS "applicationOrder";

COMMIT;
