import { describe, expect, it } from "vitest";

import { changeFeeAddedToAmountOwedHistory, changeFeeGoesOnAmountOwed } from "@/lib/change-fee-owed";

/**
 * #4661 (`INV-MOD-042`, `INV-PAY-119`): which bookings owe an edit's change fee
 * with their price. The door-to-ledger behaviour is pinned against PostgreSQL in
 * `unpaid-edit-change-fee-owed.realdb.test.ts`.
 */
const unpaidBank = { status: "PENDING", amountCents: 20_000, refundedAmountCents: 0 };

describe("changeFeeGoesOnAmountOwed", () => {
  it("is true for every status whose pay step is still ahead, with nothing captured", () => {
    for (const status of ["PENDING", "PAYMENT_PENDING", "CONFIRMED"]) {
      expect(changeFeeGoesOnAmountOwed({ status, organiserSettled: false, payment: unpaidBank }), status).toBe(true);
    }
  });

  it("is false once money is captured: the edit's own settlement collects the fee", () => {
    const captured = { status: "SUCCEEDED", amountCents: 20_000, refundedAmountCents: 0 };
    expect(changeFeeGoesOnAmountOwed({ status: "CONFIRMED", organiserSettled: false, payment: captured })).toBe(false);
  });

  it("is false for a paid, finished or cancelled booking", () => {
    for (const status of ["PAID", "COMPLETED", "CANCELLED", "DRAFT"]) {
      expect(changeFeeGoesOnAmountOwed({ status, organiserSettled: false, payment: unpaidBank }), status).toBe(false);
    }
  });

  it("is true for a card booking still at its pay step with no payment row yet (#4735)", () => {
    for (const status of ["PENDING", "PAYMENT_PENDING"]) {
      expect(changeFeeGoesOnAmountOwed({ status, organiserSettled: false, payment: null }), status).toBe(true);
    }
  });

  it("is false with no payment row for any other status, an unpaid whole-lodge approval included", () => {
    for (const status of ["CONFIRMED", "PAID", "COMPLETED", "CANCELLED", "DRAFT", "AWAITING_REVIEW"]) {
      expect(changeFeeGoesOnAmountOwed({ status, organiserSettled: false, payment: null }), status).toBe(false);
    }
  });

  it("is false for an organiser-settled joiner with no payment row", () => {
    expect(changeFeeGoesOnAmountOwed({ status: "PAYMENT_PENDING", organiserSettled: true, payment: null })).toBe(false);
  });

  it("is false for a joiner the group organiser settles", () => {
    expect(changeFeeGoesOnAmountOwed({ status: "CONFIRMED", organiserSettled: true, payment: unpaidBank })).toBe(false);
  });
});

describe("changeFeeAddedToAmountOwedHistory", () => {
  it("marks the edit's history row only when it added a fee", () => {
    expect(changeFeeAddedToAmountOwedHistory(2_500)).toEqual({ changeFeeAddedToAmountOwed: true });
    expect(changeFeeAddedToAmountOwedHistory(0)).toEqual({});
  });
});
