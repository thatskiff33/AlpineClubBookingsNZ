-- #62: link each local lodge to its lodge in the Alpine Central Server's
-- registry by the central lodge's PERMANENT id, and keep the owned lodges'
-- ids beside their names.
--
-- PURELY ADDITIVE. Two nullable columns with no default and one unique index
-- on a column that is NULL on every existing row. NO DML.
--
-- OLD-CODE COMPATIBLE: the draining colour's client never names either
-- column; its inserts leave them NULL and its reads ignore them.
--
-- LOCK IMPACT: catalogue-only ALTERs taking a brief ACCESS EXCLUSIVE on
-- "Lodge" and "ServerNzSettings" (a handful of rows each; neither is hot);
-- the unique index builds over an all-NULL column of a few rows.

-- AlterTable
ALTER TABLE "Lodge" ADD COLUMN "centralLodgeId" VARCHAR(64);

-- AlterTable
ALTER TABLE "ServerNzSettings" ADD COLUMN "otherLodgesOwnedLodges" JSONB;

-- CreateIndex
CREATE UNIQUE INDEX "Lodge_centralLodgeId_key" ON "Lodge"("centralLodgeId");
