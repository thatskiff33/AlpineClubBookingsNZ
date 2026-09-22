-- Rollback for 20261006010000_add_booking_ledger_line (#3580).
--
-- Drops the table and its four enum types. NO DATA CAN BE LOST THAT PREDATES
-- THE MIGRATION: this table has no rows except the ones the new colour posted,
-- and nothing reads them — the first reader is C5 (#3584). Rolling back before
-- C5 therefore costs the posted lines and nothing else, and re-applying plus
-- re-running C4's back-post (#3583) reconstructs them from the rows they were
-- posted from.
DROP TABLE IF EXISTS "BookingLedgerLine";
DROP TYPE IF EXISTS "SettlementMethod";
DROP TYPE IF EXISTS "LedgerAnchorKind";
DROP TYPE IF EXISTS "LedgerLineKind";
DROP TYPE IF EXISTS "LedgerSide";
