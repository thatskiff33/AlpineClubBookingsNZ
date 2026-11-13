-- #4988: an opening-credit batch carries a club's member balances over from
-- its old system, posted once as ADMIN_ADJUSTMENT credit rows. A new table
-- and one nullable column, no default and no backfill, so the previous
-- colour keeps inserting credit rows that do not mention the column.
CREATE TABLE "OpeningCreditBatch" (
    "id" TEXT NOT NULL,
    "batchKey" TEXT NOT NULL,
    "totalCents" INTEGER NOT NULL,
    "rowCount" INTEGER NOT NULL,
    "postedById" TEXT,
    "postedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reversedAt" TIMESTAMP(3),
    "reversedById" TEXT,
    "reversalReason" TEXT,

    CONSTRAINT "OpeningCreditBatch_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "OpeningCreditBatch_batchKey_key" ON "OpeningCreditBatch"("batchKey");

CREATE INDEX "OpeningCreditBatch_postedAt_idx" ON "OpeningCreditBatch"("postedAt");

ALTER TABLE "OpeningCreditBatch" ADD CONSTRAINT "OpeningCreditBatch_postedById_fkey" FOREIGN KEY ("postedById") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "OpeningCreditBatch" ADD CONSTRAINT "OpeningCreditBatch_reversedById_fkey" FOREIGN KEY ("reversedById") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "MemberCredit" ADD COLUMN "openingCreditBatchId" TEXT;

CREATE INDEX "MemberCredit_openingCreditBatchId_idx" ON "MemberCredit"("openingCreditBatchId");

ALTER TABLE "MemberCredit" ADD CONSTRAINT "MemberCredit_openingCreditBatchId_fkey" FOREIGN KEY ("openingCreditBatchId") REFERENCES "OpeningCreditBatch"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
