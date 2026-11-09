/**
 * What of `amountCents` a captured row's refunded total can still take: capped
 * at its headroom. Pure (#4119: the cancel preview's in-memory fold). A plain
 * module (#4368 review S1) so a pure reader - "Try the card again"'s check of
 * what a superseded intent's runner would send - spells the same rule the
 * runner sizes its request by (`processRefundSupersededPaymentOperation`);
 * `payment-transactions.ts` re-exports it for its writers.
 */
export function refundHeadroomIncrementCents(row: { amountCents: number; refundedAmountCents: number }, amountCents: number): number {
  return Math.min(Math.max(row.amountCents - row.refundedAmountCents, 0), Math.max(amountCents, 0));
}
