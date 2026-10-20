-- #77: whether this club's own Other lodge takes its non-member rates and
-- season dates from the Fees page. A local setting (never synced); on by
-- default (owner, 16 Oct 2026).
--
-- One NOT NULL boolean column WITH a constant default: PostgreSQL adds it
-- without rewriting the table. NO DML.
--
-- OLD-CODE COMPATIBLE: the draining colour never names the column; its inserts
-- (the download creating a lodge) take the default.
--
-- LOCK IMPACT: a brief ACCESS EXCLUSIVE lock on "OtherLodge", a small admin
-- registry, not a hot table; no rows are rewritten.

-- AlterTable
ALTER TABLE "OtherLodge" ADD COLUMN "ratesFromFees" BOOLEAN NOT NULL DEFAULT true;
