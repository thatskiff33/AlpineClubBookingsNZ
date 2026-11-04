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
      expect(changeFeeGoesOnAmountOwed({ status, finalPriceCents: 20_000, organiserSettled: false, payment: unpaidBank }), status).toBe(true);
    }
  });

  it("is false once money is captured: the edit's own settlement collects the fee", () => {
    const captured = { status: "SUCCEEDED", amountCents: 20_000, refundedAmountCents: 0 };
    expect(changeFeeGoesOnAmountOwed({ status: "CONFIRMED", finalPriceCents: 20_000, organiserSettled: false, payment: captured })).toBe(false);
  });

  it("is false for a paid, finished or cancelled booking", () => {
    for (const status of ["PAID", "COMPLETED", "CANCELLED", "DRAFT"]) {
      expect(changeFeeGoesOnAmountOwed({ status, finalPriceCents: 20_000, organiserSettled: false, payment: unpaidBank }), status).toBe(false);
    }
  });

  it("is true for a card booking still at its pay step with no payment row yet (#4735)", () => {
    for (const status of ["PENDING", "PAYMENT_PENDING"]) {
      expect(changeFeeGoesOnAmountOwed({ status, finalPriceCents: 20_000, organiserSettled: false, payment: null }), status).toBe(true);
    }
  });

  it("is false for a free booking awaiting payment with no payment row: a stranded or mid-flight waitlist confirm (#4735)", () => {
    // A row there would read as "the confirm finished": Return to waitlist would refuse and the confirm's own $0 row would collide.
    expect(changeFeeGoesOnAmountOwed({ status: "PAYMENT_PENDING", finalPriceCents: 0, organiserSettled: false, payment: null })).toBe(false);
    // A held free booking is not that shape.
    expect(changeFeeGoesOnAmountOwed({ status: "PENDING", finalPriceCents: 0, organiserSettled: false, payment: null })).toBe(true);
  });

  it("is false with no payment row for any other status, an unpaid whole-lodge approval included", () => {
    for (const status of ["CONFIRMED", "PAID", "COMPLETED", "CANCELLED", "DRAFT", "AWAITING_REVIEW"]) {
      expect(changeFeeGoesOnAmountOwed({ status, finalPriceCents: 20_000, organiserSettled: false, payment: null }), status).toBe(false);
    }
  });

  it("is false for an organiser-settled joiner with no payment row", () => {
    expect(changeFeeGoesOnAmountOwed({ status: "PAYMENT_PENDING", finalPriceCents: 20_000, organiserSettled: true, payment: null })).toBe(false);
  });

  it("is false for a joiner the group organiser settles", () => {
    expect(changeFeeGoesOnAmountOwed({ status: "CONFIRMED", finalPriceCents: 20_000, organiserSettled: true, payment: unpaidBank })).toBe(false);
  });
});

describe("changeFeeAddedToAmountOwedHistory", () => {
  it("marks the edit's history row only when it added a fee", () => {
    expect(changeFeeAddedToAmountOwedHistory(2_500)).toEqual({ changeFeeAddedToAmountOwed: true });
    expect(changeFeeAddedToAmountOwedHistory(0)).toEqual({});
  });
});
