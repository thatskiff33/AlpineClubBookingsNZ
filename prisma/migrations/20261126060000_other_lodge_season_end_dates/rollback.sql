-- Reverse script for 20261126060000_other_lodge_season_end_dates (#75).
--
-- Prisma never applies, checksums or reads this file: run it by hand, as the
-- migration role, against the database being rolled back.
--
-- WHAT IT LOSES: every season end date entered or downloaded; seasons then
-- run from each start to the other's start again.
--
-- RE-UPGRADING after running this: `_prisma_migrations` still records
-- 20261126060000 as APPLIED, so `prisma migrate deploy` skips it. Re-apply
-- migration.sql BY HAND before the release serves traffic; the next
-- whole-registry download refills the end dates other clubs set.

ALTER TABLE "OtherLodge" DROP COLUMN IF EXISTS "winterSeasonEnd";
ALTER TABLE "OtherLodge" DROP COLUMN IF EXISTS "summerSeasonEnd";
