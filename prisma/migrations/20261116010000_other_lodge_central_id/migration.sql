-- #64: key each Other lodges row by the Alpine Central Server's PERMANENT
-- lodge id, so a lodge renamed on the server is renamed here in place rather
-- than downloaded as a second lodge.
--
-- PURELY ADDITIVE. One nullable column with no default and one unique index
-- on a column that is NULL on every existing row. NO DML: the ids are filled
-- in by the download merge (matched by name once), not here.
--
-- OLD-CODE COMPATIBLE: the draining colour's client never names the column;
-- its inserts leave it NULL and its reads ignore it.
--
-- LOCK IMPACT: a catalogue-only ALTER taking a brief ACCESS EXCLUSIVE on
-- "OtherLodge" (a small admin registry, not a hot table); the unique index
-- builds over an all-NULL column.

-- AlterTable
ALTER TABLE "OtherLodge" ADD COLUMN "centralId" VARCHAR(64);

-- CreateIndex
CREATE UNIQUE INDEX "OtherLodge_centralId_key" ON "OtherLodge"("centralId");
