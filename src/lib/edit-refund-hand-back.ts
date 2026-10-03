import {
  ManualRefundTaskKind,
  type Prisma,
  type PrismaClient,
} from "@prisma/client";

import {
  getRemainingRefundableCents,
  getRemainingRefundableCentsNetOf,
  type BookingPaymentState,
} from "@/lib/booking-payment-state";
import {
  editRefundHandBackOccurrenceKey,
  OPEN_HAND_BACKS_FOR_REFUND_APPEAL_SELECT,
  OPEN_NON_CANCELLATION_HAND_BACKS_SELECT,
  refundRequestHandBackOccurrenceKey,
} from "@/lib/manual-refund-task-settlement-rules";
import { sumInternetBankingMintedCentsForBookings } from "@/lib/internet-banking-late-cash-credit";
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
 * #3827 (owner decision D-3813-7, `INV-PAY-115`): AN APPROVED REFUND REQUEST'S
 * REFUND THAT THE CLUB SENDS BACK BY HAND.
 *
 * Approving an appeal refunds through Stripe whatever the payment's card
 * ledger can carry. Before this, the rest - all of it, on a booking paid by
 * internet banking - was answered with a Xero credit note and nothing else:
 * `refundedAmountCents` never moved, nobody was asked to send the money, and a
 * second appeal could be approved against the same cash. Now that remainder
 * raises ONE officer task in the money-to-settle queue, inside the approval's
 * own transaction under `lock(1)`, and is netted from refundable cash until the
 * treasurer marks it paid back (which records the refund on the payment and,
 * D-3813-8, queues this request's own Xero refund credit note for the amount
 * paid back - `enqueueXeroRefundRequestCreditNoteOperation`).
 *
 * IDEMPOTENT PER REFUND REQUEST, as the edit's is per modification: the
 * occurrence key is unique and the insert is `ON CONFLICT DO NOTHING`. The
 * amount is fixed at creation. Returns how many rows it inserted (0 or 1).
 */
export async function raiseRefundRequestHandBack(
  tx: Prisma.TransactionClient,
  params: {
    bookingId: string;
    paymentId: string;
    refundRequestId: string;
    /** The approved amount no card refund carries; nothing is raised at 0. */
    amountCents: number;
  },
): Promise<number> {
  const { bookingId, paymentId, refundRequestId, amountCents } = params;
  if (amountCents <= 0) return 0;
  const raised = await tx.manualRefundTask.createMany({
    data: [
      {
        bookingId,
        paymentId,
        amountCents,
        raisedAmountCents: amountCents,
        kind: ManualRefundTaskKind.CANCELLED_BOOKING_HAND_BACK,
        occurrenceKey: refundRequestHandBackOccurrenceKey(refundRequestId),
        reason: `Refund appeal approved on booking ${bookingId}; not paid by card, so the club refunds this by bank transfer (#3827).`.slice(
          0,
          MANUAL_REFUND_TASK_REASON_MAX,
        ),
      },
    ],
    skipDuplicates: true,
  });
  return raised.count;
}

/**
 * The one read a refund sizer needs for the money below: a client that can
 * aggregate `ManualRefundTask`. A transaction under the caller's locks, or the
 * pooled client for an advisory quote that holds none.
 */
export type OpenNonCancellationHandBackDb = Pick<PrismaClient, "manualRefundTask">;

/**
 * #3827 (`INV-PAY-114`): MONEY ALREADY PROMISED BACK, NOT YET SENT.
 *
 * An edit refund hand-back is raised when the edit commits, but the payment's
 * `refundedAmountCents` moves only when the treasurer marks it paid back. Until
 * then the payment still reads as if that money were refundable, so a second
 * reduction, a guest's acceptance or a cancellation would size its own refund
 * off cash the club has already promised - $250 of tasks against $200 taken.
 *
 * This is the sum of the OPEN edit refund hand-backs on one payment - and,
 * since D-3813-7, of the OPEN refund-request hand-backs, which an approved
 * appeal on an internet-banking booking raises on the same terms (without them
 * a second appeal could be approved against the cash the first one promised).
 * A completed one has moved `refundedAmountCents` and drops out here as it
 * does; a dismissed one was never sent, so its money is refundable again.
 */
