import type { ClubFormat } from "@/lib/club-format";
import logger from "@/lib/logger";
import { buildLateCaptureRefundMetadata, buildLateCaptureRefundStripeKeyPrefix } from "@/lib/payment-recovery-keys";
import { captureRefundState, isCapturedTransactionStatus, isRefusedRefundStatus } from "@/lib/payment-transaction-status";
import { refundPaymentTransactions, type RefundAllocationSlice } from "@/lib/payment-transactions";
import { isCardRefundReservationRefusal } from "@/lib/member-money";
import { prisma } from "@/lib/prisma";

/**
 * #4131 (`INV-PAY-106`, `INV-PAY-110`): A LATE CAPTURE IS REFUNDED FROM ITS OWN
 * CHARGE, never another of the booking's. Every late-capture refund door pins
 * its one slice here: both webhook handlers and the treasurer's approval (the
 * repair tool pins each unheld capture's headroom by its own plan).
 *
 * Why: the capture's refund is noted in Xero per capture, from the refunds made
 * on its own intent (`noteLateCaptureRefunds`), and the note-eligible cash
 * leaves out the refunds of a capture Xero never received by that intent
 * (`resolveRefundNoteEligibleCash`). A slice on another charge escaped both: no
 * note answered it when the capture had a receipt, and the nightly self-heal
 * raised one against the booking's own invoice when it had none.
 *
 * Capped at what the capture still holds. A refund already made on it (the
 * Stripe dashboard) was the member's money going back already, so the rest is
 * never moved onto another charge; the caller reports what was not asked for.
 */
export function lateCaptureOwnChargeSlice(
  capture: { id: string; status: Parameters<typeof captureRefundState>[0]["status"]; amountCents: number; refundedAmountCents: number },
  askedCents: number,
): { slice: RefundAllocationSlice; shortCents: number } {
  const amountCents = Math.max(0, Math.min(askedCents, captureRefundState(capture).heldCents));
  return { slice: { paymentTransactionId: capture.id, amountCents }, shortCents: Math.max(0, askedCents - amountCents) };
}

/**
 * The primary webhook handler's automatic refund of a late capture: one slice
 * on its own charge, capped at what it holds (`lateCaptureOwnChargeSlice`), sent
 * under the late-capture Stripe key and body the approval shares; nothing is
 * sent when the capture holds nothing.
 *
 * `audit` reconciles the refund's audit entry: `amountCents` (the whole
 * capture) = `refundedNowCents` + `alreadyRefundedOnCaptureCents`, the latter
 * only when non-zero, with `noRefundSentReason` when nothing was sent now. A
 * refund for less than the capture is logged.
 *
 * DEPLOY LIMIT (`docs/UPGRADING.md`): the release before #4131 refunded newest
 * first across the payment's charges and persisted no plan. An attempt of it
 * that crashed after refunding a slice on another charge, redelivered to this
 * release, is refunded in full here on the capture's own charge, so that slice
 * goes back twice. The operator settles failing late-capture deliveries before
 * deploying instead of this code guessing which refunds that attempt made.
 *
 * Throws when the capture's row is missing or not captured (the handler wrote
 * it just before), and as `refundPaymentTransactions` does: the webhook answers
 * 500 and Stripe redelivers under the same keys.
 */
export async function refundLateCaptureFromOwnCharge(params: {
  format: ClubFormat;
  bookingId: string;
  paymentId: string;
  paymentIntentId: string;
  amountCents: number;
}) {
  const capture = await prisma.paymentTransaction.findUnique({
    where: { stripePaymentIntentId: params.paymentIntentId },
    select: { id: true, paymentId: true, status: true, amountCents: true, refundedAmountCents: true },
  });
  if (!capture || capture.paymentId !== params.paymentId || !isCapturedTransactionStatus(capture.status)) {
    throw new Error(
      `Late capture ${params.paymentIntentId} has no captured transaction on payment ${params.paymentId}; its refund waits for Stripe's redelivery`,
    );
  }
  const { slice, shortCents } = lateCaptureOwnChargeSlice(capture, params.amountCents);
  let reservationRefused = false;
  const refunds =
    slice.amountCents > 0
      ? await refundPaymentTransactions({
          format: params.format,
          paymentId: params.paymentId,
          amountCents: slice.amountCents,
          allocation: [slice],
          metadata: buildLateCaptureRefundMetadata(params.bookingId),
          idempotencyKeyPrefix: buildLateCaptureRefundStripeKeyPrefix(params.bookingId, params.paymentIntentId),
          // #4516 (M4c): the capture's return; its R05 posts in the reservation step (the webhook defers it).
          obligation: { scope: "capture-return", id: params.paymentIntentId, ensureFaceCents: slice.amountCents },
        }).then((result) => result.refunds, (error: unknown) => {
          // #4516: a refused reservation sent nothing; the caller holds the capture rather than redeliver.
          if (!isCardRefundReservationRefusal(error)) throw error;
          reservationRefused = true;
          return [];
        })
      : [];
  if (shortCents > 0) {
    logger.warn(
      { bookingId: params.bookingId, paymentIntentId: params.paymentIntentId, slice, alreadyRefundedOnCaptureCents: shortCents },
      "Late capture's automatic refund asked Stripe for less than the capture: the rest was already refunded on it (#4131)",
    );
  }
  return {
    refunds,
    reservationRefused,
    audit: {
      refundedNowCents: refunds
        .filter((refund) => !isRefusedRefundStatus(refund.status))
        .reduce((sum, refund) => sum + refund.amountCents, 0),
      ...(shortCents > 0 ? { alreadyRefundedOnCaptureCents: shortCents } : {}),
      ...(slice.amountCents > 0
        ? {}
        : { noRefundSentReason: "Nothing was left to send: the capture had already been refunded on its own charge." }),
    },
  };
}
