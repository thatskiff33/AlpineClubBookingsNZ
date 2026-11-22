/**
 * The answer `GET /api/bookings/[id]/cancel-preview` sends: the one place its
 * fields are put together. The route works out every figure and flag; these
 * functions only name them, so `CANCEL_PREVIEW_CONNECTION_SHAPE`, what an AI
 * app connection is sent (ALP-718, `INV-MCP-006`), is checked against the
 * answer itself rather than a copy of it (`INV-SSOT`).
 */
import type { ForcedCancelRefundMethod } from "@/lib/cancel-refund-method";
import type { cancelPreviewCardShortfall } from "@/lib/cancel-card-refund-shortfall-preview";
import type { calculateCancellationPreview } from "@/lib/policies/booking-route-decisions";

/** Nothing captured to refund: only the credit given back, and whether the treasurer settles a recorded payment. */
export function unpaidCancelPreviewAnswer(input: { creditRestoredCents: number; paymentSettledByHand: boolean }) {
  return {
    refundAmountCents: 0,
    keptAmountCents: 0,
    changeFeeCents: 0,
    refundPercentage: 0,
    creditRefundAmountCents: 0,
    creditRefundPercentage: 0,
    creditRestoredCents: input.creditRestoredCents,
    totalPaidCents: 0,
    hasPayment: false,
    manualRefund: false,
    // DECISION 2: say that a recorded payment is left to the treasurer.
    paymentSettledByHand: input.paymentSettledByHand,
  };
}

/** A captured payment: the tiered preview, adjusted as the cancel will settle it. */
export function paidCancelPreviewAnswer(input: {
  preview: ReturnType<typeof calculateCancellationPreview>;
  /**
   * #3653: the organiser's cancellation of the group already owes this
   * child's refund, so the joiner's cancel returns nothing of its own and says
   * whose the refund is.
   */
  groupCancellationRefund: { amountCents: number; note: string } | null;
  cardShortfall: Awaited<ReturnType<typeof cancelPreviewCardShortfall>>;
  manualRefund: boolean;
  refundDisputed: boolean;
  refundMethodForced: ForcedCancelRefundMethod;
}) {
  const { preview, groupCancellationRefund } = input;
  const groupCancellation = groupCancellationRefund
    ? {
        refundAmountCents: 0,
        refundPercentage: 0,
        creditRefundAmountCents: 0,
        creditRefundPercentage: 0,
        keptAmountCents: preview.keptAmountCents + preview.refundAmountCents,
        groupCancellationRefundCents: groupCancellationRefund.amountCents,
        groupCancellationRefundNote: groupCancellationRefund.note,
      }
    : {};
  return {
    ...preview,
    ...groupCancellation,
    ...input.cardShortfall,
    hasPayment: true,
    manualRefund: input.manualRefund,
    ...(input.refundDisputed ? { refundDisputed: true as const } : {}),
    refundMethodForced: input.refundMethodForced,
  };
}

/** Every answer the route sends on success. */
export type CancelPreviewAnswer =
  | ReturnType<typeof unpaidCancelPreviewAnswer>
  | ReturnType<typeof paidCancelPreviewAnswer>;
