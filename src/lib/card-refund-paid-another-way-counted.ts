/**
 * #4210 round 3 (`INV-PAY-136`, money F2): what a "Paid another way" close
 * counted as it closed, kept on its record (`reviewContext.paidAnotherWayCounted`)
 * beside a card-note cover and a paid-twice resolution: the refunds it took as
 * made, and the slices it found unsent and so paid back
 * (`cardRefundCountedAtClose`). Written once, by the close; a paid-twice
 * Resolved keeps it. A plain leaf module: the failed-later writer reads it
 * inside the refund ledger writer, which must not reach `server-only` code.
 */
import type { UnsentSliceAtClose } from "@/lib/open-card-refund-owed";

export interface PaidAnotherWayCounted {
  refundIds: string[];
  unsentSlices: UnsentSliceAtClose[];
}

/** The record's `reviewContext` entry for what the close counted. */
export function paidAnotherWayCountedContext(counted: PaidAnotherWayCounted): { paidAnotherWayCounted: PaidAnotherWayCounted } {
  return {
    paidAnotherWayCounted: {
      refundIds: [...counted.refundIds],
      unsentSlices: counted.unsentSlices.map((slice) => ({ ...slice })),
    },
  };
}

function isUnsentSlice(value: unknown): value is UnsentSliceAtClose {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const { paymentTransactionId, amountCents, exact, madeRefundId } = value as Record<string, unknown>;
  return (
    typeof paymentTransactionId === "string" &&
    typeof amountCents === "number" &&
    Number.isSafeInteger(amountCents) &&
    amountCents > 0 &&
    typeof exact === "boolean" &&
    (madeRefundId === undefined || (typeof madeRefundId === "string" && madeRefundId.length > 0))
  );
}

/**
 * What a close's record says it counted, or null where it says nothing - a
 * close recorded before #4210 round 3, or anything unreadable - which the
 * failed-later writer weighs conservatively (`findPaidAnotherWayCloseThatSettled`).
 */
export function readPaidAnotherWayCounted(reviewContext: unknown): PaidAnotherWayCounted | null {
  if (!reviewContext || typeof reviewContext !== "object" || Array.isArray(reviewContext)) return null;
  const value = (reviewContext as Record<string, unknown>).paidAnotherWayCounted;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { refundIds, unsentSlices } = value as Record<string, unknown>;
  if (!Array.isArray(refundIds) || !refundIds.every((id) => typeof id === "string" && id.length > 0)) return null;
  if (!Array.isArray(unsentSlices) || !unsentSlices.every(isUnsentSlice)) return null;
  return { refundIds: [...(refundIds as string[])], unsentSlices: (unsentSlices as UnsentSliceAtClose[]).map((slice) => ({ ...slice })) };
}
