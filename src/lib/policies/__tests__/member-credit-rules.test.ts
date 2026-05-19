import { describe, expect, it } from "vitest";
import {
  ADMIN_ADJUSTMENT_IDEMPOTENCY_CONFLICT,
  assertMatchingIdempotentAdjustmentRequest,
  calculateAppliedCreditAmount,
  calculateRestoredCreditAmount,
  formatAdjustmentAmount,
  validateAdjustmentAmount,
  validateCreditApplicationAgainstBalance,
  validateNegativeAdjustmentAgainstBalance,
} from "@/lib/policies/member-credit";

describe("member credit policy rules", () => {
  it("rejects zero admin adjustments", () => {
    expect(() => validateAdjustmentAmount(0)).toThrow(
      "Adjustment amount cannot be zero"
    );
    expect(() => validateAdjustmentAmount(1)).not.toThrow();
    expect(() => validateAdjustmentAmount(-1)).not.toThrow();
  });

  it("bounds negative admin adjustments by current balance", () => {
    expect(() => validateNegativeAdjustmentAgainstBalance(-1000, 1500)).not.toThrow();
    expect(() => validateNegativeAdjustmentAgainstBalance(-1500, 1500)).not.toThrow();
    expect(() => validateNegativeAdjustmentAgainstBalance(-1501, 1500)).toThrow(
      "Cannot deduct 1501 cents: only 1500 cents available"
    );
    expect(() => validateNegativeAdjustmentAgainstBalance(2500, 0)).not.toThrow();
  });

  it("rejects insufficient booking-credit application", () => {
    expect(() => validateCreditApplicationAgainstBalance(0, 5000)).toThrow(
      "Credit amount must be positive"
    );
    expect(() => validateCreditApplicationAgainstBalance(6000, 5000)).toThrow(
      "Insufficient credit balance: 5000 cents available, 6000 cents requested"
    );
    expect(() => validateCreditApplicationAgainstBalance(5000, 5000)).not.toThrow();
  });

  it("calculates applied and restored credit amounts in integer cents", () => {
    expect(calculateAppliedCreditAmount(3200)).toBe(-3200);
    expect(
      calculateRestoredCreditAmount([
        { amountCents: -3000 },
        { amountCents: -2000 },
      ])
    ).toBe(5000);
    expect(calculateRestoredCreditAmount([])).toBe(0);
  });

  it("compares idempotent adjustment replays and detects conflicts", () => {
    const original = {
      memberId: "member-1",
      amountCents: 2500,
      description: "Service recovery",
      requestedById: "admin-1",
    };

    expect(() =>
      assertMatchingIdempotentAdjustmentRequest(original, { ...original })
    ).not.toThrow();

    expect(() =>
      assertMatchingIdempotentAdjustmentRequest(original, {
        ...original,
        amountCents: 3000,
      })
    ).toThrow(ADMIN_ADJUSTMENT_IDEMPOTENCY_CONFLICT);
  });

  it("formats signed adjustment amounts consistently", () => {
    expect(formatAdjustmentAmount(2500)).toBe("+2500 cents");
    expect(formatAdjustmentAmount(-2500)).toBe("-2500 cents");
  });
});
