-- #58: hide an Other lodges row instead of deleting it, when the Alpine Central
-- Server reports the lodge deleted (API 2.4) or an administrator hides a lodge
-- the server does not list. The row stays, so bookings and booking requests
-- that name it keep it.
--
-- PURELY ADDITIVE. One nullable column with no default. NO DML.
--
-- OLD-CODE COMPATIBLE: the draining colour's client never names the column;
-- its inserts leave it NULL and its reads ignore it (so a hidden lodge shows
-- in its lists until it drains, which is harmless).
--
-- LOCK IMPACT: a catalogue-only ALTER taking a brief ACCESS EXCLUSIVE on
-- "OtherLodge", a small admin registry, not a hot table.

-- AlterTable
ALTER TABLE "OtherLodge" ADD COLUMN "hiddenAt" TIMESTAMP(3);
