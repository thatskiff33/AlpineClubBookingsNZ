BEGIN;

-- #3567 (owner decision D4, stage 5 of programme #3205; INV-CONFIG-006,
-- INV-SSOT-003): "PaymentRefund"."currency" loses its 'nzd' default.
--
-- WHY. A refund row records the currency Stripe refunded in, which is always
-- the charge's own. The one runtime writer (recordStripeRefundLedgerEntry in
-- src/lib/payment-transactions.ts) has always supplied it from Stripe's
-- refund.currency. The default only ever mattered to a write that forgot the
-- column, and for that write it silently recorded New Zealand dollars whatever
-- the club charges in. With the default gone such a write fails loudly
-- instead: the column stays NOT NULL.
--
-- ONE STATEMENT, and it changes only the table's definition. NO ROW IS READ OR
-- REWRITTEN. Existing rows keep exactly the currency they hold, deliberately:
-- each records what Stripe actually refunded, in the currency it was actually
-- refunded in. A refund of an NZD charge IS an NZD refund whatever the club
-- uses today, and rewriting it would falsify the payments history reconciled
-- against Stripe and Xero.
--
-- OLD-CODE COMPATIBLE: the draining colour's writer always names "currency",
-- so it never relied on the default. LOCK IMPACT: ALTER COLUMN ... DROP DEFAULT
-- is catalog-only (no table rewrite, no scan) but takes ACCESS EXCLUSIVE on
-- "PaymentRefund" for the instant of the catalog update; the deploy guard's
-- lock_timeout bounds the wait. Reverse: rollback.sql restores the default.
ALTER TABLE "PaymentRefund" ALTER COLUMN "currency" DROP DEFAULT;

COMMIT;
