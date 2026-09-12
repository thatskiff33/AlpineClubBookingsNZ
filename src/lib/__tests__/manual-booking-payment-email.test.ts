import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * B5 (#2262) M4 — the manual mark-paid confirmation email must carry the SAME
 * options shape as every comparable settle-time send (the Xero-inbound settle
 * at invoice-paid-effects, cron-confirm-pending, charge-saved-method): in
 * particular the split-booking parent's `provisionalGuests` summary, so a
 * cash-settled split parent is told about the separate later charge for their
 * provisionally-held non-member guests exactly like every other settled member.
 */

const mocks = vi.hoisted(() => ({
  markBookingPaymentManuallySettled: vi.fn(),
  sendBookingConfirmedEmail: vi.fn(),
  getProvisionalNonMemberChildSummary: vi.fn(),
  bookingFindUnique: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: { findUnique: (...a: unknown[]) => mocks.bookingFindUnique(...a) },
  },
}));
vi.mock("@/lib/payment-reconciliation", async () => {
  const actual = (await vi.importActual("@/lib/payment-reconciliation")) as typeof import("@/lib/payment-reconciliation");
  return {
    ManualBookingPaymentError: actual.ManualBookingPaymentError,
    markBookingPaymentManuallySettled: (...a: unknown[]) =>
      mocks.markBookingPaymentManuallySettled(...a),
    reverseManualBookingPayment: vi.fn(),
  };
});
vi.mock("@/lib/email", () => ({
  sendBookingConfirmedEmail: (...a: unknown[]) =>
    mocks.sendBookingConfirmedEmail(...a),
}));
vi.mock("@/lib/booking-split-summary", () => ({
  getProvisionalNonMemberChildSummary: (...a: unknown[]) =>
    mocks.getProvisionalNonMemberChildSummary(...a),
}));
vi.mock("@/lib/audit", () => ({ createAuditLog: vi.fn() }));
vi.mock("@/lib/booking-events", () => ({ recordBookingEvent: vi.fn() }));
vi.mock("@/lib/payment-transactions", () => ({
  applyLocalRefundAllocation: vi.fn(),
}));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { applyManualBookingPayment } from "@/lib/manual-booking-payment";

const HOLD_UNTIL = new Date("2026-08-01T00:00:00Z");

beforeEach(() => {
  vi.clearAllMocks();
  mocks.markBookingPaymentManuallySettled.mockResolvedValue({
    bookingId: "booking-1",
    paymentId: "payment-1",
    effectiveAmountCents: 10000,
    creditAppliedCents: 0,
    previousStatus: "PAYMENT_PENDING",
    settledAt: new Date("2026-07-29T00:00:00Z"),
    outstandingIntentIds: [],
    memberFirstName: "Ada",
    memberEmail: "ada@example.org",
    // #2397: no outstanding extra — the overwhelmingly common shape.
    amountOwingCents: 10000,
    outstandingAdditionalCents: 0,
    settledAdditionalAmountCents: 0,
    uncollectedAdditionalCents: 0,
    sparedAdditionalPaymentIntentId: null,
  });
  mocks.bookingFindUnique.mockResolvedValue({
    lodgeId: "lodge-1",
    memberId: "member-1",
    checkIn: new Date("2026-08-10"),
    checkOut: new Date("2026-08-12"),
    finalPriceCents: 10000,
    discountCents: 0,
    promoAdjustmentCents: 0,
    member: { email: "ada@example.org", firstName: "Ada" },
    promoRedemption: null,
    _count: { guests: 2 },
  });
  mocks.sendBookingConfirmedEmail.mockResolvedValue({ status: "sent" });
  mocks.getProvisionalNonMemberChildSummary.mockResolvedValue(null);
});

