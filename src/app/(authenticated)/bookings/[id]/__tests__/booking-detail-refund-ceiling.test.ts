import { describe, expect, it } from "vitest";

import { resolveBookingDetailPayment } from "../_lib/booking-detail-payment";

/**
 * #3827 (`INV-PAY-115`): the booking page offers a refund appeal up to the
 * figure the appeal route enforces - the remaining refundable cash LESS the
 * edit refunds still promised back by bank transfer. Paid 200, refunded 75 at
 * cancel, a 50 edit refund still open: 75, not the gross 125.
 */
function ceiling(manualRefundTasks: { amountCents: number | null }[]) {
  const booking = {
    status: "CANCELLED",
    finalPriceCents: 15000,
    organiserSettled: false,
    creditsFromCancellation: [],
    refundRequests: [],
    parentBooking: null,
    payment: {
      id: "payment-1",
      status: "PARTIALLY_REFUNDED",
      source: "INTERNET_BANKING",
      amountCents: 20000,
      refundedAmountCents: 7500,
      creditAppliedCents: 0,
      manualRefundTasks,
    },
  };
  return resolveBookingDetailPayment({
    booking: booking as never,
    modules: {} as never,
    viewer: { canManageBooking: true, isBookingOwner: true, nonOwnerAdminViewer: false } as never,
    access: { isDeleted: false } as never,
    party: { hasProvisionalChildren: false, isProvisionalChild: false, isFlaggedProvisional: false } as never,
  }).maxRefundableCents;
}

describe("booking page refund-appeal ceiling (#3827)", () => {
  it("is net of the open edit refunds loaded with the payment", () => {
    expect(ceiling([{ amountCents: 5000 }])).toBe(7500);
  });

  it("CONTROL: with none open it is the plain remainder", () => {
    expect(ceiling([])).toBe(12500);
  });
});
