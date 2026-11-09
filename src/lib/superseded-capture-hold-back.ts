/**
 * #4866 (`INV-PAY-145`): WHAT OF A PAYMENT'S CAPTURED CHARGES A CANCELLATION
 * LEAVES TO THE SUPERSEDED-INTENT MACHINERY.
 *
 * A superseded intent captured anyway is returned whole by its own refund row
 * (`REFUND_SUPERSEDED_PAYMENT`, R). With no stored plan R sizes its one request
 * on its charge's ledger (#4699, `processRefundSupersededPaymentOperation`), so
 * any other refund of that charge counts as R's progress. A cancellation that
 * refunded part of the charge for the booking (its newest-first plan,
 * `planCardRefundFromLedger`) therefore shrank R's request by as much, and R
 * closed with the member short; and where the booking's own money did not
 * reach the policy's cap, the cancellation tiered R's money as if paid for the
 * booking. So the cancellation counts none of what R still has to send: it is
 * taken off the money it treats as paid (with the open hand-backs,
 * `INV-PAY-117`), and its card plan takes nothing of it, on the claim and on
 * the preview alike.
 *
 * Per charge, what the machinery still owns, capped at what the charge holds:
 * - an R not SUCCEEDED (pending, retrying, held or dead: it still owes until an
 *   officer closes it, and a close fills its charge): what its runner would
 *   send (`reArmWouldSendCents`);
 * - a cancel row (`CANCEL_PAYMENT_INTENT`) still in flight whose charge reads
 *   captured: the hand-off flipped it under the Payment row and writes R after
 *   it commits (`handoffSucceededSupersededIntentToRefund`), so all of it. A
 *   dead cancel hands the money to nobody and holds nothing back, as in the
 *   Xero reading (`readSupersededCaptureHolds`).
 *
 * Read under the caller's Payment row lock (the claim) or in its read-only
 * snapshot (the preview): the hand-off's flip takes that row, and R is written
 * before its cancel row closes, so every read sees the charge owned by one of
 * them. No lock of its own, no provider call.
 */
import { PaymentRecoveryOperationType, type PaymentStatus, type Prisma } from "@prisma/client";

import { reArmWouldSendCents } from "@/lib/card-refund-dead-row";
import { PAYMENT_RECOVERY_OPERATION_IN_FLIGHT_WHERE } from "@/lib/payment-recovery-constants";
import { isCapturedTransactionStatus } from "@/lib/payment-transaction-status";
import { refundHeadroomIncrementCents } from "@/lib/refund-headroom";

/** A live superseded-intent row on the payment, as `supersededCaptureHeldBack` reads it. */
export interface SupersededHoldBackOperation {
  type: string;
  paymentId: string;
  paymentTransactionId: string | null;
  amountCents: number;
  allocationPlan: unknown;
}

/** A charge on the payment, as the planner reads it. */
export interface SupersededHoldBackCharge {
  id: string;
  paymentId: string;
  status: PaymentStatus;
  amountCents: number;
  refundedAmountCents: number;
}

/** The live superseded-intent rows on one payment: R until it closes, a cancel row while in flight. */
export function supersededHoldBackOperationWhere(paymentId: string) {
  return {
    paymentId,
    OR: [
      { type: PaymentRecoveryOperationType.REFUND_SUPERSEDED_PAYMENT, status: { not: "SUCCEEDED" } },
      { type: PaymentRecoveryOperationType.CANCEL_PAYMENT_INTENT, AND: [PAYMENT_RECOVERY_OPERATION_IN_FLIGHT_WHERE] },
    ],
  } satisfies Prisma.PaymentRecoveryOperationWhereInput;
}

/**
 * Pure: the cents of each captured charge the live rows still own, by
 * transaction id, and their total. A row naming no charge of this payment, or
 * one not captured, holds nothing.
 */
export function supersededCaptureHeldBack(
  operations: readonly SupersededHoldBackOperation[],
  charges: readonly SupersededHoldBackCharge[],
): { byTransaction: Map<string, number>; totalCents: number } {
  const byTransaction = new Map<string, number>();
  for (const operation of operations) {
    const charge = charges.find((row) => row.id === operation.paymentTransactionId && row.paymentId === operation.paymentId);
    if (!charge || !isCapturedTransactionStatus(charge.status)) continue;
    const holdsCents = refundHeadroomIncrementCents(charge, charge.amountCents);
    const owns =
      operation.type === PaymentRecoveryOperationType.REFUND_SUPERSEDED_PAYMENT
        ? (reArmWouldSendCents({ ...operation, paymentTransaction: charge }) ?? holdsCents)
        : holdsCents;
    byTransaction.set(charge.id, Math.min(holdsCents, (byTransaction.get(charge.id) ?? 0) + Math.max(0, owns)));
  }
  let totalCents = 0;
  for (const cents of byTransaction.values()) totalCents += cents;
  return { byTransaction, totalCents };
}

type HoldBackReader = Pick<Prisma.TransactionClient, "paymentRecoveryOperation" | "paymentTransaction">;

/** The live superseded-intent rows on one payment (`supersededHoldBackOperationWhere`), as the pure reading takes them. */
export function readSupersededHoldBackOperations(
  db: Pick<Prisma.TransactionClient, "paymentRecoveryOperation">,
  paymentId: string,
): Promise<SupersededHoldBackOperation[]> {
  return db.paymentRecoveryOperation.findMany({
    where: supersededHoldBackOperationWhere(paymentId),
    select: { type: true, paymentId: true, paymentTransactionId: true, amountCents: true, allocationPlan: true },
  });
}

/** `supersededCaptureHeldBack` on the rows as they stand, read through the caller's transaction or snapshot. */
export async function readSupersededCaptureHeldBack(
  db: HoldBackReader,
  paymentId: string,
): Promise<{ byTransaction: Map<string, number>; totalCents: number }> {
  const operations = await readSupersededHoldBackOperations(db, paymentId);
  if (operations.length === 0) return { byTransaction: new Map(), totalCents: 0 };
  const charges = await db.paymentTransaction.findMany({
    where: { paymentId },
    select: { id: true, paymentId: true, status: true, amountCents: true, refundedAmountCents: true },
  });
  return supersededCaptureHeldBack(operations, charges);
}
