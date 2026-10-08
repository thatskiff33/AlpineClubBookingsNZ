import "server-only";

import { ManualRefundTaskKind, PaymentRecoveryOperationStatus, type Prisma } from "@prisma/client";

import { netCollectedPaymentSelect } from "@/lib/additional-ledger-gap";
import { createAuditLog } from "@/lib/audit";
import { planHandBackLine } from "@/lib/booking-ledger-credit-posting";
import { buildBookingLedgerRows, writeBookingLedgerRows } from "@/lib/booking-ledger-write";
import { bookingOwner } from "@/lib/booking-owner";
import { formatBookingReference } from "@/lib/booking-reference";
import {
  findKeptLateCaptureInvoiceIdForPayment,
  hasXeroReceiptForLateCapture,
} from "@/lib/late-capture-xero-receipt";
import logger from "@/lib/logger";
import { MANUAL_REFUND_TASK_REASON_MAX, normaliseManualPaymentNote } from "@/lib/manual-subscription-payment";
import {
  CARD_REFUND_PAID_ANOTHER_WAY_TASK_WHERE,
  cardRefundPaidAnotherWayOccurrenceKey,
  paymentRecoveryOperationIdOfPaidAnotherWay,
} from "@/lib/manual-refund-task-settlement-rules";
import {
  CARD_REFUND_OPERATION_WHERE,
  cardRefundSentAfterPaidAnotherWay,
  cardRefundSlicesByOperation,
  isOwedCardRefundOperation,
  unsentSliceCents,
} from "@/lib/open-card-refund-owed";
import { getNetCollectedCashParts } from "@/lib/payment-net-collected";
import { prisma } from "@/lib/prisma";
import { CLAIMABLE_PAYMENT_RECOVERY_STATUSES } from "@/lib/payment-recovery";
import { MAX_PAYMENT_RECOVERY_ATTEMPTS } from "@/lib/payment-recovery-constants";
import {
  isOrganiserChildRefundKey,
  lateCaptureIntentOfApprovalRefundRecoveryKey,
} from "@/lib/payment-recovery-keys";
import {
  applyLocalRefundAllocation,
  lockPaymentForRefundedTotal,
  RefundAllocationExceedsCapturedError,
  RefundAllocationRacedError,
} from "@/lib/payment-transactions";
import {
  enqueueXeroRefundCreditNoteOperation,
  kickQueuedXeroOutboxOperationsIfConnected,
} from "@/lib/xero-operation-outbox";

