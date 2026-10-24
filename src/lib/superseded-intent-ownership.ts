/**
 * WHICH CARD CAPTURES THE SUPERSEDED-INTENT MACHINERY OWNS (#1992, #4177).
 *
 * The superseded-intent machinery (booking-payment-cleanup queues a
 * CANCEL_PAYMENT_INTENT recovery operation; when the cancel loses to a late
 * capture, payment-recovery's handoff marks that transaction SUCCEEDED and
 * queues a REFUND_SUPERSEDED_PAYMENT operation for the cron) transiently
 * produces a SUCCEEDED PRIMARY Stripe capture with net cash that no settlement
 * ever passed through. Its money is already spoken for — the recovery cron
 * will refund it under its `payment_recovery_refund_<txn>_<pi>` key — so it is
 * never "the capture that settled the booking":
 *
 * - the duplicate-capture refund (`markBookingPaymentSucceeded`, guards b′ and
 *   c′) would otherwise refund the REAL settlement as the duplicate and, once
 *   the cron also refunds the superseded capture, leave the booking PAID at
 *   zero net cash;
 * - the Xero second-instrument conflict (`findSecondInstrumentSettlement`),
 *   on a PAID / COMPLETED booking, would otherwise name a capture that is
 *   going back to the member, where the duplicate-capture refund names the
 *   real settlement (#4177). Never on a CANCELLED booking: there the new bank
 *   cash has nowhere to go, so every capture still counts.
 *
 * One home for the operation types and the refund's liveness. Its readers
 * fail safe in different directions, so they read an operation differently:
 *
 * - guards (b′) and (c′) (`listLiveSupersededIntentIds`,
 *   `findLiveSupersededIntentOperation`) treat any operation not SUCCEEDED as
 *   live. Wrongly skipping a capture there costs nothing; wrongly counting one
 *   refunds the real settlement;
 * - the Xero conflict (`listSupersededIntentIdsOwningCaptures`) counts a cancel
 *   operation only while it is in flight
 *   (`PAYMENT_RECOVERY_OPERATION_IN_FLIGHT_WHERE`). A dead cancel with no
 *   refund operation behind it has handed the money to nobody, and wrongly
 *   skipping that capture would hide a booking paid twice. A refund operation
 *   still counts until it SUCCEEDED, dead or not: its machinery alerted the
 *   admins. So does a capture whose superseded refund succeeded, while open
 *   card refund rows owe back again, dead or not, at least all it holds after
 *   refunds Stripe failed later (`supersededRefundsOwedAgainCents`, #4221);
 * - the duplicate-capture guard's check of the ARRIVING capture (#4283) reads
 *   it the Xero conflict's way: a capture the machinery is still sending back
 *   is never refunded on top as a duplicate, while one behind a dead cancel is
 *   a duplicate like any other (wrongly keeping it would keep money twice with
 *   nobody told). The guard's (b′) and (c′) add this reading's owed-back
 *   captures to their own (#4227);
 * - the settle and the card doors (#4300, `INV-PAY-138`) ask whether they may
 *   settle a booking with a capture at all: (c′), the Xero reading, and any
 *   capture open rows owe back ANY part of - never settle with money partly
 *   going back. Composed with the guard's in `superseded-capture-ownership.ts`;
 * - a saved-card charge (#4300, `beginSavedCardChargeAttempt`) asks whether it
 *   may charge beside a capture the machinery owns (the Xero reading, never
 *   "any part owed back": a capture partly owed back still holds money and
 *   refuses as taken). It reads `refundInFlight`: a superseded refund row the
 *   runner will still run (`isPaymentRecoveryOperationInFlight`), or running
 *   rows owing it back in full. It fails safe toward NOT charging: a dead
 *   refund (`refundStopped`) or one not yet started refuses, because charging
 *   beside a refund that never completes holds the price twice.
 *
 * Under (b′) and (c′) a superseded-machinery operation counts as LIVE while it
 * is not SUCCEEDED:
 * PENDING, PROCESSING and FAILED (retrying or exhausted, where the money is
 * still adjudicated to that machinery and admins were alerted). A SUCCEEDED
 * cancel operation either actually cancelled the intent (its transaction is
 * FAILED — never a settled capture) or handed off to a refund operation that
 * is enqueued BEFORE the cancel operation completes; a SUCCEEDED refund
 * operation leaves the transaction REFUNDED, which holds no net cash. So
 * `status != SUCCEEDED` across both types covers the handoff window itself.
 * It does not cover what follows: when Stripe fails a SUCCEEDED refund later,
 * the capture holds net cash again with no live operation of these types, and
 * (b′) and (c′) alone would count it as a settling capture. Every reader
 * covers that gap through the open row that owes the failed refund again - a
 * failed-later row, or a slice re-planned on an open card refund row (#4221,
 * #4227) - through `listSupersededIntentIdsOwningCaptures` (`owedBackInFull`).
 */
