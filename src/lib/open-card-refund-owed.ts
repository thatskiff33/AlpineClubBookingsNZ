import type {
  PaymentRecoveryOperationStatus,
  PaymentRecoveryOperationType,
} from "@prisma/client";

import {
  getRemainingRefundableCents,
  type BookingPaymentState,
} from "@/lib/booking-payment-state";
import { isGroupSettlementRefundRecoveryKey } from "@/lib/payment-recovery-keys";
import { isRecordedRefundStatus } from "@/lib/payment-transaction-status";
import type { RefundAllocationSlice } from "@/lib/payment-transactions";

/**
 * #3372 (owner, 7 Oct 2026: "count in both"): CARD REFUNDS STARTED BUT NOT YET
 * PAID BY STRIPE. A refund-type `PaymentRecoveryOperation` that has not
 * SUCCEEDED - pending, processing, or failed and waiting for a retry or a
 * person - is money the club has decided to send back to a card and has not
 * yet sent. It counts in "Refunds owed" and comes off Net Collected straight
 * away, like a refund owed by hand (`openHandBackOwedCents`). A dead one (its
 * retries spent) keeps counting until the treasurer closes it as paid another
 * way (owner, #3372, 7 Oct 2026: "Count + add close action";
 * `closeCardRefundPaidAnotherWay`).
 *
 * That covers a cancellation's card refund, an approved refund request's, an
 * edit's, an edit review's, a treasurer-approved late capture's, an organiser
 * child's (`INV-PAY-114`) and a superseded intent's (#3340). Not a group
 * organiser-cancel settlement's (`isGroupSettlementRefundRecoveryKey`): see
 * `isOwedCardRefundOperation`. Plain module (a type-only Prisma import), so a
 * client page can import the module that reads it.
 */

/** The operation types that send money back to a card. */
export const CARD_REFUND_RECOVERY_OPERATION_TYPES = [
  "REFUND_BOOKING_MODIFICATION",
  "REFUND_SUPERSEDED_PAYMENT",
] as const satisfies readonly PaymentRecoveryOperationType[];

const SUCCEEDED = "SUCCEEDED" satisfies PaymentRecoveryOperationStatus;
const SUPERSEDED = "REFUND_SUPERSEDED_PAYMENT" satisfies PaymentRecoveryOperationType;

/**
 * Every card refund operation, open or closed, as a `PaymentRecoveryOperation`
 * where clause. The net-out reads the CLOSED ones too: a refund a closed
 * operation sent is that operation's, and must not be taken as an open one's
 * (`openCardRefundOwedCents`).
 */
export const CARD_REFUND_OPERATION_WHERE: {
  type: { in: PaymentRecoveryOperationType[] };
} = {
  type: { in: [...CARD_REFUND_RECOVERY_OPERATION_TYPES] },
};

/**
 * The unclosed card refunds, as a `PaymentRecoveryOperation` where clause.
 * "Unclosed" is every status but the terminal SUCCEEDED, so a status added
 * later counts as owed rather than silently dropping out.
 */
export const OPEN_CARD_REFUND_OPERATION_WHERE: {
  status: { not: PaymentRecoveryOperationStatus };
  type: { in: PaymentRecoveryOperationType[] };
} = {
  status: { not: SUCCEEDED },
  ...CARD_REFUND_OPERATION_WHERE,
};

/** Parse a persisted allocation plan (#1097); null when absent or malformed. */
export function parseRefundAllocationPlan(
  value: unknown,
): RefundAllocationSlice[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const slices: RefundAllocationSlice[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") return null;
    const { paymentTransactionId, amountCents } = entry as Record<
      string,
      unknown
    >;
    if (
      typeof paymentTransactionId !== "string" ||
      !paymentTransactionId ||
      typeof amountCents !== "number" ||
      !Number.isInteger(amountCents) ||
      amountCents <= 0
    ) {
      return null;
    }
    slices.push({ paymentTransactionId, amountCents });
  }
  return slices;
}

/** A card refund operation, as the owed figure reads it. */
export interface CardRefundOperationRow {
  id: string;
  type: string;
  status: string;
  idempotencyKey: string;
  amountCents: number;
  allocationPlan: unknown;
  paymentTransactionId: string | null;
  createdAt: Date;
  /**
   * When it closed; null while open (and on a row closed before the column was
   * written). A closed operation takes no refund recorded after it.
   */
  succeededAt: Date | null;
}

