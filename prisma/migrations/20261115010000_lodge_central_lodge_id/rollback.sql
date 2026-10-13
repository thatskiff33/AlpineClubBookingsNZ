-- Reverse script for 20261115010000_lodge_central_lodge_id (#62).
--
-- Prisma never applies, checksums or reads this file: run it by hand, as the
-- migration role, against the database being rolled back.
--
-- YOU PROBABLY DO NOT NEED IT: the release before #62 never names these
-- columns, so routing traffic back needs no schema reverse. What dropping them
-- loses: each lodge's "Central lodge" link (re-chosen by an administrator, or
-- the one-lodge default applies again) and the owned-lodge ids (re-sent by the
-- central server on every pull, so the next download restores them).
--
-- RE-UPGRADING after running this: `_prisma_migrations` still records
-- 20261115010000 as APPLIED, so `prisma migrate deploy` skips it and the
-- release would fail on the missing columns. Re-apply migration.sql BY HAND
-- before the release serves traffic.

DROP INDEX IF EXISTS "Lodge_centralLodgeId_key";
ALTER TABLE "Lodge" DROP COLUMN IF EXISTS "centralLodgeId";
ALTER TABLE "ServerNzSettings" DROP COLUMN IF EXISTS "otherLodgesOwnedLodges";