import {
  PaymentRecoveryOperationStatus,
  PaymentRecoveryOperationType,
  type Prisma,
} from "@prisma/client";
import { netCollectedCardRefundSelect } from "@/lib/additional-ledger-gap";
import {
  cardRefundSlicesByOperation,
  cardRefundSliceOwesFailedLaterRefund,
  type CardRefundOwedPaymentRow,
  isOpenCardRefundOperationStatus,
  OPEN_CARD_REFUND_OPERATION_WHERE,
  unsentSliceCents,
} from "@/lib/open-card-refund-owed";
import { isPaymentRecoveryOperationInFlight, PAYMENT_RECOVERY_OPERATION_IN_FLIGHT_WHERE } from "@/lib/payment-recovery-constants";
import {
  CARD_REFUND_FAILED_LATER_RECOVERY_PREFIX,
  cardRefundFailedLaterRefundId,
  duplicateCaptureIntentIdForRecoveryKey,
} from "@/lib/payment-recovery-keys";
import { exactPrefix } from "@/lib/prisma-exact-prefix";
import { duplicateCaptureRefundOperationWhere } from "@/lib/duplicate-capture-ownership";

export const SUPERSEDED_INTENT_OPERATION_TYPES = [
  PaymentRecoveryOperationType.CANCEL_PAYMENT_INTENT,
  PaymentRecoveryOperationType.REFUND_SUPERSEDED_PAYMENT,
] as const;

type RecoveryOperationReader = Pick<Prisma.TransactionClient, "paymentRecoveryOperation">;

/** The Xero reader also reads the payment, for what each open row still owes (#4221). */
export type OwnershipReader = Pick<Prisma.TransactionClient, "paymentRecoveryOperation" | "payment">;

/**
 * The one liveness predicate both reads below share - and what a manual
 * mark-paid reversal withdraws (#4320, `INV-PAY-045`): only a row this reads
 * as dead is invisible to (b′) and (c′).
 */
export function liveSupersededOperation() {
  return {
    type: { in: [...SUPERSEDED_INTENT_OPERATION_TYPES] },
    status: { not: PaymentRecoveryOperationStatus.SUCCEEDED },
  } satisfies Prisma.PaymentRecoveryOperationWhereInput;
}

/**
 * Guard (b′): every intent id on this payment whose money a live
 * superseded-intent recovery operation already owns. Read under lock(1), which
 * every caller already holds.
 */
export async function listLiveSupersededIntentIds(
  tx: RecoveryOperationReader,
  paymentId: string
): Promise<string[]> {
  const operations = await tx.paymentRecoveryOperation.findMany({
    where: { paymentId, ...liveSupersededOperation() },
    select: { paymentIntentId: true },
  });
  return [...new Set(operations.map((operation) => operation.paymentIntentId))];
}