/** A refund recorded on the payment (`PaymentRefund`), as the net-out reads it. */
export interface RecordedCardRefundRow {
  paymentTransactionId: string | null;
  amountCents: number;
  status: string;
  /** When the app recorded it. */
  createdAt: Date;
  /**
   * When Stripe made it (whole seconds); null or absent on a row that never
   * carried it. A refund Stripe made before a close and the app recorded after
   * it is still the closed operation's (#3924 round 5, concurrency F2).
   */
  stripeCreatedAt?: Date | null;
}

/** A payment as `openCardRefundOwedCents` reads it. */
export type CardRefundOwedPaymentRow = BookingPaymentState & {
  recoveryOperations: ReadonlyArray<CardRefundOperationRow>;
  refunds: ReadonlyArray<RecordedCardRefundRow>;
};

/**
 * Whether a card refund operation's money belongs to the payment it hangs on.
 *
 * NOT A GROUP ORGANISER-CANCEL SETTLEMENT'S (#3924 money review, F3). That row
 * (`enqueueGroupSettlementRefundRecovery`) is only written for a settlement
 * whose `{childId: cents}` plan was frozen before #3653 - every later organiser
 * cancel refunds each child with its own operation, which this does read. Its
 * `paymentId` is an anchor for the schema FK and nothing else: the refund is one
 * Stripe refund for the whole group, out of the settlement's combined intent,
 * owed to the CHILDREN in that plan. Counted against the anchor payment it would
 * take another booking's money off that booking, capped at whatever that
 * payment happened to hold. Attributing it per child would need the frozen plan
 * and every child's refund mirror on every Net Collected read, for a legacy
 * row; it is left out, and the stuck-states page still lists it if its retries
 * run out.
 */
export function isOwedCardRefundOperation(operation: Pick<CardRefundOperationRow, "type" | "idempotencyKey">): boolean {
  return (
    (CARD_REFUND_RECOVERY_OPERATION_TYPES as readonly string[]).includes(operation.type) &&
    !isGroupSettlementRefundRecoveryKey(operation.idempotencyKey)
  );
}

/** One slice of an operation, as the net-out fills it. */
export interface CardRefundSlice {
  /** "" on a ledger refund with no plan yet: it names no transaction. */
  paymentTransactionId: string;
  amountCents: number;
  /**
   * A plan slice is filled only by a refund of EXACTLY its amount: Stripe answers
   * a slice's key with one refund of the slice's amount, so a refund of any other
   * amount is not this slice's. A superseded intent's slice is not exact - see
   * `operationSlices`.
   */
  exact: boolean;
  filledCents: number;
}

/**
 * The slices an operation still has to send, with nothing filled yet.
 *
 * - A frozen plan (#1097): each slice is replayed under its own Stripe key, so
 *   what the operation still owes is the plan's unsent slices.
 * - A superseded intent's refund (#3340): the whole of one transaction goes
 *   back, and the worker sends whatever that transaction still holds, up to the
 *   operation's amount (`processRefundSupersededPaymentOperation`). Any refund
 *   on that transaction after the operation was raised is therefore progress
 *   on it, whoever made it.
 * - A ledger refund with no plan yet has sent nothing (the plan is persisted
 *   before its first Stripe call): one unfillable slice of its amount, which the
 *   per-payment cap bounds, as the worker's own derivation is.
 */
function operationSlices(operation: CardRefundOperationRow): CardRefundSlice[] {
  const plan = parseRefundAllocationPlan(operation.allocationPlan);
  if (plan) {
    return plan.map((slice) => ({ ...slice, exact: true, filledCents: 0 }));
  }
  if (operation.type === SUPERSEDED && operation.paymentTransactionId) {
    return [
      {
        paymentTransactionId: operation.paymentTransactionId,
        amountCents: operation.amountCents,
        exact: false,
        filledCents: 0,
      },
    ];
  }
  return [{ paymentTransactionId: "", amountCents: operation.amountCents, exact: true, filledCents: 0 }];
}

/** Whether a slice takes this refund, of which `leftCents` is not yet placed. */
function sliceTakes(slice: CardRefundSlice, refund: RecordedCardRefundRow, leftCents: number): boolean {
  if (slice.paymentTransactionId !== refund.paymentTransactionId) return false;
  if (slice.filledCents >= slice.amountCents) return false;
  return slice.exact
    ? leftCents === refund.amountCents && refund.amountCents === slice.amountCents
    : true;
}

