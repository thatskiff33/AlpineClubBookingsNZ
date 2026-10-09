import { describe, expect, it } from "vitest";

import { resolveBookingDetailPayment } from "../_lib/booking-detail-payment";

/**
 * #3750 (#3955 review F8, `INV-PAY-119`): a change fee recorded on an unpaid
 * booking's payment is owed with the price, so the pay card shows it as its
 * own row and charges — and says — the total the rows add up to.
 */
function resolve(payment: { changeFeeCents: number; creditAppliedCents: number }) {
  const booking = {
    status: "PAYMENT_PENDING",
    // #3372 (composed with #3924): the loader selects these for the retained
    // line's Net Collected rule (`getNetCollectedCashParts`).
    deletedAt: null,
    manualRefundTasks: [],
    finalPriceCents: 20000,
    organiserSettled: false,
    creditsFromCancellation: [],
    refundRequests: [],
    parentBooking: null,
    payment: {
      id: "payment-1",
      status: "PENDING",
      source: "STRIPE",
      amountCents: 0,
      refundedAmountCents: 0,
      _count: { transactions: 0 },
      recoveryOperations: [],
      refunds: [],
      manualRefundTasks: [],
      ...payment,
    },
  };
  return resolveBookingDetailPayment({
    booking: booking as never,
    modules: {} as never,
    viewer: { canManageBooking: true, isBookingOwner: true, nonOwnerAdminViewer: false } as never,
    access: { isDeleted: false } as never,
    party: { hasProvisionalChildren: false, isProvisionalChild: false, isFlaggedProvisional: false } as never,
  });
}

describe("booking page amount due with a recorded change fee (#3955 F8)", () => {
  it("shows the fee as its own row and charges price plus fee", () => {
    const payment = resolve({ changeFeeCents: 2500, creditAppliedCents: 0 });
    expect(payment.showAmountBreakdown).toBe(true);
    expect(payment.changeFeeOwedCents).toBe(2500);
    expect(payment.cardAmountDueCents).toBe(22500);
  });

  it("nets applied credit off price plus fee, so the rows add up", () => {
    const payment = resolve({ changeFeeCents: 2500, creditAppliedCents: 5000 });
    expect(payment.showCreditApplied).toBe(true);
    // 20000 + 2500 - 5000
    expect(payment.cardAmountDueCents).toBe(17500);
    expect(payment.amountDueAfterCreditCents).toBe(17500);
  });

  it("CONTROL: with no fee and no credit there is no breakdown and the price is due", () => {
    const payment = resolve({ changeFeeCents: 0, creditAppliedCents: 0 });
    expect(payment.showAmountBreakdown).toBe(false);
    expect(payment.cardAmountDueCents).toBe(20000);
  });
});