/**
 * Guard (c′), belt-and-braces sibling of (b′) with a deliberately DIFFERENT
 * query shape (direct intent-id lookup, not scoped to a payment): does a live
 * superseded-intent recovery operation own this specific intent's money? The
 * duplicate-capture refund re-checks its matched "settlement" with it, so even
 * a candidate that slipped the (b′) exclusion leaves the arriving capture
 * plain `already_paid`.
 */
export async function findLiveSupersededIntentOperation(
  tx: RecoveryOperationReader,
  paymentIntentId: string
) {
  return tx.paymentRecoveryOperation.findFirst({
    where: { paymentIntentId, ...liveSupersededOperation() },
    select: { id: true },
  });
}

/** A row the Xero reader reads: the superseded machinery's, or an open card refund row. */
type OwnershipRow = {
  id: string;
  type: PaymentRecoveryOperationType;
  status: PaymentRecoveryOperationStatus;
  paymentIntentId: string;
  paymentTransactionId: string | null;
  idempotencyKey: string;
  /** #4300: whether the runner will still run it (`isPaymentRecoveryOperationInFlight`). */
  attempts: number;
  nextRetryAt: Date | null;
};

/** A capture the Xero reader may name: what it holds is its amount less its counted refunds. */
export type OwnershipCapture = {
  stripePaymentIntentId: string | null;
  amountCents: number;
  refundedAmountCents: number;
};

/**
 * #4221: the rows `supersededRefundsOwedAgainCents` reads - every superseded
 * refund operation, whatever its status (a SUCCEEDED one is the refund Stripe
 * can fail later), every OPEN failed-later row (`card_refund_failed_later_*`,
 * #4104), and every OPEN card refund row, whose plan a failure re-plans
 * (`OPEN_CARD_REFUND_OPERATION_WHERE`, the rows `keepFailedLaterCardRefundOwed`
 * re-plans). Open means live, or dead for the treasurer; a SUCCEEDED one was
 * made or closed as paid another way. The failed-later rows are open card
 * refund rows today; the key picks them, but what they owe comes from the
 * card-refund owed figure, so a row of another type would owe nothing.
 * Scoped to a payment: a re-planned slice names its capture by transaction,
 * on a row that may sit on another intent.
 */
const SUPERSEDED_REFUND_OWED_AGAIN_WHERE = [
  { type: PaymentRecoveryOperationType.REFUND_SUPERSEDED_PAYMENT },
  {
    idempotencyKey: exactPrefix(CARD_REFUND_FAILED_LATER_RECOVERY_PREFIX),
    status: { not: PaymentRecoveryOperationStatus.SUCCEEDED },
  },
  OPEN_CARD_REFUND_OPERATION_WHERE,
] satisfies Prisma.PaymentRecoveryOperationWhereInput[];

/**
 * #4221: how many cents open rows still owe back again, by capture, on a
 * capture a superseded refund operation exists for - what each still OWES by
 * the owed figure's own attribution (`cardRefundSlicesByOperation`,
 * `unsentSliceCents`), never what it was raised for. A re-send already
 * recorded fills its slice and owes nothing, whether its row has closed yet
 * or not (a worker that crashed before its close; a dead row the treasurer
 * paid by a refund in the Stripe dashboard, which never closes):
 *
 * - an open failed-later row whose OWN `paymentIntentId` is the capture (the
 *   intent Stripe's failed refund named, as `late-capture-paid-another-way`
 *   keys it): all its slices still owe. Rows carry the failed-later key's own
 *   rule (`cardRefundFailedLaterRefundId`, #4146), not just its prefix;
 * - each slice of another open card refund row on the capture's transaction
 *   (the superseded refund's `paymentTransactionId`) that a refund Stripe
 *   failed later re-planned and that is not made again
 *   (`cardRefundSliceOwesFailedLaterRefund`): what it still owes. That row
 *   sends it again; no failed-later row is raised.
 *
 * Open rows only: the where reads every superseded refund, and one that closed
 * after re-sending a refusal keeps a re-planned slice in its plan (#4103's
 * one-slice plan, re-planned by #4104).
 *
 * A failure the club owes again (`keepFailedLaterCardRefundOwed`) raises a
 * failed-later row on the failed refund's intent or re-plans the open row's
 * slice that made it. A failure it does not re-send - a refund made by hand
 * in Stripe, `not-resent` - raises nothing, so its cash is owed by nothing:
 * the caller compares cents, never a row's mere presence.
 *
 * Pure over the rows `SUPERSEDED_REFUND_OWED_AGAIN_WHERE` reads and the
 * payment as the owed figure reads it, so guards (b′) and (c′) can share it
 * (#4227). No payment: nothing is owed, and every capture counts.
 */
