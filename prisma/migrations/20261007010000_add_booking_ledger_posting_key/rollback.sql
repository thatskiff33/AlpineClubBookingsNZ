-- Rollback for 20261007010000_add_booking_ledger_posting_key (#3595).
-- Drops the index and the column. The lines are untouched; only their keys go.
-- Lines left without a key are still fenced per booking by the settle
-- (INV-MONEY-033), and C4's back-post (#3583) fences the same way.
DROP INDEX IF EXISTS "BookingLedgerLine_postingKey_key";
ALTER TABLE "BookingLedgerLine" DROP COLUMN IF EXISTS "postingKey";
