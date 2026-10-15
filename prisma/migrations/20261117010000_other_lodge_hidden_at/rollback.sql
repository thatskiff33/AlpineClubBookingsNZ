-- Reverse script for 20261117010000_other_lodge_hidden_at (#58).
--
-- Prisma never applies, checksums or reads this file: run it by hand, as the
-- migration role, against the database being rolled back.
--
-- WHAT IT LOSES: which lodges are hidden. Every one shows again in the lists
-- and drop-downs, and a hidden lodge that shares a visible lodge's name makes
-- the full unique index below fail to build: rename such a row first (they are
-- listed by the query in step 1). After re-upgrading, a lodge hidden because
-- the central server deleted it is hidden again only on a WHOLE-registry
-- download: clear "ServerNzSettings"."otherLodgesKeyedAt" (and the cursor) to
-- force one. A lodge an ADMINISTRATOR hid is hidden again only by hand; the
-- OTHER_LODGE_HIDDEN audit rows name each one.
--
-- Step 1 (look first): SELECT "id", "name" FROM "OtherLodge" o WHERE "hiddenAt"
-- IS NOT NULL AND EXISTS (SELECT 1 FROM "OtherLodge" v WHERE v."name" = o."name"
-- AND v."id" <> o."id");
--
-- RE-UPGRADING after running this: `_prisma_migrations` still records
-- 20261117010000 as APPLIED, so `prisma migrate deploy` skips it and the
-- release would fail on the missing column. Re-apply migration.sql BY HAND
-- before the release serves traffic.

DROP INDEX IF EXISTS "OtherLodge_name_visible_key";
CREATE UNIQUE INDEX "OtherLodge_name_key" ON "OtherLodge"("name");
ALTER TABLE "OtherLodge" DROP COLUMN IF EXISTS "hiddenAt";
