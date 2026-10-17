/**
 * #3372 (owner, 9 Oct 2026; `INV-PAY-122`): how a card refund paid back twice
 * was resolved, as kept on the "Paid another way" close's record
 * (`reviewContext.paidTwiceResolved`). A plain leaf module (#4210): the
 * failed-later writer reads it inside the refund ledger writer, which must not
 * reach `server-only` code; the list and the Resolved action
 * (`card-refund-paid-twice.ts`) read it from here too.
 */

/** How a paid-twice row was resolved, as kept on the close's record. */
export interface PaidTwiceResolution {
  resolvedAt: string;
  resolvedByMemberId: string;
  note: string;
  /** What Stripe had refunded to the card for the close when it was resolved. */
  refundedByCardCents: number;
}

/** The resolution kept on a close's record, or null when it has none (or anything else). */
export function readPaidTwiceResolution(reviewContext: unknown): PaidTwiceResolution | null {
  if (!reviewContext || typeof reviewContext !== "object" || Array.isArray(reviewContext)) return null;
  const value = (reviewContext as Record<string, unknown>).paidTwiceResolved;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { resolvedAt, resolvedByMemberId, note, refundedByCardCents } = value as Record<string, unknown>;
  if (
    typeof resolvedAt !== "string" ||
    typeof resolvedByMemberId !== "string" ||
    typeof note !== "string" ||
    typeof refundedByCardCents !== "number" ||
    !Number.isSafeInteger(refundedByCardCents)
  ) {
    return null;
  }
  return { resolvedAt, resolvedByMemberId, note, refundedByCardCents };
}
