import type { Prisma } from "@prisma/client";

import { netCollectedPaymentSelect } from "@/lib/additional-ledger-gap";
import {
  CARD_REFUND_OPERATION_WHERE,
  cardRefundSlicesByOperation,
  isOpenCardRefundOperationStatus,
  isOwedCardRefundOperation,
  operationWindowTakes,
  unsentSliceCents,
} from "@/lib/open-card-refund-owed";
import { getNetCollectedCashParts } from "@/lib/payment-net-collected";
import { PAYMENT_RECOVERY_EXHAUSTED_WHERE } from "@/lib/payment-recovery-constants";
import { cardRefundFailedLaterRefundId, cardRefundStillOwedCloseRecordId } from "@/lib/payment-recovery-keys";
import { isRecordedRefundStatus } from "@/lib/payment-transaction-status";

/**
 * #3372, #4368: ONE DEAD CARD REFUND ROW, AS EVERY STUCK-STATES ACTION ON IT READS
 * IT (`INV-SSOT`). "Paid another way" (`card-refund-paid-another-way.ts`),
 * "Nothing left owed" and "Try the card again"
 * (`card-refund-dead-row-actions.ts`) read the same row, the same payment and
 * the same owed figure, and claim it on the same status guard
 * (`deadCardRefundOperationWhere`). Each claim moves the row off that guard -
 * a close to SUCCEEDED, a re-arm to PENDING with its attempts reset - so the
 * three exclude one another on the row itself, whichever commits first.
 *
 * Plain module (type-only Prisma import): no transaction, lock or provider here.
 */

/** The card refund operations the worker will never claim again (`isPaymentRecoveryOperationExhausted`'s twin). */
export const deadCardRefundOperationWhere = {
  ...CARD_REFUND_OPERATION_WHERE,
  ...PAYMENT_RECOVERY_EXHAUSTED_WHERE,
} satisfies Prisma.PaymentRecoveryOperationWhereInput;

/** The dead row, as each action reads it. */
export const DEAD_CARD_REFUND_OPERATION_SELECT = {
  id: true,
  type: true,
  status: true,
  attempts: true,
  idempotencyKey: true,
  bookingId: true,
  paymentId: true,
  paymentIntentId: true,
  paymentTransactionId: true,
  allocationPlan: true,
  amountCents: true,
  createdAt: true,
  lastError: true,
  stripeKeyPrefix: true,
} as const satisfies Prisma.PaymentRecoveryOperationSelect;

/** Its payment: the owed figure's inputs (every card refund row on it, and its recorded Stripe refunds). */
export const DEAD_CARD_REFUND_PAYMENT_SELECT = {
  id: true,
  xeroInvoiceId: true,
  ...netCollectedPaymentSelect,
} as const satisfies Prisma.PaymentSelect;

export type DeadCardRefundPayment = Prisma.PaymentGetPayload<{ select: typeof DEAD_CARD_REFUND_PAYMENT_SELECT }>;
export type DeadCardRefundOperation = Prisma.PaymentRecoveryOperationGetPayload<{
  select: typeof DEAD_CARD_REFUND_OPERATION_SELECT;
}>;

/** What one dead card refund still has to send: its own unsent slices, and what the figures say is owed. */
export interface DeadCardRefundStillOwed {
  /** Its own unsent slices, before any cap. */
  ownCents: number;
  /** `ownCents` capped at the card refund part Net Collected takes off its payment: the most a close may record. */
  owedCents: number;
  /** The transactions its unsent slices are on, in its plan's order. */
  unsentTransactionIds: string[];
  /** #4516: its unsent slices, what each still had to send, in its plan's order (a still-owed rest's plan). */
  unsent: { paymentTransactionId: string; amountCents: number }[];
}

/**
 * What one dead card refund still owes, in cents: its own unsent slices
 * (`cardRefundSlicesByOperation`), capped at the card refund part Net
 * Collected takes off its payment, so no action can treat more as owed than
 * the figures say is owed.
 */
export function deadCardRefundStillOwed(payment: DeadCardRefundPayment, operationId: string): DeadCardRefundStillOwed {
  const own = cardRefundSlicesByOperation(payment).find(({ operation }) => operation.id === operationId);
  const unsent = (own?.slices ?? []).filter((slice) => unsentSliceCents(slice) > 0);
  const ownCents = unsent.reduce((sum, slice) => sum + unsentSliceCents(slice), 0);
  return {
    ownCents,
    owedCents: Math.min(ownCents, getNetCollectedCashParts(payment).cardRefundOwedCents),
    // #3924 round 4 (M7): only the charges it still had to refund - a sent
    // slice's transaction is no longer where this money belongs.
    unsentTransactionIds: [
      ...new Set(unsent.map((slice) => slice.paymentTransactionId).filter((id) => id !== "")),
    ],
    unsent: unsent.map((slice) => ({ paymentTransactionId: slice.paymentTransactionId, amountCents: unsentSliceCents(slice) })),
  };
}

