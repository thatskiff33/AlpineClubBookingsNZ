import type {
  PaymentRecoveryOperationStatus,
  PaymentRecoveryOperationType,
} from "@prisma/client";

import {
  getRemainingRefundableCents,
  type BookingPaymentState,
} from "@/lib/booking-payment-state";
import {
  cardRefundFailedLaterRefundId,
  cardRefundOperationRefundMetadata,
  isGroupSettlementRefundRecoveryKey,
  isRefusedRefundKeySuffix,
} from "@/lib/payment-recovery-keys";
import { isRecordedRefundStatus } from "@/lib/payment-transaction-status";
import { REFUND_SLICE_KEY_METADATA } from "@/lib/refund-slice-evidence";
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

/** Whether a card refund operation is unclosed: `OPEN_CARD_REFUND_OPERATION_WHERE`'s status, for a row already read. */
export function isOpenCardRefundOperationStatus(status: string): boolean {
  return status !== SUCCEEDED;
}

/**
 * #4104: a plan slice that made a refund Stripe failed later: the failure
 * re-planned it (`failedRefundIds`) onto its next key. Whether it was made
 * again since is `cardRefundSliceOwesFailedLaterRefund`.
 */
export function cardRefundSliceRecordsFailedLaterRefund(slice: Pick<RefundAllocationSlice, "failedRefundIds">): boolean {
  return (slice.failedRefundIds?.length ?? 0) > 0;
}

/**
 * #4104, #4221: a re-planned slice its row still owes: not made again since
 * (`madeRefundId`, the mark a slice made beside a refusal keeps). On an open
 * row, the runner sends it again; on a dead one, the treasurer pays it.
 */
export function cardRefundSliceOwesFailedLaterRefund(slice: Pick<RefundAllocationSlice, "failedRefundIds" | "madeRefundId">): boolean {
  return cardRefundSliceRecordsFailedLaterRefund(slice) && !slice.madeRefundId;
}

/**
 * #4104, #4312 (`INV-SSOT`): THE REFUNDS STRIPE FAILED LATER THAT ONE SLICE IS
 * SENT FOR - the one spelling, per slice, of the two links #4104 keeps: every
 * slice of a row of its own (`card_refund_failed_later_<refund>`, the key names
 * it) and a re-planned slice's `failedRefundIds`. Empty for a slice sent for
 * nothing that failed. Every per-slice reader asks it - the pairing, the mark,
 * the failed-later owner and the paid-another-way cover. A question about the
 * whole row (is it a row of its own, and so owed at its amount) reads the key
 * itself (`cardRefundFailedLaterRefundId`).
 */
export function cardRefundSliceFailedRefundIds(
  operation: { idempotencyKey: string },
  slice: Pick<RefundAllocationSlice, "failedRefundIds">,
): string[] {
  const byKey = cardRefundFailedLaterRefundId(operation.idempotencyKey);
  return [...new Set([...(byKey ? [byKey] : []), ...(slice.failedRefundIds ?? [])])];
}

/**
 * #4104 review (CM), #4312 round 8 (`INV-SSOT`): whether a Stripe refund
 * carries exactly the metadata this row's runner sends
 * (`cardRefundOperationRefundMetadata`), with optional per-slice evidence
 * (`INV-PAY-147`) - no door key missing, no unrelated key extra. The one
 * test of "this row's runner could have sent it": a refund another door or the
 * Stripe dashboard made never passes it.
 */
export function carriesCardRefundOperationMetadata(
  operation: Parameters<typeof cardRefundOperationRefundMetadata>[0],
  metadata: Record<string, string> | null | undefined,
): boolean {
  const expected = Object.entries(cardRefundOperationRefundMetadata(operation));
  const actual = metadata ?? {};
  return Object.keys(actual).filter((key) => key !== REFUND_SLICE_KEY_METADATA).length === expected.length &&
    expected.every(([key, value]) => actual[key] === value);
}

