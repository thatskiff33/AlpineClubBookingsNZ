-- #58: hide an Other lodges row instead of deleting it, when the Alpine Central
-- Server reports the lodge deleted (API 2.4) or an administrator hides a lodge
-- the server does not list. The row stays, so bookings and booking requests
-- that name it keep it.
--
-- Lodge names become unique among VISIBLE lodges only: two lodges may share a
-- name (the id makes them distinct), so a hidden lodge keeps its name for the
-- bookings that name it without blocking a live lodge of the same name. The
-- full unique index is replaced by a partial one.
--
-- One nullable column with no default, and the name index swap. NO DML.
--
-- OLD-CODE COMPATIBLE, one bounded exposure: the draining colour's client never
-- names "hiddenAt" (a hidden lodge shows in its lists until it drains, which
-- is harmless). Its download creates a new lodge with an upsert keyed on the
-- name, which needs the full unique index; a download the OLD colour runs in
-- the drain window fails (no data is written; the next download repeats it).
--
-- LOCK IMPACT: brief ACCESS EXCLUSIVE locks on "OtherLodge", a small admin
-- registry, not a hot table; the new index builds over its few hundred rows.

-- AlterTable
ALTER TABLE "OtherLodge" ADD COLUMN "hiddenAt" TIMESTAMP(3);

-- A lodge name is unique among visible lodges only.
DROP INDEX "OtherLodge_name_key";
CREATE UNIQUE INDEX "OtherLodge_name_visible_key" ON "OtherLodge"("name") WHERE "hiddenAt" IS NULL;