export async function openNonCancellationHandBackCents(
  db: OpenNonCancellationHandBackDb,
  paymentId: string | null | undefined,
): Promise<number> {
  if (!paymentId) return 0;
  const open = await db.manualRefundTask.aggregate({
    where: { paymentId, ...OPEN_NON_CANCELLATION_HAND_BACKS_SELECT.where },
    _sum: { amountCents: true },
  });
  return open._sum.amountCents ?? 0;
}

/**
 * #3827 (`INV-PAY-114`): THE REFUNDABLE CASH ON A PAYMENT, NET OF REFUNDS
 * ALREADY PROMISED BACK BY HAND (an edit's, or an approved refund request's).
 * The one figure an edit, a guest's acceptance, a cancellation and a refund
 * appeal's approval size their refund from, so what the club promises back
 * never exceeds what it took. Read under the locks the caller already holds
 * (the global cohort key on every edit, acceptance, paid cancel and appeal
 * approval), which every raise of such a task also holds, so no task can
 * appear between this read and the caller's own raise.
 */
export async function refundableCashNetOfOpenHandBacks(
  db: OpenNonCancellationHandBackDb,
  payment: (BookingPaymentState & { id: string }) | null | undefined,
): Promise<number> {
  if (getRemainingRefundableCents(payment) === 0 || !payment) return 0;
  return getRemainingRefundableCentsNetOf(
    payment,
    await openNonCancellationHandBackCents(db, payment.id),
  );
}

/** What a refund appeal's cap reads: hand-back tasks and member credit. */
export type RefundAppealCapDb = Pick<PrismaClient, "manualRefundTask" | "memberCredit">;

/**
 * #3827 (`INV-PAY-115`): the sum of EVERY open hand-back on one payment - any
 * kind, the cancellation's own included. Only a refund appeal's cap reads
 * this; an edit or a cancel reads `openNonCancellationHandBackCents`, which
 * leaves the cancellation's task out by design.
 */
export async function openHandBackCentsForRefundAppeal(
  db: Pick<PrismaClient, "manualRefundTask">,
  paymentId: string,
): Promise<number> {
  const open = await db.manualRefundTask.aggregate({
    where: { paymentId, ...OPEN_HAND_BACKS_FOR_REFUND_APPEAL_SELECT.where },
    _sum: { amountCents: true },
  });
  return open._sum.amountCents ?? 0;
}

/**
 * #3827 (`INV-PAY-115`): what a refund appeal must treat as ALREADY handed
 * back, beyond `refundedAmountCents`: every hand-back still open on the
 * payment and the member credit already minted from its late cash
 * (`refundAppealCeiling` says why each one is missing from the mirror).
 *
 * READ THIS BEFORE THE PAYMENT. A cancellation's own hand-back completes
 * without `lock(1)` (legacy kinds take none; it holds only the Payment row),
 * moving the mirror and closing the task in one commit. Read in this order, a
 * completion landing between the two reads is counted twice - the task still
 * open here, its refund already in the payment read after - so the ceiling
 * errs LOW, never high. The other order would count it nowhere. The late-cash
 * mint and every non-cancellation hand-back hold `lock(1)`, as the approval
 * does, so they cannot land in between at all.
 */
export async function refundAppealHandedBackCents(
  db: RefundAppealCapDb,
  payment: { id: string; bookingId: string },
): Promise<number> {
  return (
    (await openHandBackCentsForRefundAppeal(db, payment.id)) +
    (await sumInternetBankingMintedCentsForBookings(db, [payment.bookingId]))
  );
}

/**
 * #3827 (`INV-PAY-115`): THE MOST A REFUND APPEAL MAY PROMISE BACK, for a
 * caller holding no lock (the member's advisory request): the refundable cash
 * less `refundAppealHandedBackCents`, read before the payment. The admin
 * approval and the reopen of a dismissed appeal task, which re-read the
 * payment under `lock(1)`, call that function first and read the payment
 * after it themselves.
 */
export async function refundableCashForRefundAppeal(
  db: RefundAppealCapDb & Pick<PrismaClient, "payment">,
  payment: { id: string; bookingId: string } | null | undefined,
): Promise<number> {
  if (!payment) return 0;
  const handedBack = await refundAppealHandedBackCents(db, payment);
  const fresh = await db.payment.findUnique({
    where: { id: payment.id },
    select: { status: true, amountCents: true, refundedAmountCents: true },
  });
  return getRemainingRefundableCentsNetOf(fresh, handedBack);
}
