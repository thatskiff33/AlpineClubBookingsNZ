/**
 * #3372 (owner, 8 Oct 2026: "Difference is gone", and "need a way for
 * Treasurer to mark a partial versus only a full payment"): THE TREASURER'S
 * ANSWER WHEN CLOSING A CARD REFUND AS PAID ANOTHER WAY - paid back in full, or
 * paid back in part. Chosen explicitly, never inferred from the amount.
 *
 * #4516 (owner, 2 Nov 2026: "Ask exactly and officer chooses"): a part close
 * also says what happens to the rest - the club keeps it, or it is still owed
 * to the member. There is no default: a part close without the answer is
 * refused (`INV-PAY-122`).
 *
 * Pure and client-safe: the one home of the answers, read by the close
 * (`closeCardRefundPaidAnotherWay`), its route's request schema and the
 * stuck-states dialog (`INV-SSOT`).
 */
export const PAID_BACK_CHOICES = ["full", "partial"] as const;

/** How much the treasurer says was paid back. */
export type PaidBackChoice = (typeof PAID_BACK_CHOICES)[number];

/** What a part close does with the rest: the club keeps it, or the member is still owed it. */
export const PAID_BACK_REST_CHOICES = ["club-keeps", "still-owed"] as const;

export type PaidBackRestChoice = (typeof PAID_BACK_REST_CHOICES)[number];

/** The dialog's words for each answer, one spelling for the panel and its tests. */
export const PAID_BACK_REST_LABELS: Record<PaidBackRestChoice, string> = {
  "club-keeps": "The club keeps the rest",
  "still-owed": "The rest is still owed to the member",
};
