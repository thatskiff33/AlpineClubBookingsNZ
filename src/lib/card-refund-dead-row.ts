import type { Prisma } from "@prisma/client";

import { netCollectedPaymentSelect } from "@/lib/additional-ledger-gap";
import {
  CARD_REFUND_OPERATION_WHERE,
  cardRefundsAttributedByOperation,
  cardRefundSlicesByOperation,
  carriesCardRefundOperationMetadata,
  parseRefundAllocationPlan,
  unsentSliceCents,
} from "@/lib/open-card-refund-owed";
import { getNetCollectedCashParts } from "@/lib/payment-net-collected";
import { PAYMENT_RECOVERY_EXHAUSTED_WHERE } from "@/lib/payment-recovery-constants";
import { cardRefundFailedLaterRefundId, cardRefundStillOwedCloseRecordId } from "@/lib/payment-recovery-keys";
import { isRecordedRefundStatus } from "@/lib/payment-transaction-status";
import { REFUND_SLICE_KEY_METADATA } from "@/lib/refund-slice-evidence";

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

/**
 * A refusal of a settlement of a dead row, with the status its route answers:
 * "Paid another way" (`CardRefundPaidAnotherWayError`, the same class),
 * "Nothing left owed" and "Try the card again". Thrown before or inside the
 * transaction, so nothing commits.
 */
export class DeadCardRefundActionError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409,
  ) {
    super(message);
    this.name = "DeadCardRefundActionError";
  }
}

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
 * #3924 round 4 (M7): whether a refund's last failure looks like a timeout, a
 * network error, a Stripe server error, or Stripe saying the money is already
 * back - the failures where the refund may have gone through with its answer
 * lost. The panel then tells the treasurer to check the Stripe dashboard before
 * paying the member again. A hint only: it reads the worker's wording, and
 * decides nothing.
 *
 * #3924 round 5 (money F5, concurrency F3): a 5xx is matched only beside a
 * status word ("status 502", "statusCode: 503"), never any three digits
 * starting with 5 - "$500.00" is an amount, not a server error.
 *
 * #4101: Stripe refusing a reused idempotency key ("Keys for idempotent requests
 * can only be used with the same parameters...", `idempotency_error`) means an
 * earlier request under that key reached Stripe, and a refund replay's earlier
 * request is the refund itself. A guest-acceptance re-price refund's replay
 * died this way before #4101 although Stripe had made the refund.
 */
export function lastErrorSuggestsStripeMayHaveRefunded(lastError: string | null): boolean {
  if (!lastError) return false;
  return /time[- ]?out|timed out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|socket hang up|network|connection (?:error|reset|closed|refused)|StripeConnectionError|StripeAPIError|status(?:Code)?\D{0,3}5\d\d\b|has already been refunded|greater than (?:the )?unrefunded amount|idempotent requests can only be used with the same parameters|idempotency_error/i.test(
    lastError,
  );
}

/**
 * #4368 (owner decision, 25 Oct 2026; review C): the Stripe refunds that paid a
 * dead row whose own unsent slices are all filled - the ones the attribution
 * the owed figure runs gives THIS row (`cardRefundsAttributedByOperation`),
 * oldest first. "Nothing left owed" names them, and the treasurer checks them
 * in Stripe before closing. Empty while the row still has anything unsent of
 * its own: a $0 read only off the payment's cap (it holds nothing more to
 * refund) names no refund that paid this row, and is a developer's to
 * reconcile, never closed here.
 */