describe("applyManualBookingPayment — confirmation email parity (M4)", () => {
  it("threads the split-parent provisionalGuests summary into the confirmation, matching the other settle-time sends", async () => {
    mocks.getProvisionalNonMemberChildSummary.mockResolvedValue({
      guestCount: 2,
      holdUntil: HOLD_UNTIL,
    });

    const result = await applyManualBookingPayment({
      bookingId: "booking-1",
      direction: "paid",
      actingMemberId: "admin-1",
      notifyMember: true,
      expectedAmountCents: 10000,
    });

    expect(result.receipt).toBe("queued");
    expect(mocks.getProvisionalNonMemberChildSummary).toHaveBeenCalledWith({
      id: "booking-1",
      memberId: "member-1",
    });
    expect(mocks.sendBookingConfirmedEmail).toHaveBeenCalledWith(
      { bookingId: "booking-1", recipientMemberId: "member-1" },
      "ada@example.org",
      "Ada",
      expect.any(Date),
      expect.any(Date),
      2,
      10000,
      expect.objectContaining({
        lodgeId: "lodge-1",
        provisionalGuests: { guestCount: 2, holdUntil: HOLD_UNTIL },
      }),
    );
  });

  it("omits the provisionalGuests option entirely for a non-split booking", async () => {
    await applyManualBookingPayment({
      bookingId: "booking-1",
      direction: "paid",
      actingMemberId: "admin-1",
      notifyMember: true,
      expectedAmountCents: 10000,
    });

    const options = mocks.sendBookingConfirmedEmail.mock.calls[0][7] as Record<
      string,
      unknown
    >;
    expect("provisionalGuests" in options).toBe(false);
  });
});

/**
 * #2397 F1 — the member's confirmation must not contradict the admin's receipt.
 *
 * When the admin says the cash did NOT cover an outstanding price increase, the
 * club records less than the booking is worth and goes on asking for the rest.
 * A confirmation reading "Total Paid: $121.00 — Payment has been processed
 * successfully" would tell the member the opposite of what the same HTTP
 * response tells the admin, and would re-create member-facing exactly the
 * contradiction this issue exists to remove.
 */
