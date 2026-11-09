import "server-only";

import { BookingEventType } from "@prisma/client";

import { recordBookingEvent } from "@/lib/booking-events";
import type { ClubFormat } from "@/lib/club-format";
import logger from "@/lib/logger";
import {
  buildBookingModificationRefundMetadata,
  markEditFinancialReviewRefundRecoverySucceeded,
} from "@/lib/payment-recovery";
import {
  buildEditFinancialReviewRefundRecoveryIdempotencyKey,
  buildEditFinancialReviewRefundStripeKeyPrefix,
} from "@/lib/payment-recovery-keys";
import { refundPaymentTransactions, type RefundAllocationSlice } from "@/lib/payment-transactions";
import { closeDoorRow } from "@/lib/pre-persisted-refund-close";
import { keepRefusedPrePersistedRefundOwed, type RefundAttempt } from "@/lib/refused-card-refund-retry";

/**
 * #3032: a completed edit financial review's card refund, AFTER its transaction
 * committed - the provider round trip the locking guide keeps outside it.
 * Moved out of `edit-financial-review-settlement.ts` whole (#4103), which
 * decides the route and calls this for its `stripe-refund` arm.
 *
 * The refund debt - the frozen slices and the task-scoped Stripe key prefix -
 * was persisted inside the completion's transaction, so a crash here loses
 * nothing: the recovery cron replays exactly what this sends.
 *
 * #4103 (`INV-PAY-130`): a slice Stripe answers `failed` or `canceled` is a
 * refusal, not a refund. The row stays open, re-planned on fresh keys
 * (`keepRefusedPrePersistedRefundOwed`), and no refund id is returned, so no
 * REFUNDED event and no receipt. A slice refused before a later one threw is
 * re-planned the same way.
 *
 * Returns the Stripe refund id when the refund was made, and null otherwise,
 * which the caller turns into an honest message rather than a receipt.
 */
export async function executeEditReviewCardRefund({
  bookingId,
  taskId,
  actingMemberId,
  route,
  format,
}: {
  bookingId: string;
  taskId: string;
  actingMemberId: string;
  route: { paymentId: string; allocation: RefundAllocationSlice[]; refundCents: number };
  format: ClubFormat;
}): Promise<string | null> {
  const refundAmountCents = route.refundCents;
  const keepRefusalOwed = (attempt: RefundAttempt) =>
    keepRefusedPrePersistedRefundOwed({
      bookingId,
      idempotencyKey: buildEditFinancialReviewRefundRecoveryIdempotencyKey(taskId),
      plan: route.allocation,
      attempt,
      format,
    });
  let stripeRefundId: string | null = null;
  try {
    const refundResult = await refundPaymentTransactions({
      format,
      paymentId: route.paymentId,
      amountCents: refundAmountCents,
      // #1507: the body is rebuilt byte-identically by a recovery replay from
      // the stored key prefix, so the reason is a fixed discriminator, never
      // prose. `bookingModificationRefundReasonForKeyPrefix` maps this task's
      // prefix back to exactly this string.
      metadata: buildBookingModificationRefundMetadata(
        bookingId,
        "edit_financial_review",
      ),
      // TASK-scoped, not modification-scoped. Owner decision D-3032-1 settles a
      // review against the ORIGINAL edit's `BookingModification`, and one edit
      // can raise TWO review tasks - two unpriceable strands, one modification
      // row. A modification-scoped prefix would give both the same per-slice
      // key, Stripe would answer the second with the FIRST refund, and the
      // caller would take the replayed id as success and tell the member their
      // money came back when half of it never left.
      idempotencyKeyPrefix:
        buildEditFinancialReviewRefundStripeKeyPrefix(taskId),
      // The slices frozen inside the transaction, so an inline attempt and a
      // cron replay send byte-identical requests.
      allocation: route.allocation,
      obligation: { scope: "review", id: taskId }, // #4516: the R05 the completion posted
    });
    // #4103: a refusal is still owed - re-planned, never closed or reported.
    const refused = await keepRefusalOwed(refundResult);
    if (refused) throw refused;
    stripeRefundId = refundResult.refunds[0]?.refundId ?? null;
    // Best-effort close, exactly as #1349's is: a lost close leaves the
    // operation open and the cron replays the identical frozen slices, which
    // Stripe answers with the original refunds. #4144: only on the plan sent.
    await closeDoorRow(
      {
        door: "edit-review",
        idempotencyKey: buildEditFinancialReviewRefundRecoveryIdempotencyKey(taskId),
        bookingId,
        paymentIntentId: refundResult.refunds[0]?.paymentIntentId ?? "",
        amountCents: refundAmountCents,
        refundId: stripeRefundId,
        format,
        context: { taskId },
      },
      async (idempotencyKey) => (await markEditFinancialReviewRefundRecoverySucceeded({ idempotencyKey, sentPlan: route.allocation })).count === 1,
    );
  } catch (err) {
    // The debt is already durable, so there is nothing to enqueue here and
    // nothing is lost: the operation stays PENDING and the cron replays it.
    // #4103: a slice refused before a later one threw is re-planned now.
    await keepRefusalOwed({ error: err });
    logger.error(
      { err, bookingId, taskId, amountCents: refundAmountCents },
      "Stripe refund failed after an edit financial review was completed - the persisted recovery operation will replay it",
    );
  }
  if (stripeRefundId) {
    // Only on a refund that actually issued. A failure records NO event: a
    // REFUNDED row is member-facing through `booking-narrative.ts`, so writing
    // one for money still sitting in the club's account would tell the member
    // their refund had happened.
    await recordBookingEvent({
      bookingId,
      type: BookingEventType.REFUNDED,
      actorMemberId: actingMemberId,
      amountCents: refundAmountCents,
      reason: "edit_financial_review_completed",
    });
  }
  return stripeRefundId;
}
