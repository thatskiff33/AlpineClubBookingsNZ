import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { BookingStatus } from "@prisma/client";

// Issue #1641 — a member who applies account credit to a CARD booking now pays the
// EFFECTIVE (credit-reduced) amount, not the full finalPriceCents.
//
// This file was the verify-only reproduction pinning the double-charge; it is
// flipped here to pin the FIX. It drives the create-payment-intent route (the card
// charge origin) and asserts:
//   1. the Stripe intent is minted at the effective 7000 (was 10000);
//   2. the Payment mirror carries the split so amountCents + creditAppliedCents =
//      finalPriceCents (was amountCents=full, no mirror);
//   3. a no-credit booking still charges full price with a zero mirror;
//   4. a fully credit-covered booking is REFUSED (the zero-dollar path is create-
//      time), never minting a $0 Stripe intent;
//   5. the reuse/supersede decision keys on the effective price.

const mocks = vi.hoisted(() => ({
  queueSupersededPrimaryIntentCancellations: vi.fn().mockResolvedValue([]),
  markBookingPaymentSucceeded: vi.fn(),
  upsertPaymentIntentTransaction: vi.fn(),
  queueXeroInvoiceForPaidBooking: vi.fn(),
  deriveBookingAppliedCreditCents: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: {
      findUnique: vi.fn(),
    },
    payment: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
  },
}));

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
}));

vi.mock("@/lib/xero-booking-invoice-queue", () => ({
  queueXeroInvoiceForPaidBooking: mocks.queueXeroInvoiceForPaidBooking,
}));

