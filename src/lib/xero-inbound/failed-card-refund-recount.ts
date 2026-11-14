/**
 * #4370 (`INV-PAY-128`, `INV-PAY-151`; owner decision 11 Nov 2026, option (a)):
 * WHAT THE INBOUND RECOUNT TAKES OFF A PAYMENT FOR CARD REFUNDS STRIPE FAILED
 * LATER. A card refund's credit note records an instruction Stripe accepted,
 * not money that stayed returned: when Stripe fails the refund the note stays
 * in Xero, and the recount (`repairRefundedPaymentBusinessState`) would count
 * it again at every later credit-note event. Each failed refund comes off once:
 *
 * - **reversed**: through its live reversal invoice, at the cents #4369's
 *   net-coverage reader takes off (`readCardRefundReversalCentsByPayment`). A
 *   voided or deleted reversal takes off nothing, as it adds its note's
 *   coverage back there;
 * - **never reversed** (a failure from before #4369, or one no close has
 *   answered yet): through the failure record - the refunds the ledger writer
 *   recorded as failed after they counted (`failedRefundIds` on a card refund
 *   row's slices, or a row of its own, `card_refund_failed_later_<refund>`),
 *   at their `PaymentRefund` amounts, less every reversal ever raised on the
 *   payment, voided ones included, so a failure a reversal answered is never
 *   taken off a second time. Never more than the payment's refund notes cover
 *   above the cash still standing (`readRefundNoteCoverageAboveCashCents`, the
 *   reader a "Paid another way" close's card cover shares), with none of the
 *   close's adjustments for documents still queued: this follows what Xero
 *   holds. A failure whose note was never raised, or whose money a later refund
 *   or close has paid back under a note of its own, so takes off nothing.
 *
 * A payment with no failed-later refund and no reversal reads 0 and is absent
 * from the map: it recounts exactly as before. Where the notes' cover above
 * cash cannot be read (a hand-resolved note with no readable amount), the
 * whole unreversed failure comes off: a failed-later refund is a card refund,
 * so a lower total is kept off and alerted by the raise-only floor (#1353),
 * never written, and never raised over the failure either.
 *
 * Reads only, in one read-only snapshot (`withReadOnlySnapshot`): no lock, no
 * Xero call. The reversal-link writer moves no Payment column, so the caller's
 * compare-and-set claim (#3979) cannot see a reversal linked mid-read; the one
 * snapshot is what keeps the live, raised and coverage reads agreeing on it.
 */
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { CARD_REFUND_OPERATION_WHERE, cardRefundSliceFailedRefundIds, parseRefundAllocationPlan } from "@/lib/open-card-refund-owed";
import { EXCLUDED_LEDGER_REFUND_STATUSES } from "@/lib/payment-transaction-status";
import { cardRefundFailedLaterRefundId } from "@/lib/payment-recovery-keys";
import { readRefundNoteCoverageAboveCashCents } from "@/lib/refund-note-coverage-above-cash";
import { withReadOnlySnapshot } from "@/lib/read-only-snapshot";
import { readCardRefundReversalCentsByPayment } from "@/lib/xero-resolved-in-xero-fences";

export async function readFailedCardRefundRecountCentsByPayment(
  payments: ReadonlyArray<{ id: string; bookingId: string; refundedAmountCents: number }>,
): Promise<Map<string, number>> {
  const centsByPayment = new Map<string, number>();
  if (payments.length === 0) return centsByPayment;
  const paymentIds = payments.map((payment) => payment.id);
  return withReadOnlySnapshot(prisma, async (tx) => {
    // Sequential: one transaction's connection runs one statement at a time.
    const liveReversalCents = await readCardRefundReversalCentsByPayment(paymentIds, tx, "live");
    const raisedReversalCents = await readCardRefundReversalCentsByPayment(paymentIds, tx, "raised");
    const failedLaterCents = await readFailedLaterCardRefundCentsByPayment(paymentIds, tx);
    for (const payment of payments) {
      const unreversedCents = Math.max(0, (failedLaterCents.get(payment.id) ?? 0) - (raisedReversalCents.get(payment.id) ?? 0));
      const aboveCashCents = unreversedCents > 0 ? await readRefundNoteCoverageAboveCashCents(payment, tx) : 0;
      const failureRecordCents = aboveCashCents === null ? unreversedCents : Math.min(unreversedCents, Math.max(0, aboveCashCents));
      const cents = (liveReversalCents.get(payment.id) ?? 0) + failureRecordCents;
      if (cents > 0) centsByPayment.set(payment.id, cents);
    }
    return centsByPayment;
  });
}

/**
 * The cents of each payment's card refunds Stripe failed after they counted,
 * each refund once however many rows or slices record it. A refund Stripe
 * refused outright never counted, took no note, and is not recorded here.
 */
async function readFailedLaterCardRefundCentsByPayment(paymentIds: readonly string[], db: Prisma.TransactionClient): Promise<Map<string, number>> {
  const centsByPayment = new Map<string, number>();
  const operations = await db.paymentRecoveryOperation.findMany({
    where: { paymentId: { in: [...paymentIds] }, ...CARD_REFUND_OPERATION_WHERE },
    select: { paymentId: true, idempotencyKey: true, allocationPlan: true },
  });
  const failedRefundIds = new Set<string>();
  for (const operation of operations) {
    const ownRefundId = cardRefundFailedLaterRefundId(operation.idempotencyKey);
    if (ownRefundId) failedRefundIds.add(ownRefundId);
    for (const slice of parseRefundAllocationPlan(operation.allocationPlan) ?? []) {
      for (const refundId of cardRefundSliceFailedRefundIds(operation, slice)) failedRefundIds.add(refundId);
    }
  }
  if (failedRefundIds.size === 0) return centsByPayment;
  // `stripeRefundId` is unique, so each failed refund is summed once, on its own payment.
  const refunds = await db.paymentRefund.findMany({
    where: { paymentId: { in: [...paymentIds] }, stripeRefundId: { in: [...failedRefundIds] }, status: { in: EXCLUDED_LEDGER_REFUND_STATUSES } },
    select: { paymentId: true, amountCents: true },
  });
  for (const refund of refunds) {
    if (refund.amountCents > 0) centsByPayment.set(refund.paymentId, (centsByPayment.get(refund.paymentId) ?? 0) + refund.amountCents);
  }
  return centsByPayment;
}