/**
 * #3372 (owner, 7 Oct 2026: "Count + add close action"; 8 Oct 2026: "Keep it
 * together"): A DEAD CARD REFUND, CLOSED AS PAID ANOTHER WAY (`INV-PAY-120`).
 *
 * A card refund operation whose retries are spent stays owed - in "Refunds
 * owed" and off Net Collected (`openCardRefundOwedCents`) - until the treasurer
 * says the member was paid back another way, for example by bank transfer.
 * This is that close. It is the card refund's equivalent of completing a
 * by-hand hand-back (`resolveManualRefundTask`, local-allocation route), and
 * records the money the same way.
 *
 * - THE TERMINAL STATE IS THE EXISTING ONE. The operation moves to `SUCCEEDED`,
 *   the status every reader already takes as "nothing more to send"; no new
 *   enum value. `lastError` carries `PAID_ANOTHER_WAY_MARKER` for a person
 *   reading the row; NOTHING parses it - the persisted record is the task
 *   below. `nextRetryAt` is cleared, so no claim can take it again.
 * - DEAD MEANS THE RECOVERY MODULE'S DEAD (#3220): a status the worker would
 *   claim with no attempts left (`deadCardRefundOperationWhere`). The close is a
 *   status-guarded `updateMany` on exactly that, so a retry, a second click or a
 *   second treasurer loses the claim and nothing else is written.
 * - THE MONEY: `applyLocalRefundAllocation`, as a by-hand hand-back records it,
 *   placed first on the charges the card refund still had to send (its unsent
 *   slices, `cardRefundSlicesByOperation`). It raises `refundedAmountCents`, so
 *   the payment's refunded total says the money went back. No Stripe call: the
 *   card refund is over.
 * - FULL OR PART, SAID EXPLICITLY (owner, 8 Oct 2026: "Difference is gone",
 *   and "need a way for Treasurer to mark a partial versus only a full
 *   payment"). The treasurer chooses `paidBack`: "full" closes for exactly what
 *   is still owed; "partial" for more than nothing and less than that. The
 *   choice is never inferred from the amount. A part close is final: what was
 *   not paid back stops being owed anywhere - "Refunds owed", Net Collected,
 *   this list, and a later review's netting, which counts the refund at its
 *   full raised amount (`edit-financial-review-cancel-netting.ts`).
 * - A SUPERSEDED INTENT'S REFUND closes in full only, on its own transaction,
 *   only while what it owes IS what that transaction still holds, never capped
 *   and never for nothing (#3924 round 5, F3): the reconciliation reads a
 *   closed one as that transaction refunded (`payment-reconciliation.ts`,
 *   predicate (b)).
 * - THE RECORD (#3924 round 4, M2): a `ManualRefundTask` born COMPLETED, of the
 *   hand-back kind, under `cardRefundPaidAnotherWayOccurrenceKey`, for the
 *   amount paid back - `raisedAmountCents` keeps what was still owed when it
 *   closed, and its reason says full or part - and the booking ledger's
 *   `BANK_REFUND` line anchored on it (`planHandBackLine`), keyed on the task.
 *   The census then explains the raised refunded total as a hand-back
 *   (`REFUND_MIRROR_HAND_BACK`), and the Xero cash evidence reads this row, not
 *   the wording above, to tell the bank transfer from a card refund
 *   (`readPaidAnotherWayCash`). It is never OPEN, so no queue, count or
 *   reopen sees it (`isCardRefundPaidAnotherWayTask`). The line is posted on a
 *   card payment, which `postHandBackLedgerLine` refuses: there the card refund
 *   posts from its refund row, and here there is none (`INV-MONEY-035`).
 * - XERO (#3924 round 4, M3; round 5, owner 8 Oct 2026: "Raise a refund note
 *   for all"): EVERY kind of card refund takes a refund note worded as a bank
 *   transfer (`INV-PAY-101`) - a cancellation's, an approved refund request's,
 *   an edit's or an edit review's, a late capture's and a superseded intent's.
 *   It is queued on this transaction for exactly the amount paid back and keyed
 *   on the record (`paidAnotherWayTaskId`), so it is sized on its own beside any
 *   card note. Each needs an invoice to credit (`paidAnotherWayNoteInvoice`,
 *   F4). With none, no note is queued: the dialog says so before the close, and
 *   the record's key says so after it, for the cash evidence.
 * - NOT HERE: an organiser child's refund (#3653) comes out of the organiser's
 *   combined card payment, which the child's payment has no ledger rows for; a
 *   group organiser-cancel settlement's refund is not owed on the payment it
 *   hangs on (`isOwedCardRefundOperation`). Both are refused.
 *
 * LOCKS (`INV-LOCK-001`): the global key first - it moves a payment's refunded
 * total and closes a refund debt, which every edit, acceptance, paid cancel and
 * refund appeal reads separately to size a refund net of what is promised back
 * - then the operation is re-read, then the PAYMENT ROW
 * (`lockPaymentForRefundedTotal`, #3924 round 4, C1) BEFORE the payment is read,
 * so the owed figure the close is checked against cannot move under it: every
 * refunded-total writer without lock(1) - every Stripe refund recorder, and a
 * cancellation hand-back's completion - takes the Payment row first. Then the
 * claim, the allocation (which re-takes the row it holds), the record and the
 * line. No provider call runs under them; the Xero note is an outbox row,
 * kicked after the commit.
 */

/** What `lastError` says on an operation closed here, for a person reading the row. Nothing parses it. */
export const PAID_ANOTHER_WAY_MARKER = "Closed by the treasurer: paid another way (#3372)";

/** The card refund operations the worker will never claim again. */
export const deadCardRefundOperationWhere = {
  ...CARD_REFUND_OPERATION_WHERE,
  status: { in: [...CLAIMABLE_PAYMENT_RECOVERY_STATUSES] },
  attempts: { gte: MAX_PAYMENT_RECOVERY_ATTEMPTS },
} satisfies Prisma.PaymentRecoveryOperationWhereInput;

