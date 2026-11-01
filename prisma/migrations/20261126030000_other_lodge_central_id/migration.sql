-- #64: key each Other lodges row by the Alpine Central Server's PERMANENT
-- lodge id, so a lodge renamed on the server is renamed here in place rather
-- than downloaded as a second lodge.
--
-- PURELY ADDITIVE. Two nullable columns with no default and one unique index
-- on a column that is NULL on every existing row. NO DML: the ids are filled
-- in by the download merge (matched by name once), not here, and the NULL
-- "ServerNzSettings"."otherLodgesKeyedAt" is what makes the next download ask
-- for the whole registry to do it.
--
-- OLD-CODE COMPATIBLE: the draining colour's client never names either
-- column; its inserts leave them NULL and its reads ignore them.
--
-- LOCK IMPACT: catalogue-only ALTERs taking a brief ACCESS EXCLUSIVE on
-- "OtherLodge" (a small admin registry) and "ServerNzSettings" (one row);
-- neither is hot. The unique index builds over an all-NULL column.

-- AlterTable
ALTER TABLE "OtherLodge" ADD COLUMN "centralId" VARCHAR(64);

-- AlterTable
ALTER TABLE "ServerNzSettings" ADD COLUMN "otherLodgesKeyedAt" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX "OtherLodge_centralId_key" ON "OtherLodge"("centralId");
