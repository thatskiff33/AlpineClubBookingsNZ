import "server-only";

import { PaymentRecoveryOperationStatus, type Prisma } from "@prisma/client";

import { netCollectedPaymentSelect } from "@/lib/additional-ledger-gap";
import { createAuditLog } from "@/lib/audit";
import { bookingOwner } from "@/lib/booking-owner";
import { formatBookingReference } from "@/lib/booking-reference";
import logger from "@/lib/logger";
import { normaliseManualPaymentNote } from "@/lib/manual-subscription-payment";
import {
  CARD_REFUND_OPERATION_WHERE,
  isOwedCardRefundOperation,
  openCardRefundOwedByOperation,
  parseRefundAllocationPlan,
} from "@/lib/open-card-refund-owed";
import { getNetCollectedCashParts } from "@/lib/payment-net-collected";
import { prisma } from "@/lib/prisma";
import { CLAIMABLE_PAYMENT_RECOVERY_STATUSES } from "@/lib/payment-recovery";
import { MAX_PAYMENT_RECOVERY_ATTEMPTS } from "@/lib/payment-recovery-constants";
import {
  buildBookingCancellationRefundIdempotencyKey,
  isOrganiserChildRefundKey,
} from "@/lib/payment-recovery-keys";
import {
  applyLocalRefundAllocation,
  RefundAllocationRacedError,
} from "@/lib/payment-transactions";
import {
  enqueueXeroRefundCreditNoteOperation,
  kickQueuedXeroOutboxOperationsIfConnected,
} from "@/lib/xero-operation-outbox";

/**
 * #3372 (owner, 7 Oct 2026: "Count + add close action"): A DEAD CARD REFUND,
 * CLOSED AS PAID ANOTHER WAY.
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
 *   enum value. `lastError` carries `PAID_ANOTHER_WAY_MARKER`, the one thing
 *   that tells this close from Stripe's (nothing parses it; the audit row is
 *   the record), and `nextRetryAt` is cleared, so no claim can take it again.
 * - DEAD MEANS THE RECOVERY MODULE'S DEAD (#3220): a status the worker would
 *   claim with no attempts left (`deadCardRefundOperationWhere`). The close is a
 *   status-guarded `updateMany` on exactly that, so a retry, a second click or a
 *   second treasurer loses the claim and nothing else is written.
 * - THE MONEY: `applyLocalRefundAllocation`, as a by-hand hand-back records it,
 *   placed first on the charges the card refund was meant to come off. It
 *   raises `refundedAmountCents`, so the payment's refunded total says the money
 *   went back. No Stripe call: the card refund is over. A superseded intent's
 *   refund must close for its whole amount, on its own transaction, because the
 *   reconciliation reads a closed one as that transaction refunded
 *   (`payment-reconciliation.ts`, predicate (b)).
 * - XERO, MIRRORED FROM THE HAND-BACK, AND ONLY WHERE THE HAND-BACK POSTS: a
 *   cancellation's card refund takes the refund credit note a cancellation's
 *   bank-transfer hand-back takes (`queueCancelledBookingHandBackNoteInTransaction`:
 *   `enqueueXeroRefundCreditNoteOperation`, "internet-banking", on this
 *   transaction), where the payment has its invoice. Every other card refund
 *   queues nothing here, as the worker's own success queues nothing; whatever
 *   note the refunded total still lacks is the existing credit-note self-heal's
 *   (`getRefundsMissingXeroCreditNotes`), exactly as after a card refund.
 * - NOT HERE: an organiser child's refund (#3653) comes out of the organiser's
 *   combined card payment, which the child's payment has no ledger rows for; a
 *   group organiser-cancel settlement's refund is not owed on the payment it
 *   hangs on (`isOwedCardRefundOperation`). Both are refused.
 *
 * Under the global key (`INV-LOCK-001`): it moves a payment's refunded total
 * and closes a refund debt, which every edit, acceptance, paid cancel and
 * refund appeal reads separately to size a refund net of what is promised back.
 * It is taken first, then the operation and payment are re-read, then the claim,
 * then the payment row (`applyLocalRefundAllocation`). No provider call runs
 * under it; the Xero note is an outbox row, kicked after the commit.
 */

/** What `lastError` says on an operation closed here. Nothing parses it. */
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
} as const satisfies Prisma.PaymentRecoveryOperationSelect;