/** A refusal with the status the route answers. Thrown before or inside the transaction, so nothing commits. */
export class CardRefundPaidAnotherWayError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409,
  ) {
    super(message);
    this.name = "CardRefundPaidAnotherWayError";
  }
}

const OPERATION_SELECT = {
  id: true,
  type: true,
  status: true,
  attempts: true,
  idempotencyKey: true,
  bookingId: true,
  paymentId: true,
  paymentTransactionId: true,
  allocationPlan: true,
  amountCents: true,
  createdAt: true,
  lastError: true,
} as const satisfies Prisma.PaymentRecoveryOperationSelect;

const PAYMENT_SELECT = {
  id: true,
  xeroInvoiceId: true,
  ...netCollectedPaymentSelect,
} as const satisfies Prisma.PaymentSelect;

type ClosablePayment = Prisma.PaymentGetPayload<{ select: typeof PAYMENT_SELECT }>;

/** What one dead card refund still has to send: its own unsent slices, and what the figures say is owed. */
interface StillOwed {
  /** Its own unsent slices, before any cap. */
  ownCents: number;
  /** `ownCents` capped at the card refund part Net Collected takes off its payment: the most a close may record. */
  owedCents: number;
  /** The transactions its unsent slices are on, in its plan's order. */
  unsentTransactionIds: string[];
}

/**
 * What one dead card refund still owes, in cents: its own unsent slices
 * (`cardRefundSlicesByOperation`), capped at the card refund part Net
 * Collected takes off its payment, so the close can never record more than the
 * figures say is owed.
 */
function stillOwed(payment: ClosablePayment, operationId: string): StillOwed {
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
  };
}

type NoteInvoiceStore = Pick<Prisma.TransactionClient, "manualRefundTask" | "xeroObjectLink" | "xeroSyncOperation">;

/**
 * #3924 round 5 (F4; owner, 8 Oct 2026: "Raise a refund note for all"): WHETHER
 * A CLOSE OF THIS CARD REFUND HAS AN INVOICE ITS XERO REFUND NOTE CAN CREDIT -
 * the one the note executor names (`createXeroCreditNote`), so the dialog never
 * promises a note that will fail:
 *
 * - a treasurer-approved late capture's refund: the capture's own receipt, only
 *   once the app recorded it (`hasXeroReceiptForLateCapture`, `INV-PAY-110`).
 *   Without one Xero never took that money in, so there is nothing to credit -
 *   never the booking's cleared pre-cancel invoice;
 * - any other: the payment's kept late-capture invoice, else its own invoice
 *   (`findKeptLateCaptureInvoiceIdForPayment` ?? `payment.xeroInvoiceId`).
 *
 * STATED LIMIT: a payment whose invoice is still on its way to Xero reads as
 * having none, and its close queues no note; the toast says to check Xero.
 */
async function paidAnotherWayNoteInvoice(
  db: NoteInvoiceStore,
  operation: { idempotencyKey: string },
  payment: { id: string; xeroInvoiceId: string | null },
): Promise<boolean> {
  const lateCaptureIntent = lateCaptureIntentOfApprovalRefundRecoveryKey(operation.idempotencyKey);
  if (lateCaptureIntent !== null) return hasXeroReceiptForLateCapture(lateCaptureIntent, db);
  if (payment.xeroInvoiceId !== null) return true;
  return (await findKeptLateCaptureInvoiceIdForPayment(payment.id, db)) !== null;
}

