-- #4532: additive. A new table only the new code writes; the deployed client
-- neither reads nor writes it.
CREATE TABLE "UnrecognisedStripePayment" (
    "id" TEXT NOT NULL,
    "stripePaymentIntentId" TEXT NOT NULL,
    "stripeChargeId" TEXT,
    "stripeCheckoutSessionId" TEXT,
    "stripePaymentLinkId" TEXT,
    "amountCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "stripeCreatedAt" TIMESTAMP(3) NOT NULL,
    "description" TEXT,
    "stripeEventId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UnrecognisedStripePayment_pkey" PRIMARY KEY ("id")
);

-- The claim: one row per PaymentIntent.
CREATE UNIQUE INDEX "UnrecognisedStripePayment_stripePaymentIntentId_key" ON "UnrecognisedStripePayment"("stripePaymentIntentId");
