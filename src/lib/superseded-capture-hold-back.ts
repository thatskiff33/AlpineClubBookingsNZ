/**
 * #4866 (`INV-PAY-150`): WHAT OF A PAYMENT'S CAPTURED CHARGES A REFUND DOOR
 * LEAVES TO THE SUPERSEDED-INTENT MACHINERY.
 *
 * A superseded intent captured anyway is returned whole by its own refund row
 * (`REFUND_SUPERSEDED_PAYMENT`, R). With no stored plan R sizes its one request
 * on its charge's ledger (#4699, `processRefundSupersededPaymentOperation`), so
 * any other refund of that charge counts as R's progress. A door that refunded
 * part of the charge for the booking (its newest-first card plan,
 * `planCardRefundFromLedger`, or its credit or hand-back allocation,
 * `applyLocalRefundAllocation`) therefore shrank R's request by as much, and R
 * closed with the member short; and where a door works out what the booking
 * paid, it could count that capture as paid for the booking. So those doors
 * count none of what the machinery still owns: it is taken off the money they
 * treat as paid (with the open hand-backs, `INV-PAY-117`), and neither a card
 * plan nor a local allocation takes any of it. Read under the caller's Payment
 * row, in the same transaction as the plan or allocation it feeds.
 *
 * Who owns a capture is the Xero reading's rule, read through its one home
 * (`readSupersededCaptureOwnership`, `superseded-intent-ownership.ts`). Per
 * charge, capped at what the charge holds:
 * - an R not SUCCEEDED (pending, retrying, held or dead: it still owes until an
 *   officer closes it, and a close fills its charge): what its runner would
 *   send (`reArmWouldSendCents`);
 * - a cancel row (`CANCEL_PAYMENT_INTENT`) still in flight whose charge reads
 *   captured: the hand-off flipped it under the Payment row and writes R after
 *   it commits (`handoffSucceededSupersededIntentToRefund`), so all of it. A
 *   dead cancel hands the money to nobody and holds nothing back;
 * - what open rows owe back again on the capture after Stripe failed a
 *   superseded refund later (`supersededRefundsOwedAgainCents`, #4221).
 *
 * Read under the caller's Payment row lock (the claim) or in its read-only
 * snapshot (the preview): the hand-off's flip takes that row, and R is written
 * before its cancel row closes, so every read sees the charge owned by one of
 * them. No lock of its own, no provider call.
 */
import { PaymentRecoveryOperationType, type PaymentStatus, type Prisma } from "@prisma/client";

import { reArmWouldSendCents } from "@/lib/card-refund-dead-row";
import { isCapturedTransactionStatus } from "@/lib/payment-transaction-status";
import { refundHeadroomIncrementCents } from "@/lib/refund-headroom";
import { readSupersededCaptureOwnership, type OwnershipReader, type SupersededOwningRow } from "@/lib/superseded-intent-ownership";

/** A charge on the payment, as the planner reads it. */
export interface SupersededHoldBackCharge {
  id: string;
  paymentId: string;
  status: PaymentStatus;
  stripePaymentIntentId: string | null;
  amountCents: number;
  refundedAmountCents: number;
}

/** The ownership a hold-back is sized from (`readSupersededCaptureOwnership`). */
export type SupersededCaptureOwnership = { owning: readonly SupersededOwningRow[]; owedAgainByIntent: ReadonlyMap<string, number> };

/**
 * Pure: the cents of each captured charge the machinery still owns, by
 * transaction id, and their total. A row naming no charge of this payment, or
 * one not captured, holds nothing.
 */
export function supersededCaptureHeldBack(
  { owning, owedAgainByIntent }: SupersededCaptureOwnership,
  charges: readonly SupersededHoldBackCharge[],
): { byTransaction: Map<string, number>; totalCents: number } {
  const byTransaction = new Map<string, number>();
  const hold = (charge: SupersededHoldBackCharge, cents: number) => {
    if (!isCapturedTransactionStatus(charge.status)) return;
    const holdsCents = refundHeadroomIncrementCents(charge, charge.amountCents);
    byTransaction.set(charge.id, Math.min(holdsCents, (byTransaction.get(charge.id) ?? 0) + Math.max(0, cents)));
  };
  for (const operation of owning) {
    const charge = charges.find((row) => row.id === operation.paymentTransactionId && row.paymentId === operation.paymentId);
    if (!charge) continue;
    const holdsCents = refundHeadroomIncrementCents(charge, charge.amountCents);
    hold(
      charge,
      operation.type === PaymentRecoveryOperationType.REFUND_SUPERSEDED_PAYMENT
        ? (reArmWouldSendCents({ ...operation, paymentTransaction: charge }) ?? holdsCents)
        : holdsCents,
    );
  }
  for (const [intent, cents] of owedAgainByIntent) {
    const charge = charges.find((row) => row.stripePaymentIntentId === intent);
    if (charge) hold(charge, cents);
  }
  let totalCents = 0;
  for (const cents of byTransaction.values()) totalCents += cents;
  return { byTransaction, totalCents };
}

/** `supersededCaptureHeldBack` on the rows as they stand, read through the caller's transaction or snapshot. */
export async function readSupersededCaptureHeldBack(
  db: OwnershipReader & Pick<Prisma.TransactionClient, "paymentTransaction">,
  paymentId: string,
): Promise<{ byTransaction: Map<string, number>; totalCents: number }> {
  const ownership = await readSupersededCaptureOwnership(db, paymentId);
  if (ownership.owning.length === 0 && ownership.owedAgainByIntent.size === 0) return { byTransaction: new Map(), totalCents: 0 };
  const charges = await db.paymentTransaction.findMany({
    where: { paymentId },
    select: { id: true, paymentId: true, status: true, stripePaymentIntentId: true, amountCents: true, refundedAmountCents: true },
  });
  return supersededCaptureHeldBack(ownership, charges);
}
