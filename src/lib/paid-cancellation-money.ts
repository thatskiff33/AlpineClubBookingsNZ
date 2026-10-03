/**
 * WHAT A PAID CANCELLATION RETURNS AND WHAT IT KEEPS, IN ONE CALL (#3611).
 *
 * The paid cancel path used to assemble these one figure at a time beside the
 * claim; the CANCELLED event froze one "retained" figure and the booking
 * ledger was about to post another (review of #3611, SSOT B1/B2). Both now come
 * from here, and the relationship between them is stated once, in design
 * `docs/design/booking-ledger.md` §5.1.
 *
 * NOTHING HERE CHANGES WHAT A CANCELLATION REFUNDS OR RESTORES. The refund is
 * `calculateRefundAmount` on `cancelRefundableBaseCents`, and the restore is
 * `calculateAppliedCreditRestore` tiered off the payment's applied-credit
 * mirror, exactly as the cancel path computed them before. What this adds is
 * the ledger's kept figure, which reads the credit ACTUALLY applied (the
 * booking's applied rows) wherever the mirror disagrees with it.
 *
 * Pure: the caller reads the rows and the policy; this reads nothing.
 */
import { cancelRefundableBaseCents } from "@/lib/booking-payment-state";
import {
  calculateAppliedCreditRestore,
  calculateRefundAmount,
  type CancellationRule,
} from "@/lib/cancellation";

export type PaidCancellationMoney = {
  /**
   * Money taken for the booking, net of earlier refunds and of edit refunds
   * already promised back by hand (`amountCents - refundedAmountCents -
   * openEditRefundHandBackCents`, `INV-PAY-114`).
   */
  paidAmountCents: number;
  /** The slice the tier applies to: paid, capped at price plus change fee, less the change fee. */
  refundableBaseCents: number;
  /** What the policy returns from that slice — by card, as credit or by hand. */
  refundAmountCents: number;
  refundPercentage: number;
  /** What the policy restores of the applied credit, tiered off the mirror as before. */
  creditToRestoreCents: number;
  /**
   * What `restoreCreditFromBooking` will restore: the policy's figure capped at
   * the credit actually applied, and nothing where there is no member ledger.
   */
  creditRestoredCents: number;
  /** The CANCELLED event's figure: paid money not refunded (`INV-PAY-106`'s snapshot). */
  retainedAmountCents: number;
  /** The booking ledger's figure: retained, plus applied credit not restored (§5.1). */
  ledgerKeptCents: number;
  /**
   * What the policy ALONE keeps (review D1): the tiered slice less its refund,
   * the change fee, and the mirror's applied credit less the restore. Equal to
   * `ledgerKeptCents` unless the ledger figure also absorbs money the policy
   * never tiered — the components below say which.
   */
  policyKeptCents: number;
  /** Paid money above price plus change fee, which the refundable base leaves out. */
  paidAboveRefundableCents: number;
  /** Applied credit the booking's rows hold beyond (or, negative, short of) the mirror. */
  appliedCreditBeyondMirrorCents: number;
};

/** The one formula for what the club keeps on a cancellation (design §5.1). */
export function cancellationKeptCents({
  retainedAmountCents,
  appliedCreditCents,
  creditRestoredCents,
}: {
  retainedAmountCents: number;
  appliedCreditCents: number;
  creditRestoredCents: number;
}): number {
  return retainedAmountCents + appliedCreditCents - creditRestoredCents;
}

export function paidCancellationMoney({
  payment,
  openEditRefundHandBackCents,
  finalPriceCents,
  appliedCreditCents,
  restoresToMemberLedger,
  days,
  policy,
  refundMethod,
}: {
  payment: {
    amountCents: number;
    refundedAmountCents: number;
    changeFeeCents: number;
    creditAppliedCents: number;
  };
  /**
   * The payment's open edit refund hand-backs (`openEditRefundHandBackCents`,
   * #3827 `INV-PAY-114`), read under the cancel's locks: cash promised back on an
   * earlier edit that this cancellation must not refund or credit a second time.
   */
  openEditRefundHandBackCents: number;
  finalPriceCents: number;
  /** The credit the booking's applied rows actually hold (`deriveBookingAppliedCreditCents`). */
  appliedCreditCents: number;
  /** False for an organisation-owned booking: no member ledger to restore to (#3369). */
  restoresToMemberLedger: boolean;
  days: number;
  policy: CancellationRule[];
  refundMethod: "card" | "credit";
}): PaidCancellationMoney {
  const paidAmountCents =
    payment.amountCents - payment.refundedAmountCents - openEditRefundHandBackCents;
  const refundableBaseCents = cancelRefundableBaseCents({
    ...payment,
    openEditRefundHandBackCents,
    finalPriceCents,
  });
  const creditToRestoreCents =
    payment.creditAppliedCents > 0
      ? calculateAppliedCreditRestore(payment.creditAppliedCents, refundableBaseCents, days, policy)
          .creditRestoredCents
      : 0;
  const creditRestoredCents =
    restoresToMemberLedger && payment.creditAppliedCents > 0
      ? Math.max(0, Math.min(creditToRestoreCents, appliedCreditCents))
      : 0;
  const { refundAmountCents, refundPercentage } = calculateRefundAmount(
    refundableBaseCents,
    days,
    policy,
    refundMethod,
  );
  const retainedAmountCents = Math.max(paidAmountCents - refundAmountCents, 0);
  const priceWithChangeFeeCents = finalPriceCents + payment.changeFeeCents;
  return {
    paidAmountCents,
    refundableBaseCents,
    refundAmountCents,
    refundPercentage,
    creditToRestoreCents,
    creditRestoredCents,
    retainedAmountCents,
    ledgerKeptCents: cancellationKeptCents({ retainedAmountCents, appliedCreditCents, creditRestoredCents }),
    policyKeptCents:
      refundableBaseCents - refundAmountCents + payment.changeFeeCents + payment.creditAppliedCents - creditRestoredCents,
    paidAboveRefundableCents: Math.max(0, paidAmountCents - priceWithChangeFeeCents),
    appliedCreditBeyondMirrorCents: appliedCreditCents - payment.creditAppliedCents,
  };
}
