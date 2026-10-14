-- Reverse script for 20261116010000_other_lodge_central_id (#64).
--
-- Prisma never applies, checksums or reads this file: run it by hand, as the
-- migration role, against the database being rolled back.
--
-- YOU PROBABLY DO NOT NEED IT: the release before #64 never names this
-- column, so routing traffic back needs no schema reverse. What dropping it
-- loses: each row's central id. Nothing else: the next download after
-- re-upgrading finds no row keyed and asks for the whole registry, which
-- matches every row by name again and refills the ids.
--
-- RE-UPGRADING after running this: `_prisma_migrations` still records
-- 20261116010000 as APPLIED, so `prisma migrate deploy` skips it and the
-- release would fail on the missing column. Re-apply migration.sql BY HAND
-- before the release serves traffic.

DROP INDEX IF EXISTS "OtherLodge_centralId_key";
ALTER TABLE "OtherLodge" DROP COLUMN IF EXISTS "centralId";
