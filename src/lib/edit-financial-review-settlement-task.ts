import type { ManualRefundTaskKind, PaymentSource } from "@prisma/client";

/**
 * Exactly what the route decision reads off the task, and nothing else.
 *
 * `paymentId` is the money behind the booking WHEN THE REVIEW WAS RAISED;
 * `booking.status` and `booking.payment` are the money behind it NOW (#3194) -
 * see `chooseEditReviewSettlementRoute` for why both are read and which wins.
 * (Moved out of `edit-financial-review-settlement.ts` by #3835 for its size budget.)
 */
export type EditReviewSettlementTask = {
  id: string;
  bookingId: string;
  paymentId: string | null;
  kind: ManualRefundTaskKind | null;
  /** #3639: set on a late capture held for a treasurer; names its intent. */
  lateCaptureApprovalIntentId: string | null;
  /** #3639: a #2700 task's frozen sentence, which names its capture. */
  reason: string;
  reviewContext: unknown;
  payment: { source: PaymentSource } | null;
  booking: {
    /**
     * #3194: the booking's own lifecycle status, so the settle-time read of its
     * captured money asks exactly the question the raise sites asked. Already
     * selected by the caller for `hasIssuedPrimaryXeroInvoice`.
     */
    status: string;
    /** #3835: what a cancelled booking's netting re-tiers by (`capturedShareOwedAfterCancellationCents`). */
    checkIn: Date;
    lodgeId: string;
    payment: {
      id: string;
      status: string;
      amountCents: number | null;
      refundedAmountCents: number | null;
      /**
       * #3170: a CHARGE has no task payment to route on - the money is coming the
       * other way - so it asks the BOOKING's payment whether there is a card
       * behind it, and needs that payment's own source and Stripe customer.
       */
      source: PaymentSource;
      stripeCustomerId: string | null;
    } | null;
    /**
     * #3170: for `findOrCreateCustomer` when a charge has to mint a Stripe
     * customer. Read inside the completion transaction with everything else.
     */
    member: {
      id: string;
      email: string;
      firstName: string;
      lastName: string;
    } | null;
  };
};