export function laterStripeRefundsCovering(payment: DeadCardRefundPayment, operationId: string): LaterStripeRefund[] {
  if (deadCardRefundStillOwed(payment, operationId).ownCents !== 0) return [];
  return (cardRefundsAttributedByOperation(payment).get(operationId) ?? [])
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
 * #4368 (decision 5; review A, B): why "Try the card again" may not re-arm
 * this dead row, or null when it may. The rule: where the app cannot show a
 * new request would not pay the member twice, it refuses. Read under the row's
 * locks by the re-arm itself, and by the list, so the button is offered only
 * where the re-arm would take it (the re-arm adds Stripe's own evidence,
 * `unadoptedOwnStripeRefunds`).
 *
 * - Nothing owed: there is nothing to send - "Nothing left owed" closes it.
 * - A row the app raised dead for a person, never to send: a refund Stripe
 *   failed later that is not asked for again (`INV-PAY-128`, `INV-PAY-142`: a
 *   retry that failed too, one made before the cutoff, one after a "Paid
 *   another way" close of the row that made it - the member may already be
 *   paid), and a part close's still-owed rest (#4516: "a later close settles
 *   it"). Those are settled with "Paid another way".
 * - Its last failure says Stripe may have refunded after all
 *   (`lastErrorSuggestsStripeMayHaveRefunded`): a re-arm runs outside Stripe's
 *   24-hour key window, and a refund made under the key before slice evidence
 *   existed (`INV-PAY-147`) is not adopted, so it could be sent again.
 * - The payment holds less than the row's own unsent slices: the runner sends
 *   a stored plan's slices as written (`INV-PAY-146`), so it could send more
 *   than the figures say is owed. "Paid another way" closes it instead.
 * - #4492: ANY refund Stripe failed later (`card_refund_failed_later_<refund>`)
 *   on the same payment, open or closed: it may be the same money as this row
 *   (a refund this row's door made whose answer was lost, then failed), and
 *   once it is re-sent and paid the row reads owed again - re-sending the row
 *   then would pay the member twice.
 */
export function tryCardAgainRefusal(
  payment: { recoveryOperations: ReadonlyArray<{ id: string; idempotencyKey: string }> },
  operation: { id: string; idempotencyKey: string; lastError: string | null },
  owed: Pick<DeadCardRefundStillOwed, "ownCents" | "owedCents">,
): string | null {
  if (owed.owedCents === 0) {
    return "Nothing is left owed on this card refund, so there is nothing to send to the card.";
  }
  if (raisedForAPerson(operation.idempotencyKey)) {
    return "The app raised this refund for a person to settle, not to send to the card again. Check what the member is owed and settle it with Paid another way.";
  }
  if (lastErrorSuggestsStripeMayHaveRefunded(operation.lastError)) {
    return "Stripe may have made this refund after all, and the app cannot tell, so the card cannot be tried again. Check the Stripe dashboard: if Stripe refunded it, it shows here as nothing left owed once Stripe reports it; if not, settle it with Paid another way.";
  }
  if (owed.owedCents !== owed.ownCents) {
    return "This payment now holds less than this refund would send to the card, so the card cannot be tried again. Settle it with Paid another way.";
  }
  if (payment.recoveryOperations.some((other) => other.id !== operation.id && cardRefundFailedLaterRefundId(other.idempotencyKey) !== null)) {
    return "A refund Stripe failed later is on this payment, and it may be the same money as this one. Do not try the card again: check what the member is owed and settle it with Paid another way.";
  }
  return null;
}

/** A refund as Stripe lists it for an intent, as the re-arm reads it before its locks. */
export interface ListedStripeRefund {
  id: string;
  status?: string | null;
  metadata?: Record<string, string> | null;
}

/**
 * #4368 review (B): the refunds Stripe lists on this row's charges that THIS
 * ROW'S DOOR made (its metadata, `carriesCardRefundOperationMetadata`), that
 * still count, that carry no slice key (`INV-PAY-147`: made before slice
 * evidence, or by an unkeyed send) and that nothing here accounts for - no
 * slice of any row is marked with it, and the attribution gives it to none.
 * The runner adopts a refund only by its slice key, and a re-arm runs outside
 * Stripe's 24-hour key window, so a request sent for this row could pay any of
 * these again: the re-arm refuses while there is one.
 */
export function unadoptedOwnStripeRefunds(
  payment: DeadCardRefundPayment,
  operation: { type: string; idempotencyKey: string; stripeKeyPrefix: string | null; bookingId: string },
  listed: ReadonlyArray<ListedStripeRefund>,
): string[] {
  const marked = new Set(
    payment.recoveryOperations.flatMap((row) =>
      (parseRefundAllocationPlan(row.allocationPlan) ?? []).flatMap((slice) => (slice.madeRefundId ? [slice.madeRefundId] : [])),
    ),
  );
  const attributed = new Set([...cardRefundsAttributedByOperation(payment).values()].flat().map((refund) => refund.stripeRefundId));
  return listed
    .filter(
      (refund) =>
        isRecordedRefundStatus(refund.status ?? "unknown") &&
        carriesCardRefundOperationMetadata(operation, refund.metadata) &&
        !refund.metadata?.[REFUND_SLICE_KEY_METADATA] &&
        !marked.has(refund.id) &&
        !attributed.has(refund.id),
    )
    .map((refund) => refund.id);
}
