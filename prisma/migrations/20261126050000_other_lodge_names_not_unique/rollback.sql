-- Reverse script for 20261126050000_other_lodge_names_not_unique (#69).
--
-- That migration is declared `old_code_compatible=windowed` in
-- docs/BLUE_GREEN_MIGRATION_SAFETY.tsv, together with
-- 20261126040000_other_lodge_hidden_at (owner decision, 24 Oct 2026, #4262):
-- its rollback boundary is the MIGRATE step. Prisma never applies, checksums
-- or reads this file: run it by hand, as the migration role, against the
-- database being rolled back, with every web colour and worker stopped.
--
-- ORDER: newest first. Run THIS script, then
-- 20261126040000_other_lodge_hidden_at/rollback.sql. This one alone does not
-- restore the previous release: that release needs the FULL unique index on
-- name, which only the second script restores (and the second refuses to run
-- first: the index it drops exists only once this one has restored it).
--
-- DUPLICATE NAMES: THE RECOVERY LIMIT. From cutover on, the release this
-- reverses may hold two lodges of one name (the central id tells them apart).
-- The partial unique index restored below allows one VISIBLE lodge per name,
-- so the script REFUSES, before changing anything, while two visible lodges
-- share a name (other_lodge_names_rollback_blocked). Nothing can choose
-- between them for you. Look first:
--
-- Step 1: SELECT "id", "name", "location", "centralId" FROM "OtherLodge" o
-- WHERE "hiddenAt" IS NULL AND EXISTS (SELECT 1 FROM "OtherLodge" v WHERE
-- v."hiddenAt" IS NULL AND v."name" = o."name" AND v."id" <> o."id")
-- ORDER BY "name", "id";
--
-- Step 2: rename all but one of each set by id, for example
-- UPDATE "OtherLodge" SET "name" = "name" || ' (' || COALESCE("location",
-- "id") || ')' WHERE "id" = '<id>'; and re-run this script. Rename rather than hide: the next
-- script refuses a hidden lodge that shares any lodge's name too. Bookings and
-- booking requests name a lodge by id, so they keep it, under its new name.
-- After rolling back, the previous release matches downloads by name, so a
-- renamed row of ANOTHER club's lodge is no longer refreshed from the central
-- server; the row that kept the name takes the server's copy.
--
-- RE-UPGRADING after running this: `_prisma_migrations` still records
-- 20261126050000 as APPLIED, so `prisma migrate deploy` skips it. Re-apply
-- migration.sql BY HAND, after 20261126040000's, before the release serves
-- traffic. This script is not idempotent: a second run fails on the index it
-- dropped, which is the safe direction.

BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "OtherLodge"
    WHERE "hiddenAt" IS NULL
    GROUP BY "name"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'other_lodge_names_rollback_blocked: two or more visible Other lodges share a name; rename all but one of each (step 1 in this script lists them) and run it again';
  END IF;
END $$;

DROP INDEX "OtherLodge_name_idx";
CREATE UNIQUE INDEX "OtherLodge_name_visible_key" ON "OtherLodge"("name") WHERE "hiddenAt" IS NULL;

COMMIT;
