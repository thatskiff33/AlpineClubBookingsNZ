import "server-only";

import type { Prisma } from "@prisma/client";

import type { ClubFormat } from "@/lib/club-format";
import { assertCardRefundNotOverPromised } from "@/lib/edit-financial-review-cancel-netting";
import { REVIEW_REFUND_EXCEEDS_CAPTURED_MESSAGE } from "@/lib/edit-financial-review-refund-refusals";
import { ManualBookingPaymentError } from "@/lib/manual-booking-payment-error";
import { SUPERSEDED_HOLD_BACK_REFUSAL_MESSAGE } from "@/lib/manual-refund-task-settlement-refusal";
import { lockMemberCreditLedger } from "@/lib/member-credit";
import { lockPaymentForRefundedTotal, planStripeRefundAllocation, type RefundAllocationSlice } from "@/lib/payment-transactions";
import { readSupersededCaptureHeldBack } from "@/lib/superseded-capture-hold-back";

/**
 * The edit financial review's card arm (`chooseEditReviewSettlementRoute`): its
 * frozen allocation and both caps, on the caller's transaction and before its claim.
 *
 * Freeze the allocation and cap the amount in ONE read. Once the cap has passed
 * the planned total cannot be short of it: the planner allocates newest-first
 * across exactly the transactions the cap totalled.
 *
 * #4879 (`INV-PAY-150`): a live superseded capture's charge is left to its own
 * refund, read under the Payment row (after lock(1) and the booking row); a
 * review needing it is refused, task OPEN.
 *
 * #5171 review: the owner's member-credit key FIRST (`INV-LOCK-002`: member
 * credit before the Payment row), since the completion's give-back and re-price
 * take it after the claim. The read-only preview takes neither: it holds no
 * lock(1), and the completion re-derives this under both.
 */
export async function planEditReviewCardRefund({
  paymentId,
  bookingId,
  ownerMemberId,
  refundCents,
  format,
  store,
  readOnlyPreview,
}: {
  paymentId: string;
  bookingId: string;
  /** The booking owner's member id (`bookingOwner(...).memberId`), or null for a school. */
  ownerMemberId: string | null;
  /** Integer cents, already netted against any cancellation. */
  refundCents: number;
  format: ClubFormat;
  store: Prisma.TransactionClient;
  readOnlyPreview: boolean;
}): Promise<RefundAllocationSlice[]> {
  if (!readOnlyPreview) {
    if (ownerMemberId) await lockMemberCreditLedger(ownerMemberId, store);
    await lockPaymentForRefundedTotal(store, paymentId);
  }
  const heldBack = await readSupersededCaptureHeldBack(store, paymentId);
  const { slices, totalRefundableCents } = await planStripeRefundAllocation({
    paymentId,
    amountCents: refundCents,
    store,
    heldBackByTransaction: heldBack.byTransaction,
  });
  if (refundCents > totalRefundableCents) {
    // #5171 review (`INV-SSOT`): named as the hand-back door names it when only the hold-back stands in the way.
    if (refundCents <= totalRefundableCents + heldBack.totalCents) throw new ManualBookingPaymentError(SUPERSEDED_HOLD_BACK_REFUSAL_MESSAGE, 409);
    throw new ManualBookingPaymentError(REVIEW_REFUND_EXCEEDS_CAPTURED_MESSAGE, 400);
  }
  // #3835: and less the card refunds already promised and not yet made.
  await assertCardRefundNotOverPromised({ paymentId, bookingId, refundCents, totalRefundableCents, format, store });
  return slices;
}
