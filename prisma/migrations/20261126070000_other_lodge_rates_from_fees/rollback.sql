-- Reverse script for 20261126070000_other_lodge_rates_from_fees (#77).
--
-- Prisma never applies, checksums or reads this file: run it by hand, as the
-- migration role, against the database being rolled back.
--
-- WHAT IT LOSES: the "from the Fees page" switch; the rates and dates it filled
-- stay as they are and become hand-edited values again.
--
-- RE-UPGRADING after running this: `_prisma_migrations` still records
-- 20261126070000 as APPLIED, so `prisma migrate deploy` skips it. Re-apply
-- migration.sql BY HAND before the release serves traffic.

ALTER TABLE "OtherLodge" DROP COLUMN IF EXISTS "ratesFromFees";
