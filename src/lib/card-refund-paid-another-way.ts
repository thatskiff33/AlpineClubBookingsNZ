import "server-only";

import { ManualRefundTaskKind, PaymentRecoveryOperationStatus, type Prisma } from "@prisma/client";

import { netCollectedPaymentSelect } from "@/lib/additional-ledger-gap";
import { createAuditLog } from "@/lib/audit";
import { planHandBackLine } from "@/lib/booking-ledger-credit-posting";
import { buildBookingLedgerRows, writeBookingLedgerRows } from "@/lib/booking-ledger-write";
import { bookingOwner } from "@/lib/booking-owner";
import { formatBookingReference } from "@/lib/booking-reference";
import { takesPaidAnotherWayRefundNote } from "@/lib/card-refund-paid-another-way-cash";
import logger from "@/lib/logger";
import { MANUAL_REFUND_TASK_REASON_MAX, normaliseManualPaymentNote } from "@/lib/manual-subscription-payment";
import { cardRefundPaidAnotherWayOccurrenceKey } from "@/lib/manual-refund-task-settlement-rules";
import {
  CARD_REFUND_OPERATION_WHERE,
  cardRefundSlicesByOperation,
  isOwedCardRefundOperation,
  unsentSliceCents,
} from "@/lib/open-card-refund-owed";
import { getNetCollectedCashParts } from "@/lib/payment-net-collected";
import { prisma } from "@/lib/prisma";
import { CLAIMABLE_PAYMENT_RECOVERY_STATUSES } from "@/lib/payment-recovery";
import { MAX_PAYMENT_RECOVERY_ATTEMPTS } from "@/lib/payment-recovery-constants";
import { isOrganiserChildRefundKey } from "@/lib/payment-recovery-keys";
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
 * together"): A DEAD CARD REFUND, CLOSED AS PAID ANOTHER WAY (`INV-PAY-119`).
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
 *   card refund is over. A superseded intent's refund must close for its whole
 *   amount, on its own transaction, and only while what it owes IS what that
 *   transaction still holds: the reconciliation reads a closed one as that
 *   transaction refunded (`payment-reconciliation.ts`, predicate (b)).
 * - A PARTIAL CLOSE ENDS THE REFUND. What was not paid back stops being owed
 *   anywhere - "Refunds owed", Net Collected, this list. The dialog says so.
 * - THE RECORD (#3924 round 4, M2): a `ManualRefundTask` born COMPLETED, of the
 *   hand-back kind, under `cardRefundPaidAnotherWayOccurrenceKey` (unique, so a
 *   replay writes nothing), for the amount paid back - `raisedAmountCents`
 *   keeps what was still owed when it closed - and the booking ledger's
 *   `BANK_REFUND` line anchored on it (`planHandBackLine`), keyed on the task.
 *   The census then explains the raised refunded total as a hand-back
 *   (`REFUND_MIRROR_HAND_BACK`), and the Xero cash evidence reads this row, not
 *   the wording above, to tell the bank transfer from a card refund
 *   (`readPaidAnotherWayCash`). It is never OPEN, so no queue, count or
 *   reopen sees it (`isCardRefundPaidAnotherWayTask`). The line is posted on a
 *   card payment, which `postHandBackLedgerLine` refuses: there the card refund
 *   posts from its refund row, and here there is none (`INV-MONEY-035`).
 * - XERO (#3924 round 4, M3): a cancellation's card refund takes the note its
 *   card refund would have raised, worded as a bank transfer (`INV-PAY-101`),
 *   queued on this transaction for exactly the amount paid back and keyed on
 *   the record (`paidAnotherWayTaskId`), so it is sized on its own beside any
 *   card note. Every other close queues none: an edit's refund was credited on
 *   the invoice by the edit's own note, as an edit's hand-back is
 *   (`INV-PAY-117`). `takesPaidAnotherWayRefundNote` is the one rule, read by
 *   the cash evidence too.
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
 * so the owed figure the close is checked against cannot move under it: the
 * `charge.refunded` sync and a hand-back's completion take no global key but do
 * take that row. Then the claim, the allocation (which re-takes the row it
 * holds), the record and the line. No provider call runs under them; the Xero
 * note is an outbox row, kicked after the commit.
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

export interface DeadCardRefundRow {
  operationId: string;
  bookingId: string;
  bookingReference: string;
  /** When the refund was started (ISO instant). */
  raisedAt: string;
  /** What it still owes, which the close defaults to. */
  owedCents: number;
  /** A superseded intent's refund closes only for the whole of what it owes. */
  wholeAmountOnly: boolean;
  /** Whether a close queues a Xero refund note (a cancellation's card refund). */
  takesXeroRefundNote: boolean;
  /** Its last failure looked like a timeout or a network error, so Stripe may have refunded after all. */
  stripeMayHaveRefunded: boolean;
}

/**
 * #3924 round 4 (M7): whether a refund's last failure looks like a timeout or a
 * network error - the failures where the request may have reached Stripe and
 * the refund gone through with its answer lost. The panel then tells the
 * treasurer to check the Stripe dashboard before paying the member again. A
 * hint only: it reads the worker's wording, and decides nothing.
 */
export function lastErrorSuggestsStripeMayHaveRefunded(lastError: string | null): boolean {
  if (!lastError) return false;
  return /time[- ]?out|timed out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|socket hang up|network|connection (?:error|reset|closed|refused)|StripeConnectionError|StripeAPIError|\b5\d\d\b/i.test(
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
  return operations
    .filter((operation) => isOwedCardRefundOperation(operation) && !isOrganiserChildRefundKey(operation.idempotencyKey))
    .map((operation) => ({
      operationId: operation.id,
      bookingId: operation.bookingId,
      bookingReference: formatBookingReference(operation.bookingId),
      raisedAt: operation.createdAt.toISOString(),
      owedCents: stillOwed(operation.payment, operation.id).owedCents,
      wholeAmountOnly: operation.type === "REFUND_SUPERSEDED_PAYMENT",
      takesXeroRefundNote: takesPaidAnotherWayRefundNote(operation),
      stripeMayHaveRefunded: lastErrorSuggestsStripeMayHaveRefunded(operation.lastError),
    }));
}

export interface CardRefundPaidAnotherWayInput {
  operationId: string;
  /** What the treasurer paid back, in cents: at most what is owed, and all of it on a superseded intent's refund. */
  amountCents: number;
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
  /** Whether a Xero refund credit note was queued for this close (a cancellation's refund, with an amount). */
  xeroRefundNoteQueued: boolean;
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
    if (owedCents > 0 && input.amountCents === 0) {
      throw new CardRefundPaidAnotherWayError("Enter the amount the member was paid back.", 400);
    }
    if (operation.type === "REFUND_SUPERSEDED_PAYMENT") {
      if (input.amountCents !== owedCents) {
        throw new CardRefundPaidAnotherWayError(
          "A superseded payment's refund closes only for the whole of what it still owes.",
          400,
        );
      }
      if (input.amountCents > 0) await assertSupersededCloseFillsItsTransaction(tx, operation, ownCents);
    }

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
          occurrenceKey: cardRefundPaidAnotherWayOccurrenceKey(operation.id),
          amountCents: input.amountCents,
          raisedAmountCents: owedCents,
          status: "COMPLETED",
          completedAt: closedAt,
          completedByMemberId: input.actingMemberId,
          note,
          reason:
            `A card refund on booking ${formatBookingReference(booking.id)} that Stripe gave up on was paid back another way by the treasurer (#3372).`.slice(
              0,
              MANUAL_REFUND_TASK_REASON_MAX,
            ),
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

      // M3: a cancellation's card refund only, sized on its own (the record is
      // already in this transaction, so the cash evidence counts it).
      if (takesPaidAnotherWayRefundNote(operation)) {
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
        summary: "Card refund Stripe gave up on closed as paid another way",
        details: note,
        metadata: {
          operationId: operation.id,
          bookingId: operation.bookingId,
          paymentId: payment.id,
          operationType: operation.type,
          amountCents: input.amountCents,
          owedCents,
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
