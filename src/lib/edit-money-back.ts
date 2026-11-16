/**
 * The money an edit's SETTLEMENT hands back, in one place (`INV-SSOT`): a card
 * refund, paid money returned as account credit, and a paid booking's applied
 * credit given back (#3809). `BatchModificationResponse` carries all three; the
 * hosting linked-move quote (`combineLinkedMoveQuote`) and "Add to work party"
 * (fork #129) both read the sum from here.
 *
 * Exactly one of the refund and the account credit is non-zero for a given
 * reduction (`calculateModificationSettlementOptions` routes it down one arm),
 * and credit given back adds to either, so summing them never double-counts.
 *
 * NOT IN THIS SUM: an UNPAID booking's applied credit freed by a lower price
 * (`refundedExcessCreditCents`, the F20/#1887 clamp in `applyLifecycleTransitions`).
 * That is the lifecycle's, not the settlement's, and it never overlaps the
 * give-back: the give-back runs only on a booking that was PAID or COMPLETED,
 * the clamp only on one that is still pending (PENDING, PAYMENT_PENDING, or an
 * unpaid confirmed whole-lodge hold), and no edit moves a paid booking back to
 * pending. A caller that must count every cent coming back adds it explicitly
 * (`workPartyMoneyBackCents`). Client-safe: no imports.
 */
export interface EditSettlementMoneyBack {
  refundAmountCents: number;
  accountCreditAmountCents: number;
  appliedCreditGivenBackCents: number;
}

export function editMoneyBackCents(result: EditSettlementMoneyBack): number {
  return result.refundAmountCents + result.accountCreditAmountCents + result.appliedCreditGivenBackCents;
}
