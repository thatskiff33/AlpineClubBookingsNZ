-- Alpine Central Server API 2.1: other-lodge bed counts, walking time, room
-- type, ski workshop and games room; the free-text booking path is removed
-- (the non-member booking page URL, "siteUrl", is now the one booking field).
--
-- ADDITIVE PART. Three nullable INTEGER columns, one nullable enum column of a
-- brand-new type, and two BOOLEAN NOT NULL DEFAULT false columns. No DML: the
-- constant defaults are catalogue-only on PostgreSQL 11+, so no row is
-- rewritten and existing lodges read as "no" / empty until the next download.
--
-- DESTRUCTIVE PART: DROP COLUMN "bookingPath". That column was added by
-- 20261006020000_add_other_lodge_details_and_amenities (#50), which has not
-- shipped on its own: the two travel in one release, so the colour draining at
-- cutover predates #50 and never names the column. A colour that DOES name it
-- (a #50-only build) would fail every OtherLodge read, so the ledger row is
-- declared old_code_compatible=windowed with rollback.sql beside this file.
-- The values are not recoverable, and need not be: the central server dropped
-- the field in the same API version, so nothing would ever be synced into it.
--
-- LOCK IMPACT: catalogue-only ALTERs taking ACCESS EXCLUSIVE on "OtherLodge"
-- briefly. "OtherLodge" is a small admin registry, not a hot table.

-- CreateEnum
CREATE TYPE "OtherLodgeRoomType" AS ENUM ('ROOM', 'DORMITORY');

-- AlterTable
ALTER TABLE "OtherLodge" DROP COLUMN "bookingPath",
  ADD COLUMN "doubleBeds" INTEGER,
  ADD COLUMN "singleBeds" INTEGER,
  ADD COLUMN "minutesWalkToLodge" INTEGER,
  ADD COLUMN "roomType" "OtherLodgeRoomType",
  ADD COLUMN "skiWorkshopArea" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "gamesRoom" BOOLEAN NOT NULL DEFAULT false;
