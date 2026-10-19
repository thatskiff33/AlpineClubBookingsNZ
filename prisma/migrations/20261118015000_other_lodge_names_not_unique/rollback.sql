-- Reverse script for 20261118010000_other_lodge_names_not_unique (#69).
--
-- Prisma never applies, checksums or reads this file: run it by hand, as the
-- migration role, against the database being rolled back.
--
-- WHAT IT NEEDS: no two VISIBLE lodges sharing a name, or the partial unique
-- index below fails to build. Look first, and rename (or hide) all but one of
-- each pair:
--
-- Step 1 (look first): SELECT "id", "name", "location", "centralId" FROM
-- "OtherLodge" o WHERE "hiddenAt" IS NULL AND EXISTS (SELECT 1 FROM
-- "OtherLodge" v WHERE v."hiddenAt" IS NULL AND v."name" = o."name" AND
-- v."id" <> o."id") ORDER BY "name";
--
-- RE-UPGRADING after running this: `_prisma_migrations` still records
-- 20261118010000 as APPLIED, so `prisma migrate deploy` skips it. Re-apply
-- migration.sql BY HAND before the release serves traffic.

DROP INDEX IF EXISTS "OtherLodge_name_idx";
CREATE UNIQUE INDEX "OtherLodge_name_visible_key" ON "OtherLodge"("name") WHERE "hiddenAt" IS NULL;
