-- #3819 manual reverse, never applied by Prisma migrate.
--
-- The previous release reads none of these columns, so routing back to it needs
-- no schema reverse: it keeps reading #3416's switch, which this migration left
-- untouched. Run this only to remove the columns on purpose, with the new
-- application and workers stopped.
--
-- WARNING: this does NOT remove the migration's row from "_prisma_migrations".
-- Prisma still records 20261104010000_add_lodge_school_hut_leader_kinds as
-- applied, so a later forward deploy will NOT re-add these columns and the
-- release that needs them will fail on its first read. Before deploying
-- forward again, either re-run migration.sql by hand or delete that row from
-- "_prisma_migrations" so `prisma migrate deploy` applies it again.
--
-- What it cannot undo: the rows step 2 inserted (only when the switch was ON)
-- — own rows for lodges no row served, and a legacy "default" row linked to the
-- default lodge when none existed. They hold NULL capacity and soft cap, which
-- is what those lodges resolved to before, so they are left in place; deleting
-- them would be a guess about which rows were inserted here. Per-lodge edits
-- made on the new release are lost with the columns.
ALTER TABLE "LodgeSettings"
  DROP COLUMN IF EXISTS "schoolHutLeaderTeacherOnBooking",
  DROP COLUMN IF EXISTS "schoolHutLeaderCustodian",
  DROP COLUMN IF EXISTS "schoolHutLeaderMemberOnBooking",
  DROP COLUMN IF EXISTS "schoolHutLeaderMemberStayingSeparately";