describe("applyManualBookingPayment — a balance left owing is stated to the member", () => {
  function primeUncoveredExtra(
    overrides: { sparedAdditionalPaymentIntentId?: string | null } = {},
  ) {
    mocks.markBookingPaymentManuallySettled.mockResolvedValue({
      bookingId: "booking-1",
      paymentId: "payment-1",
      // 12100 owing, 2100 extra left uncollected -> 10000 recorded.
      effectiveAmountCents: 10000,
      creditAppliedCents: 0,
      previousStatus: "PAYMENT_PENDING",
      settledAt: new Date("2026-07-29T00:00:00Z"),
      outstandingIntentIds: [],
      memberFirstName: "Ada",
      memberEmail: "ada@example.org",
      amountOwingCents: 12100,
      outstandingAdditionalCents: 2100,
      settledAdditionalAmountCents: 0,
      uncollectedAdditionalCents: 2100,
      sparedAdditionalPaymentIntentId:
        "sparedAdditionalPaymentIntentId" in overrides
          ? overrides.sparedAdditionalPaymentIntentId
          : "pi_additional",
    });
    mocks.bookingFindUnique.mockResolvedValue({
      lodgeId: "lodge-1",
      memberId: "member-1",
      checkIn: new Date("2026-08-10"),
      checkOut: new Date("2026-08-12"),
      finalPriceCents: 12100,
      discountCents: 0,
      promoAdjustmentCents: 0,
      member: { email: "ada@example.org", firstName: "Ada" },
      promoRedemption: null,
      _count: { guests: 2 },
    });
  }

  async function send() {
    await applyManualBookingPayment({
      bookingId: "booking-1",
      direction: "paid",
      actingMemberId: "admin-1",
      notifyMember: true,
      expectedAmountCents: 12100,
      additionalCoverage: {
        covered: false,
        expectedAdditionalAmountCents: 2100,
      },
    });
    return mocks.sendBookingConfirmedEmail.mock.calls[0];
  }

  it("passes the uncollected balance, so the confirmation cannot claim the booking was paid in full", async () => {
    primeUncoveredExtra();

    const call = await send();

    // The booking's PRICE is still what the money rows are derived from — the
    // template splits it into paid vs still owing.
    expect(call[6]).toBe(12100);
    expect(call[7]).toMatchObject({
      outstandingBalance: { amountCents: 2100, payableOnline: true },
    });
  });

  it("states the booking's PRICE and the uncollected extra when account credit paid part of the stay", async () => {
    // The shape neither of the tests above covers: credit > 0. A $200.00
    // booking with $50.00 of account credit applied and a $30.00 addition the
    // cash did not cover — so the admin handed over $120.00 and that is what
    // the club recorded. What the confirmation is given is still the booking's
    // PRICE and the uncollected delta, never the recorded cash, because the
    // template derives "Paid" as price − still-owing: $170.00, which is the
    // $120.00 of cash PLUS the $50.00 of credit that genuinely paid for part of
    // the stay. Passing the recorded cash as the total instead would tell the
    // member the club was still owed the credit they had already spent.
    mocks.markBookingPaymentManuallySettled.mockResolvedValue({
      bookingId: "booking-1",
      paymentId: "payment-1",
      effectiveAmountCents: 12000,
      creditAppliedCents: 5000,
      previousStatus: "PAYMENT_PENDING",
      settledAt: new Date("2026-07-29T00:00:00Z"),
      outstandingIntentIds: [],
      memberFirstName: "Ada",
      memberEmail: "ada@example.org",
      amountOwingCents: 15000,
      outstandingAdditionalCents: 3000,
      settledAdditionalAmountCents: 0,
      uncollectedAdditionalCents: 3000,
      sparedAdditionalPaymentIntentId: "pi_additional",
    });
    mocks.bookingFindUnique.mockResolvedValue({
      lodgeId: "lodge-1",
      memberId: "member-1",
      checkIn: new Date("2026-08-10"),
      checkOut: new Date("2026-08-12"),
      finalPriceCents: 20000,
      discountCents: 0,
      promoAdjustmentCents: 0,
      member: { email: "ada@example.org", firstName: "Ada" },
      promoRedemption: null,
      _count: { guests: 2 },
    });

    await applyManualBookingPayment({
      bookingId: "booking-1",
      direction: "paid",
      actingMemberId: "admin-1",
      notifyMember: true,
      expectedAmountCents: 15000,
      additionalCoverage: {
        covered: false,
        expectedAdditionalAmountCents: 3000,
      },
    });
    const call = mocks.sendBookingConfirmedEmail.mock.calls[0];

    expect(call[6]).toBe(20000);
    expect(call[7]).toMatchObject({
      outstandingBalance: { amountCents: 3000, payableOnline: true },
    });
  });

  it("says the member can pay it online only when the settlement really left a live card door open", async () => {
    primeUncoveredExtra({ sparedAdditionalPaymentIntentId: null });

    const call = await send();

    expect(call[7]).toMatchObject({
      outstandingBalance: { amountCents: 2100, payableOnline: false },
    });
  });

  it("sends the ordinary paid-in-full confirmation when the cash covered the extra", async () => {
    mocks.markBookingPaymentManuallySettled.mockResolvedValue({
      bookingId: "booking-1",
      paymentId: "payment-1",
      effectiveAmountCents: 12100,
      creditAppliedCents: 0,
      previousStatus: "PAYMENT_PENDING",
      settledAt: new Date("2026-07-29T00:00:00Z"),
      outstandingIntentIds: [],
      memberFirstName: "Ada",
      memberEmail: "ada@example.org",
      amountOwingCents: 12100,
      outstandingAdditionalCents: 2100,
      settledAdditionalAmountCents: 2100,
      uncollectedAdditionalCents: 0,
      sparedAdditionalPaymentIntentId: null,
    });

    await applyManualBookingPayment({
      bookingId: "booking-1",
      direction: "paid",
      actingMemberId: "admin-1",
      notifyMember: true,
      expectedAmountCents: 12100,
      additionalCoverage: {
        covered: true,
        expectedAdditionalAmountCents: 2100,
      },
    });

    const options = mocks.sendBookingConfirmedEmail.mock.calls[0][7] as Record<
      string,
      unknown
    >;
    expect("outstandingBalance" in options).toBe(false);
  });
});
