-- Ledger M13 (#4525), the capture-receipt cohort: expand only. One more export
-- document role on the manifest #4525 already created (a stored Xero payment's
-- cents of one card capture) and two more conflict reasons (the payment's
-- cents exceed what is left of the capture's receipt, and the payment names no
-- capture the journal holds a live receipt for). A receipt's coverage row
-- carries the payment's idempotency key in the existing "sliceKey" column, so
-- the existing component key already admits several receipts of one capture
-- and refuses one key covering it twice: no column, constraint or index.
--
-- Purely additive: enum values only, catalog-only, no table lock, no DML. The
-- draining release never writes this role or these reasons and reads no
-- manifest row, so no read it makes can return one. Nothing in this migration
-- uses the new values, so PostgreSQL's refusal to use a label in the
-- transaction that added it does not arise. PostgreSQL cannot drop an enum
-- value; the reverse is to leave them unused.
ALTER TYPE "MemberMoneyExportDocumentRole" ADD VALUE IF NOT EXISTS 'CAPTURE_RECEIPT';
ALTER TYPE "MemberMoneyExportConflictReason" ADD VALUE IF NOT EXISTS 'CAPTURE_CENTS';
ALTER TYPE "MemberMoneyExportConflictReason" ADD VALUE IF NOT EXISTS 'CAPTURE_NOT_JOURNALLED';
