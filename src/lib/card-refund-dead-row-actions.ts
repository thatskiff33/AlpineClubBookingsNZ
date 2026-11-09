import "server-only";

import { PaymentRecoveryOperationStatus, type Prisma } from "@prisma/client";

import { createAuditLog } from "@/lib/audit";
import { bookingOwner } from "@/lib/booking-owner";
import {
  DEAD_CARD_REFUND_OPERATION_SELECT,
  DEAD_CARD_REFUND_PAYMENT_SELECT,
  deadCardRefundOperationWhere,
  deadCardRefundStillOwed,
  laterStripeRefundsCovering,
  tryCardAgainRefusal,
  type DeadCardRefundOperation,
  type DeadCardRefundPayment,
  type LaterStripeRefund,
} from "@/lib/card-refund-dead-row";
import { isOwedCardRefundOperation } from "@/lib/open-card-refund-owed";
import { lockPaymentForRefundedTotal } from "@/lib/payment-transactions";
import { prisma } from "@/lib/prisma";
import { isPaymentRecoveryOperationExhausted, rearmedPaymentRecoveryOperationData } from "@/lib/payment-recovery-constants";
import { isOrganiserChildRefundKey } from "@/lib/payment-recovery-keys";
import { onPlanWhere } from "@/lib/refused-card-refund-retry";

/**
 * #4368 (owner decision, 25 Oct 2026: "build as shown in the mock-up";
 * `INV-PAY-149`): THE TWO OTHER WAYS TO SETTLE A CARD REFUND STRIPE GAVE UP ON.
 * "Paid another way" (`card-refund-paid-another-way.ts`) records money the
 * treasurer paid back; these two record none.
 *
 * - **Nothing left owed** (`closeCardRefundNothingLeftOwed`). A dead row whose
 *   owed figure reads $0 - a later Stripe refund on its payment already paid
 *   it - closes naming that refund. It moves no money, makes no Stripe call,
 *   makes no Xero change and posts nothing to the booking journal: the refund
 *   that covered it was recorded, noted and posted when it arrived. The row
 *   goes to SUCCEEDED, the status every reader takes as "nothing more to
 *   send", with `lastError` saying why (`NOTHING_LEFT_OWED_MARKER`; nothing
 *   parses it). Refused (409) unless the figure is still $0 under the locks and
 *   the refunds it names are still the ones the treasurer saw.
 * - **Try the card again** (`tryDeadCardRefundAgain`, decision 5). The row is
 *   put back to run from the start (`rearmedPaymentRecoveryOperationData`):
 *   PENDING, attempts reset, due now. Nothing is sent here. The runner claims
 *   it as any row, and its charge-backed preflight (`INV-PAY-145`, #4359) reads
 *   Stripe before any slice is sent: a refund Stripe made under the row's key
 *   is adopted, and one made outside the app holds the row again. Refused (409)
 *   where the re-send could pay the member more than is owed
 *   (`tryCardAgainRefusal`), and unless the owed figure is the one the
 *   treasurer saw.
 *
 * ONE ROW, ONE WINNER (#4492). "Paid another way", these two and every retry
 * claim the row on the same guard - dead (`deadCardRefundOperationWhere`), on
 * the plan read (`onPlanWhere`) - under the same locks. A close moves it to
 * SUCCEEDED and a re-arm to PENDING with its attempts reset, so whichever
 * commits second matches nothing and writes nothing: a closed row is never
 * re-armed, and a re-armed row is offered no close until it is given up again.
 *
 * LOCKS (`INV-LOCK-001`, `INV-LOCK-002`; registered as `lockDeadCardRefundRow#1`):
 * `lock(1)` first, as "Paid another way" takes it - each changes whether a
 * refund debt is open, owed or in flight, which every edit, acceptance, paid
 * cancel and refund appeal reads separately to size a refund - then the row
 * re-read, then the Payment row (`lockPaymentForRefundedTotal`) BEFORE the
 * payment is read: every refunded-total writer without `lock(1)`, the
 * failed-later writer among them, takes that row first, so the owed figure,
 * the refunds and the payment's other card refund rows cannot move between the
 * read and the claim. No provider call runs under them.
 */

/** What `lastError` says on a row closed with nothing left owed, for a person reading it. Nothing parses it. */
export const NOTHING_LEFT_OWED_MARKER = "Closed by the treasurer: nothing left owed, a later Stripe refund covers it (#4368)";

