import { describe, expect, it } from "vitest";

import { resolveBookingDetailPayment } from "../_lib/booking-detail-payment";

/**
 * #3827 (`INV-PAY-117`): the booking page offers a refund appeal up to the
 * figure the appeal route enforces - the remaining refundable cash LESS the
 * edit refunds still promised back by bank transfer. Paid 200, refunded 75 at
 * cancel, a 50 edit refund still open: 75, not the gross 125.
 */
function resolve(
  manualRefundTasks: { amountCents: number | null }[],
  options: { recoveryOperations?: unknown[]; refundedAmountCents?: number; isBookingOwner?: boolean; supersededHeldBackCents?: number } = {},
) {
  const booking = {
    status: "CANCELLED",
    deletedAt: null,
    // #3372: the retained line's Net Collected rule reads these too.
    manualRefundTasks: [],
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
      refundedAmountCents: options.refundedAmountCents ?? 7500,
      creditAppliedCents: 0,
      _count: { transactions: 1 },
      recoveryOperations: options.recoveryOperations ?? [],
      refunds: [],
      manualRefundTasks,
    },
  };
  return resolveBookingDetailPayment({
    booking: booking as never,
    modules: {} as never,
    viewer: {
      canManageBooking: true,
      isBookingOwner: options.isBookingOwner ?? true,
      nonOwnerAdminViewer: !(options.isBookingOwner ?? true),
      canSeeOwnerCredit: true,
    } as never,
    access: { isDeleted: false } as never,
    party: { hasProvisionalChildren: false, isProvisionalChild: false, isFlaggedProvisional: false } as never,
    amountOwed: { owedCents: 15000, dueCents: 15000, appliedCreditCents: 0 },
    supersededHeldBackCents: options.supersededHeldBackCents,
  });
}

function ceiling(manualRefundTasks: { amountCents: number | null }[]) {
  return resolve(manualRefundTasks).maxRefundableCents;
}

/** #4124: a card refund not yet made - a recovery row with nothing made yet. */
const OPEN_CARD_REFUND = {
  id: "op-1",
  type: "REFUND_BOOKING_MODIFICATION",
  status: "FAILED",
  idempotencyKey: "refund_request_req-1",
  amountCents: 2500,
  allocationPlan: null,
  paymentTransactionId: null,
  createdAt: new Date("2026-06-20T00:00:00.000Z"),
  succeededAt: null,
};

describe("booking page refund-appeal ceiling (#3827)", () => {
  it("is net of the open edit refunds loaded with the payment", () => {
    expect(ceiling([{ amountCents: 5000 }])).toBe(7500);
  });

  it("CONTROL: with none open it is the plain remainder", () => {
    expect(ceiling([])).toBe(12500);
  });

  // #4872 (`INV-PAY-150`): the approval nets a live superseded capture's hold-back, so the form does too.
  it("is net of a live superseded capture's hold-back", () => {
    expect(resolve([], { supersededHeldBackCents: 2000 }).maxRefundableCents).toBe(10500);
  });
});

describe("booking page refund-appeal ceiling net of a card refund not yet made (#4124)", () => {
  it("nets the card refund and hands the owner its figure for the form's line", () => {
    const payment = resolve([], { recoveryOperations: [OPEN_CARD_REFUND] });
    expect(payment.maxRefundableCents).toBe(10000);
    expect(payment.appealCardRefundOwedCents).toBe(2500);
  });

  it("keeps the second-person figure from a viewer who is not the owner", () => {
    const payment = resolve([], { recoveryOperations: [OPEN_CARD_REFUND], isBookingOwner: false });
    expect(payment.maxRefundableCents).toBe(10000);
    expect(payment.appealCardRefundOwedCents).toBe(0);
  });

  it("names the card refund when it is what takes the ceiling to zero", () => {
    const payment = resolve([], { recoveryOperations: [OPEN_CARD_REFUND], refundedAmountCents: 17500 });
    expect(payment.maxRefundableCents).toBe(0);
    expect(payment.appealCardRefundOwedCents).toBe(2500);
  });

  // #4124 delta review: the figure is what the card refund actually took off,
  // never more - $10 refundable, a $5 hand-back open and a $10 card refund
  // still owed leave $0, of which the card refund took $5.
  it("blames the card refund only for what it took off the ceiling", () => {
    const payment = resolve([{ amountCents: 500 }], { recoveryOperations: [{ ...OPEN_CARD_REFUND, amountCents: 1000 }], refundedAmountCents: 19000 });
    expect(payment.maxRefundableCents).toBe(0);
    expect(payment.appealCardRefundOwedCents).toBe(500);
  });

  it("does not blame the card refund for a ceiling that was zero without it", () => {
    const payment = resolve([{ amountCents: 12500 }], { recoveryOperations: [OPEN_CARD_REFUND] });
    expect(payment.maxRefundableCents).toBe(0);
    expect(payment.appealCardRefundOwedCents).toBe(0);
  });
});
