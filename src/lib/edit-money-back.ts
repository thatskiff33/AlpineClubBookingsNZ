/**
 * The money an edit hands back, in one place (`INV-SSOT`).
 *
 * `editMoneyBackCents` is the SETTLEMENT's share: a card refund, paid money
 * returned as account credit, and a paid booking's applied credit given back
 * (#3809). Exactly one of the refund and the account credit is non-zero for a
 * given reduction (`calculateModificationSettlementOptions` routes it down one
 * arm), and credit given back adds to either, so summing them never
 * double-counts.
 *
 * `editTotalMoneyBackCents` is EVERY CENT coming back: that share plus an
 * UNPAID booking's applied credit freed by a lower price
 * (`refundedExcessCreditCents`, the F20/#1887 clamp in `applyLifecycleTransitions`).
 * The freed credit is the lifecycle's, not the settlement's, and it never
 * overlaps the give-back: the give-back runs only on a booking that was PAID or
 * COMPLETED, the clamp only on one that is still pending (PENDING,
 * PAYMENT_PENDING, or an unpaid confirmed whole-lodge hold), and no edit moves
 * a paid booking back to pending. `BatchModificationResponse` carries all four.
 * The hosting linked-move quote (`combineLinkedMoveQuote`, fork triyder/AlpineClubBookingsNZ#132) and
 * "Add to work party" (Remove's guard, and the absorbed-ask test, #5149) both count every
 * cent, so what the member is told comes back matches their balance change.
 * Client-safe: no imports.
 */
export interface EditSettlementMoneyBack {
  refundAmountCents: number;
  accountCreditAmountCents: number;
  appliedCreditGivenBackCents: number;
}

export interface EditMoneyBack extends EditSettlementMoneyBack {
  /** F20 (#1887): an UNPAID booking's applied credit above its new worth, returned to the balance. */
  refundedExcessCreditCents: number;
}

export function editMoneyBackCents(result: EditSettlementMoneyBack): number {
  return result.refundAmountCents + result.accountCreditAmountCents + result.appliedCreditGivenBackCents;
}

export function editTotalMoneyBackCents(result: EditMoneyBack): number {
  return editMoneyBackCents(result) + result.refundedExcessCreditCents;
}

/**
 * Every cent of a work-party correction that comes back as account credit:
 * all the money back less what is refunded (paid money credited, a paid
 * booking's applied credit given back, and an unpaid one's applied credit
 * freed). One rule for the server and the confirm dialog.
 */
export function workPartyCreditBackCents(figures: EditMoneyBack): number {
  return editTotalMoneyBackCents(figures) - figures.refundAmountCents;
}

/**
 * #5149 (B-L1 of the maintainers' comment
 * https://github.com/thatskiff33/AlpineClubBookingsNZ/pull/5149#issuecomment-6952444211):
 * what "Add to work party" says when an unpaid additional ask took the whole
 * reduction (#3954, `INV-PAY-120`), so nothing comes back and there is nothing
 * to choose. One sentence for the server's refusal and the confirm dialog;
 * `amount` is already formatted for the club.
 */
export function workPartyAskAbsorbedSentence(amount: string): string {
  return `The discount cancels ${amount} of what is still owed on this booking, so nothing comes back.`;
}

/** The same, when the ask took only part of the discount and the rest comes back (#5149 review M4). */
export function workPartyAskPartlyAbsorbedSentence(amount: string): string {
  return `Of the discount, ${amount} cancels what is still owed on this booking.`;
}