export interface DeadCardRefundRow {
  operationId: string;
  bookingId: string;
  bookingReference: string;
  /** When the refund was started (ISO instant). */
  raisedAt: string;
  /** What it still owes, which a full close is for. */
  owedCents: number;
  /** A superseded intent's refund closes only for the whole of what it owes. */
  wholeAmountOnly: boolean;
  /** Whether a close queues a Xero refund note: there is an invoice to credit (`paidAnotherWayNoteInvoice`). */
  takesXeroRefundNote: boolean;
  /** Its last failure looked like a timeout or a network error, so Stripe may have refunded after all. */
  stripeMayHaveRefunded: boolean;
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
 */
export function lastErrorSuggestsStripeMayHaveRefunded(lastError: string | null): boolean {
  if (!lastError) return false;
  return /time[- ]?out|timed out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|socket hang up|network|connection (?:error|reset|closed|refused)|StripeConnectionError|StripeAPIError|status(?:Code)?\D{0,3}5\d\d\b|has already been refunded|greater than (?:the )?unrefunded amount/i.test(
    lastError,
  );
}

/**
 * The dead card refunds the treasurer can close, oldest first, with what each
 * still owes. Organiser child refunds and group settlement refunds are left
 * out, as the close refuses them.
 */
export async function listDeadCardRefunds(): Promise<DeadCardRefundRow[]> {
  const operations = await prisma.paymentRecoveryOperation.findMany({
    where: deadCardRefundOperationWhere,
    orderBy: { createdAt: "asc" },
    select: { ...OPERATION_SELECT, payment: { select: PAYMENT_SELECT } },
  });
  const closable = operations.filter(
    (operation) => isOwedCardRefundOperation(operation) && !isOrganiserChildRefundKey(operation.idempotencyKey),
  );
  return Promise.all(
    closable.map(async (operation) => ({
      operationId: operation.id,
      bookingId: operation.bookingId,
      bookingReference: formatBookingReference(operation.bookingId),
      raisedAt: operation.createdAt.toISOString(),
      owedCents: stillOwed(operation.payment, operation.id).owedCents,
      wholeAmountOnly: operation.type === "REFUND_SUPERSEDED_PAYMENT",
      takesXeroRefundNote: await paidAnotherWayNoteInvoice(prisma, operation, operation.payment),
      stripeMayHaveRefunded: lastErrorSuggestsStripeMayHaveRefunded(operation.lastError),
    })),
  );
}

/** A card refund closed as paid another way that Stripe then paid as well. */
export interface CardRefundPaidTwiceRow {
  operationId: string;
  bookingId: string;
  bookingReference: string;
  /** When the treasurer closed it (ISO instant). */
  closedAt: string;
  /** What the close recorded as paid back another way. */
  paidAnotherWayCents: number;
  /** What Stripe refunded to the card for it after the close. */
  refundedByCardCents: number;
}

/**
 * #3924 round 5 (concurrency F2): the card refunds the treasurer closed as paid
 * another way that Stripe ALSO refunded - a refund Stripe made before the close
 * (its answer lost to a timeout) that reached the app after it. The member has
 * that money twice; the stuck-states page lists each so the treasurer can
 * recover it. Read from the close's record and the payment's own refund rows
 * (`cardRefundSentAfterPaidAnotherWay`), oldest close first.
 *
 * STATED LIMIT: it reads every close ever made, which stays small - a close is
 * the treasurer's hand on a refund Stripe gave up on.
 */
export async function listCardRefundsPaidTwice(): Promise<CardRefundPaidTwiceRow[]> {
  const records = await prisma.manualRefundTask.findMany({
    where: CARD_REFUND_PAID_ANOTHER_WAY_TASK_WHERE,
    orderBy: { completedAt: "asc" },
    select: {
      kind: true,
      occurrenceKey: true,
      bookingId: true,
      amountCents: true,
      completedAt: true,
      payment: { select: PAYMENT_SELECT },
    },
  });
  const rows: CardRefundPaidTwiceRow[] = [];
  for (const record of records) {
    const operationId = paymentRecoveryOperationIdOfPaidAnotherWay(record);
    if (operationId === null || record.payment === null) continue;
    const refundedByCardCents =
      cardRefundSentAfterPaidAnotherWay(record.payment, new Set([operationId])).get(operationId) ?? 0;
    if (refundedByCardCents <= 0) continue;
    rows.push({
      operationId,
      bookingId: record.bookingId,
      bookingReference: formatBookingReference(record.bookingId),
      closedAt: (record.completedAt ?? new Date(0)).toISOString(),
      paidAnotherWayCents: record.amountCents ?? 0,
      refundedByCardCents,
    });
  }
  return rows;
}

/** How much the treasurer says was paid back (owner, 8 Oct 2026): chosen, never inferred from the amount. */
export type PaidBackChoice = "full" | "partial";

export interface CardRefundPaidAnotherWayInput {
  operationId: string;
  /** What the treasurer paid back, in cents: exactly what is owed for "full", less than it for "partial". */
  amountCents: number;
  /** Paid back in full, or in part with the rest no longer owed - the treasurer's explicit choice. */
  paidBack: PaidBackChoice;
  /** How it was paid. Required. */
  note: string | null | undefined;
  actingMemberId: string;
}

export interface CardRefundPaidAnotherWayResult {
  operationId: string;
  bookingId: string;
  paymentId: string;
  amountCents: number;
  owedCents: number;
  paidBack: PaidBackChoice;
  /** Whether a Xero refund credit note was queued for this close. */
  xeroRefundNoteQueued: boolean;
}

/**
 * The full-or-part rule (owner, 8 Oct 2026), against what is still owed:
 * "full" is exactly that; "partial" is more than nothing and less than that.
 * A refusal is a 400: the request does not say a consistent thing.
 */
function assertPaidBackChoice(paidBack: PaidBackChoice, amountCents: number, owedCents: number): void {
  if (paidBack === "full" && amountCents !== owedCents) {
    throw new CardRefundPaidAnotherWayError(
      "Paid back in full must be exactly what is still owed. Refresh and check the amount.",
      400,
    );
  }
  if (paidBack === "partial" && !(amountCents > 0 && amountCents < owedCents)) {
    throw new CardRefundPaidAnotherWayError(
      "Paid back part of it must be more than nothing and less than what is still owed.",
      400,
    );
  }
}

/** The record's reason: what happened, and whether the rest stopped being owed. */
function paidAnotherWayReason(bookingId: string, paidBack: PaidBackChoice): string {
  const how =
    paidBack === "full"
      ? "was paid back in full another way by the treasurer"
      : "was paid back in part another way by the treasurer; the rest is no longer owed";
  return `A card refund on booking ${formatBookingReference(bookingId)} that Stripe gave up on ${how} (#3372).`.slice(
    0,
    MANUAL_REFUND_TASK_REASON_MAX,
  );
}

/**
 * A superseded intent's refund closes only while what it owes is exactly what
 * its transaction still holds, so the whole of it lands there and the
 * transaction reads fully refunded (#3924 round 4, M7). Anything else is a
 * state the close cannot make true; a developer reconciles it.
 */
async function assertSupersededCloseFillsItsTransaction(
  tx: Prisma.TransactionClient,
  operation: { paymentTransactionId: string | null; paymentId: string },
  ownCents: number,
): Promise<void> {
  const transaction = operation.paymentTransactionId
    ? await tx.paymentTransaction.findUnique({
        where: { id: operation.paymentTransactionId },
        select: { paymentId: true, amountCents: true, refundedAmountCents: true },
      })
    : null;
  const remainingCents = transaction ? transaction.amountCents - transaction.refundedAmountCents : null;
  if (!transaction || transaction.paymentId !== operation.paymentId || remainingCents !== ownCents) {
    throw new CardRefundPaidAnotherWayError(
      "This superseded payment's refund no longer matches what its charge still holds, so it cannot be closed here. Ask a developer to reconcile it.",
      409,
    );
  }
}

/**
 * Post the booking ledger's line for the money paid back, on the record. Built
 * in pure code, caught and logged, so a planning fault leaves the close
 * standing and the gap for the census to report; written unwrapped, as
 * `postHandBackLedgerLine` writes. Keyed on the record, so a replay posts nothing.
 */
async function postPaidAnotherWayLine(
  tx: Prisma.TransactionClient,
  input: { bookingId: string; lodgeId: string; taskId: string; amountCents: number; officerMemberId: string },
): Promise<void> {
  let rows: ReturnType<typeof buildBookingLedgerRows> = [];
  try {
    rows = buildBookingLedgerRows([
      planHandBackLine({
        bookingId: input.bookingId,
        lodgeId: input.lodgeId,
        manualRefundTaskId: input.taskId,
        amountCents: input.amountCents,
        settlementMethod: "INTERNET_BANKING",
        officerMemberId: input.officerMemberId,
      }),
    ]);
  } catch (error) {
    logger.error(
      { err: error, bookingId: input.bookingId, manualRefundTaskId: input.taskId },
      "Booking ledger: could not build the paid-another-way line; the close stands and the gap is the census's to report (#3924)",
    );
    return;
  }
  await writeBookingLedgerRows(tx, rows);
}

/** Close one dead card refund as paid another way. See the module comment. */
export async function closeCardRefundPaidAnotherWay(
  input: CardRefundPaidAnotherWayInput,
): Promise<CardRefundPaidAnotherWayResult> {
  const note = normaliseManualPaymentNote(input.note);
  if (!note) {
    throw new CardRefundPaidAnotherWayError("Say how the member was paid back - a note is required.", 400);
  }
  if (!Number.isSafeInteger(input.amountCents) || input.amountCents < 0) {
    throw new CardRefundPaidAnotherWayError("The amount paid back must be whole cents, not below nil.", 400);
  }
  if (input.paidBack !== "full" && input.paidBack !== "partial") {
    throw new CardRefundPaidAnotherWayError("Say whether it was paid back in full or in part.", 400);
  }

  const result = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
    const operation = await tx.paymentRecoveryOperation.findUnique({
      where: { id: input.operationId },
      select: OPERATION_SELECT,
    });
    if (!operation) throw new CardRefundPaidAnotherWayError("Card refund not found.", 404);
    if (!isOwedCardRefundOperation(operation)) {
      throw new CardRefundPaidAnotherWayError("This is not a card refund that can be closed here.", 409);
    }
    if (isOrganiserChildRefundKey(operation.idempotencyKey)) {
      throw new CardRefundPaidAnotherWayError(
        "This refund comes out of the group organiser's card payment, so it cannot be closed here. Ask a developer to reconcile it.",
        409,
      );
    }
    const dead =
      (CLAIMABLE_PAYMENT_RECOVERY_STATUSES as readonly string[]).includes(operation.status) &&
      operation.attempts >= MAX_PAYMENT_RECOVERY_ATTEMPTS;
    if (!dead) {
      throw new CardRefundPaidAnotherWayError(
        operation.status === PaymentRecoveryOperationStatus.SUCCEEDED
          ? "This card refund has already been closed."
          : "This card refund is still being retried, so it cannot be closed yet.",
        409,
      );
    }

    // C1: the payment row before the payment is read - `lock(1)`, then this.
    await lockPaymentForRefundedTotal(tx, operation.paymentId);
    const payment = await tx.payment.findUnique({ where: { id: operation.paymentId }, select: PAYMENT_SELECT });
    if (!payment) throw new CardRefundPaidAnotherWayError("Card refund not found.", 404);
    const booking = await tx.booking.findUnique({
      where: { id: payment.bookingId },
      select: { id: true, lodgeId: true, memberId: true },
    });
    // The record and its line are read by the booking (the census loads both
    // by it), so they go on the payment's booking, which must be the operation's.
    if (!booking || booking.id !== operation.bookingId) {
      throw new CardRefundPaidAnotherWayError(
        "This card refund's payment belongs to another booking, so it cannot be closed here. Ask a developer to reconcile it.",
        409,
      );
    }
    const { ownCents, owedCents, unsentTransactionIds } = stillOwed(payment, operation.id);
    if (input.amountCents > owedCents) {
      throw new CardRefundPaidAnotherWayError(
        "That is more than this refund still owes. Refresh and check the amount.",
        409,
      );
    }
    assertPaidBackChoice(input.paidBack, input.amountCents, owedCents);
    if (operation.type === "REFUND_SUPERSEDED_PAYMENT") {
      if (input.paidBack !== "full") {
        throw new CardRefundPaidAnotherWayError(
          "A superseded payment's refund closes only for the whole of what it still owes.",
          400,
        );
      }
      // F3: never capped below its own unsent amount, and never for nothing -
      // either would read the transaction refunded when it is not.
      if (ownCents === 0 || owedCents !== ownCents) {
        throw new CardRefundPaidAnotherWayError(
          "This superseded payment's refund no longer matches what its payment still holds, so it cannot be closed here. Ask a developer to reconcile it.",
          409,
        );
      }
      await assertSupersededCloseFillsItsTransaction(tx, operation, ownCents);
    }
    // F4: decided before the record, whose key carries the answer.
    const takesXeroRefundNote =
      input.amountCents > 0 && (await paidAnotherWayNoteInvoice(tx, operation, payment));

    const closedAt = new Date();
    const claimed = await tx.paymentRecoveryOperation.updateMany({
      where: { id: operation.id, ...deadCardRefundOperationWhere },
      data: {
        status: PaymentRecoveryOperationStatus.SUCCEEDED,
        succeededAt: closedAt,
        nextRetryAt: null,
        processingStartedAt: null,
        lastError: PAID_ANOTHER_WAY_MARKER,
      },
    });
    if (claimed.count === 0) {
      throw new CardRefundPaidAnotherWayError(
        "This card refund changed while you were closing it - refresh and try again.",
        409,
      );
    }

    // The money moves only after the claim, so a lost claim moves nothing.
    let xeroRefundNoteQueued = false;
    let recordId: string | null = null;
    if (input.amountCents > 0) {
      try {
        await applyLocalRefundAllocation({
          paymentId: payment.id,
          amountCents: input.amountCents,
          preferTransactionIds: unsentTransactionIds,
          store: tx,
        });
      } catch (error) {
        // C3: only the allocation's two refusals are the operator's to act on;
        // anything else is a fault, for the route's 500.
        if (error instanceof RefundAllocationRacedError || error instanceof RefundAllocationExceedsCapturedError) {
          logger.warn({ err: error, operationId: operation.id }, "Paid-another-way close refused by the refund allocation");
          throw new CardRefundPaidAnotherWayError(
            error instanceof RefundAllocationRacedError
              ? "This payment's refunds changed while you were closing it - refresh and try again."
              : "The payment no longer holds that much to refund. Refresh and check the amount.",
            409,
          );
        }
        throw error;
      }

      const record = await tx.manualRefundTask.create({
        data: {
          bookingId: booking.id,
          paymentId: payment.id,
          kind: ManualRefundTaskKind.CANCELLED_BOOKING_HAND_BACK,
          occurrenceKey: cardRefundPaidAnotherWayOccurrenceKey(operation.id, { xeroRefundNote: takesXeroRefundNote }),
          amountCents: input.amountCents,
          raisedAmountCents: owedCents,
          status: "COMPLETED",
          completedAt: closedAt,
          completedByMemberId: input.actingMemberId,
          note,
          reason: paidAnotherWayReason(booking.id, input.paidBack),
        },
        select: { id: true },
      });
      recordId = record.id;
      await postPaidAnotherWayLine(tx, {
        bookingId: booking.id,
        lodgeId: booking.lodgeId,
        taskId: record.id,
        amountCents: input.amountCents,
        officerMemberId: input.actingMemberId,
      });

      // M3 / round 5: every kind with an invoice to credit, sized on its own
      // (the record is already in this transaction, so the cash evidence counts it).
      if (takesXeroRefundNote) {
        const queued = await enqueueXeroRefundCreditNoteOperation(payment.id, input.amountCents, {
          createdByMemberId: input.actingMemberId,
          refundMethod: "internet-banking",
          paidAnotherWayTaskId: record.id,
          store: tx,
        });
        xeroRefundNoteQueued = queued.queueOperationId !== null;
      }
    }

    await createAuditLog(
      {
        action: "booking-payment.card-refund.paid-another-way",
        memberId: input.actingMemberId,
        actorMemberId: input.actingMemberId,
        subjectMemberId: bookingOwner(booking).memberId,
        targetId: operation.bookingId,
        entityType: "PaymentRecoveryOperation",
        entityId: operation.id,
        category: "payment",
        severity: "important",
        outcome: "success",
        summary:
          input.paidBack === "full"
            ? "Card refund Stripe gave up on closed as paid back in full another way"
            : "Card refund Stripe gave up on closed as paid back in part another way; the rest is no longer owed",
        details: note,
        metadata: {
          operationId: operation.id,
          bookingId: operation.bookingId,
          paymentId: payment.id,
          operationType: operation.type,
          paidBack: input.paidBack,
          amountCents: input.amountCents,
          owedCents,
          noLongerOwedCents: owedCents - input.amountCents,
          manualRefundTaskId: recordId,
          xeroRefundNoteQueued,
        },
      },
      tx,
    );

    return {
      operationId: operation.id,
      bookingId: operation.bookingId,
      paymentId: payment.id,
      amountCents: input.amountCents,
      owedCents,
      paidBack: input.paidBack,
      xeroRefundNoteQueued,
    };
  });

  if (result.xeroRefundNoteQueued) {
    // The note's row committed with the close: only the kick is left.
    await kickQueuedXeroOutboxOperationsIfConnected({ limit: 1 }).catch((error: unknown) =>
      logger.error({ err: error, operationId: result.operationId }, "Failed to kick the Xero outbox after a paid-another-way close"),
    );
  }
  return result;
}
