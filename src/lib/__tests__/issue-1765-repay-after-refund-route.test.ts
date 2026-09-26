import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// #1765 — repay-after-refund: a booking that was paid, fully (or partially)
// refunded, then repriced must be able to take a fresh card payment. The
// create-payment-intent route must discriminate refund history (fall through
// to a fresh mint) from crashed-webhook recovery (reconcile as before) on the
// intent's local PaymentTransaction status, never on the Stripe intent status
// (a refunded intent stays "succeeded" forever).

const mocks = vi.hoisted(() => ({
  queueSupersededPrimaryIntentCancellations: vi.fn().mockResolvedValue([]),
  markBookingPaymentSucceeded: vi.fn(),
  upsertPaymentIntentTransaction: vi.fn(),
  findPaymentTransactionByIntentId: vi.fn(),
  queueXeroInvoiceForPaidBooking: vi.fn(),
  deriveBookingAppliedCreditCents: vi.fn(),
}));

vi.mock("@/lib/prisma", () => {
  const payment = {
    upsert: vi.fn(),
  };
  return {
    prisma: {
      booking: {
        findUnique: vi.fn(),
      },
      payment,
      // #3638: the mint attaches its intent under lock(1), re-reading the
      // payment's source first; nothing here has switched to Internet Banking.
      $transaction: vi.fn(async (fn: (tx: unknown) => unknown) =>
        fn({
          $executeRaw: vi.fn(),
          payment: {
            findUnique: vi.fn().mockResolvedValue(null),
            upsert: payment.upsert,
          },
        })
      ),
    },
  };
});

vi.mock("@/lib/auth", () => ({
  auth: vi.fn(),
}));

vi.mock("@/lib/session-guards", () => ({
  requireActiveSessionUser: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/stripe", () => ({
  createPaymentIntent: vi.fn(),
  findOrCreateCustomer: vi.fn(),
  getPaymentIntent: vi.fn(),
}));

vi.mock("@/lib/booking-payment-cleanup", () => ({
  queueSupersededPrimaryIntentCancellations:
    mocks.queueSupersededPrimaryIntentCancellations,
}));

vi.mock("@/lib/payment-reconciliation", () => ({
  markBookingPaymentSucceeded: mocks.markBookingPaymentSucceeded,
}));

vi.mock("@/lib/payment-transactions", () => ({
  upsertPaymentIntentTransaction: mocks.upsertPaymentIntentTransaction,
  findPaymentTransactionByIntentId: mocks.findPaymentTransactionByIntentId,
}));

vi.mock("@/lib/xero-booking-invoice-queue", () => ({
  queueXeroInvoiceForPaidBooking: mocks.queueXeroInvoiceForPaidBooking,
}));

vi.mock("@/lib/member-credit", () => ({
  deriveBookingAppliedCreditCents: mocks.deriveBookingAppliedCreditCents,
  // #3369: the one home for the account-credit refusal four settlement paths
  // share. Real, not stubbed: the mock must not turn a refusal into a pass.
  requireMemberCreditRecipient: (memberId: string | null) => {
    if (!memberId) throw new Error("no account to credit (#3369)");
    return memberId;
  },
}));

