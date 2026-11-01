-- Reverse script for 20261126040000_other_lodge_hidden_at (#58).
--
-- That migration is declared `old_code_compatible=windowed` in
-- docs/BLUE_GREEN_MIGRATION_SAFETY.tsv, together with
-- 20261126050000_other_lodge_names_not_unique (owner decision, 24 Oct 2026,
-- #4262): its rollback boundary is the MIGRATE step. Prisma never applies,
-- checksums or reads this file: run it by hand, as the migration role, against
-- the database being rolled back, with every web colour and worker stopped.
--
-- ORDER: newest first. Run 20261126050000_other_lodge_names_not_unique's
-- rollback.sql FIRST, then this one; run out of order, this one stops on the
-- missing "OtherLodge_name_visible_key" and changes nothing. Only after both
-- may the previous release start: its download creates a lodge with an upsert
-- keyed on the name, which needs the full unique index restored below.
--
-- DUPLICATE NAMES: THE RECOVERY LIMIT. The previous release can hold one lodge
-- per name, hidden or not. While any two rows share a name (a hidden lodge
-- beside a live one of its name, which this release allows) the full unique
-- index cannot be built, so the script REFUSES before changing anything
-- (other_lodge_hidden_rollback_blocked). Look first:
--
-- Step 1: SELECT "id", "name", "location", "centralId", "hiddenAt" FROM
-- "OtherLodge" o WHERE EXISTS (SELECT 1 FROM "OtherLodge" v WHERE v."name" =
-- o."name" AND v."id" <> o."id") ORDER BY "name", "id";
--
-- Step 2: rename all but one of each set by id (a hidden one first), for
-- example UPDATE "OtherLodge" SET "name" = "name" || ' (deleted)' WHERE "id" =
-- '<id>'; and re-run this script. Bookings and booking requests name a lodge
-- by id, so they keep it, under its new name.
--
-- WHAT IT LOSES: which lodges are hidden. Every one shows again in the lists
-- and drop-downs of the previous release. After re-upgrading, a lodge hidden
-- because the central server deleted it is hidden again only on a
-- WHOLE-registry download: clear "ServerNzSettings"."otherLodgesKeyedAt" (and
-- the cursor) to force one. A lodge an ADMINISTRATOR hid is hidden again only
-- by hand; the OTHER_LODGE_HIDDEN audit rows name each one.
--
-- RE-UPGRADING after running this: `_prisma_migrations` still records
-- 20261126040000 as APPLIED, so `prisma migrate deploy` skips it and the
-- release would fail on the missing column. Re-apply migration.sql BY HAND,
-- then 20261126050000's, before the release serves traffic. This script is
-- not idempotent: a second run fails on the index it dropped, which is the
-- safe direction.

BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "OtherLodge"
    GROUP BY "name"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'other_lodge_hidden_rollback_blocked: two or more Other lodges (hidden or not) share a name; rename all but one of each (step 1 in this script lists them) and run it again';
  END IF;
END $$;

DROP INDEX "OtherLodge_name_visible_key";
CREATE UNIQUE INDEX "OtherLodge_name_key" ON "OtherLodge"("name");
ALTER TABLE "OtherLodge" DROP COLUMN "hiddenAt";

COMMIT;
