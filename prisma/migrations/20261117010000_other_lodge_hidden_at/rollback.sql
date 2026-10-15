-- Reverse script for 20261117010000_other_lodge_hidden_at (#58).
--
-- Prisma never applies, checksums or reads this file: run it by hand, as the
-- migration role, against the database being rolled back.
--
-- YOU PROBABLY DO NOT NEED IT: the release before #58 never names this
-- column, so routing traffic back needs no schema reverse. What dropping it
-- loses: which lodges are hidden, so every one shows again in the lists and
-- drop-downs. A lodge hidden because the central server deleted it is hidden
-- again only when it is next reported, which a whole-registry download does.
--
-- RE-UPGRADING after running this: `_prisma_migrations` still records
-- 20261117010000 as APPLIED, so `prisma migrate deploy` skips it and the
-- release would fail on the missing column. Re-apply migration.sql BY HAND
-- before the release serves traffic.

ALTER TABLE "OtherLodge" DROP COLUMN IF EXISTS "hiddenAt";