vi.mock("@/lib/logger", () => ({
  default: {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import {
  createPaymentIntent as stripeCreatePaymentIntent,
  findOrCreateCustomer,
  getPaymentIntent,
} from "@/lib/stripe";
import { POST as createPaymentIntentRoute } from "@/app/api/payments/create-payment-intent/route";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

const mockPrisma = prisma as unknown as {
  booking: { findUnique: ReturnType<typeof vi.fn> };
  payment: { upsert: ReturnType<typeof vi.fn> };
};

const mockAuth = auth as ReturnType<typeof vi.fn>;
const mockStripeCreatePaymentIntent =
  stripeCreatePaymentIntent as ReturnType<typeof vi.fn>;
const mockFindOrCreateCustomer = findOrCreateCustomer as ReturnType<typeof vi.fn>;
const mockGetPaymentIntent = getPaymentIntent as ReturnType<typeof vi.fn>;

// The production repro, values verbatim from #1765: paid 19500, fully
// refunded, promo repriced the booking to 9000, no applied account credit.
const ORIGINAL_PRICE = 19500;
const REPRICED_FINAL = 9000;

function makeRepayBooking(paymentOverrides: Record<string, unknown> = {}) {
  return {
    id: "booking-1",
    memberId: "member-1",
    status: "PAYMENT_PENDING",
    finalPriceCents: REPRICED_FINAL,
    hasNonMembers: false,
    organiserSettled: false,
    member: {
      id: "member-1",
      email: "member@example.com",
      firstName: "Test",
      lastName: "Member",
    },
    guests: [],
    payment: {
      id: "pay-1",
      stripePaymentIntentId: "pi_refunded",
      status: "REFUNDED",
      source: "STRIPE",
      ...paymentOverrides,
    },
  };
}

function makeRequest() {
  return new NextRequest(
    "http://localhost/api/payments/create-payment-intent",
    {
      method: "POST",
      body: JSON.stringify({ bookingId: "booking-1" }),
      headers: { "Content-Type": "application/json" },
    }
  );
}

function mockRefundedIntent(
  id = "pi_refunded",
  amount = ORIGINAL_PRICE
) {
  mockGetPaymentIntent.mockResolvedValue({
    id,
    amount,
    status: "succeeded",
    // A succeeded intent still exposes its client_secret; the route must
    // never hand it back for refund history.
    client_secret: "cs_refunded_history",
    payment_method: "pm_original",
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({
    user: { id: "member-1", role: "MEMBER", accessRoles: [{ role: "USER" }] },
  });
  mockFindOrCreateCustomer.mockResolvedValue({ id: "cus_123" });
  mocks.deriveBookingAppliedCreditCents.mockResolvedValue(0);
  mocks.queueSupersededPrimaryIntentCancellations.mockResolvedValue([]);
  mockPrisma.payment.upsert.mockResolvedValue({ id: "pay-1" });
  mockStripeCreatePaymentIntent.mockResolvedValue({
    id: "pi_fresh",
    client_secret: "cs_fresh",
    amount: REPRICED_FINAL,
  });
  mocks.queueXeroInvoiceForPaidBooking.mockResolvedValue({
    queueOperationId: "xero-op-1",
    message: "queued",
  });
});

describe("#1765 repay-after-refund: create-payment-intent", () => {
  it("(a) mints a fresh card-entry intent at the effective price for fully-refunded history instead of reconciling it", async () => {
    mockPrisma.booking.findUnique.mockResolvedValue(makeRepayBooking());
    mockRefundedIntent();
    mocks.findPaymentTransactionByIntentId.mockResolvedValue({
      id: "txn-refunded",
      status: "REFUNDED",
      amountCents: ORIGINAL_PRICE,
      refundedAmountCents: ORIGINAL_PRICE,
    });

    const res = await createPaymentIntentRoute(makeRequest());
    const data = await res.json();

    expect(res.status).toBe(200);
    // Fresh secret, never the refunded intent's, never alreadyPaid.
    expect(data.clientSecret).toBe("cs_fresh");
    expect(data.paymentIntentId).toBe("pi_fresh");
    expect(data.alreadyPaid).toBeUndefined();
    // Refund history is never re-admitted as settlement.
    expect(mocks.markBookingPaymentSucceeded).not.toHaveBeenCalled();
    expect(mocks.queueXeroInvoiceForPaidBooking).not.toHaveBeenCalled();
    // The repay is minted at the current effective price on the card-entry
    // path (createPaymentIntent, not a saved-method charge).
    expect(mockStripeCreatePaymentIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        amountCents: REPRICED_FINAL,
        idempotencyKey: "pi_booking-1_repay_pi_refunded",
      })
    );
    // The fresh PRIMARY transaction lands on the SAME payment row; the
    // refunded transaction row is never written to.
    expect(mocks.upsertPaymentIntentTransaction).toHaveBeenCalledTimes(1);
    expect(mocks.upsertPaymentIntentTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentId: "pay-1",
        paymentIntentId: "pi_fresh",
        amountCents: REPRICED_FINAL,
        status: "PROCESSING",
        reason: "repay_after_refund",
      })
    );
    // The sweep for older stranded pending intents runs at the new effective
    // price (it cannot touch the refunded transaction: PENDING/PROCESSING
    // filter — locked in by the reconciliation-guard test file).
    expect(
      mocks.queueSupersededPrimaryIntentCancellations
    ).toHaveBeenCalledWith(expect.anything(), {
      bookingId: "booking-1",
      paymentId: "pay-1",
      newFinalPriceCents: REPRICED_FINAL,
    });
  });

  it("(a2) the repay mint is credit-reduced: effective price = finalPrice − applied credit", async () => {
    mockPrisma.booking.findUnique.mockResolvedValue(makeRepayBooking());
    mockRefundedIntent();
    mocks.findPaymentTransactionByIntentId.mockResolvedValue({
      id: "txn-refunded",
      status: "REFUNDED",
    });
    mocks.deriveBookingAppliedCreditCents.mockResolvedValue(2000);

    const res = await createPaymentIntentRoute(makeRequest());

    expect(res.status).toBe(200);
    expect(mockStripeCreatePaymentIntent).toHaveBeenCalledWith(
      expect.objectContaining({ amountCents: REPRICED_FINAL - 2000 })
    );
  });

  it("(b) a saved payment method on file does not divert the repay off the card-entry path", async () => {
    mockPrisma.booking.findUnique.mockResolvedValue(
      makeRepayBooking({
        stripePaymentMethodId: "pm_saved",
        stripeCustomerId: "cus_123",
      })
    );
    mockRefundedIntent();
    mocks.findPaymentTransactionByIntentId.mockResolvedValue({
      id: "txn-refunded",
      status: "REFUNDED",
    });

    const res = await createPaymentIntentRoute(makeRequest());
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.clientSecret).toBe("cs_fresh");
    expect(mockStripeCreatePaymentIntent).toHaveBeenCalledWith(
      expect.objectContaining({ amountCents: REPRICED_FINAL })
    );
    expect(mocks.markBookingPaymentSucceeded).not.toHaveBeenCalled();
  });

  it("(c) crashed-webhook recovery still reconciles: transaction stuck PROCESSING, intent succeeded", async () => {
    mockPrisma.booking.findUnique.mockResolvedValue(
      makeRepayBooking({ status: "PROCESSING", stripePaymentIntentId: "pi_stuck" })
    );
    mockGetPaymentIntent.mockResolvedValue({
      id: "pi_stuck",
      amount: REPRICED_FINAL,
      status: "succeeded",
      payment_method: "pm_123",
    });
    mocks.findPaymentTransactionByIntentId.mockResolvedValue({
      id: "txn-stuck",
      status: "PROCESSING",
    });
    mocks.markBookingPaymentSucceeded.mockResolvedValue({
      outcome: "paid",
      bookingId: "booking-1",
      bumpedBookingIds: [],
    });

    const res = await createPaymentIntentRoute(makeRequest());
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.alreadyPaid).toBe(true);
    expect(data).not.toHaveProperty("paymentIntentId");
    expect(mocks.markBookingPaymentSucceeded).toHaveBeenCalledWith({
      bookingId: "booking-1",
      paymentIntentId: "pi_stuck",
      amountCents: REPRICED_FINAL,
      paymentMethodId: "pm_123",
      format: CLUB_FORMAT_TEST,
    });
    expect(mocks.queueXeroInvoiceForPaidBooking).toHaveBeenCalledWith({
      bookingId: "booking-1",
      createdByMemberId: "member-1",
    });
    expect(mockStripeCreatePaymentIntent).not.toHaveBeenCalled();
  });

  it("(c2) legacy pre-ledger recovery (no transaction row, payment PROCESSING) still reconciles", async () => {
    mockPrisma.booking.findUnique.mockResolvedValue(
      makeRepayBooking({ status: "PROCESSING" })
    );
    mockGetPaymentIntent.mockResolvedValue({
      id: "pi_refunded",
      amount: REPRICED_FINAL,
      status: "succeeded",
      payment_method: "pm_123",
    });
    mocks.findPaymentTransactionByIntentId.mockResolvedValue(null);
    mocks.markBookingPaymentSucceeded.mockResolvedValue({
      outcome: "paid",
      bookingId: "booking-1",
      bumpedBookingIds: [],
    });

    const res = await createPaymentIntentRoute(makeRequest());
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.alreadyPaid).toBe(true);
    expect(mocks.markBookingPaymentSucceeded).toHaveBeenCalled();
    expect(mockStripeCreatePaymentIntent).not.toHaveBeenCalled();
  });

  it("(d-ii) after the repay settles (booking PAID) another call cannot mint again", async () => {
    mockPrisma.booking.findUnique.mockResolvedValue({
      ...makeRepayBooking({ status: "PARTIALLY_REFUNDED" }),
      status: "PAID",
    });

    const res = await createPaymentIntentRoute(makeRequest());

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: "Booking is not in a payable state",
    });
    expect(mockGetPaymentIntent).not.toHaveBeenCalled();
    expect(mockStripeCreatePaymentIntent).not.toHaveBeenCalled();
  });

  it("(d-iii) PARTIALLY_REFUNDED transaction history also falls through to a fresh mint", async () => {
    mockPrisma.booking.findUnique.mockResolvedValue(
      makeRepayBooking({ status: "PARTIALLY_REFUNDED" })
    );
    mockRefundedIntent();
    mocks.findPaymentTransactionByIntentId.mockResolvedValue({
      id: "txn-partial",
      status: "PARTIALLY_REFUNDED",
      amountCents: ORIGINAL_PRICE,
      refundedAmountCents: 5000,
    });

    const res = await createPaymentIntentRoute(makeRequest());
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.clientSecret).toBe("cs_fresh");
    expect(mocks.markBookingPaymentSucceeded).not.toHaveBeenCalled();
  });

  it("(d-iv) legacy pre-ledger fully-refunded payment (no transaction row) falls through on the aggregate fallback", async () => {
    mockPrisma.booking.findUnique.mockResolvedValue(makeRepayBooking());
    mockRefundedIntent();
    mocks.findPaymentTransactionByIntentId.mockResolvedValue(null);

    const res = await createPaymentIntentRoute(makeRequest());
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.clientSecret).toBe("cs_fresh");
    expect(mocks.markBookingPaymentSucceeded).not.toHaveBeenCalled();
  });

  it("(e) idempotency keys are stable within a repay generation, unique across generations, and never the initial key", async () => {
    mocks.findPaymentTransactionByIntentId.mockResolvedValue({
      id: "txn-refunded",
      status: "REFUNDED",
    });

    // Generation 1, attempt 1.
    mockPrisma.booking.findUnique.mockResolvedValue(makeRepayBooking());
    mockRefundedIntent("pi_refunded");
    await createPaymentIntentRoute(makeRequest());
    const keyGen1Attempt1 =
      mockStripeCreatePaymentIntent.mock.calls[0][0].idempotencyKey;

    // Generation 1, attempt 2 (the first mint never committed, the pointer
    // still holds the refunded intent) — the key must be identical so Stripe
    // replays instead of erroring.
    mockStripeCreatePaymentIntent.mockClear();
    await createPaymentIntentRoute(makeRequest());
    const keyGen1Attempt2 =
      mockStripeCreatePaymentIntent.mock.calls[0][0].idempotencyKey;

    // Generation 2: the first repay intent itself succeeded and was later
    // refunded (pointer moved to it), booking repriced again.
    mockStripeCreatePaymentIntent.mockClear();
    mockPrisma.booking.findUnique.mockResolvedValue(
      makeRepayBooking({ stripePaymentIntentId: "pi_repay_gen1" })
    );
    mockRefundedIntent("pi_repay_gen1", REPRICED_FINAL);
    await createPaymentIntentRoute(makeRequest());
    const keyGen2 = mockStripeCreatePaymentIntent.mock.calls[0][0].idempotencyKey;

    expect(keyGen1Attempt1).toBe("pi_booking-1_repay_pi_refunded");
    expect(keyGen1Attempt2).toBe(keyGen1Attempt1);
    expect(keyGen2).toBe("pi_booking-1_repay_pi_repay_gen1");
    expect(keyGen2).not.toBe(keyGen1Attempt1);
    expect([keyGen1Attempt1, keyGen2]).not.toContain("pi_booking-1_initial");
    // Disjoint from the non-repay scheme for the same pointers.
    expect([keyGen1Attempt1, keyGen2]).not.toContain(
      "pi_booking-1_pi_refunded"
    );
    expect([keyGen1Attempt1, keyGen2]).not.toContain(
      "pi_booking-1_pi_repay_gen1"
    );
  });

  it("keeps the non-repay idempotency key scheme unchanged for ordinary mints", async () => {
    mockPrisma.booking.findUnique.mockResolvedValue({
      ...makeRepayBooking(),
      payment: null,
    });

    const res = await createPaymentIntentRoute(makeRequest());

    expect(res.status).toBe(200);
    expect(mockStripeCreatePaymentIntent).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: "pi_booking-1_initial" })
    );
  });
});