/** When Stripe made a refund: its own time where recorded, else when the app recorded it. */
function stripeMadeAt(refund: RecordedCardRefundRow): Date {
  return refund.stripeCreatedAt ?? refund.createdAt;
}

/** An instant floored to its whole second: Stripe dates a refund in whole seconds. */
function flooredToSecond(at: Date): number {
  return Math.floor(at.getTime() / 1000) * 1000;
}

/**
 * Whether an operation can take a refund: one MADE BY STRIPE at or after it
 * was raised and, once it closed, at or before its close.
 *
 * - One clock at both ends (#3924 round 7, money M3): the raised end reads
 *   Stripe's time too, against the raise floored to its second, so a refund
 *   Stripe made before the operation existed - a dashboard refund the app
 *   recorded late - is never the operation's, and one the operation asked for
 *   in the second it was raised still is.
 *
 * - The close bound (#3924 round-4 money review, M4): a closed operation's
 *   slices stop at its close, so a refund Stripe made later - another
 *   operation's retry - is never a closed operation's.
 * - Read against Stripe's own time, not the app's (#3924 round 5, concurrency
 *   F2): a refund an operation asked for, whose answer was lost (a timeout), is
 *   made by Stripe BEFORE the treasurer closes the operation as paid another
 *   way and recorded by the `charge.refunded` sync AFTER it. It is still that
 *   operation's, and so not an older open operation's same-amount slice; it is
 *   money the member was paid twice (`cardRefundSentAfterPaidAnotherWay`).
 *
 * A row closed before `succeededAt` was written has no close bound, as before.
 * STATED LIMIT: Stripe dates a refund in whole seconds, so a refund Stripe made
 * in the same second as a close, just after it, reads as made before it; and
 * one made in the second an operation was raised, just before it, reads as
 * made after it. A refund with no Stripe time is read at when the app recorded it.
 */
function operationWindowTakes(operation: CardRefundOperationRow, refund: RecordedCardRefundRow): boolean {
  if (flooredToSecond(operation.createdAt) > stripeMadeAt(refund).getTime()) return false;
  if (operation.status !== SUCCEEDED || operation.succeededAt === null) return true;
  return stripeMadeAt(refund).getTime() <= operation.succeededAt.getTime();
}

/**
 * Every card refund operation on one payment with its slices, each filled by
 * the refunds already recorded on the payment that are its own.
 *
 * WHICH RECORDED REFUND IS WHOSE (#3924 money review, F1 and F2). A refund's
 * `PaymentRefund` row and its `refundedAmountCents` are written slice by slice,
 * BEFORE the operation closes (`refundPaymentTransactions`, then
 * `completePaymentRecoveryOperation`), and a partial failure leaves an operation
 * open with some slices sent. A row carries no link to the operation that sent
 * it, so each is matched by what a slice's own refund must look like: on that
 * slice's transaction, of exactly its amount, inside the operation's window
 * (`operationWindowTakes`: made by Stripe no earlier than it was raised and,
 * once it closed, no later than its close). A refund made BEFORE an operation
 * was raised is never its: every writer that raises one after a partial inline refund carries only
 * the remainder - the refund request's route enqueues the plan's unsent slices
 * (a recording failure included, since round 4: `refundPaymentTransactions`
 * wraps it in `PartialRefundError`), an edit's enqueues the amount less what
 * was recorded, and a cancellation persists its plan before its first Stripe
 * call. Each row fills at most one slice, and goes to the operation raised MOST
 * RECENTLY before it with a slice it fits - so a later operation's own refund,
 * open or closed, is never taken as an older open one's progress. Every card
 * refund operation on the payment takes part, closed ones included, though only
 * open ones owe.
 *
 * So an unrelated later refund of a different amount nets nothing. One of
 * exactly a still-unsent slice's amount, on its transaction, made with no
 * operation behind it (a refund in the Stripe dashboard, an inline refund that
 * succeeded first time) is taken as that slice: for a refund the treasurer made
 * in the dashboard to settle a dead operation, that is the truth.
 */
export function cardRefundSlicesByOperation(
  payment: CardRefundOwedPaymentRow,
): ReadonlyArray<{ operation: CardRefundOperationRow; slices: ReadonlyArray<CardRefundSlice> }> {
  if (!payment.recoveryOperations.some((operation) => isOwedCardRefundOperation(operation) && operation.status !== SUCCEEDED)) {
    return payment.recoveryOperations
      .filter(isOwedCardRefundOperation)
      .map((operation) => ({ operation, slices: operationSlices(operation) }))
      .sort((left, right) => left.operation.createdAt.getTime() - right.operation.createdAt.getTime());
  }
  return attributeRecordedRefunds(payment).operations;
}

