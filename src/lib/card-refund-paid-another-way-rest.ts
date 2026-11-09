import "server-only";

import { PaymentRecoveryOperationStatus, PaymentRecoveryOperationType, type Prisma } from "@prisma/client";

import type { PaidBackChoice, PaidBackRestChoice } from "@/lib/card-refund-paid-back";
import { MAX_PAYMENT_RECOVERY_ATTEMPTS } from "@/lib/payment-recovery-constants";
import { buildCardRefundStillOwedRecoveryKey } from "@/lib/payment-recovery-keys";
import type { RefundAllocationSlice } from "@/lib/payment-transactions";

/**
 * #4516 (owner, 2 Nov 2026: "Ask exactly and officer chooses"; `INV-PAY-122`): WHAT A PART "PAID ANOTHER WAY"
 * CLOSE DOES WITH THE REST. The treasurer says it, with no default:
 *
 * - "club-keeps": today's rule. The rest is owed nowhere; the journal clears it into a retained booking charge.
 * - "still-owed": the rest stays owed to the member. The close records what was paid on its own record, which
 *   closes the row it paid for exactly that (`raisedAmountCents` = the amount, so nothing reads as written off),
 *   and the rest moves to a row of its own (`buildCardRefundStillOwedRecoveryKey`), born dead: attempts spent and
 *   no retry time, so the runner never claims it and nothing is sent to Stripe for it. "Refunds owed", Net
 *   Collected and the dead card refund list count it as every dead row is counted; a later close pays it, in full
 *   or in part again. The journal leaves the refund obligation open for the rest.
 */

/** A refusal with the status the route answers: the request does not say a consistent thing. */
export function paidBackRestRefusal(paidBack: PaidBackChoice, rest: PaidBackRestChoice | null | undefined): string | null {
  if (paidBack === "partial" && !rest) {
    return "Say what happens to the rest: the club keeps it, or it is still owed to the member.";
  }
  if (paidBack === "full" && rest) return "A refund paid back in full has no rest to keep or owe.";
  return null;
}

/**
 * The slices of what is left after a part close: the unsent slices in the plan's order, less the paid amount from
 * the front, totalling exactly the rest (the owed figure can be capped below the slices, never above).
 */
export function stillOwedRestSlices(unsent: ReadonlyArray<{ paymentTransactionId: string; amountCents: number }>, paidCents: number, restCents: number): RefundAllocationSlice[] {
  const slices: RefundAllocationSlice[] = [];
  let skip = paidCents;
  let left = restCents;
  for (const slice of unsent) {
    if (left <= 0) break;
    const skipped = Math.min(skip, slice.amountCents);
    skip -= skipped;
    const cents = Math.min(left, slice.amountCents - skipped);
    if (cents <= 0 || slice.paymentTransactionId === "") continue;
    slices.push({ paymentTransactionId: slice.paymentTransactionId, amountCents: cents });
    left -= cents;
  }
  return slices;
}

/** The rest's own row, in the close's transaction, keyed by its record: a replay of the close cannot write two. */
export async function carryStillOwedRest(tx: Prisma.TransactionClient, input: {
  operation: { bookingId: string; paymentId: string; paymentIntentId: string };
  recordId: string;
  restCents: number;
  slices: RefundAllocationSlice[];
  closedAt: Date;
}): Promise<string> {
  const idempotencyKey = buildCardRefundStillOwedRecoveryKey(input.recordId);
  const row = await tx.paymentRecoveryOperation.create({
    data: {
      type: PaymentRecoveryOperationType.REFUND_BOOKING_MODIFICATION,
      status: PaymentRecoveryOperationStatus.FAILED,
      attempts: MAX_PAYMENT_RECOVERY_ATTEMPTS,
      nextRetryAt: null,
      bookingId: input.operation.bookingId,
      paymentId: input.operation.paymentId,
      paymentIntentId: input.operation.paymentIntentId,
      amountCents: input.restCents,
      idempotencyKey,
      stripeKeyPrefix: idempotencyKey,
      ...(input.slices.length > 0 ? { allocationPlan: input.slices as unknown as Prisma.InputJsonValue } : {}),
      lastError: "Still owed after the treasurer paid part of a card refund another way (#4516). Close it as paid another way when it is paid.",
      createdAt: input.closedAt,
    },
    select: { id: true },
  });
  return row.id;
}