/**
 * #4312 round 7 (#4104, `INV-ADDPAY-047`): WHICH REFUNDS STRIPE FAILED LATER A
 * REFUND WAS SENT AGAIN FOR, by the record the recovery replay keeps and by
 * nothing else. The replay sends a slice for its failures
 * (`cardRefundSliceFailedRefundIds`) and marks that slice with the refund
 * Stripe made for it (`madeRefundId`, `refundPlanOrRetryRefusals`), so the
 * refund a slice is marked with answers that slice's failures. A refund no
 * slice is marked with - one made in the Stripe dashboard, say - answers none,
 * whatever its charge, amount or time.
 *
 * THE CHAIN. A failure that was itself a re-send passes on what it answered:
 * the slice marked with it lists its own failures, which join the answer. A
 * slice re-planned while its row is open loses its mark and lists the failed
 * re-send with the earlier failures (`card-refund-failed-later.ts`), so either
 * way each failure is reached once. Pure; every card refund row of the payment,
 * open or closed, as read.
 */
export function cardRefundFailuresAnsweredBy(
  operations: ReadonlyArray<{ idempotencyKey: string; allocationPlan: unknown }>,
  stripeRefundId: string,
): string[] {
  const marked = operations.flatMap((operation) =>
    (parseRefundAllocationPlan(operation.allocationPlan) ?? []).flatMap((slice) =>
      slice.madeRefundId ? [{ madeRefundId: slice.madeRefundId, failed: cardRefundSliceFailedRefundIds(operation, slice) }] : [],
    ),
  );
  const answered: string[] = [];
  const seen = new Set([stripeRefundId]);
  const toWalk = [stripeRefundId];
  for (let refundId = toWalk.shift(); refundId !== undefined; refundId = toWalk.shift()) {
    for (const slice of marked) {
      if (slice.madeRefundId !== refundId) continue;
      for (const failed of slice.failed.filter((id) => !seen.has(id))) {
        seen.add(failed);
        answered.push(failed);
        toWalk.push(failed);
      }
    }
  }
  return answered;
}

/**
 * Parse a persisted allocation plan (#1097); null when absent or malformed. A
 * slice's key generation after a refusal (#4083) is kept, so a replay sends it,
 * and so is the mark of a slice Stripe made beside one it refused, which the
 * runner never sends again and which still fills here, as this row's.
 */
export function parseRefundAllocationPlan(
  value: unknown,
): RefundAllocationSlice[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const slices: RefundAllocationSlice[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") return null;
    const { paymentTransactionId, amountCents, stripeKeySuffix, madeRefundId, failedRefundIds, madeByOperationId } = entry as Record<
      string,
      unknown
    >;
    if (
      typeof paymentTransactionId !== "string" ||
      !paymentTransactionId ||
      typeof amountCents !== "number" ||
      !Number.isInteger(amountCents) ||
      amountCents <= 0 ||
      (stripeKeySuffix !== undefined && !isRefusedRefundKeySuffix(stripeKeySuffix)) ||
      (madeRefundId !== undefined && (typeof madeRefundId !== "string" || !madeRefundId)) ||
      (failedRefundIds !== undefined &&
        (!Array.isArray(failedRefundIds) || !failedRefundIds.every((id) => typeof id === "string" && id.length > 0))) ||
      (madeByOperationId !== undefined && madeByOperationId !== null && (typeof madeByOperationId !== "string" || !madeByOperationId))
    ) {
      return null;
    }
    slices.push({
      paymentTransactionId,
      amountCents,
      ...(stripeKeySuffix === undefined ? {} : { stripeKeySuffix }),
      ...(madeRefundId === undefined ? {} : { madeRefundId }),
      ...(failedRefundIds === undefined ? {} : { failedRefundIds: [...(failedRefundIds as string[])] }),
      ...(madeByOperationId === undefined ? {} : { madeByOperationId: madeByOperationId as string | null }),
    });
  }
  return slices;
}

/**
 * #4117: what a card refund operation still has to send, by its own record:
 * its amount less the slices its plan marks made (`madeRefundId`). A marked
 * slice was made by Stripe and is never sent again, though the amount keeps
 * it (the cancellation's, the runner's and a refund request's rows). A row
 * with no marked slice reads its amount, exactly as before. Not the owed
 * figure: that also nets the refunds recorded since (`openCardRefundOwedByOperation`).
 */
export function cardRefundOperationUnmadeCents(operation: { amountCents: number; allocationPlan?: unknown }): number {
  const plan = parseRefundAllocationPlan(operation.allocationPlan);
  const madeCents = (plan ?? []).reduce((sum, slice) => sum + (slice.madeRefundId ? slice.amountCents : 0), 0);
  return Math.max(0, operation.amountCents - madeCents);
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
  /** Stripe's refund id: a plan slice marked with it (`madeRefundId`) is filled by this refund (#4117). */
  stripeRefundId: string;
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
  /**
   * #4083/#4102: the Stripe refund that made this slice, on an attempt that met
   * a refusal. Filled by exactly that recorded refund, whenever it was made.
   */
  madeRefundId?: string;
  /** #4083: the key generation it moved to after Stripe refused it: it was refused, so is certainly unmade. */
  stripeKeySuffix?: string;
  /** #4104: the refunds that made it and that Stripe failed later, carried from the plan (`cardRefundSliceOwesFailedLaterRefund`). */
  failedRefundIds?: string[];
}

