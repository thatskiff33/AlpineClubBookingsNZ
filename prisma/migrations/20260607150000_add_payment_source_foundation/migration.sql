-- Add first-class payment source typing so local non-Stripe payments can be
-- represented without fake Stripe PaymentIntent identifiers.

CREATE TYPE "PaymentSource" AS ENUM ('STRIPE', 'INTERNET_BANKING');

ALTER TABLE "Payment"
  ADD COLUMN "source" "PaymentSource" NOT NULL DEFAULT 'STRIPE',
  ADD COLUMN "reference" TEXT;

ALTER TABLE "PaymentTransaction"
  ADD COLUMN "source" "PaymentSource" NOT NULL DEFAULT 'STRIPE',
  ADD COLUMN "xeroInvoiceId" TEXT,
  ADD COLUMN "xeroInvoiceNumber" TEXT,
  ADD COLUMN "reference" TEXT,
  ALTER COLUMN "stripePaymentIntentId" DROP NOT NULL;

CREATE INDEX "Payment_source_status_createdAt_idx" ON "Payment"("source", "status", "createdAt");
CREATE INDEX "PaymentTransaction_source_status_createdAt_idx" ON "PaymentTransaction"("source", "status", "createdAt");
CREATE INDEX "PaymentTransaction_xeroInvoiceId_idx" ON "PaymentTransaction"("xeroInvoiceId");
CREATE INDEX "PaymentTransaction_reference_idx" ON "PaymentTransaction"("reference");
