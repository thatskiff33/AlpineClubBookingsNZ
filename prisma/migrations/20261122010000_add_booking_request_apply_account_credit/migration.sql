-- #4019: a member whole-lodge request records whether the member
-- asked for their account credit to be put towards the booking when it is
-- approved. The price is unknown at request time, so this is a yes/no election;
-- approval applies min(balance, price) under the member's ledger lock.
--
-- PURELY ADDITIVE EXPAND. One constant-defaulted boolean column on
-- "BookingRequest". Nothing is renamed, retyped, dropped or repurposed, and no
-- existing row's values are rewritten. See docs/BLUE_GREEN_MIGRATION_SAFETY.tsv.
--
-- NOT DATA-REWRITING: no DML at all. Every existing row takes the default of
-- false, which is the truthful value: no member could have asked for this
-- before the column existed.
--
-- OLD-CODE COMPATIBLE: the draining colour's generated client never selects or
-- writes the column; its inserts receive the default and its reads ignore it.
--
-- LOCK IMPACT: ADD COLUMN with a constant default is catalog-only on
-- PostgreSQL 11 and later (no table rewrite), taking ACCESS EXCLUSIVE on
-- "BookingRequest" for the catalogue change alone. "BookingRequest" is not a
-- hot table.

-- AlterTable
ALTER TABLE "BookingRequest"
  ADD COLUMN "applyAccountCredit" BOOLEAN NOT NULL DEFAULT false;
