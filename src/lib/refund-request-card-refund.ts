/**
 * #4102, #4117 (`INV-PAY-128`): AN APPROVED REFUND REQUEST'S CARD REFUND, AFTER
 * ITS INLINE ATTEMPT - what is still owed is queued for the recovery runner,
 * and the officers hear what they must.
 *
 * The route sends the frozen plan inline and reads the attempt
 * (`inlineRefundAfterAttempt`): refused slices on their next key, made ones
 * marked, unanswered ones on their own key. Whatever is still unmade is queued
 * as one row, keyed by the request, whose plan is the whole read plan and whose
 * amount is the plan's total, as the cancellation's and the runner's are.
 *
 * - The officers are alerted for the slices refused here when this approval
 *   wrote the row (`firstRefusals`, `alertRefusedCardRefund`).
 * - When no row can be written and Stripe was asked (anything but a throw
 *   before the first Stripe call), the approval STANDS: releasing it would let
 *   a second approval plan the refund afresh over the money already made, and
 *   send it again. The officers are alerted for the whole unmade amount, split
 *   into what Stripe refused (refund it another way) and what got no answer
 *   (it may have been made: check Stripe first), and the route records it on
 *   the approval's audit row, with the plan and when it was attempted, for the
 *   screen to net later refunds against (`readApprovedAppealOutcomes`). Never
 *   on the request's admin notes: the member reads those.
 * - When no row can be written and Stripe was never asked, nothing moved: the
 *   route releases the claim for a manual retry, as before #1039. Nothing was
 *   refused, so nothing was alerted, and a second approval alerts once.
 */
import type { ClubFormat } from "@/lib/club-format";
import logger from "@/lib/logger";
import { enqueueRefundRequestRefundRecovery } from "@/lib/payment-recovery";
import { alertPaymentRecoveryOfficers } from "@/lib/payment-recovery-alert";
import type { RefundAllocationSlice } from "@/lib/payment-transactions";
import { formatCents } from "@/lib/utils";
import { cardRefundNotQueuedMessage } from "@/lib/refund-request-card-refund-copy";
import {
  alertRefusedCardRefund,
  firstRefusals,
  type InlineRefundRead,
  refusedRefundCents,
} from "@/lib/refused-card-refund-retry";

/** What became of the unmade part: nothing owed, queued, not queued (approval stands), or release the claim. */
export type RefundRequestCardRefundOutcome = "nothing_owed" | "queued" | "not_queued" | "release_claim";

/** What the approve route answers, and audits, about its card refund (#4117). */
export interface RefundRequestCardRefundAnswer {
  /** Not made: queued for retry, or - `cardRefundQueued` false - for an officer. */
  cardRefundOwedCents: number;
  cardRefundQueued: boolean;
  /** Of that, refused by Stripe: certainly not made. */
  cardRefundRefusedCents: number;
  /** Of that, with no answer from Stripe: it may have been made. */
  cardRefundUnansweredCents: number;
  /**
   * Not queued only: the plan read (made slices marked, refused ones moved) and
   * when the attempt began, so the screen can net refunds recorded later.
   */
  cardRefundUnqueued?: { plan: RefundAllocationSlice[]; attemptedAt: string };
}

export const NO_CARD_REFUND_OWED: RefundRequestCardRefundAnswer = {
  cardRefundOwedCents: 0,
  cardRefundQueued: true,
  cardRefundRefusedCents: 0,
  cardRefundUnansweredCents: 0,
};

export function refundRequestCardRefundAnswer(
  read: InlineRefundRead,
  outcome: RefundRequestCardRefundOutcome,
  attemptedAt: Date,
): RefundRequestCardRefundAnswer {
  return {
    cardRefundOwedCents: read.unmadeCents,
    cardRefundQueued: outcome !== "not_queued",
    cardRefundRefusedCents: read.refusedCents,
    cardRefundUnansweredCents: read.unansweredCents,
    ...(outcome === "not_queued" ? { cardRefundUnqueued: { plan: read.plan, attemptedAt: attemptedAt.toISOString() } } : {}),
  };
}

export async function queueUnmadeRefundRequestCardRefund({
  bookingId,
  paymentId,
  refundRequestId,
  read,
  paymentIntentIdFallback,
  notesEachRefund = false,
  format,
}: {
  bookingId: string;
  paymentId: string;
  refundRequestId: string;
  read: InlineRefundRead;
  /** The payment's own intent, for an alert with no refused answer to name one. */
  paymentIntentIdFallback: string;
  /** #4312: a bank transfer's approval notes each refund, so the replay notes those it makes. */
  notesEachRefund?: boolean;
  format: ClubFormat;
}): Promise<RefundRequestCardRefundOutcome> {
  if (read.unmadeCents <= 0) return "nothing_owed";
  const refusedCents = refusedRefundCents(read.refused.map((answer) => answer.slice));
  if (refusedCents > 0) {
    logger.error({ refundRequestId, refusedCents }, "Stripe refused part of an approved appeal's card refund - enqueueing durable recovery");
  }
  let created: boolean;
  try {
    ({ created } = await enqueueRefundRequestRefundRecovery({
      bookingId,
      paymentId,
      refundRequestId,
      amountCents: read.plan.reduce((sum, slice) => sum + slice.amountCents, 0),
      allocationPlan: read.plan,
      notesEachRefund,
    }));
  } catch (enqueueErr) {
    if (!read.reachedStripe) {
      logger.error({ err: enqueueErr, refundRequestId }, "Failed to enqueue refund recovery - releasing the claim for manual retry");
      return "release_claim";
    }
    logger.error({ err: enqueueErr, refundRequestId }, "Failed to enqueue refund recovery after Stripe was asked - the approval stands, the officers are alerted");
    try {
      await alertPaymentRecoveryOfficers(
        {
          bookingId,
          amountCents: read.unmadeCents,
          paymentIntentId: read.refused[0]?.paymentIntentId || paymentIntentIdFallback,
          // Split (#4117): a refused part is refunded another way; an unanswered
          // one may have been made, so Stripe is checked first.
          errorMessage: cardRefundNotQueuedMessage(read, (cents) => formatCents(cents, format)),
        },
        format,
      );
    } catch (alertErr) {
      logger.error({ err: alertErr, refundRequestId }, "Could not alert the officers to a card refund that could not be queued (#4117)");
    }
    return "not_queued";
  }
  const first = firstRefusals(read.refused);
  if (created && first.length > 0) {
    await alertRefusedCardRefund(
      {
        bookingId,
        paymentIntentId: first[0]?.paymentIntentId || paymentIntentIdFallback,
        refusedCents: refusedRefundCents(first.map((answer) => answer.slice)),
      },
      format,
    );
  }
  return "queued";
}