/** A refusal with the status the route answers. Thrown inside the transaction, so nothing commits. */
export class DeadCardRefundActionError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409,
  ) {
    super(message);
    this.name = "DeadCardRefundActionError";
  }
}

interface LockedDeadRow {
  operation: DeadCardRefundOperation;
  payment: DeadCardRefundPayment;
  booking: { id: string; memberId: string | null };
}

/**
 * `lock(1)`, the row re-read and refused unless it is a dead card refund the
 * list offers, then the Payment row, then the payment and its booking read
 * under it. The first lock of its caller's transaction.
 */
async function lockDeadCardRefundRow(tx: Prisma.TransactionClient, operationId: string): Promise<LockedDeadRow> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
  const operation = await tx.paymentRecoveryOperation.findUnique({
    where: { id: operationId },
    select: DEAD_CARD_REFUND_OPERATION_SELECT,
  });
  if (!operation) throw new DeadCardRefundActionError("Card refund not found.", 404);
  // The list's own rule: never an organiser child's or a legacy group settlement's
  // refund, whose executors skip the charge-backed preflight (`INV-PAY-145`).
  if (!isOwedCardRefundOperation(operation) || isOrganiserChildRefundKey(operation.idempotencyKey)) {
    throw new DeadCardRefundActionError("This card refund cannot be settled here. Ask a developer to reconcile it.", 409);
  }
  if (!isPaymentRecoveryOperationExhausted(operation)) {
    throw new DeadCardRefundActionError(
      operation.status === PaymentRecoveryOperationStatus.SUCCEEDED
        ? "This card refund has already been closed."
        : "This card refund is being tried again, so it is not waiting for you. Refresh the list.",
      409,
    );
  }
  await lockPaymentForRefundedTotal(tx, operation.paymentId);
  const payment = await tx.payment.findUnique({ where: { id: operation.paymentId }, select: DEAD_CARD_REFUND_PAYMENT_SELECT });
  if (!payment) throw new DeadCardRefundActionError("Card refund not found.", 404);
  const booking = await tx.booking.findUnique({ where: { id: payment.bookingId }, select: { id: true, memberId: true } });
  if (!booking || booking.id !== operation.bookingId) {
    throw new DeadCardRefundActionError(
      "This card refund's payment belongs to another booking, so it cannot be settled here. Ask a developer to reconcile it.",
      409,
    );
  }
  return { operation, payment, booking };
}

/** The one status-guarded claim each action writes: still dead, still on the plan read. */
function deadRowClaimWhere(operation: DeadCardRefundOperation): Prisma.PaymentRecoveryOperationWhereInput {
  return { id: operation.id, ...deadCardRefundOperationWhere, ...onPlanWhere(operation.allocationPlan) };
}

const CHANGED_WHILE_SETTLING = "This card refund changed while you were settling it. The list has been refreshed: check it and try again.";

export interface NothingLeftOwedInput {
  operationId: string;
  /** The later Stripe refunds the dialog named; a different set under the locks is a 409. */
  expectedStripeRefundIds: readonly string[];
  actingMemberId: string;
}

export interface NothingLeftOwedResult {
  operationId: string;
  bookingId: string;
  paymentId: string;
  coveredBy: LaterStripeRefund[];
}

