-- #3402 (INV-PAY-111): the lease that makes raising one booking edit's
-- review-charge request single-flight.
--
-- Before this, two settlements of one edit could both read the request's stored
-- amount, both derive a larger figure and both raise the Stripe intent; whichever
-- provider call and row write landed last won, so shares of $60 and $100 against
-- a stored $50 could end at $60 with the difference never asked for. No lock may
-- be held across the Stripe call, so the repair is a claim taken BEFORE it: a run
-- writes an opaque token here with a guarded UPDATE and calls Stripe only if it
-- won.
--
-- TWO STATEMENTS, BOTH ADDITIVE:
--
--   1. CREATE TABLE "EditReviewChargeRaiseClaim", one row per
--      BookingModification (the primary key), created on first use by the new
--      runtime. Two CHECKs: a token and its claim time are set and cleared
--      together, and a recorded intent is a positive amount.
--   2. Its foreign key to "BookingModification", ON DELETE CASCADE: the row is
--      a lease, never evidence, so it must not block removing the edit.
--
-- NO DML, no new enum label, and no existing table is altered, so every
-- existing row is byte-identical and the data-migration gate classifies this as
-- shape-only.
--
-- OLD-CODE COMPATIBLE: the previous colour never names the table. While it is
-- still serving, its own syncs take no claim, so the race this closes stays open
-- for exactly the drain window and no wider than before this release.

-- CreateTable
CREATE TABLE "EditReviewChargeRaiseClaim" (
    "bookingModificationId" TEXT NOT NULL,
    "claimToken" TEXT,
    "claimedAt" TIMESTAMP(3),
    "intendedAmountCents" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EditReviewChargeRaiseClaim_pkey" PRIMARY KEY ("bookingModificationId"),
    CONSTRAINT "EditReviewChargeRaiseClaim_token_and_time_together" CHECK (("claimToken" IS NULL) = ("claimedAt" IS NULL)),
    CONSTRAINT "EditReviewChargeRaiseClaim_intent_positive" CHECK ("intendedAmountCents" IS NULL OR "intendedAmountCents" > 0)
);

-- AddForeignKey
ALTER TABLE "EditReviewChargeRaiseClaim" ADD CONSTRAINT "EditReviewChargeRaiseClaim_bookingModificationId_fkey" FOREIGN KEY ("bookingModificationId") REFERENCES "BookingModification"("id") ON DELETE CASCADE ON UPDATE CASCADE;
