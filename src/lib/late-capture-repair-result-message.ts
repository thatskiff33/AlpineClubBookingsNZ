import type { RepairedLateCaptureXeroOutcome } from "@/lib/late-capture-repair-refund-record";

/**
 * #3635 (N4): the operator's result message for a repaired late-capture
 * refund says only what happened: "recorded" only for the intents whose
 * record was written, "queued" only for a note that was queued, and a
 * suspected double payment always.
 */
export function describeRepairedLateCaptureRefund(
  refunds: ReadonlyArray<{ paymentIntentId: string; refundId?: string | null }>,
  xero: RepairedLateCaptureXeroOutcome,
): string {
  const refundIds = refunds.map((refund) => refund.refundId).filter(Boolean);
  const failed = new Set(xero.recordFailed);
  const recorded = [...new Set(refunds.map((refund) => refund.paymentIntentId))].filter(
    (intent) => intent && !failed.has(intent),
  );
  const sentences = [
    `Refunded ${refunds.length} Stripe payment intent(s) (${refundIds.join(", ")}).`,
  ];
  if (recorded.length > 0) {
    sentences.push(`Recorded the refund of ${recorded.join(", ")} as the webhook does.`);
  }
  if (xero.recordFailed.length > 0) {
    sentences.push(`Could not record the refund of ${xero.recordFailed.join(", ")}: a critical audit row names it, and no Xero refund credit note was raised. Record it and settle Xero by hand.`);
  }
  if (xero.doubleRefundSuspected.length > 0) {
    sentences.push(`An officer hand-completed the refund task for ${xero.doubleRefundSuspected.join(", ")} while this refund ran, so the member may have been paid twice: check the booking's refunds now.`);
  }
  if (xero.noted.length > 0) {
    sentences.push(`Queued the Xero refund credit note against the payment's own Xero receipt for ${xero.noted.join(", ")}.`);
  }
  if (xero.alreadyNoted.length > 0) {
    sentences.push(`The Xero refund credit note for ${xero.alreadyNoted.join(", ")} was already raised, so none was queued.`);
  }
  if (xero.noteFailed.length > 0) {
    sentences.push(`Could not queue the Xero refund credit note for ${xero.noteFailed.join(", ")}: raise it by hand in Xero.`);
  }
  if (xero.byHand.length > 0) {
    sentences.push(`An officer recorded ${xero.byHand.join(", ")} by hand in Xero: record the refund by hand in Xero too.`);
  }
  if (xero.notInXero.length > 0) {
    sentences.push(`Xero never recorded ${xero.notInXero.join(", ")}, so no refund credit note was raised; reconcile the Stripe bank lines by hand in Xero.`);
  }
  return sentences.join(" ");
}