function supersededRefundsOwedAgainCents(
  rows: readonly OwnershipRow[],
  payment: CardRefundOwedPaymentRow | null,
): Map<string, number> {
  const supersededRefunds = rows.filter((row) => row.type === PaymentRecoveryOperationType.REFUND_SUPERSEDED_PAYMENT);
  return refundsOwedAgainCents(rows, payment, {
    intents: new Set(supersededRefunds.map((row) => row.paymentIntentId)),
    intentOfTransaction: new Map(
      supersededRefunds.flatMap((row) => (row.paymentTransactionId === null ? [] : [[row.paymentTransactionId, row.paymentIntentId] as const])),
    ),
  });
}

/**
 * The cents rule behind `supersededRefundsOwedAgainCents`, for any refund
 * machinery: `intents` are the captures its refunds were made on, and
 * `intentOfTransaction` names each by its ledger row. #4285 review: the
 * duplicate-capture refunds read it too (`listDuplicateRefundIntentIdsOwningCaptures`).
 */
function refundsOwedAgainCents(
  rows: readonly OwnershipRow[],
  payment: CardRefundOwedPaymentRow | null,
  { intents: superseded, intentOfTransaction }: { intents: ReadonlySet<string>; intentOfTransaction: ReadonlyMap<string, string> },
): Map<string, number> {
  const slicesOf = new Map(
    (payment ? cardRefundSlicesByOperation(payment) : []).map(({ operation, slices }) => [operation.id, slices] as const),
  );
  const owed = new Map<string, number>();
  const add = (intent: string, cents: number) => owed.set(intent, (owed.get(intent) ?? 0) + cents);
  for (const row of rows) {
    if (!isOpenCardRefundOperationStatus(row.status)) continue;
    const slices = slicesOf.get(row.id) ?? [];
    if (cardRefundFailedLaterRefundId(row.idempotencyKey) !== null) {
      if (superseded.has(row.paymentIntentId)) add(row.paymentIntentId, slices.reduce((sum, slice) => sum + unsentSliceCents(slice), 0));
      continue;
    }
    for (const slice of slices) {
      const intent = intentOfTransaction.get(slice.paymentTransactionId);
      if (intent !== undefined && cardRefundSliceOwesFailedLaterRefund(slice)) add(intent, unsentSliceCents(slice));
    }
  }
  return owed;
}

/** The rows and payment `supersededRefundsOwedAgainCents` reads, under the caller's lock(1). */
async function readSupersededRefundsOwedAgain(tx: OwnershipReader, paymentId: string, extraRows: Prisma.PaymentRecoveryOperationWhereInput[]) {
  const operations: OwnershipRow[] = await tx.paymentRecoveryOperation.findMany({
    where: { paymentId, OR: [...SUPERSEDED_REFUND_OWED_AGAIN_WHERE, ...extraRows] },
    select: { id: true, type: true, status: true, paymentIntentId: true, paymentTransactionId: true, idempotencyKey: true, attempts: true, nextRetryAt: true },
  });
  // What each card refund row still owes, as the owed figure reads it.
  const payment = await tx.payment.findUnique({
    where: { id: paymentId },
    select: { status: true, amountCents: true, refundedAmountCents: true, ...netCollectedCardRefundSelect },
  });
  return { operations, payment };
}

