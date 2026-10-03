import { ManualRefundTaskKind, type Prisma } from "@prisma/client";

import { editRefundHandBackOccurrenceKey } from "@/lib/manual-refund-task-settlement-rules";
import { MANUAL_REFUND_TASK_REASON_MAX } from "@/lib/manual-subscription-payment";

/**
 * #3827 (owner decision D-3813-6, `INV-PAY-114`): AN EDIT'S REFUND THAT THE
 * CLUB SENDS BACK BY HAND.
 *
 * A price reduction on a booking paid by card is refunded through Stripe after
 * the edit commits. One paid by internet banking (or marked paid in cash) has
 * no card to refund, and before this the edit recorded a refund amount, queued
 * the Xero credit note and told the member the refund "has been processed" -
 * while asking nobody to send the money. Now every such reduction, from any
 * edit door or a guest's acceptance, raises ONE officer task in the existing
 * money-to-settle queue, inside the edit's own transaction (no provider call),
 * and the member is told the club will refund them by bank transfer. The Xero
 * credit note stays exactly as it was. Completing the task is the cancellation
 * hand-back's completion: it records the refund on the payment, the booking
 * ledger's bank-refund line and the booking event - and queues no second Xero
 * note, because the edit's own note already corrects the invoice.
 */

/**
 * Does this edit's refund go back by hand? True exactly when the edit returns
 * money (`refundAmountCents`, never the account-credit arm) and that money was
 * not captured through Stripe (`hasSucceededPayment`, the same test that
 * decides whether a Stripe refund runs). The one spelling for every door.
 */
export function editRefundGoesBackByHand(adjusted: {
  refundAmountCents: number;
  hasSucceededPayment: boolean;
}): boolean {
  return adjusted.refundAmountCents > 0 && !adjusted.hasSucceededPayment;
}

/**
 * Raise the edit's refund hand-back, when it owes one, and say whether it did.
 *
 * IDEMPOTENT PER MODIFICATION: the occurrence key is unique, and the insert is
 * `ON CONFLICT DO NOTHING` (`skipDuplicates`) rather than a create that could
 * raise a unique violation, which in Postgres would abort the edit's whole
 * transaction. Runs under the edit's own locks; takes none of its own.
 *
 * The amount is fixed at creation (`raisedAmountCents` mirrors it), as every
 * hand-back's is: it is the refund the edit already decided, not an officer's
 * estimate.
 */
export async function raiseEditRefundHandBackIfOwed(
  tx: Prisma.TransactionClient,
  params: {
    bookingId: string;
    paymentId: string | null;
    bookingModificationId: string;
    adjusted: { refundAmountCents: number; hasSucceededPayment: boolean };
    /** What changed, for the task's reason line (e.g. "date change"). */
    editLabel: string;
  },
): Promise<boolean> {
  const { bookingId, paymentId, bookingModificationId, adjusted, editLabel } = params;
  if (!editRefundGoesBackByHand(adjusted) || paymentId === null) return false;
  await tx.manualRefundTask.createMany({
    data: [
      {
        bookingId,
        paymentId,
        amountCents: adjusted.refundAmountCents,
        raisedAmountCents: adjusted.refundAmountCents,
        kind: ManualRefundTaskKind.CANCELLED_BOOKING_HAND_BACK,
        occurrenceKey: editRefundHandBackOccurrenceKey(bookingModificationId),
        reason: `Booking ${bookingId} lowered by a ${editLabel}; paid by internet banking or by hand, so the club refunds the difference by bank transfer (#3827).`.slice(
          0,
          MANUAL_REFUND_TASK_REASON_MAX,
        ),
      },
    ],
    skipDuplicates: true,
  });
  return true;
}
