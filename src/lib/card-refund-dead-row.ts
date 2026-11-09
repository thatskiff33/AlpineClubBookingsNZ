import type { Prisma } from "@prisma/client";

import { netCollectedPaymentSelect } from "@/lib/additional-ledger-gap";
import {
  CARD_REFUND_OPERATION_WHERE,
  cardRefundsAttributedByOperation,
  cardRefundSlicesByOperation,
  carriesCardRefundOperationMetadata,
  type CardRefundAttributionRow,
  isOwnUnstampedCardRefund,
  parseRefundAllocationPlan,
  unsentSliceCents,
} from "@/lib/open-card-refund-owed";
import { getNetCollectedCashParts } from "@/lib/payment-net-collected";
import { PAYMENT_RECOVERY_EXHAUSTED_WHERE } from "@/lib/payment-recovery-constants";
import { cardRefundFailedLaterRefundId, cardRefundStillOwedCloseRecordId } from "@/lib/payment-recovery-keys";
import { isRecordedRefundStatus } from "@/lib/payment-transaction-status";
import { refundHeadroomIncrementCents } from "@/lib/refund-headroom";

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
 * - (Review F1) What the runner would send is not what the treasurer confirms:
 *   it sends every plan slice not marked `madeRefundId`, whole, whatever the
 *   owed figure says, and the preflight marks a slice only by its slice key.
 *   A slice a recorded refund filled but nobody marked (a refund made before
 *   slice evidence, a mark that failed) would be sent again, so the unmarked
 *   slices must add up to exactly the row's own unsent figure. A row with no
 *   stored plan cannot be checked, except a superseded intent's refund, whose
 *   runner sizes one request on its charge's ledger (review S1).
 * Where "Paid another way" cannot close the row either (a superseded intent's
 * refund whose charge does not hold exactly what it owes), the refusal points
 * to a developer instead (review S1).
 * - #4492: ANY refund Stripe failed later (`card_refund_failed_later_<refund>`)
 *   on the same payment, open or closed: it may be the same money as this row
 *   (a refund this row's door made whose answer was lost, then failed), and
 *   once it is re-sent and paid the row reads owed again - re-sending the row
 *   then would pay the member twice.
 */
export function tryCardAgainRefusal(
  payment: { recoveryOperations: ReadonlyArray<{ id: string; idempotencyKey: string }> },
  operation: ReArmedRow & { id: string; idempotencyKey: string; lastError: string | null },
  owed: Pick<DeadCardRefundStillOwed, "ownCents" | "owedCents">,
): string | null {
  if (owed.owedCents === 0) {
    return "Nothing is left owed on this card refund, so there is nothing to send to the card.";
  }
  // Review S1: where "Paid another way" cannot close it either, the refusal says so and points to a developer.
  const settle = deadRowSettleHint(operation, owed);
  if (raisedForAPerson(operation.idempotencyKey)) {
    return `The app raised this refund for a person to settle, not to send to the card again. Check what the member is owed. ${settle}`;
  }
  if (lastErrorSuggestsStripeMayHaveRefunded(operation.lastError)) {
    return `Stripe may have made this refund after all, and the app cannot tell, so the card cannot be tried again. Check the Stripe dashboard: if Stripe refunded it, it shows here as nothing left owed once Stripe reports it. If not: ${settle}`;
  }
  if (owed.owedCents !== owed.ownCents) {
    return `This payment now holds less than this refund would send to the card, so the card cannot be tried again. ${settle}`;
  }
  const sends = reArmWouldSendCents(operation);
  if (sends === null) {
    return `This refund keeps no record of exactly what it would send, so the app cannot check it against what is owed, and the card cannot be tried again. ${settle}`;
  }
  // A superseded intent's runner sends what its charge still holds, up to its amount: never more than the row's own
  // unsent figure, and less only where its charge was already part refunded - the money truly left to return (S1).
  const sizedOnLedger = isSizedOnLedger(operation);
  if (sizedOnLedger && sends === 0) {
    return `This refund's card charge holds nothing more to refund, so there is nothing to send to the card. ${settle}`;
  }
  if (sizedOnLedger ? sends > owed.ownCents : sends !== owed.ownCents) {
    return `Part of this refund was already refunded without being marked on it, so trying the card again would send a different amount from what is owed. ${settle}`;
  }
  if (payment.recoveryOperations.some((other) => other.id !== operation.id && cardRefundFailedLaterRefundId(other.idempotencyKey) !== null)) {
    return `A refund Stripe failed later is on this payment, and it may be the same money as this one. Do not try the card again: check what the member is owed. ${settle}`;
  }
  return null;
}

/** What a re-arm's send is read from: the row's stored plan, or a superseded intent's own charge (review S1). */
export interface ReArmedRow {
  type: string;
  paymentId: string;
  amountCents: number;
  allocationPlan: unknown;
  /** A superseded intent's charge, as its runner reads it; null or absent where unknown. Another payment's is ignored. */
  paymentTransaction?: SupersededCharge | null;
}

/** A superseded intent's charge, as its refund's settlements read it. */
export interface SupersededCharge {
  paymentId: string;
  amountCents: number;
  refundedAmountCents: number;
}

/** The row's charge, only while it is on the row's own payment (review R2: one rule for the list, the re-arm and the close). */
function ownCharge(operation: Pick<ReArmedRow, "paymentId" | "paymentTransaction">): SupersededCharge | null {
  const charge = operation.paymentTransaction;
  return charge && charge.paymentId === operation.paymentId ? charge : null;
}

/**
 * #4368 review R2 (`INV-SSOT`): THE ONE RULE OF WHEN "PAID ANOTHER WAY" CAN
 * CLOSE A SUPERSEDED INTENT'S REFUND - in full only, never for nothing, never
 * below its own unsent figure, and only while what it owes is exactly what its
 * charge on its own payment still holds, so the whole of it lands there and
 * the charge reads fully refunded (#3924 round 4, M7; round 5, F3). The close
 * enforces it (`assertSupersededCloseFillsItsTransaction`), and "Try the card
 * again" reads it to say whether "Paid another way" is the way out.
 */
export function supersededCloseFillsItsCharge(
  charge: SupersededCharge | null | undefined,
  paymentId: string,
  owed: Pick<DeadCardRefundStillOwed, "ownCents" | "owedCents">,
): boolean {
  return (
    !!charge &&
    charge.paymentId === paymentId &&
    owed.ownCents > 0 &&
    owed.owedCents === owed.ownCents &&
    charge.amountCents - charge.refundedAmountCents === owed.ownCents
  );
}

/**
 * Review S1, R1: where "Paid another way" cannot close this row either - a
 * superseded intent's refund whose charge does not hold exactly what it owes
 * (`supersededCloseFillsItsCharge`) - a refusal points to a developer instead.
 */
export function deadRowSettleHint(
  operation: Pick<ReArmedRow, "type" | "paymentId" | "paymentTransaction">,
  owed: Pick<DeadCardRefundStillOwed, "ownCents" | "owedCents">,
): string {
  const canClose =
    operation.type !== "REFUND_SUPERSEDED_PAYMENT" ||
    supersededCloseFillsItsCharge(operation.paymentTransaction, operation.paymentId, owed);
  return canClose ? "Settle it with Paid another way." : "Paid another way cannot close it either, so ask a developer to reconcile it.";
}

/** A superseded intent's refund with no stored plan: its runner sizes one request on its charge's ledger (S1). */
export function isSizedOnLedger(operation: Pick<ReArmedRow, "type" | "allocationPlan">): boolean {
  return operation.type === "REFUND_SUPERSEDED_PAYMENT" && !parseRefundAllocationPlan(operation.allocationPlan)?.length;
}

/**
 * #4368 review F1, S1: what the runner would send for a re-armed row.
 *
 * - A stored plan: every slice not marked `madeRefundId`, at its whole amount
 *   (`refundPlanOrRetryRefusals`, `processBookingModificationRefundOperation`).
 * - A superseded intent's refund with no plan: one request its runner sizes on
 *   the ledger after the preflight records Stripe's refunds - what its charge
 *   still holds, up to its amount (`refundHeadroomIncrementCents`,
 *   `processRefundSupersededPaymentOperation`). Read under the Payment row by
 *   the re-arm; any refund recorded after only lowers it.
 * - Any other row with no plan (a legacy booking modification's, whose runner
 *   derives its plan at the time), or a superseded one whose charge is not
 *   known: null - it cannot be checked.
 */
export function reArmWouldSendCents(operation: ReArmedRow): number | null {
  const plan = parseRefundAllocationPlan(operation.allocationPlan);
  if (plan && plan.length > 0) return plan.reduce((sum, slice) => sum + (slice.madeRefundId ? 0 : slice.amountCents), 0);
  const charge = ownCharge(operation);
  if (operation.type === "REFUND_SUPERSEDED_PAYMENT" && charge) return refundHeadroomIncrementCents(charge, operation.amountCents);
  return null;
}

/** A refund as Stripe lists it for an intent, as the re-arm and the runner's hold read it; a `Stripe.Refund` is one as listed. */
export interface ListedStripeRefund {
  id: string;
  status?: string | null;
  metadata?: Record<string, string> | null;
}

/**
 * #4368 review (B, F1): the refunds Stripe lists on this row's charges that a
 * request like this row's made - this booking's same kind of refund
 * (`isOwnUnstampedCardRefund`: its door's metadata, no slice key, so no slice
 * key ties it to a slice) - that still count and that no slice of any row is
 * marked with. The runner adopts a refund only by its slice key and a re-arm
 * runs outside Stripe's 24-hour key window, so a request sent for this row
 * could pay any of these again: the re-arm refuses while there is one. Being
 * matched by the owed figure's attribution does not clear it - the runner
 * sends by marks, not by that figure (review F1).
 */
export function unadoptedOwnStripeRefunds(
  payment: Pick<DeadCardRefundPayment, "recoveryOperations">,
  operation: { type: string; idempotencyKey: string; stripeKeyPrefix: string | null; bookingId: string },
  listed: ReadonlyArray<ListedStripeRefund>,
): string[] {
  const marked = new Set(
    payment.recoveryOperations.flatMap((row) =>
      (parseRefundAllocationPlan(row.allocationPlan) ?? []).flatMap((slice) => (slice.madeRefundId ? [slice.madeRefundId] : [])),
    ),
  );
  return listed
    .filter(
      (refund) =>
        isRecordedRefundStatus(refund.status ?? "unknown") && isOwnUnstampedCardRefund(operation, refund.metadata) && !marked.has(refund.id),
    )
    .map((refund) => refund.id);
}

/**
 * #4368 review R1, #4858 (`INV-SSOT`): THE ONE RULE OF WHEN A PLAN-LESS
 * SUPERSEDED ROW'S LEDGER SIZING CANNOT BE TRUSTED. A superseded intent's
 * refund with no plan is sized on its charge's ledger, which a refund another
 * door made counts as paid - and the owed figure's attribution may give that
 * refund to this row's slice. If it then fails later, the failed-later writer
 * (`findOwner`) does not take it as this row's (it lacks this row's metadata)
 * and raises a row of its own to pay it, while this row's runner re-sizes on
 * the ledger with that headroom back: the money would go twice. So the ledger
 * sizing is trusted only while every refund the attribution gives this row is
 * one this row's own request made (`carriesCardRefundOperationMetadata`, on
 * Stripe's own listing). Returns the refunds that are not - another door's,
 * the Stripe dashboard's, or ones Stripe did not list. Its readers: "Try the
 * card again" refuses a re-arm (read before the locks), and the runner holds
 * the row before it sends (`holdSupersededRowSizedOnAnotherRefund`, #4858).
 * Empty for a row with a stored plan: its slices are sent as written.
 */
export function foreignRefundsSizingSupersededRow(
  payment: CardRefundAttributionRow,
  operation: { id: string; type: string; idempotencyKey: string; stripeKeyPrefix: string | null; bookingId: string; allocationPlan: unknown },
  listed: ReadonlyArray<ListedStripeRefund>,
): string[] {
  if (!isSizedOnLedger(operation)) return [];
  return (cardRefundsAttributedByOperation(payment).get(operation.id) ?? [])
    .filter((refund) => {
      const onStripe = listed.find((each) => each.id === refund.stripeRefundId);
      return !onStripe || !carriesCardRefundOperationMetadata(operation, onStripe.metadata);
    })
    .map((refund) => refund.stripeRefundId);
}