/** A Stripe refund recorded on the payment, as "Nothing left owed" names it. */
export interface LaterStripeRefund {
  stripeRefundId: string;
  amountCents: number;
  /** When Stripe made it (its own time where recorded, else when the app recorded it), ISO instant. */
  madeAt: string;
}

/**
 * #4368 (owner decision, 25 Oct 2026): the later Stripe refunds that cover a
 * dead row whose owed figure reads $0 - every refund recorded on its payment
 * that still counts (`isRecordedRefundStatus`) and that Stripe made at or after
 * the row was raised (`operationWindowTakes`, the owed figure's own window,
 * read for an open row), oldest first. "Nothing left owed" names them, and
 * the treasurer checks them in Stripe before closing.
 */
export function laterStripeRefundsCovering(
  payment: Pick<DeadCardRefundPayment, "refunds">,
  operation: { createdAt: Date },
): LaterStripeRefund[] {
  const open = { createdAt: operation.createdAt, status: "FAILED", succeededAt: null };
  return payment.refunds
    .filter((refund) => isRecordedRefundStatus(refund.status) && operationWindowTakes(open, refund))
    .map((refund) => ({
      stripeRefundId: refund.stripeRefundId,
      amountCents: refund.amountCents,
      madeAt: (refund.stripeCreatedAt ?? refund.createdAt).toISOString(),
    }))
    .sort((left, right) => left.madeAt.localeCompare(right.madeAt) || left.stripeRefundId.localeCompare(right.stripeRefundId));
}

/** A failed-later row or a still-owed rest: raised dead for a person (`tryCardAgainRefusal`). */
function raisedForAPerson(idempotencyKey: string): boolean {
  return cardRefundFailedLaterRefundId(idempotencyKey) !== null || cardRefundStillOwedCloseRecordId(idempotencyKey) !== null;
}

/**
 * #4368 (decision 5): why "Try the card again" may not re-arm this dead row,
 * or null when it may. Read under the row's locks by the re-arm itself, and by
 * the list, so the button is offered only where the re-arm would take it.
 *
 * - Nothing owed: there is nothing to send - "Nothing left owed" closes it.
 * - A row the app raised dead for a person, never to send: a refund Stripe
 *   failed later that is not asked for again (`INV-PAY-128`, `INV-PAY-142`: a
 *   retry that failed too, one made before the cutoff, one after a "Paid
 *   another way" close of the row that made it - the member may already be
 *   paid), and a part close's still-owed rest (#4516: "a later close settles
 *   it"). Those are settled with "Paid another way".
 * - The payment holds less than the row's own unsent slices: the runner sends
 *   a stored plan's slices as written (`INV-PAY-146`), so it could send more
 *   than the figures say is owed. "Paid another way" closes it instead.
 * - #4492: a refund Stripe failed later (`card_refund_failed_later_<refund>`)
 *   is still open on the same payment: it may be the same money as this row (a
 *   refund this row's door made whose answer was lost, then failed), and
 *   re-sending this row while that one is owed could pay the member twice.
 */
export function tryCardAgainRefusal(
  payment: { recoveryOperations: ReadonlyArray<{ id: string; type: string; status: string; idempotencyKey: string }> },
  operation: { id: string; idempotencyKey: string },
  owed: Pick<DeadCardRefundStillOwed, "ownCents" | "owedCents">,
): string | null {
  if (owed.owedCents === 0) {
    return "Nothing is left owed on this card refund, so there is nothing to send to the card.";
  }
  if (raisedForAPerson(operation.idempotencyKey)) {
    return "The app raised this refund for a person to settle, not to send to the card again. Check what the member is owed and settle it with Paid another way.";
  }
  if (owed.owedCents !== owed.ownCents) {
    return "This payment now holds less than this refund would send to the card, so the card cannot be tried again. Settle it with Paid another way.";
  }
  const isFailedLater = (key: string) => cardRefundFailedLaterRefundId(key) !== null;
  const others = payment.recoveryOperations.filter(
    (other) => other.id !== operation.id && isOwedCardRefundOperation(other) && isOpenCardRefundOperationStatus(other.status),
  );
  if (others.some((other) => isFailedLater(other.idempotencyKey))) {
    return "A refund Stripe failed later is still open on this payment, and it may be the same money as this one. Do not try the card again: check what the member is owed and settle it with Paid another way.";
  }
  return null;
}
