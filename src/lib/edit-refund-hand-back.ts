import {
  ManualRefundTaskKind,
  ManualRefundTaskStatus,
  type Prisma,
  type PrismaClient,
} from "@prisma/client";

import {
  getRemainingRefundableCents,
  type BookingPaymentState,
} from "@/lib/booking-payment-state";
import {
  EDIT_REFUND_HAND_BACK_WHERE,
  editRefundHandBackOccurrenceKey,
} from "@/lib/manual-refund-task-settlement-rules";
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

/**
 * The one read a refund sizer needs for the money below: a client that can
 * aggregate `ManualRefundTask`. A transaction under the caller's locks, or the
 * pooled client for an advisory quote that holds none.
 */
export type OpenEditRefundHandBackDb = Pick<PrismaClient, "manualRefundTask">;

/**
 * #3827 (`INV-PAY-114`): MONEY ALREADY PROMISED BACK, NOT YET SENT.
 *
 * An edit refund hand-back is raised when the edit commits, but the payment's
 * `refundedAmountCents` moves only when the treasurer marks it paid back. Until
 * then the payment still reads as if that money were refundable, so a second
 * reduction, a guest's acceptance or a cancellation would size its own refund
 * off cash the club has already promised - $250 of tasks against $200 taken.
 *
 * This is the sum of the OPEN edit refund hand-backs on one payment. A completed
 * one has moved `refundedAmountCents` and drops out here as it does; a dismissed
 * one was never sent, so its money is refundable again.
 */
export async function openEditRefundHandBackCents(
  db: OpenEditRefundHandBackDb,
  paymentId: string | null | undefined,
): Promise<number> {
  if (!paymentId) return 0;
  const open = await db.manualRefundTask.aggregate({
    where: { paymentId, status: ManualRefundTaskStatus.OPEN, ...EDIT_REFUND_HAND_BACK_WHERE },
    _sum: { amountCents: true },
  });
  return open._sum.amountCents ?? 0;
}

/**
 * #3827 (`INV-PAY-114`): THE REFUNDABLE CASH ON A PAYMENT, NET OF EDIT REFUNDS
 * ALREADY PROMISED BACK BY HAND. The one figure an edit, a guest's acceptance
 * and a cancellation size their refund from, so what the club promises back
 * never exceeds what it took. Read under the locks the caller already holds
 * (the global cohort key on every edit, acceptance and paid cancel), which every
 * raise of such a task also holds, so no task can appear between this read and
 * the caller's own raise.
 */
export async function refundableCashNetOfOpenEditRefunds(
  db: OpenEditRefundHandBackDb,
  payment: (BookingPaymentState & { id: string }) | null | undefined,
): Promise<number> {
  const remaining = getRemainingRefundableCents(payment);
  if (remaining === 0 || !payment) return 0;
  return Math.max(0, remaining - (await openEditRefundHandBackCents(db, payment.id)));
}