/**
 * The attribution `cardRefundSlicesByOperation` describes, run whether or not
 * any operation is open, with the cents each closed operation took from refunds
 * the app recorded AFTER its close (`lateCentsByOperation`).
 */
function attributeRecordedRefunds(payment: CardRefundOwedPaymentRow): {
  operations: Array<{ operation: CardRefundOperationRow; slices: CardRefundSlice[] }>;
  lateCentsByOperation: Map<string, number>;
} {
  const operations = payment.recoveryOperations
    .filter(isOwedCardRefundOperation)
    .map((operation) => ({ operation, slices: operationSlices(operation) }))
    .sort((left, right) => left.operation.createdAt.getTime() - right.operation.createdAt.getTime());
  const lateCentsByOperation = new Map<string, number>();
  const refunds = payment.refunds
    .filter((refund) => refund.paymentTransactionId !== null && isRecordedRefundStatus(refund.status))
    .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime());
  for (const refund of refunds) {
    let leftCents = Math.max(0, refund.amountCents);
    for (let index = operations.length - 1; index >= 0 && leftCents > 0; index -= 1) {
      const candidate = operations[index];
      if (!candidate || !operationWindowTakes(candidate.operation, refund)) continue;
      const slice = candidate.slices.find((each) => sliceTakes(each, refund, leftCents));
      if (!slice) continue;
      const takenCents = Math.min(leftCents, slice.amountCents - slice.filledCents);
      slice.filledCents += takenCents;
      leftCents -= takenCents;
      const { succeededAt } = candidate.operation;
      if (succeededAt !== null && refund.createdAt.getTime() > succeededAt.getTime()) {
        lateCentsByOperation.set(candidate.operation.id, (lateCentsByOperation.get(candidate.operation.id) ?? 0) + takenCents);
      }
    }
  }
  return { operations, lateCentsByOperation };
}

/**
 * #3924 round 5 (concurrency F2): what Stripe refunded to the card for each of
 * these closed operations AFTER the treasurer closed it as paid another way -
 * a refund Stripe made before the close and the app recorded after it
 * (`operationWindowTakes`). The member then has that money twice: by card, and
 * by the bank transfer the close recorded. Keyed by operation id; only the ids
 * asked for, and only where something came back.
 */
export function cardRefundSentAfterPaidAnotherWay(
  payment: CardRefundOwedPaymentRow,
  paidAnotherWayOperationIds: ReadonlySet<string>,
): Map<string, number> {
  const late = new Map<string, number>();
  for (const [operationId, cents] of attributeRecordedRefunds(payment).lateCentsByOperation) {
    if (paidAnotherWayOperationIds.has(operationId) && cents > 0) late.set(operationId, cents);
  }
  return late;
}

/** What a slice has still to send, in cents. */
export function unsentSliceCents(slice: CardRefundSlice): number {
  return Math.max(0, slice.amountCents - slice.filledCents);
}

/**
 * What each of one payment's open card refunds still owes, in cents, keyed by
 * operation id, before the per-payment cap: its slices' unsent parts
 * (`cardRefundSlicesByOperation`).
 */
export function openCardRefundOwedByOperation(payment: CardRefundOwedPaymentRow): Map<string, number> {
  const owed = new Map<string, number>();
  for (const { operation, slices } of cardRefundSlicesByOperation(payment)) {
    if (operation.status === SUCCEEDED) continue;
    owed.set(
      operation.id,
      slices.reduce((sum, slice) => sum + unsentSliceCents(slice), 0),
    );
  }
  return owed;
}

/**
 * What one payment still owes back by card, in cents: its open card refunds'
 * unsent slices (`openCardRefundOwedByOperation`), CAPPED PER PAYMENT at what
 * the payment still holds (`getRemainingRefundableCents`): money cannot be owed
 * back from a payment that no longer has it.
 */
export function openCardRefundOwedCents(payment: CardRefundOwedPaymentRow): number {
  let owedCents = 0;
  for (const cents of openCardRefundOwedByOperation(payment).values()) owedCents += cents;
  return Math.min(owedCents, getRemainingRefundableCents(payment));
}