/** Whether open rows owe a capture back again for at least all it still holds. */
function isOwedBackInFull(owedCents: number, capture: OwnershipCapture): boolean {
  return owedCents >= capture.amountCents - capture.refundedAmountCents;
}

/** The captures open rows owe back again for at least all each still holds. */
function owedBackInFull(
  operations: readonly OwnershipRow[],
  payment: CardRefundOwedPaymentRow | null,
  captures: readonly OwnershipCapture[],
): Set<string> {
  const owned = new Set<string>();
  for (const [intent, owedCents] of supersededRefundsOwedAgainCents(operations, payment)) {
    const capture = captures.find((each) => each.stripePaymentIntentId === intent);
    if (capture && isOwedBackInFull(owedCents, capture)) owned.add(intent);
  }
  return owned;
}

/**
 * #4285 review: of this booking's duplicate-capture refunds, the captures each
 * still holds for the member - what an admin is told is NOT another payment
 * (the guard's `readTellingWhere`). A refund operation not yet SUCCEEDED owns its
 * capture (still being sent, or dead and alerted to the treasurer), as does a
 * capture its refund left nothing in. One SUCCEEDED whose refund Stripe failed
 * later owns it only while open rows owe it back again for at least all it
 * holds - #4221's cents check, by the same rule (`refundsOwedAgainCents`). A
 * failure nothing re-sends (`not-resent`) leaves money nothing will return, so
 * that capture is told as another payment holding money. `captures` are the
 * payment's captured PRIMARY Stripe rows with net cash. Read-only.
 */
export async function listDuplicateRefundIntentIdsOwningCaptures(
  tx: OwnershipReader,
  input: { bookingId: string; paymentId: string; captures: readonly (OwnershipCapture & { id: string })[] },
): Promise<string[]> {
  const { operations, payment } = await readSupersededRefundsOwedAgain(tx, input.paymentId, [duplicateCaptureRefundOperationWhere(input.bookingId)]);
  const refunds = operations.flatMap((operation) => {
    const intent = duplicateCaptureIntentIdForRecoveryKey(input.bookingId, operation.idempotencyKey);
    return intent === null ? [] : [{ operation, intent }];
  });
  const intents = new Set(refunds.map(({ intent }) => intent));
  // Its row is on the payment's newest capture's intent, so its capture is named by the ledger row.
  const intentOfTransaction = new Map(
    input.captures.flatMap((capture) =>
      capture.stripePaymentIntentId !== null && intents.has(capture.stripePaymentIntentId) ? [[capture.id, capture.stripePaymentIntentId] as const] : [],
    ),
  );
  const owedAgain = refundsOwedAgainCents(operations, payment, { intents, intentOfTransaction });
  return [...new Set(refunds.flatMap(({ operation, intent }) => {
    const capture = input.captures.find((each) => each.stripePaymentIntentId === intent);
    const holding =
      operation.status !== PaymentRecoveryOperationStatus.SUCCEEDED || !capture || isOwedBackInFull(owedAgain.get(intent) ?? 0, capture);
    return holding ? [intent] : [];
  }))];
}

/**
 * The Xero second-instrument conflict's reading (#4177), and the
 * duplicate-capture guard's for the arriving capture (#4283): every intent id on
 * this payment whose captured money a superseded-intent operation still holds
 * for the member - a REFUND_SUPERSEDED_PAYMENT not yet SUCCEEDED, a
 * CANCEL_PAYMENT_INTENT still in flight, or (#4221) one of `captures` whose
 * superseded refund is owed back again (`supersededRefundsOwedAgainCents`)
 * for at least all it holds. A capture holding more than open rows owe back
 * holds cash nothing will return - a failed refund no row re-sends - and
 * still counts. See the module comment for why a dead cancel does not count
 * here while it does for (b′); a dead row that owes a failed refund again
 * counts, since it still owes the member. Read under lock(1).
 */
