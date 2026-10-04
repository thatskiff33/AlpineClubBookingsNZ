/**
 * The paid cancellation's money in one call (#3611): the refund and the restore
 * are the policy's own figures, unchanged; the CANCELLED event's retained figure
 * and the ledger's kept figure come from the same call and differ by exactly the
 * applied credit the tier did not restore (design §5.1).
 */
import { describe, expect, it } from "vitest";

import { cancelRefundableBaseCents } from "@/lib/booking-payment-state";
import { paidCancellationMoney } from "@/lib/paid-cancellation-money";
import {
  calculateAppliedCreditRestore,
  calculateRefundAmount,
  type CancellationRule,
} from "@/lib/policies/cancellation";

const FIFTY: CancellationRule[] = [{ daysBeforeStay: 0, refundPercentage: 50, fixedFeeCents: 0 }];
const FIFTY_FEE: CancellationRule[] = [{ daysBeforeStay: 0, refundPercentage: 50, fixedFeeCents: 2_000 }];

function money(over: {
  amountCents: number;
  refundedAmountCents?: number;
  changeFeeCents?: number;
  creditAppliedCents?: number;
  appliedCreditCents?: number;
  finalPriceCents: number;
  policy?: CancellationRule[];
  restoresToMemberLedger?: boolean;
}) {
  const payment = {
    amountCents: over.amountCents,
    refundedAmountCents: over.refundedAmountCents ?? 0,
    changeFeeCents: over.changeFeeCents ?? 0,
    creditAppliedCents: over.creditAppliedCents ?? 0,
  };
  return {
    payment,
    result: paidCancellationMoney({
      payment,
      openNonCancellationHandBackCents: 0,
      finalPriceCents: over.finalPriceCents,
      appliedCreditCents: over.appliedCreditCents ?? payment.creditAppliedCents,
      restoresToMemberLedger: over.restoresToMemberLedger ?? true,
      days: 10,
      policy: over.policy ?? FIFTY,
      refundMethod: "card",
    }),
  };
}

describe("paidCancellationMoney", () => {
  it("returns the policy's own refund and restore, unchanged", () => {
    const { payment, result } = money({ amountCents: 15_000, creditAppliedCents: 5_000, finalPriceCents: 20_000, policy: FIFTY_FEE });
    const base = cancelRefundableBaseCents({ ...payment, openNonCancellationHandBackCents: 0, finalPriceCents: 20_000 });
    expect(result.refundableBaseCents).toBe(base);
    expect(result.refundAmountCents).toBe(calculateRefundAmount(base, 10, FIFTY_FEE, "card").refundAmountCents);
    expect(result.creditToRestoreCents).toBe(calculateAppliedCreditRestore(5_000, base, 10, FIFTY_FEE).creditRestoredCents);
  });

  it("the review's B1 example: price $200, $50 credit, $150 card, 50% — the event retains $75, the ledger keeps $100", () => {
    const { result } = money({ amountCents: 15_000, creditAppliedCents: 5_000, finalPriceCents: 20_000 });
    expect(result).toMatchObject({ refundAmountCents: 7_500, creditRestoredCents: 2_500, retainedAmountCents: 7_500, ledgerKeptCents: 10_000 });
    expect(result.ledgerKeptCents).toBe(result.retainedAmountCents + 5_000 - result.creditRestoredCents);
  });

  it("the retained figure is the CANCELLED event's own: paid less refunded, never below zero", () => {
    const { result } = money({ amountCents: 20_000, changeFeeCents: 1_500, finalPriceCents: 18_500 });
    expect(result.retainedAmountCents).toBe(Math.max(result.paidAmountCents - result.refundAmountCents, 0));
  });

  it("reads the credit ACTUALLY applied where the mirror says none (review X1): the ledger keeps it", () => {
    const { result } = money({ amountCents: 20_000, creditAppliedCents: 0, appliedCreditCents: 3_000, finalPriceCents: 20_000 });
    expect(result.creditRestoredCents).toBe(0);
    expect(result.ledgerKeptCents).toBe(result.retainedAmountCents + 3_000);
  });

  it("D1: the policy's own kept figure equals the ledger's whenever nothing outside the policy is held", () => {
    for (const over of [
      { amountCents: 20_000, finalPriceCents: 20_000 },
      { amountCents: 15_000, creditAppliedCents: 5_000, finalPriceCents: 20_000, policy: FIFTY_FEE },
      { amountCents: 21_500, changeFeeCents: 1_500, finalPriceCents: 20_000, policy: FIFTY_FEE },
    ]) {
      const { result } = money(over);
      expect(result.policyKeptCents).toBe(result.ledgerKeptCents);
    }
  });

  it("D1: an edit's kept-back reduction is kept beyond the policy, even at a 100% tier, and named", () => {
    // $200 paid, the price reduced to $150 with $5 refunded, then cancelled at 100%.
    const { result } = money({ amountCents: 20_000, refundedAmountCents: 500, finalPriceCents: 15_000, policy: [{ daysBeforeStay: 0, refundPercentage: 100 }] });
    expect(result).toMatchObject({ refundAmountCents: 15_000, policyKeptCents: 0, ledgerKeptCents: 4_500, paidAboveRefundableCents: 4_500 });
  });

  it("D1: the difference is exactly paid-above-refundable plus applied credit beyond the mirror", () => {
    for (const over of [
      { amountCents: 23_000, finalPriceCents: 20_000 },
      { amountCents: 20_000, creditAppliedCents: 0, appliedCreditCents: 3_000, finalPriceCents: 20_000 },
      { amountCents: 15_000, creditAppliedCents: 5_000, appliedCreditCents: 1_000, finalPriceCents: 20_000, policy: FIFTY_FEE },
    ]) {
      const { result } = money(over);
      expect(result.ledgerKeptCents - result.policyKeptCents).toBe(result.paidAboveRefundableCents + result.appliedCreditBeyondMirrorCents);
    }
  });

  it("predicts the restore's own cap at the applied rows, and no restore without a member ledger", () => {
    expect(money({ amountCents: 15_000, creditAppliedCents: 5_000, appliedCreditCents: 1_000, finalPriceCents: 20_000 }).result.creditRestoredCents).toBe(1_000);
    expect(money({ amountCents: 15_000, creditAppliedCents: 5_000, finalPriceCents: 20_000, restoresToMemberLedger: false }).result.creditRestoredCents).toBe(0);
  });
});