/**
 * The slices an operation still has to send, with nothing filled yet.
 *
 * - A frozen plan (#1097): each slice is replayed under its own Stripe key, so
 *   what the operation still owes is the plan's unsent slices. A slice marked
 *   made (`madeRefundId`) is filled by that refund alone (`attributeRecordedRefunds`).
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

/** Whether a slice takes this refund, of which `leftCents` is not yet placed. A marked slice takes only its own. */
function sliceTakes(slice: CardRefundSlice, refund: RecordedCardRefundRow, leftCents: number): boolean {
  if (slice.madeRefundId || slice.paymentTransactionId !== refund.paymentTransactionId) return false;
  if (slice.filledCents >= slice.amountCents) return false;
  return slice.exact
    ? leftCents === refund.amountCents && refund.amountCents === slice.amountCents
    : true;
}

/** When Stripe made a refund: its own time where recorded, else when the app recorded it. */
function stripeMadeAt(refund: Pick<RecordedCardRefundRow, "createdAt" | "stripeCreatedAt">): Date {
  return refund.stripeCreatedAt ?? refund.createdAt;
}

/** An instant floored to its whole second: Stripe dates a refund in whole seconds. */
function flooredToSecond(at: Date): number {
  return Math.floor(at.getTime() / 1000) * 1000;
}

