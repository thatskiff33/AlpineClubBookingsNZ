-- Reverse of 20261103010000_multi_promo_redemptions (#3826, epic #3813).
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
--
-- RUN IT ONLY WITH THE PRE-#3826 RELEASE SERVING. The release that shipped this
-- migration selects ClubModuleSettings."multiPromoCodes" whenever it reads the
-- module settings, and orders a booking's redemptions by
-- PromoRedemption."applicationOrder" when it writes night adjustments; both
-- columns are gone once this script commits, so that release fails on its next
-- read of either.
--
-- ROLLING FORWARD AFTER THIS SCRIPT. `_prisma_migrations` still records
-- 20261103010000_multi_promo_redemptions as APPLIED and this script does not
-- touch it, so `prisma migrate status` answers "Database schema is up to date"
-- and `prisma migrate deploy` answers "No pending migrations to apply" — and a
-- redeploy of the new release then SKIPS the migration and breaks on the
-- missing columns. To roll forward, delete this migration's ledger row, as the
-- migration role, and let the normal deploy re-apply it:
--
--   DELETE FROM "_prisma_migrations"
--   WHERE "migration_name" = '20261103010000_multi_promo_redemptions';
--
-- then run `prisma migrate deploy`. migration.sql is not idempotent (ADD COLUMN,
-- CREATE INDEX), which is exactly why it must be re-applied from a schema this
-- script has fully reversed and not on top of a partial one.
BEGIN;

ALTER TABLE "ClubModuleSettings" DROP COLUMN IF EXISTS "multiPromoCodes";

DROP INDEX IF EXISTS "BookingGuestNightAdjustment_night_kind_unique";

CREATE UNIQUE INDEX IF NOT EXISTS "PromoRedemption_bookingId_key" ON "PromoRedemption"("bookingId");

DROP INDEX IF EXISTS "PromoRedemption_bookingId_promoCodeId_key";

ALTER TABLE "PromoRedemption" DROP COLUMN IF EXISTS "applicationOrder";

COMMIT;
