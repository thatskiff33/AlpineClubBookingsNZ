-- Rollback for 20261007010000_add_booking_ledger_posting_key (#3595).
-- Drops the index and the column. The lines are untouched; only their keys go,
-- and C4's back-post (#3583) re-derives every key from the rows it posts from.
DROP INDEX IF EXISTS "BookingLedgerLine_postingKey_key";
ALTER TABLE "BookingLedgerLine" DROP COLUMN IF EXISTS "postingKey";
