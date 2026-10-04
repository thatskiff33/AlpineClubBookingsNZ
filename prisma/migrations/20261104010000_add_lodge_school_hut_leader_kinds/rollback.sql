-- #3819 manual reverse, never applied by Prisma migrate.
--
-- The previous release reads none of these columns, so routing back to it needs
-- no schema reverse: it keeps reading #3416's switch, which this migration left
-- untouched. Run this only to remove the columns on purpose, with the new
-- application and workers stopped.
--
-- What it cannot undo: the own LodgeSettings rows step 2 inserted for lodges no
-- row served (only when the switch was ON). They hold NULL capacity and soft
-- cap, which is what those lodges resolved to before, so they are left in
-- place; deleting them would be a guess about which rows were inserted here.
ALTER TABLE "LodgeSettings"
  DROP COLUMN IF EXISTS "schoolHutLeaderTeacherOnBooking",
  DROP COLUMN IF EXISTS "schoolHutLeaderCustodian",
  DROP COLUMN IF EXISTS "schoolHutLeaderMemberOnBooking",
  DROP COLUMN IF EXISTS "schoolHutLeaderMemberStayingSeparately";
