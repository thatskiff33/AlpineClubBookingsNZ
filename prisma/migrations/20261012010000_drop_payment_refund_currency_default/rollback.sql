BEGIN;

-- Reverse of 20261012010000_drop_payment_refund_currency_default (#3567 D4).
-- Restores the column default exactly as 20260509090000_enrich_payment_refund_ledger
-- created it. Rewrites no row: every refund keeps the currency it records.
ALTER TABLE "PaymentRefund" ALTER COLUMN "currency" SET DEFAULT 'nzd';

COMMIT;
