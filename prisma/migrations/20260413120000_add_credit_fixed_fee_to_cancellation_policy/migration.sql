-- Add a separate fixed-fee override for credit refunds.
-- NULL preserves the legacy behavior of reusing fixedFeeCents for both refund methods.
ALTER TABLE "CancellationPolicy"
ADD COLUMN "creditFixedFeeCents" INTEGER;
