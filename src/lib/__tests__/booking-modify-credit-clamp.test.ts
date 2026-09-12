import { beforeEach, describe, expect, it, vi } from "vitest";

// F20 (#1887): applyLifecycleTransitions must take the EFFECTIVE (credit-reduced)
// price for its zero-dollar decision so a pre-payment reduction that lands a
// booking fully credit-covered auto-confirms at $0 instead of dead-ending at the
// card-intent guard. This suite exercises that decision in isolation by mocking
// the clamp, the ledger derive, and the intent-supersede helper.
//
// F1 (#1887): the clamp is gated on the LEDGER + a pre-payment status, NOT the
// payment.creditAppliedCents mirror, so it also fires for a CARD booking that
// has no Payment row yet (the card path writes no payment row at create).

const mockClamp = vi.fn();
const mockDerive = vi.fn();
const mockQueueSuperseded = vi.fn();
const mockPaymentUpsert = vi.fn();
// #2265 (#2319): the guarded claim that clears a stale credit election when this
// reprice settles the booking at $0.
const mockBookingUpdateMany = vi.fn();

vi.mock("@/lib/member-credit", () => ({
  clampAppliedCreditToBookingPrice: (...args: unknown[]) => mockClamp(...args),
  deriveBookingAppliedCreditCents: (...args: unknown[]) => mockDerive(...args),
}));

vi.mock("@/lib/booking-payment-cleanup", () => ({
  queueSupersededPrimaryIntentCancellations: (...args: unknown[]) =>
    mockQueueSuperseded(...args),
}));

// applyLifecycleTransitions imports these but does not reach them on the
// all-member, no-review path exercised here.
vi.mock("@/lib/cancellation", () => ({
  calculateDualRefundAmounts: vi.fn(),
  daysUntilDate: vi.fn(),
  loadCancellationPolicy: vi.fn(),
  getNonMemberHoldPolicy: vi.fn(),
}));
vi.mock("@/lib/booking-payment-state", () => ({
  getRemainingRefundableCents: vi.fn(),
  hasCapturedPayment: vi.fn(),
  hasIssuedPrimaryXeroInvoice: vi.fn(),
  isSettledBookingStatus: vi.fn(),
  // #3340 widened this module's graph: `booking-modify-settlement` now reaches
  // `additional-payment-ask`, which reads the one home of the captured-payment
  // status list AT IMPORT TIME. A factory missing it throws before a single test
  // runs, so the real value is handed back rather than a stub - nothing here
  // exercises it, and a wrong list would be a silently different population.
  CAPTURED_PAYMENT_STATUS_LIST: ["SUCCEEDED", "PARTIALLY_REFUNDED", "REFUNDED"],
}));
vi.mock("@/lib/policies/booking-route-decisions", () => ({
  calculateBookingHoldDecision: vi.fn(),
}));

import { applyLifecycleTransitions } from "@/lib/booking-modify-settlement";

function makeTx() {
  return {
    payment: { upsert: mockPaymentUpsert },
    booking: { updateMany: mockBookingUpdateMany },
  } as any;
}

function baseBooking(
  overrides: { creditAppliedCents?: number; hasPayment?: boolean } = {},
) {
  const hasPayment = overrides.hasPayment ?? true;
  return {
    id: "bk-1",
    memberId: "member-1",
    status: "PAYMENT_PENDING",
    nonMemberHoldUntil: null,
    lodgeId: "lodge-1",
    // A CARD booking has NO payment row until it requests a card intent.
    payment: hasPayment
      ? { id: "pay-1", creditAppliedCents: overrides.creditAppliedCents ?? 0 }
      : null,
  } as any;
}

