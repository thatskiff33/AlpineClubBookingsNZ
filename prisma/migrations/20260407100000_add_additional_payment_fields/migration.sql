-- AlterTable
ALTER TABLE "Payment" ADD COLUMN "additionalPaymentIntentId" TEXT,
ADD COLUMN "additionalAmountCents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "additionalPaymentStatus" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Payment_additionalPaymentIntentId_key" ON "Payment"("additionalPaymentIntentId");

-- CreateIndex
CREATE INDEX "Payment_additionalPaymentIntentId_idx" ON "Payment"("additionalPaymentIntentId");