/** Close a dead card refund with nothing left owed. See the module comment. */
export async function closeCardRefundNothingLeftOwed(input: NothingLeftOwedInput): Promise<NothingLeftOwedResult> {
  const expected = [...new Set(input.expectedStripeRefundIds)].sort();
  if (expected.length === 0 || expected.length !== input.expectedStripeRefundIds.length) {
    throw new DeadCardRefundActionError("Name the Stripe refunds that cover this card refund, each once.", 400);
  }
  return prisma.$transaction(async (tx) => {
    const { operation, payment, booking } = await lockDeadCardRefundRow(tx, input.operationId);
    const { ownCents, owedCents } = deadCardRefundStillOwed(payment, operation.id);
    if (owedCents !== 0) {
      throw new DeadCardRefundActionError(
        "Something is owed on this card refund again, so it cannot be closed with nothing left owed. The list has been refreshed: check what is owed.",
        409,
      );
    }
    const coveredBy = laterStripeRefundsCovering(payment, operation);
    if (coveredBy.length === 0) {
      throw new DeadCardRefundActionError(
        "No later Stripe refund on this payment covers this card refund, so it cannot be closed here. Ask a developer to reconcile it.",
        409,
      );
    }
    const found = coveredBy.map((refund) => refund.stripeRefundId).sort();
    if (found.length !== expected.length || found.some((id, index) => id !== expected[index])) {
      throw new DeadCardRefundActionError(
        "The Stripe refunds on this payment changed since you opened it. The list has been refreshed: check them and close it again.",
        409,
      );
    }

    const closedAt = new Date();
    const claimed = await tx.paymentRecoveryOperation.updateMany({
      where: deadRowClaimWhere(operation),
      data: {
        status: PaymentRecoveryOperationStatus.SUCCEEDED,
        succeededAt: closedAt,
        nextRetryAt: null,
        processingStartedAt: null,
        lastError: NOTHING_LEFT_OWED_MARKER,
      },
    });
    if (claimed.count === 0) throw new DeadCardRefundActionError(CHANGED_WHILE_SETTLING, 409);

    await createAuditLog(
      {
        action: "booking-payment.card-refund.nothing-left-owed",
        memberId: input.actingMemberId,
        actorMemberId: input.actingMemberId,
        subjectMemberId: bookingOwner(booking).memberId,
        targetId: operation.bookingId,
        entityType: "PaymentRecoveryOperation",
        entityId: operation.id,
        category: "payment",
        severity: "important",
        outcome: "success",
        summary: `Card refund Stripe gave up on closed with nothing left owed: covered by Stripe refund ${found.join(", ")}. No money moved.`,
        metadata: {
          operationId: operation.id,
          bookingId: operation.bookingId,
          paymentId: payment.id,
          operationType: operation.type,
          ownUnsentCents: ownCents,
          owedCents,
          coveredBy: coveredBy.map((refund) => ({ ...refund })),
        },
      },
      tx,
    );
    return { operationId: operation.id, bookingId: operation.bookingId, paymentId: payment.id, coveredBy };
  });
}

export interface TryCardAgainInput {
  operationId: string;
  /** What the dialog showed still owed: the amount the card will be asked for. A moved figure is a 409. */
  expectedOwedCents: number;
  actingMemberId: string;
}

export interface TryCardAgainResult {
  operationId: string;
  bookingId: string;
  paymentId: string;
  owedCents: number;
}

/** Re-arm a dead card refund so the runner asks the card again. See the module comment. */
export async function tryDeadCardRefundAgain(input: TryCardAgainInput): Promise<TryCardAgainResult> {
  if (!Number.isSafeInteger(input.expectedOwedCents) || input.expectedOwedCents <= 0) {
    throw new DeadCardRefundActionError("Say what you saw still owed, in whole cents, more than nothing.", 400);
  }
  return prisma.$transaction(async (tx) => {
    const { operation, payment, booking } = await lockDeadCardRefundRow(tx, input.operationId);
    const owed = deadCardRefundStillOwed(payment, operation.id);
    const refusal = tryCardAgainRefusal(payment, operation, owed);
    if (refusal) throw new DeadCardRefundActionError(refusal, 409);
    if (owed.owedCents !== input.expectedOwedCents) {
      throw new DeadCardRefundActionError(
        "What is still owed on this card refund changed since you opened it. The list has been refreshed: check the amount and try again.",
        409,
      );
    }

    const claimed = await tx.paymentRecoveryOperation.updateMany({
      where: deadRowClaimWhere(operation),
      data: rearmedPaymentRecoveryOperationData(new Date()),
    });
    if (claimed.count === 0) throw new DeadCardRefundActionError(CHANGED_WHILE_SETTLING, 409);

    await createAuditLog(
      {
        action: "booking-payment.card-refund.try-card-again",
        memberId: input.actingMemberId,
        actorMemberId: input.actingMemberId,
        subjectMemberId: bookingOwner(booking).memberId,
        targetId: operation.bookingId,
        entityType: "PaymentRecoveryOperation",
        entityId: operation.id,
        category: "payment",
        severity: "important",
        outcome: "success",
        summary: "Card refund Stripe gave up on put back to try the card again. Stripe is checked before anything is sent.",
        metadata: {
          operationId: operation.id,
          bookingId: operation.bookingId,
          paymentId: payment.id,
          operationType: operation.type,
          owedCents: owed.owedCents,
          previousAttempts: operation.attempts,
          previousStatus: operation.status,
          previousLastError: operation.lastError?.slice(0, 500) ?? null,
        },
      },
      tx,
    );
    return { operationId: operation.id, bookingId: operation.bookingId, paymentId: payment.id, owedCents: owed.owedCents };
  });
}