describe("applyLifecycleTransitions — F20 applied-credit clamp (#1887)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDerive.mockResolvedValue(0);
    mockQueueSuperseded.mockResolvedValue([]);
    mockPaymentUpsert.mockResolvedValue({ id: "pay-1" });
    mockBookingUpdateMany.mockResolvedValue({ count: 1 });
  });

  it("refunds the over-consumed credit and auto-confirms at $0 when the reprice drops below applied credit", async () => {
    // Applied 5000 on the ledger, reprice to 3000: clamp returns 2000, net 3000.
    mockDerive.mockResolvedValue(5000);
    mockClamp.mockResolvedValue({
      appliedCreditCents: 3000,
      refundedExcessCents: 2000,
    });

    const result = await applyLifecycleTransitions(makeTx(), {
      booking: baseBooking({ creditAppliedCents: 5000 }),
      bookingId: "bk-1",
      newCheckIn: new Date("2026-08-01"),
      newFinalPriceCents: 3000,
      guestsForPricing: [{ isMember: true }],
      skipBookingLifecycleRules: false,
    });

    expect(mockClamp).toHaveBeenCalledWith(
      { memberId: "member-1", bookingId: "bk-1", newFinalPriceCents: 3000 },
      expect.anything(),
    );
    expect(result.newStatus).toBe("PAID");
    expect(result.zeroDollarAutoPaid).toBe(true);
    expect(result.appliedCreditCents).toBe(3000);
    expect(result.refundedExcessCreditCents).toBe(2000);
    // The $0 payment mirror keeps amountCents + creditAppliedCents = finalPrice.
    expect(mockPaymentUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { bookingId: "bk-1" },
        create: expect.objectContaining({
          amountCents: 0,
          creditAppliedCents: 3000,
          status: "SUCCEEDED",
        }),
      }),
    );
    // A credit-covered $0 sweeps every positive pending intent (effective 0).
    expect(mockQueueSuperseded).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ newFinalPriceCents: 0 }),
    );
  });

  it("clamps a CARD booking with NO payment row and auto-confirms it at $0 (F1 regression, #1887)", async () => {
    // The card path writes no payment row at create, so booking.payment is null.
    // The mirror gate would skip the clamp here and the booking would dead-end
    // unpayable at the card-intent guard. The ledger gate fires the clamp, which
    // upserts (creates) the $0 payment row and auto-confirms the booking.
    mockDerive.mockResolvedValue(4000);
    mockClamp.mockResolvedValue({
      appliedCreditCents: 3000,
      refundedExcessCents: 1000,
    });

    const result = await applyLifecycleTransitions(makeTx(), {
      booking: baseBooking({ hasPayment: false }),
      bookingId: "bk-1",
      newCheckIn: new Date("2026-08-01"),
      newFinalPriceCents: 3000,
      guestsForPricing: [{ isMember: true }],
      skipBookingLifecycleRules: false,
    });

    expect(mockDerive).toHaveBeenCalledWith("bk-1", expect.anything());
    expect(mockClamp).toHaveBeenCalled();
    expect(result.newStatus).toBe("PAID");
    expect(result.zeroDollarAutoPaid).toBe(true);
    expect(result.appliedCreditCents).toBe(3000);
    expect(result.refundedExcessCreditCents).toBe(1000);
    // upsert CREATES the payment row for the previously payment-less card booking.
    expect(mockPaymentUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { bookingId: "bk-1" },
        create: expect.objectContaining({
          amountCents: 0,
          creditAppliedCents: 3000,
          status: "SUCCEEDED",
        }),
      }),
    );
  });

  it("leaves a partially-credit-covered card reprice payable (clamp no-op, no $0 path)", async () => {
    // Applied 4000, reprice to 5000 (still above credit): clamp is a no-op, the
    // booking stays PAYMENT_PENDING with a positive effective price to charge.
    mockDerive.mockResolvedValue(4000);
    mockClamp.mockResolvedValue({
      appliedCreditCents: 4000,
      refundedExcessCents: 0,
    });

    const result = await applyLifecycleTransitions(makeTx(), {
      booking: baseBooking({ hasPayment: false }),
      bookingId: "bk-1",
      newCheckIn: new Date("2026-08-01"),
      newFinalPriceCents: 5000,
      guestsForPricing: [{ isMember: true }],
      skipBookingLifecycleRules: false,
    });

    expect(mockClamp).toHaveBeenCalled();
    expect(result.newStatus).toBe("PAYMENT_PENDING");
    expect(result.zeroDollarAutoPaid).toBe(false);
    expect(result.appliedCreditCents).toBe(4000);
    expect(mockPaymentUpsert).not.toHaveBeenCalled();
  });

  it("does not touch the credit ledger or auto-pay for a no-credit reduction (unchanged behaviour)", async () => {
    mockDerive.mockResolvedValue(0);

    const result = await applyLifecycleTransitions(makeTx(), {
      booking: baseBooking({ creditAppliedCents: 0 }),
      bookingId: "bk-1",
      newCheckIn: new Date("2026-08-01"),
      newFinalPriceCents: 3000,
      guestsForPricing: [{ isMember: true }],
      skipBookingLifecycleRules: false,
    });

    // No applied credit on the ledger -> the clamp (and its lock) is never invoked.
    expect(mockClamp).not.toHaveBeenCalled();
    expect(result.newStatus).toBe("PAYMENT_PENDING");
    expect(result.zeroDollarAutoPaid).toBe(false);
    expect(result.appliedCreditCents).toBe(0);
    expect(mockPaymentUpsert).not.toHaveBeenCalled();
    // Existing #1161 supersede still runs against the full new price.
    expect(mockQueueSuperseded).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ newFinalPriceCents: 3000 }),
    );
  });

  it("keeps the legacy no-credit price-to-zero auto-pay ($0 == effective when no credit)", async () => {
    mockDerive.mockResolvedValue(0);

    const result = await applyLifecycleTransitions(makeTx(), {
      booking: baseBooking({ creditAppliedCents: 0 }),
      bookingId: "bk-1",
      newCheckIn: new Date("2026-08-01"),
      newFinalPriceCents: 0,
      guestsForPricing: [{ isMember: true }],
      skipBookingLifecycleRules: false,
    });

    expect(mockClamp).not.toHaveBeenCalled();
    expect(result.newStatus).toBe("PAID");
    expect(result.zeroDollarAutoPaid).toBe(true);
    expect(mockPaymentUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ amountCents: 0, creditAppliedCents: 0 }),
      }),
    );
  });
});