export async function listSupersededIntentIdsOwningCaptures(
  tx: OwnershipReader,
  paymentId: string,
  captures: readonly OwnershipCapture[],
): Promise<string[]> {
  return [...(await readSupersededCaptureHolds(tx, paymentId, captures)).holdsForMember];
}

/**
 * The Xero reading's set (`holdsForMember`), and for #4300 from the same read:
 * every capture open rows owe back ANY part of (`owedBackAtAll`, the settle's
 * refusal), and the saved-card charge's reading of whether a capture's money is
 * on its way back - `refundInFlight`: a superseded refund row the runner will
 * still run (`isPaymentRecoveryOperationInFlight`), or rows still running that
 * owe it back in full; `refundStopped`: a superseded refund row, or rows owing
 * it back in full, that the runner will never run again (a person must act).
 * Composed with (c′) into one payment's reading by `superseded-capture-ownership.ts`.
 */
export async function readSupersededCaptureHolds(
  tx: OwnershipReader,
  paymentId: string,
  captures: readonly OwnershipCapture[],
): Promise<{ holdsForMember: Set<string>; owedBackAtAll: Set<string>; refundInFlight: Set<string>; refundStopped: Set<string> }> {
  const { operations, payment } = await readSupersededRefundsOwedAgain(tx, paymentId, [
    { type: PaymentRecoveryOperationType.CANCEL_PAYMENT_INTENT, AND: [PAYMENT_RECOVERY_OPERATION_IN_FLIGHT_WHERE] },
  ]);
  const owned = owedBackInFull(operations, payment, captures);
  for (const operation of operations) {
    // A failed-later row counts only through `supersededRefundsOwedAgainCents`,
    // as does an open edit or cancel refund row, which no branch below matches.
    if (cardRefundFailedLaterRefundId(operation.idempotencyKey) !== null) continue;
    if (operation.type === PaymentRecoveryOperationType.CANCEL_PAYMENT_INTENT) {
      // Only an in-flight cancel is read.
      owned.add(operation.paymentIntentId);
    } else if (
      operation.type === PaymentRecoveryOperationType.REFUND_SUPERSEDED_PAYMENT &&
      operation.status !== PaymentRecoveryOperationStatus.SUCCEEDED
    ) {
      owned.add(operation.paymentIntentId);
    }
  }
  const owedBackAtAll = new Set(
    [...supersededRefundsOwedAgainCents(operations, payment)].flatMap(([intent, cents]) => (cents > 0 ? [intent] : [])),
  );
  // Fails safe toward waiting: only rows the runner will still run count as
  // returning; the superseded refund rows still name which captures are
  // superseded (a SUCCEEDED one is the refund Stripe can fail later).
  const isSupersededRefund = (row: OwnershipRow) => row.type === PaymentRecoveryOperationType.REFUND_SUPERSEDED_PAYMENT;
  const running = operations.filter((row) => isPaymentRecoveryOperationInFlight(row) || (isSupersededRefund(row) && row.status === PaymentRecoveryOperationStatus.SUCCEEDED));
  const refundInFlight = owedBackInFull(running, payment, captures);
  for (const row of operations) if (isSupersededRefund(row) && isPaymentRecoveryOperationInFlight(row)) refundInFlight.add(row.paymentIntentId);
  const refundStopped = new Set([...owedBackInFull(operations, payment, captures)].filter((intent) => !refundInFlight.has(intent)));
  for (const row of operations) {
    if (isSupersededRefund(row) && row.status !== PaymentRecoveryOperationStatus.SUCCEEDED && !refundInFlight.has(row.paymentIntentId)) refundStopped.add(row.paymentIntentId);
  }
  return { holdsForMember: owned, owedBackAtAll, refundInFlight, refundStopped };
}