const PAYMENT_SELECT = {
  id: true,
  xeroInvoiceId: true,
  ...netCollectedPaymentSelect,
} as const satisfies Prisma.PaymentSelect;

type ClosablePayment = Prisma.PaymentGetPayload<{ select: typeof PAYMENT_SELECT }>;

/**
 * What one dead card refund still owes, in cents: its own unsent slices
 * (`openCardRefundOwedByOperation`), capped at the card refund part Net
 * Collected takes off its payment, so the close can never record more than the
 * figures say is owed.
 */
function stillOwedCents(payment: ClosablePayment, operationId: string): number {
  const own = openCardRefundOwedByOperation(payment).get(operationId) ?? 0;
  return Math.min(own, getNetCollectedCashParts(payment).cardRefundOwedCents);
}

/** The transactions the refund was meant to come off, in its plan's order. */
function plannedTransactionIds(operation: { allocationPlan: unknown; paymentTransactionId: string | null }): string[] {
  const plan = parseRefundAllocationPlan(operation.allocationPlan);
  if (plan) return plan.map((slice) => slice.paymentTransactionId);
  return operation.paymentTransactionId ? [operation.paymentTransactionId] : [];
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
      owedCents: stillOwedCents(operation.payment, operation.id),
      wholeAmountOnly: operation.type === "REFUND_SUPERSEDED_PAYMENT",
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
  /** Whether a Xero refund credit note was queued (a cancellation's refund, on an invoiced payment). */
  xeroRefundNoteQueued: boolean;
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

    const payment = await tx.payment.findUnique({ where: { id: operation.paymentId }, select: PAYMENT_SELECT });
    if (!payment) throw new CardRefundPaidAnotherWayError("Card refund not found.", 404);
    const owedCents = stillOwedCents(payment, operation.id);
    if (input.amountCents > owedCents) {
      throw new CardRefundPaidAnotherWayError(
        "That is more than this refund still owes. Refresh and check the amount.",
        409,
      );
    }
    if (owedCents > 0 && input.amountCents === 0) {
      throw new CardRefundPaidAnotherWayError("Enter the amount the member was paid back.", 400);
    }
    if (operation.type === "REFUND_SUPERSEDED_PAYMENT" && input.amountCents !== owedCents) {
      throw new CardRefundPaidAnotherWayError(
        "A superseded payment's refund closes only for the whole of what it still owes.",
        400,
      );
    }

    const claimed = await tx.paymentRecoveryOperation.updateMany({
      where: { id: operation.id, ...deadCardRefundOperationWhere },
      data: {
        status: PaymentRecoveryOperationStatus.SUCCEEDED,
        succeededAt: new Date(),
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
    if (input.amountCents > 0) {
      try {
        await applyLocalRefundAllocation({
          paymentId: payment.id,
          amountCents: input.amountCents,
          preferTransactionIds: plannedTransactionIds(operation),
          store: tx,
        });
      } catch (error) {
        logger.warn({ err: error, operationId: operation.id }, "Paid-another-way close refused by the refund allocation");
        throw new CardRefundPaidAnotherWayError(
          error instanceof RefundAllocationRacedError
            ? "This payment's refunds changed while you were closing it - refresh and try again."
            : "The payment no longer holds that much to refund. Refresh and check the amount.",
          409,
        );
      }
    }

    // Mirrors a cancellation's bank-transfer hand-back (`INV-PAY-101`), and only that.
    const xeroRefundNoteQueued =
      input.amountCents > 0 &&
      payment.xeroInvoiceId !== null &&
      operation.idempotencyKey === buildBookingCancellationRefundIdempotencyKey(operation.bookingId)
        ? (
            await enqueueXeroRefundCreditNoteOperation(payment.id, input.amountCents, {
              createdByMemberId: input.actingMemberId,
              refundMethod: "internet-banking",
              store: tx,
            })
          ).queueOperationId !== null
        : false;

    const booking = await tx.booking.findUnique({
      where: { id: operation.bookingId },
      select: { memberId: true },
    });
    await createAuditLog(
      {
        action: "booking-payment.card-refund.paid-another-way",
        memberId: input.actingMemberId,
        actorMemberId: input.actingMemberId,
        subjectMemberId: booking ? bookingOwner(booking).memberId : null,
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
