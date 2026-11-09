import "server-only";

import { PaymentRecoveryOperationStatus, PaymentRecoveryOperationType, type Prisma } from "@prisma/client";

import type { PaidBackChoice, PaidBackRestChoice } from "@/lib/card-refund-paid-back";
import { postPaidAnotherWayClose, resolveCardRefundObligation, type BookingJournalContext } from "@/lib/member-money/doors";
import { parseRefundAllocationPlan } from "@/lib/open-card-refund-owed";
import { MAX_PAYMENT_RECOVERY_ATTEMPTS } from "@/lib/payment-recovery-constants";
import { buildCardRefundStillOwedRecoveryKey, refundSliceStripeIdempotencyKey } from "@/lib/payment-recovery-keys";
import { cardRefundOperationStripeKeyPrefix } from "@/lib/card-refund-stripe-key-prefix";
import type { RefundAllocationSlice } from "@/lib/payment-transactions";

/**
 * #4516 (owner, 2 Nov 2026: "Ask exactly and officer chooses"; `INV-PAY-122`): WHAT A PART "PAID ANOTHER WAY"
 * CLOSE DOES WITH THE REST. The treasurer says it, with no default:
 *
 * - "club-keeps": today's rule. The rest is owed nowhere; the journal clears it into a retained booking charge.
 * - "still-owed": the rest stays owed to the member. The close records what was paid on its own record, which
 *   closes the row it paid for exactly that (`raisedAmountCents` = the amount, so nothing reads as written off),
 *   and the rest moves to a row of its own (`buildCardRefundStillOwedRecoveryKey`), born dead: PENDING, attempts spent and
 *   no retry time, so the runner never claims it and nothing is sent to Stripe for it. "Refunds owed", Net
 *   Collected and the dead card refund list count it as every dead row is counted; a later close pays it, in full
 *   or in part again. The journal leaves the refund obligation open for the rest.
 */

/**
 * The full-or-part rule (owner, 8 Oct 2026), against what is still owed: "full" is exactly that; "partial" is more
 * than nothing and less than that. A refusal is a 400: the request does not say a consistent thing.
 */
export function paidBackChoiceRefusal(paidBack: PaidBackChoice, amountCents: number, owedCents: number): string | null {
  if (paidBack === "full" && amountCents !== owedCents) return "Paid back in full must be exactly what is still owed. Refresh and check the amount.";
  if (paidBack === "partial" && !(amountCents > 0 && amountCents < owedCents)) return "Paid back part of it must be more than nothing and less than what is still owed.";
  return null;
}

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
      // Dead as a failed-later row is raised dead (`INV-PAY-128`): PENDING with its attempts spent, never claimed.
      status: PaymentRecoveryOperationStatus.PENDING,
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

/** What the close's record and audit say happened, with the treasurer's choice for the rest. */
export function paidAnotherWayOutcome(paidBack: PaidBackChoice, rest: PaidBackRestChoice | null, by = ""): string {
  const how = `paid back in ${paidBack === "full" ? "full" : "part"} another way${by}`;
  if (paidBack === "full") return how;
  return `${how}; ${rest === "still-owed" ? "the rest is still owed to the member" : "the club keeps the rest"}`;
}

/**
 * In the close's transaction, after its record and line: a still-owed rest's own row (`carryStillOwedRest`), then
 * R14 for the bank cash, its reservations closed without a refund and a kept rest's close-out
 * (`postPaidAnotherWayClose`, #4516), under the `lock(1)` and Payment row the close holds.
 */
export async function closePaidAnotherWayRest(tx: Prisma.TransactionClient, journal: BookingJournalContext, input: {
  operation: { id: string; type: string; idempotencyKey: string; bookingId: string; paymentId: string; paymentIntentId: string; amountCents: number;
    stripeKeyPrefix: string | null; allocationPlan: unknown };
  recordId: string; amountCents: number; owedCents: number; paidBack: PaidBackChoice; rest: PaidBackRestChoice | null;
  unsent: ReadonlyArray<{ paymentTransactionId: string; amountCents: number }>; unsentTransactionIds: readonly string[]; closedAt: Date; actingMemberId: string;
}): Promise<{ restCents: number; stillOwedOperationId: string | null }> {
  const { operation } = input;
  const restCents = input.owedCents - input.amountCents;
  const stillOwedOperationId = input.rest === "still-owed" && restCents > 0
    ? await carryStillOwedRest(tx, { operation, recordId: input.recordId, restCents, slices: stillOwedRestSlices(input.unsent, input.amountCents, restCents), closedAt: input.closedAt })
    : null;
  const prefix = cardRefundOperationStripeKeyPrefix(operation);
  await postPaidAnotherWayClose(tx, journal, { bookingId: operation.bookingId, obligation: await resolveCardRefundObligation(tx, operation), recordId: input.recordId,
    amountCents: input.amountCents, restCents, rest: input.paidBack === "full" ? null : input.rest,
    attemptKeys: [operation.idempotencyKey, ...(parseRefundAllocationPlan(operation.allocationPlan) ?? []).map((slice) => refundSliceStripeIdempotencyKey(prefix, slice))],
    transactionIds: input.unsentTransactionIds, closedAt: input.closedAt, actorMemberId: input.actingMemberId });
  return { restCents, stillOwedOperationId };
}
