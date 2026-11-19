-- Ledger M13 (#4525), the refund-note cohort: expand only. Three more export
-- document roles on the manifest #4525 already created (a refund credit note,
-- the cash payment that settles it, and the planned failed-later refund
-- reversal invoice) and two more conflict reasons (the note's cents do not
-- equal one obligation, and the component is already covered by an earlier
-- document of the same role).
--
-- Purely additive: enum values only, catalog-only, no table lock, no DML. The
-- draining release never writes these roles or reasons and reads no manifest
-- row, so no read it makes can return one. Nothing in this migration uses the
-- new values, so PostgreSQL's refusal to use a label in the transaction that
-- added it does not arise. PostgreSQL cannot drop an enum value; the reverse
-- is to leave them unused.
ALTER TYPE "MemberMoneyExportDocumentRole" ADD VALUE IF NOT EXISTS 'REFUND_NOTE';
ALTER TYPE "MemberMoneyExportDocumentRole" ADD VALUE IF NOT EXISTS 'REFUND_NOTE_PAYMENT';
ALTER TYPE "MemberMoneyExportDocumentRole" ADD VALUE IF NOT EXISTS 'FAILED_LATER_REFUND_REVERSAL';
ALTER TYPE "MemberMoneyExportConflictReason" ADD VALUE IF NOT EXISTS 'CENTS';
ALTER TYPE "MemberMoneyExportConflictReason" ADD VALUE IF NOT EXISTS 'ALREADY_COVERED';
