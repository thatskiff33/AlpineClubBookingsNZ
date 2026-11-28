-- #5005 child D: a cancelled imported booking's hand-back may be given as
-- account credit, and the task records which credit. Expand only: one nullable
-- column with no default and no backfill, its unique index and a CHECK that is
-- valid at once (every existing row holds NULL). The previous colour never
-- selects or writes the column, so it keeps completing tasks as before.
ALTER TABLE "ManualRefundTask" ADD COLUMN "settledAsCreditId" TEXT;

CREATE UNIQUE INDEX "ManualRefundTask_settledAsCreditId_key" ON "ManualRefundTask"("settledAsCreditId");

ALTER TABLE "ManualRefundTask" ADD CONSTRAINT "ManualRefundTask_settled_as_credit_completed"
  CHECK ("settledAsCreditId" IS NULL OR "status" = 'COMPLETED');