// The route derives the applied credit from the ledger; drive it directly.
vi.mock("@/lib/member-credit", () => ({
  deriveBookingAppliedCreditCents: mocks.deriveBookingAppliedCreditCents,
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
// The real credit-application helper — the SAME function booking-create uses
// (booking-create.ts:736) to decide how much credit to consume and the effective
// price. It proves the effective figure the fixed card path must charge.
import { calculateBookingCreditApplication } from "@/lib/policies/booking-route-decisions";
import { POST as createPaymentIntentRoute } from "@/app/api/payments/create-payment-intent/route";

const mockPrisma = prisma as unknown as {
  booking: { findUnique: ReturnType<typeof vi.fn> };
  payment: {
    findUnique: ReturnType<typeof vi.fn>;
    upsert: ReturnType<typeof vi.fn>;
  };
};

const mockAuth = auth as ReturnType<typeof vi.fn>;
const mockStripeCreatePaymentIntent =
  stripeCreatePaymentIntent as ReturnType<typeof vi.fn>;
const mockFindOrCreateCustomer =
  findOrCreateCustomer as ReturnType<typeof vi.fn>;
const mockGetPaymentIntent = getPaymentIntent as ReturnType<typeof vi.fn>;

const FINAL_PRICE_CENTS = 10_000;
const APPLIED_CREDIT_CENTS = 3_000;
const EFFECTIVE_CENTS = 7_000;

function makeCardBooking(overrides: Record<string, unknown> = {}) {
  return {
    id: "booking-1641",
    memberId: "member-1",
    status: "PAYMENT_PENDING",
    hasNonMembers: false,
    organiserSettled: false,
    finalPriceCents: FINAL_PRICE_CENTS,
    member: {
      id: "member-1",
      email: "member@example.com",
      firstName: "Test",
      lastName: "Member",
    },
    guests: [],
    payment: null,
    ...overrides,
  };
}

function makeRequest() {
  return new NextRequest(
    "http://localhost/api/payments/create-payment-intent",
    {
      method: "POST",
      body: JSON.stringify({ bookingId: "booking-1641" }),
      headers: { "Content-Type": "application/json" },
    }
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({
    user: { id: "member-1", role: "MEMBER", accessRoles: [{ role: "USER" }] },
  });
  mockFindOrCreateCustomer.mockResolvedValue({ id: "cus_1641" });
  mockPrisma.payment.upsert.mockResolvedValue({ id: "pay-1641" });
  mocks.deriveBookingAppliedCreditCents.mockResolvedValue(APPLIED_CREDIT_CENTS);
});

describe("issue #1641: card booking with applied credit pays the effective amount", () => {
  it("mints the Stripe intent at the effective price and mirrors the credit split", async () => {
    // The credit decision booking-create made: 3000 consumed, effective 7000.
    const creditDecision = calculateBookingCreditApplication({
      requestedCreditCents: APPLIED_CREDIT_CENTS,
      creditBalanceCents: 5_000,
      finalPriceCents: FINAL_PRICE_CENTS,
      status: BookingStatus.PAYMENT_PENDING,
    });
    expect(creditDecision.creditAppliedCents).toBe(APPLIED_CREDIT_CENTS);
    expect(creditDecision.effectivePriceCents).toBe(EFFECTIVE_CENTS);

    mockPrisma.booking.findUnique.mockResolvedValue(makeCardBooking());
    mockStripeCreatePaymentIntent.mockResolvedValue({
      id: "pi_1641",
      client_secret: "cs_1641",
      amount: EFFECTIVE_CENTS,
    });

    const res = await createPaymentIntentRoute(makeRequest());
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.clientSecret).toBe("cs_1641");

    // THE FIX: intent minted at the effective 7000, not the full 10000.
    const intentCall = mockStripeCreatePaymentIntent.mock.calls[0][0];
    expect(intentCall.amountCents).toBe(EFFECTIVE_CENTS);

    // Payment mirror invariant: amountCents + creditAppliedCents = finalPriceCents.
    const paymentUpsert = mockPrisma.payment.upsert.mock.calls[0][0];
    expect(paymentUpsert.create.amountCents).toBe(EFFECTIVE_CENTS);
    expect(paymentUpsert.create.creditAppliedCents).toBe(APPLIED_CREDIT_CENTS);
    expect(
      paymentUpsert.create.amountCents + paymentUpsert.create.creditAppliedCents
    ).toBe(FINAL_PRICE_CENTS);
    // The update branch corrects a legacy full-price payment forward on re-mint.
    expect(paymentUpsert.update.amountCents).toBe(EFFECTIVE_CENTS);
    expect(paymentUpsert.update.creditAppliedCents).toBe(APPLIED_CREDIT_CENTS);

    // No double-charge: card charge + applied credit = exactly the booking price.
    expect(intentCall.amountCents + creditDecision.creditAppliedCents).toBe(
      FINAL_PRICE_CENTS
    );
  });

  it("charges full price with a zero mirror when no credit was applied", async () => {
    mocks.deriveBookingAppliedCreditCents.mockResolvedValue(0);
    mockPrisma.booking.findUnique.mockResolvedValue(makeCardBooking());
    mockStripeCreatePaymentIntent.mockResolvedValue({
      id: "pi_full",
      client_secret: "cs_full",
      amount: FINAL_PRICE_CENTS,
    });

    const res = await createPaymentIntentRoute(makeRequest());
    expect(res.status).toBe(200);
    expect(mockStripeCreatePaymentIntent.mock.calls[0][0].amountCents).toBe(
      FINAL_PRICE_CENTS
    );
    const paymentUpsert = mockPrisma.payment.upsert.mock.calls[0][0];
    expect(paymentUpsert.create.amountCents).toBe(FINAL_PRICE_CENTS);
    expect(paymentUpsert.create.creditAppliedCents).toBe(0);
  });

  it("refuses a fully credit-covered booking instead of minting a $0 intent", async () => {
    // A fully-covered booking is confirmed at $0 by booking-create's zero-dollar
    // branch (effectivePriceCents === 0) BEFORE any intent; the route only needs
    // to guard defensively if one ever reaches it. Prove the create-time signal:
    expect(
      calculateBookingCreditApplication({
        requestedCreditCents: FINAL_PRICE_CENTS,
        creditBalanceCents: FINAL_PRICE_CENTS,
        finalPriceCents: FINAL_PRICE_CENTS,
        status: BookingStatus.PAYMENT_PENDING,
      }).effectivePriceCents
    ).toBe(0);

    mocks.deriveBookingAppliedCreditCents.mockResolvedValue(FINAL_PRICE_CENTS);
    mockPrisma.booking.findUnique.mockResolvedValue(makeCardBooking());

    const res = await createPaymentIntentRoute(makeRequest());
    const data = await res.json();

    expect(res.status).toBe(400);
    expect(data.error).toContain("Fully credit-covered");
    expect(mockStripeCreatePaymentIntent).not.toHaveBeenCalled();
    expect(mockPrisma.payment.upsert).not.toHaveBeenCalled();
  });

  it("reuses an existing intent already at the effective price", async () => {
    mockPrisma.booking.findUnique.mockResolvedValue(
      makeCardBooking({
        payment: {
          id: "pay-1641",
          stripePaymentIntentId: "pi_existing",
          source: null,
        },
      })
    );
    mockGetPaymentIntent.mockResolvedValue({
      id: "pi_existing",
      status: "requires_payment_method",
      amount: EFFECTIVE_CENTS,
      client_secret: "cs_existing",
    });

    const res = await createPaymentIntentRoute(makeRequest());
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.clientSecret).toBe("cs_existing");
    // Reused, not re-minted, and not superseded.
    expect(mockStripeCreatePaymentIntent).not.toHaveBeenCalled();
    expect(mocks.queueSupersededPrimaryIntentCancellations).not.toHaveBeenCalled();
  });

  it("supersedes a legacy full-price intent and re-mints at the effective price", async () => {
    mockPrisma.booking.findUnique.mockResolvedValue(
      makeCardBooking({
        payment: {
          id: "pay-1641",
          stripePaymentIntentId: "pi_legacy_full",
          source: null,
        },
      })
    );
    // A legacy intent minted before the fix at the FULL price.
    mockGetPaymentIntent.mockResolvedValue({
      id: "pi_legacy_full",
      status: "requires_payment_method",
      amount: FINAL_PRICE_CENTS,
      client_secret: "cs_legacy_full",
    });
    mockStripeCreatePaymentIntent.mockResolvedValue({
      id: "pi_new",
      client_secret: "cs_new",
      amount: EFFECTIVE_CENTS,
    });

    const res = await createPaymentIntentRoute(makeRequest());
    const data = await res.json();

    expect(res.status).toBe(200);
    // The stale full-price intent is queued for cancellation at the NEW effective
    // amount, and a fresh intent is minted at the effective price.
    expect(mocks.queueSupersededPrimaryIntentCancellations).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ newFinalPriceCents: EFFECTIVE_CENTS })
    );
    expect(mockStripeCreatePaymentIntent.mock.calls[0][0].amountCents).toBe(
      EFFECTIVE_CENTS
    );
    expect(data.clientSecret).toBe("cs_new");
  });
});
