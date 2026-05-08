-- AlterTable
ALTER TABLE "PaymentRefund" ADD COLUMN "stripeChargeId" TEXT;
ALTER TABLE "PaymentRefund" ADD COLUMN "stripePaymentIntentId" TEXT;
ALTER TABLE "PaymentRefund" ADD COLUMN "currency" TEXT NOT NULL DEFAULT 'nzd';
ALTER TABLE "PaymentRefund" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'succeeded';
ALTER TABLE "PaymentRefund" ADD COLUMN "xeroRefundCreditNoteId" TEXT;
ALTER TABLE "PaymentRefund" ADD COLUMN "stripeCreatedAt" TIMESTAMP(3);
ALTER TABLE "PaymentRefund" ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Backfill the PaymentIntent pointer for any legacy rows that may have been
-- inserted manually before the application started writing the full ledger.
UPDATE "PaymentRefund" AS pr
SET "stripePaymentIntentId" = COALESCE(
    pt."stripePaymentIntentId",
    p."stripePaymentIntentId",
    p."additionalPaymentIntentId"
)
FROM "Payment" AS p
LEFT JOIN "PaymentTransaction" AS pt
    ON pt."id" = pr."paymentTransactionId"
WHERE p."id" = pr."paymentId"
  AND pr."stripePaymentIntentId" IS NULL;

-- CreateIndex
CREATE INDEX "PaymentRefund_stripeChargeId_idx" ON "PaymentRefund"("stripeChargeId");

-- CreateIndex
CREATE INDEX "PaymentRefund_stripePaymentIntentId_idx" ON "PaymentRefund"("stripePaymentIntentId");

-- CreateIndex
CREATE INDEX "PaymentRefund_status_createdAt_idx" ON "PaymentRefund"("status", "createdAt");
