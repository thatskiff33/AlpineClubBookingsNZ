import "server-only";

import { PaymentRecoveryOperationStatus, type Prisma } from "@prisma/client";

import {
  DEAD_CARD_REFUND_OPERATION_SELECT,
  DEAD_CARD_REFUND_PAYMENT_SELECT,
  DeadCardRefundActionError,
  deadCardRefundOperationWhere,
  type DeadCardRefundOperation,
  type DeadCardRefundPayment,
} from "@/lib/card-refund-dead-row";
import { isOwedCardRefundOperation } from "@/lib/open-card-refund-owed";
import { isPaymentRecoveryOperationExhausted } from "@/lib/payment-recovery-constants";
import { isOrganiserChildRefundKey } from "@/lib/payment-recovery-keys";
import { lockPaymentForRefundedTotal } from "@/lib/payment-transactions";
import { onPlanWhere } from "@/lib/refused-card-refund-retry";

/**
 * #3372, #4368 (`INV-SSOT`; review D): THE ONE LOCK AND CLAIM OF EVERY
 * SETTLEMENT OF A DEAD CARD REFUND ROW - "Paid another way"
 * (`closeCardRefundPaidAnotherWay`), "Nothing left owed" and "Try the card
 * again" (`card-refund-dead-row-actions.ts`). Each says its own refusals; the
 * order and the claim are this module's.
 *
 * `lock(1)` FIRST (`INV-LOCK-001`; registered as `lockDeadCardRefundRow#1`):
 * each moves or closes a refund debt, which every edit, acceptance, paid
 * cancel and refund appeal reads separately to size a refund net of what is
 * promised back. Then the row re-read and refused unless it is a dead card
 * refund the list offers, then the PAYMENT ROW (`lockPaymentForRefundedTotal`)
 * BEFORE the payment is read: every refunded-total writer without `lock(1)` -
 * every Stripe refund recorder, the failed-later writer inside it, and a
 * cancellation hand-back's completion - takes that row first, so the owed
 * figure, the recorded refunds and the payment's other card refund rows cannot
 * move between the read and the claim. Then the payment's booking.
 *
 * THE CLAIM (`deadRowClaimWhere`): one status-guarded `updateMany` on the row
 * still dead (`deadCardRefundOperationWhere`) and still on the plan read
 * (`onPlanWhere`; #4312 F2, `INV-ADDPAY-047`). A close moves it to SUCCEEDED and
 * a re-arm to PENDING with its attempts reset, so of any two settlements of one
 * row the second matches nothing and writes nothing (#4492).
 */

/** What a settlement says when the row is not one it may settle. */
export interface DeadCardRefundRowRefusals {
  /** Not a card refund owed on its payment (a legacy group settlement's). */
  notOwedKind: string;
  /** An organiser child's refund, out of the organiser's combined payment. */
  organiserChild: string;
  /** Already SUCCEEDED. */
  closed: string;
  /** Not dead: retries left, or re-armed. */
  notGivenUp: string;
  /** The payment's booking is not the row's. */
  otherBooking: string;
}

export interface LockedDeadCardRefundRow {
  operation: DeadCardRefundOperation;
  payment: DeadCardRefundPayment;
  booking: { id: string; lodgeId: string; memberId: string | null };
}

/** The locks, the re-read and the refusals, in that order. The first lock of its caller's transaction. */
export async function lockDeadCardRefundRow(
  tx: Prisma.TransactionClient,
  operationId: string,
  refusals: DeadCardRefundRowRefusals,
): Promise<LockedDeadCardRefundRow> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
  const operation = await tx.paymentRecoveryOperation.findUnique({
    where: { id: operationId },
    select: DEAD_CARD_REFUND_OPERATION_SELECT,
  });
  if (!operation) throw new DeadCardRefundActionError("Card refund not found.", 404);
  if (!isOwedCardRefundOperation(operation)) throw new DeadCardRefundActionError(refusals.notOwedKind, 409);
  // The list's own rule: an organiser child's refund skips the charge-backed preflight (`INV-PAY-145`).
  if (isOrganiserChildRefundKey(operation.idempotencyKey)) throw new DeadCardRefundActionError(refusals.organiserChild, 409);
  if (!isPaymentRecoveryOperationExhausted(operation)) {
    throw new DeadCardRefundActionError(
      operation.status === PaymentRecoveryOperationStatus.SUCCEEDED ? refusals.closed : refusals.notGivenUp,
      409,
    );
  }
  await lockPaymentForRefundedTotal(tx, operation.paymentId);
  const payment = await tx.payment.findUnique({ where: { id: operation.paymentId }, select: DEAD_CARD_REFUND_PAYMENT_SELECT });
  if (!payment) throw new DeadCardRefundActionError("Card refund not found.", 404);
  // The settlement's records are read by the booking, so they go on the payment's booking, which must be the row's.
  const booking = await tx.booking.findUnique({
    where: { id: payment.bookingId },
    select: { id: true, lodgeId: true, memberId: true },
  });
  if (!booking || booking.id !== operation.bookingId) throw new DeadCardRefundActionError(refusals.otherBooking, 409);
  return { operation, payment, booking };
}

/** The one status-guarded claim every settlement writes: still dead, still on the plan read. */
export function deadRowClaimWhere(operation: Pick<DeadCardRefundOperation, "id" | "allocationPlan">): Prisma.PaymentRecoveryOperationWhereInput {
  return { id: operation.id, ...deadCardRefundOperationWhere, ...onPlanWhere(operation.allocationPlan) };
}
