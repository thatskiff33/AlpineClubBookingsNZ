-- Reverse script for 20261123010000_other_lodge_non_member_rates (#61).
--
-- Prisma never applies, checksums or reads this file: run it by hand, as the
-- migration role, against the database being rolled back to a release that
-- speaks Alpine Central Server API 2.1.
--
-- YOU PROBABLY DO NOT NEED IT. The release before #61 never names these
-- columns, so routing traffic back needs no schema reverse at all: leave the
-- columns in place and the rates are still there when 2.2 returns. Run this
-- only when the columns themselves must go.
--
-- IT KEEPS THE RATES. The rates cannot be counted on to come back from the
-- central server: the download is incremental from
-- "ServerNzSettings"."otherLodgesCursor", so a lodge the server has not changed
-- since is never sent again, and the next UPLOAD of an edited lodge would send
-- its empty rates as null - which the server reads as "clear" - erasing them
-- for every club. So the rates are copied to "_rollback_other_lodge_rates"
-- first, and put back by the statement at the end of this file.

BEGIN;

CREATE TABLE "_rollback_other_lodge_rates" AS
SELECT
  "id",
  "name",
  "winterRateUnder5Cents",
  "winterRate5To11Cents",
  "winterRate12To17Cents",
  "winterRateAdultCents",
  "summerRateUnder5Cents",
  "summerRate5To11Cents",
  "summerRate12To17Cents",
  "summerRateAdultCents"
FROM "OtherLodge";

ALTER TABLE "OtherLodge"
  DROP CONSTRAINT IF EXISTS "OtherLodge_winterRateUnder5Cents_range",
  DROP CONSTRAINT IF EXISTS "OtherLodge_winterRate5To11Cents_range",
  DROP CONSTRAINT IF EXISTS "OtherLodge_winterRate12To17Cents_range",
  DROP CONSTRAINT IF EXISTS "OtherLodge_winterRateAdultCents_range",
  DROP CONSTRAINT IF EXISTS "OtherLodge_summerRateUnder5Cents_range",
  DROP CONSTRAINT IF EXISTS "OtherLodge_summerRate5To11Cents_range",
  DROP CONSTRAINT IF EXISTS "OtherLodge_summerRate12To17Cents_range",
  DROP CONSTRAINT IF EXISTS "OtherLodge_summerRateAdultCents_range",
  DROP COLUMN IF EXISTS "winterRateUnder5Cents",
  DROP COLUMN IF EXISTS "winterRate5To11Cents",
  DROP COLUMN IF EXISTS "winterRate12To17Cents",
  DROP COLUMN IF EXISTS "winterRateAdultCents",
  DROP COLUMN IF EXISTS "summerRateUnder5Cents",
  DROP COLUMN IF EXISTS "summerRate5To11Cents",
  DROP COLUMN IF EXISTS "summerRate12To17Cents",
  DROP COLUMN IF EXISTS "summerRateAdultCents";

COMMIT;

-- RE-UPGRADING. Prisma will NOT put the columns back: this script does not
-- touch `_prisma_migrations`, which still records 20261123010000 as APPLIED,
-- so `prisma migrate deploy` answers "No pending migrations to apply." and a
-- 2.2 release would fail every OtherLodge read on the missing columns. So,
-- with the 2.2 release deployed but BEFORE it serves traffic or syncs (the
-- nightly run, or anyone pressing Upload):
--
--   1. RE-APPLY migration.sql BY HAND as the migration role. The history row
--      is already correct, so history, schema and database then agree
--      (`prisma migrate diff --exit-code --from-config-datasource --to-schema
--      prisma/schema.prisma` confirms it). Deleting the history row and
--      migrating again is equivalent but edits migration history for no gain.
--   2. Put the rates back, matching by id (the row is the same row; a lodge
--      deleted meanwhile is simply skipped), then drop the holding table:
--
--   UPDATE "OtherLodge" AS l SET
--     "winterRateUnder5Cents" = r."winterRateUnder5Cents",
--     "winterRate5To11Cents"  = r."winterRate5To11Cents",
--     "winterRate12To17Cents" = r."winterRate12To17Cents",
--     "winterRateAdultCents"  = r."winterRateAdultCents",
--     "summerRateUnder5Cents" = r."summerRateUnder5Cents",
--     "summerRate5To11Cents"  = r."summerRate5To11Cents",
--     "summerRate12To17Cents" = r."summerRate12To17Cents",
--     "summerRateAdultCents"  = r."summerRateAdultCents"
--   FROM "_rollback_other_lodge_rates" AS r
--   WHERE r."id" = l."id";
--   DROP TABLE "_rollback_other_lodge_rates";
--
-- Raw SQL does not move "updatedAt" (Prisma sets @updatedAt in its client),
-- so the restored rows are not re-uploaded as though they had been edited.