/**
 * Whether an operation can take a refund: one MADE BY STRIPE at or after it
 * was raised and, once it closed, at or before its close. Also the window of a
 * re-send `charge.refunded` records before its slice is marked
 * (`unmarkedResendSlicesFor`, #4312 round 8).
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
export function operationWindowTakes(
  operation: Pick<CardRefundOperationRow, "createdAt" | "status" | "succeededAt">,
  refund: Pick<RecordedCardRefundRow, "createdAt" | "stripeCreatedAt">,
): boolean {
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
 * was raised is never its: every writer that raises one after a partial
 * inline refund carries only the remainder, or marks what was made - the
 * refund request's route enqueues the slices its attempt did not make, refused
 * ones on their next key, with each made one marked (#4102); an edit's
 * enqueues the amount less what was made; and a cancellation persists its plan
 * before its first Stripe call.
 *
 * A MARKED SLICE (`madeRefundId`, #4083, #4102) is filled first, by the
 * recorded refund with exactly that Stripe id, whenever Stripe made it - the
 * refund request's row is raised after its made slices - and that refund then
 * leaves the pool, so it can fill nothing else (an older row's slice of the
 * same transaction and amount included). A marked slice whose refund is not
 * recorded as made stays unfilled, and owed. Each other row fills at most one slice, and goes to the operation raised MOST
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
function attributeRecordedRefunds(
  payment: CardRefundOwedPaymentRow,
  /** #4104: told which slice each recorded refund filled, and with how much (`cardRefundSliceFilledBy`). */
  onFill?: (refund: RecordedCardRefundRow, operation: CardRefundOperationRow, sliceIndex: number, cents: number) => void,
): {
  operations: Array<{ operation: CardRefundOperationRow; slices: CardRefundSlice[] }>;
  lateCentsByOperation: Map<string, number>;
} {
  const operations = payment.recoveryOperations
    .filter(isOwedCardRefundOperation)
    .map((operation) => ({ operation, slices: operationSlices(operation) }))
    .sort((left, right) => left.operation.createdAt.getTime() - right.operation.createdAt.getTime());
  const lateCentsByOperation = new Map<string, number>();
  const recorded = payment.refunds.filter(
    (refund) => refund.paymentTransactionId !== null && isRecordedRefundStatus(refund.status),
  );
  const claimed = new Set<RecordedCardRefundRow>();
  // #4104: a refund Stripe failed later whose debt was handed to a row of its
  // own (`card_refund_failed_later_<refund>`) is that row's to owe, never this one's.
  const handedOver = new Set(
    payment.recoveryOperations.flatMap((operation) => {
      const refundId = cardRefundFailedLaterRefundId(operation.idempotencyKey);
      return refundId ? [refundId] : [];
    }),
  );
  for (const { operation, slices } of operations) {
    for (const [sliceIndex, slice] of slices.entries()) {
      if (slice.madeRefundId && handedOver.has(slice.madeRefundId)) {
        slice.filledCents = slice.amountCents;
        continue;
      }
      const refund = slice.madeRefundId
        ? recorded.find((each) => each.stripeRefundId === slice.madeRefundId && !claimed.has(each))
        : undefined;
      if (!refund) continue;
      claimed.add(refund);
      slice.filledCents = Math.min(slice.amountCents, Math.max(0, refund.amountCents));
      onFill?.(refund, operation, sliceIndex, slice.filledCents);
      if (operation.succeededAt !== null && refund.createdAt.getTime() > operation.succeededAt.getTime()) {
        lateCentsByOperation.set(operation.id, (lateCentsByOperation.get(operation.id) ?? 0) + slice.filledCents);
      }
    }
  }
  const refunds = recorded
    .filter((refund) => !claimed.has(refund))
    .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime());
  for (const refund of refunds) {
    let leftCents = Math.max(0, refund.amountCents);
    for (let index = operations.length - 1; index >= 0 && leftCents > 0; index -= 1) {
      const candidate = operations[index];
      if (!candidate || !operationWindowTakes(candidate.operation, refund)) continue;
      const slice = candidate.slices.find((each) => sliceTakes(each, refund, leftCents));
      if (!slice) continue;
      const takenCents = Math.min(leftCents, slice.amountCents - slice.filledCents);
      onFill?.(refund, candidate.operation, candidate.slices.indexOf(slice), takenCents);
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
 * #4104: the slice a recorded refund fills, by the attribution the owed figure
 * runs (`attributeRecordedRefunds`) - so a refund Stripe failed later is owed
 * again by the row that counted it as made, not by a second one. The caller
 * passes the payment as it stood before the failure (the refund still counted).
 */
export function cardRefundSliceFilledBy(
  payment: CardRefundOwedPaymentRow,
  stripeRefundId: string,
): { operation: CardRefundOperationRow; sliceIndex: number } | null {
  let owner: { operation: CardRefundOperationRow; sliceIndex: number } | null = null;
  attributeRecordedRefunds(payment, (refund, operation, sliceIndex) => {
    if (refund.stripeRefundId === stripeRefundId && owner === null) owner = { operation, sliceIndex };
  });
  return owner;
}

/**
 * #4104, #4166 (`INV-SSOT`): a payment as it stood before Stripe failed one of
 * its refunds later - that refund still counted (`pending`), and the row owing
 * it again (`card_refund_failed_later_<refund>`) not yet raised, so it cannot
 * take its own refund. What the failed-later writer reads as it raises that
 * row, and what the booking page reads to find which row made the refund.
 */
export function cardRefundPaymentBeforeFailure(payment: CardRefundOwedPaymentRow, stripeRefundId: string): CardRefundOwedPaymentRow {
  return {
    ...payment,
    recoveryOperations: payment.recoveryOperations.filter((operation) => cardRefundFailedLaterRefundId(operation.idempotencyKey) !== stripeRefundId),
    refunds: payment.refunds.map((refund) => (refund.stripeRefundId === stripeRefundId ? { ...refund, status: "pending" } : refund)),
  };
}

/**
 * #4145 (`INV-PAY-134`): what the recorded refunds made of one operation's
 * slices - marked or matched, by the attribution the owed figure runs - and
 * when Stripe made the latest of them (`stripeMadeAt`). A slice whose refund
 * failed later and was handed to a row of its own counts nothing: no recorded
 * refund made it.
 */
export function cardRefundMadeForOperation(
  payment: CardRefundOwedPaymentRow,
  operationId: string,
): { madeCents: number; lastMadeAt: Date | null } {
  let madeCents = 0;
  let lastMadeAt: Date | null = null;
  attributeRecordedRefunds(payment, (refund, operation, _sliceIndex, cents) => {
    if (operation.id !== operationId || cents <= 0) return;
    madeCents += cents;
    const madeAt = stripeMadeAt(refund);
    if (lastMadeAt === null || madeAt.getTime() > lastMadeAt.getTime()) lastMadeAt = madeAt;
  });
  return { madeCents, lastMadeAt };
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
