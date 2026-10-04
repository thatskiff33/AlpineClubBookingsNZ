import { Prisma } from "@prisma/client";

/**
 * WHAT `resolveManualRefundTask` READS OF THE TASK, its booking and its
 * payments (#3740, moved out of the resolution module to keep it in budget).
 *
 * For an `EDIT_FINANCIAL_REVIEW` this is read AFTER the completion's
 * `pg_advisory_xact_lock(1)`, because the settlement route is chosen from it
 * (docs/CONCURRENCY_AND_LOCKING.md, #3582).
 */
export const MANUAL_REFUND_TASK_RESOLUTION_SELECT = Prisma.validator<Prisma.ManualRefundTaskSelect>()({
  id: true,
  bookingId: true,
  paymentId: true,
  amountCents: true,
  // #3030: `raisedAmountCents` is read so the audit entry can say what the
  // amount was when the task was raised, and `kind` because only an
  // `EDIT_FINANCIAL_REVIEW` task may have its amount amended at completion
  // (owner decision D2).
  raisedAmountCents: true,
  kind: true,
  // #3639: which capture a late-capture approval refunds, and the
  // sentence that names a #2700 task's capture.
  lateCaptureApprovalIntentId: true,
  partPaymentReviewPaymentId: true,
  reason: true,
  status: true,
  // #3032: the settlement route needs three more facts, all read inside
  // the same transaction as the claim. `reviewContext` carries the
  // `BookingModification` anchor a confirmed amount settles against
  // (D-3032-1); the task's own payment says whether the money went out on
  // a card (Stripe) or by hand (internet banking); and the BOOKING's
  // payment is what an account credit must be allocated against, which is
  // a different question from whether the TASK sits on one.
  reviewContext: true,
  payment: { select: { source: true } },
  booking: {
    select: {
      memberId: true,
      lodgeId: true,
      // #3170: the CHARGE direction mints an additional PaymentIntent
      // through the same helper every ordinary price increase uses, and
      // that helper needs a Stripe customer. Read here, under the same
      // transaction as everything else, rather than re-queried after the
      // commit.
      member: {
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
        },
      },
      organisation: { select: { name: true, email: true } },
      // #3032: the booking's own status and its primary Xero invoice id,
      // for `hasIssuedPrimaryXeroInvoice`. A completion that moves money on
      // a booking whose invoice was issued has to correct that invoice, or
      // the ledger and Xero disagree permanently.
      status: true,
      // #3653: a charge on a booking the group organiser paid for by card is
      // refused (`chooseEditReviewChargeRoute`).
      organiserSettled: true,
      parentBookingId: true,
      payment: {
        select: {
          id: true,
          status: true,
          amountCents: true,
          refundedAmountCents: true,
          xeroInvoiceId: true,
          // #3170: a charge routes on the BOOKING's payment rather than the
          // task's - the task's payment is the one money would come back
          // OUT of, and a charge has none.
          source: true,
          stripeCustomerId: true,
        },
      },
    },
  },
});