/**
 * #2265 (#2319). The one arm that could genuinely land a SETTLED booking still
 * carrying a stored credit election.
 *
 * A guest removal on a booking parked in AWAITING_REVIEW releases it to
 * PAYMENT_PENDING with its election intact — correctly, because the pay step is
 * supposed to consume it. But if that same removal reprices the stay to nothing,
 * this function auto-pays it at $0 right here, and the election would ride into a
 * PAID row that no consumer will ever read again.
 *
 * Cleared silently, and that is the honest treatment rather than an oversight:
 * nothing is owed, so the election is MOOT, not unhonoured. No credit was
 * consumed, the member's balance is exactly as it was, and there is no
 * disappointed choice to explain to anybody — the same reasoning (and the same
 * silence) as confirm-draft's $0 confirm.
 */
describe("applyLifecycleTransitions — stale credit election on a $0 settle (#2265)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDerive.mockResolvedValue(0);
    mockQueueSuperseded.mockResolvedValue([]);
    mockPaymentUpsert.mockResolvedValue({ id: "pay-1" });
    mockBookingUpdateMany.mockResolvedValue({ count: 1 });
  });

  it("clears the election when the reprice settles the booking at $0", async () => {
    const result = await applyLifecycleTransitions(makeTx(), {
      booking: { ...baseBooking({ creditAppliedCents: 0 }), creditElectionCents: 7500 },
      bookingId: "bk-1",
      newCheckIn: new Date("2026-08-01"),
      newFinalPriceCents: 0,
      guestsForPricing: [{ isMember: true }],
      skipBookingLifecycleRules: false,
    });

    expect(result.newStatus).toBe("PAID");
    expect(result.zeroDollarAutoPaid).toBe(true);
    // Guarded on the exact amount read, like every other consumer of the column.
    expect(mockBookingUpdateMany).toHaveBeenCalledWith({
      where: { id: "bk-1", creditElectionCents: 7500 },
      data: { creditElectionCents: null },
    });
  });

  it("leaves the election alone when the reprice does NOT settle the booking", async () => {
    const result = await applyLifecycleTransitions(makeTx(), {
      booking: { ...baseBooking({ creditAppliedCents: 0 }), creditElectionCents: 7500 },
      bookingId: "bk-1",
      newCheckIn: new Date("2026-08-01"),
      newFinalPriceCents: 9000,
      guestsForPricing: [{ isMember: true }],
      skipBookingLifecycleRules: false,
    });

    // Still payable, so the election is still perfectly honourable — the pay step
    // will apply it against the NEW price. Clearing it here would be the original
    // #2265 bug all over again.
    expect(result.newStatus).toBe("PAYMENT_PENDING");
    expect(result.zeroDollarAutoPaid).toBe(false);
    expect(mockBookingUpdateMany).not.toHaveBeenCalled();
  });

  it("costs nothing for a $0 settle on a booking that never made an election", async () => {
    await applyLifecycleTransitions(makeTx(), {
      booking: { ...baseBooking({ creditAppliedCents: 0 }), creditElectionCents: null },
      bookingId: "bk-1",
      newCheckIn: new Date("2026-08-01"),
      newFinalPriceCents: 0,
      guestsForPricing: [{ isMember: true }],
      skipBookingLifecycleRules: false,
    });

    expect(mockBookingUpdateMany).not.toHaveBeenCalled();
  });
});
