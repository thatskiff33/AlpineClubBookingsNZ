-- Reverse script for 20261116010000_other_lodge_central_id (#64).
--
-- Prisma never applies, checksums or reads this file: run it by hand, as the
-- migration role, against the database being rolled back.
--
-- YOU PROBABLY DO NOT NEED IT: the release before #64 never names these
-- columns, so routing traffic back needs no schema reverse. What dropping them
-- loses: each row's central id and the "keyed" marker. Nothing else: the next
-- download after re-upgrading finds the marker NULL and asks for the whole
-- registry, which matches every row by name again and refills the ids.
--
-- WHILE ROLLED BACK the old release merges downloads by name again, so a lodge
-- renamed on the central server in that time arrives as a second row; after
-- re-upgrading the stale one is marked "not found on the Alpine Central
-- Server" in the Other lodges panel for an administrator to assess.
--
-- RE-UPGRADING after running this: `_prisma_migrations` still records
-- 20261116010000 as APPLIED, so `prisma migrate deploy` skips it and the
-- release would fail on the missing column. Re-apply migration.sql BY HAND
-- before the release serves traffic.

DROP INDEX IF EXISTS "OtherLodge_centralId_key";
ALTER TABLE "OtherLodge" DROP COLUMN IF EXISTS "centralId";
ALTER TABLE "ServerNzSettings" DROP COLUMN IF EXISTS "otherLodgesKeyedAt";
