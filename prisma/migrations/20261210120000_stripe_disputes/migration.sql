-- #4911 (INV-PAY-151): additive. A new enum and a new table only the new code
-- writes; the deployed client neither reads nor writes either.
CREATE TYPE "StripeDisputeStatus" AS ENUM ('OPEN', 'WON', 'LOST', 'CLOSED_OTHER');

CREATE TABLE "StripeDispute" (
    "id" TEXT NOT NULL,
    "stripeDisputeId" TEXT NOT NULL,
    "stripeChargeId" TEXT NOT NULL,
    "stripePaymentIntentId" TEXT,
    "paymentTransactionId" TEXT,
    "paymentId" TEXT,
    "bookingId" TEXT,
    "amountCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "withdrawnCents" INTEGER NOT NULL DEFAULT 0,
    "reinstatedCents" INTEGER NOT NULL DEFAULT 0,
    "reason" TEXT NOT NULL,
    "status" "StripeDisputeStatus" NOT NULL,
    "stripeStatus" TEXT NOT NULL,
    "stripeCreatedAt" TIMESTAMP(3) NOT NULL,
    "lastEventCreatedAt" TIMESTAMP(3) NOT NULL,
    "stripeEventId" TEXT NOT NULL,
    "openedAlertedAt" TIMESTAMP(3),
    "closedAlertedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StripeDispute_pkey" PRIMARY KEY ("id")
);

-- The claim: one row per Stripe dispute.
CREATE UNIQUE INDEX "StripeDispute_stripeDisputeId_key" ON "StripeDispute"("stripeDisputeId");

-- The cancel guard and the refund chokepoint read by intent; the admin
-- payments list by payment.
CREATE INDEX "StripeDispute_stripePaymentIntentId_idx" ON "StripeDispute"("stripePaymentIntentId");
CREATE INDEX "StripeDispute_paymentId_idx" ON "StripeDispute"("paymentId");
