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
      "Cannot deduct $15.01: only $15.00 available"
    );
    expect(() => validateNegativeAdjustmentAgainstBalance(2500, 0)).not.toThrow();
  });

  it("rejects insufficient booking-credit application", () => {
    expect(() => validateCreditApplicationAgainstBalance(0, 5000)).toThrow(
      "Credit amount must be positive"
    );
    expect(() => validateCreditApplicationAgainstBalance(6000, 5000)).toThrow(
      "Insufficient credit balance: $50.00 available, $60.00 requested"
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

  // F20 F2 (#1887): the clamp appends a POSITIVE BOOKING_APPLIED offset row to
  // return the over-consumed slice, so BOOKING_APPLIED rows are no longer all
  // negative. The restored amount must be the SIGNED net (what is still
  // applied), not Σ|amount| — otherwise a default restore over-restores by
  // 2×excess. Clamped [-4000, +1000] nets to 3000 applied, so 3000 restores.
  it("restores the SIGNED net, not the abs-sum, when a clamp offset is present (#1887 F2)", () => {
    expect(
      calculateRestoredCreditAmount([
        { amountCents: -4000 },
        { amountCents: 1000 },
      ])
    ).toBe(3000);
    // A fully-clamped ledger (net 0) restores nothing rather than 2×|rows|.
    expect(
      calculateRestoredCreditAmount([
        { amountCents: -1000 },
        { amountCents: 1000 },
      ])
    ).toBe(0);
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
    // #3533: the adjustment reads as an amount, with its sign.
    expect(formatAdjustmentAmount(2500)).toBe("+$25.00");
    expect(formatAdjustmentAmount(-2500)).toBe("-$25.00");
  });
});
