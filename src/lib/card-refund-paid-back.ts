/**
 * #3372 (owner, 8 Oct 2026: "Difference is gone", and "need a way for
 * Treasurer to mark a partial versus only a full payment"): THE TREASURER'S
 * ANSWER WHEN CLOSING A CARD REFUND AS PAID ANOTHER WAY - paid back in full, or
 * paid back in part with the rest no longer owed. Chosen explicitly, never
 * inferred from the amount.
 *
 * Pure and client-safe: the one home of the two answers, read by the close
 * (`closeCardRefundPaidAnotherWay`), its route's request schema and the
 * stuck-states dialog (`INV-SSOT`).
 */
export const PAID_BACK_CHOICES = ["full", "partial"] as const;

/** How much the treasurer says was paid back. */
export type PaidBackChoice = (typeof PAID_BACK_CHOICES)[number];
