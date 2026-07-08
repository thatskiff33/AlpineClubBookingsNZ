import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  queueSupersededPrimaryIntentCancellations: vi.fn().mockResolvedValue([]),
  markBookingPaymentSucceeded: vi.fn(),
  markBookingSetupIntentSucceeded: vi.fn(),
  logAudit: vi.fn(),
  upsertPaymentIntentTransaction: vi.fn(),
  sendBookingConfirmedEmail: vi.fn(),
  queueXeroInvoiceForPaidBooking: vi.fn(),
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
  createSetupIntent: vi.fn(),
  findOrCreateCustomer: vi.fn(),
  getPaymentIntent: vi.fn(),
  getSetupIntent: vi.fn(),
}));

vi.mock("@/lib/booking-payment-cleanup", () => ({
  queueSupersededPrimaryIntentCancellations:
    mocks.queueSupersededPrimaryIntentCancellations,
}));

vi.mock("@/lib/payment-reconciliation", () => ({
  markBookingPaymentSucceeded: mocks.markBookingPaymentSucceeded,
  markBookingSetupIntentSucceeded: mocks.markBookingSetupIntentSucceeded,
}));

vi.mock("@/lib/payment-transactions", () => ({
  upsertPaymentIntentTransaction: mocks.upsertPaymentIntentTransaction,
}));

vi.mock("@/lib/audit", () => ({
  logAudit: mocks.logAudit,
}));

vi.mock("@/lib/email", () => ({
  sendBookingConfirmedEmail: mocks.sendBookingConfirmedEmail,
}));

vi.mock("@/lib/xero-booking-invoice-queue", () => ({
  queueXeroInvoiceForPaidBooking: mocks.queueXeroInvoiceForPaidBooking,
}));

// #1641 — these fixtures apply no account credit, so the effective price equals
// finalPriceCents and every existing intent-amount assertion is unchanged.
vi.mock("@/lib/member-credit", () => ({
  deriveBookingAppliedCreditCents: vi.fn().mockResolvedValue(0),
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
  createSetupIntent as stripeCreateSetupIntent,
  findOrCreateCustomer,
  getPaymentIntent,
  getSetupIntent,
} from "@/lib/stripe";
import { POST as createPaymentIntentRoute } from "@/app/api/payments/create-payment-intent/route";
import { POST as createSetupIntentRoute } from "@/app/api/payments/create-setup-intent/route";
import { POST as confirmPaymentRoute } from "@/app/api/bookings/[id]/confirm-payment/route";

const mockPrisma = prisma as unknown as {
  booking: { findUnique: ReturnType<typeof vi.fn> };
  payment: {
    findUnique: ReturnType<typeof vi.fn>;
    upsert: ReturnType<typeof vi.fn>;
  };
};

const mockAuth = auth as ReturnType<typeof vi.fn>;
const mockStripeCreatePaymentIntent = stripeCreatePaymentIntent as ReturnType<typeof vi.fn>;
const mockStripeCreateSetupIntent = stripeCreateSetupIntent as ReturnType<typeof vi.fn>;
const mockFindOrCreateCustomer = findOrCreateCustomer as ReturnType<typeof vi.fn>;
const mockGetPaymentIntent = getPaymentIntent as ReturnType<typeof vi.fn>;
const mockGetSetupIntent = getSetupIntent as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({ user: { id: "member-1", role: "MEMBER", accessRoles: [{ role: "USER" }] } });
  mockFindOrCreateCustomer.mockResolvedValue({ id: "cus_123" });
  mocks.markBookingPaymentSucceeded.mockResolvedValue({
    outcome: "paid",
    bookingId: "booking-1",
    bumpedBookingIds: [],
  });
  mocks.sendBookingConfirmedEmail.mockResolvedValue(undefined);
  mocks.queueXeroInvoiceForPaidBooking.mockResolvedValue({
    queueOperationId: "xero-op-1",
    message: "queued",
  });
});

describe("payment intent routes", () => {
  it("reuses an existing retryable payment intent instead of replacing it", async () => {
    mockPrisma.booking.findUnique.mockResolvedValue({
      id: "booking-1",
      memberId: "member-1",
      status: "CONFIRMED",
      finalPriceCents: 12500,
      member: {
        id: "member-1",
        email: "member@example.com",
        firstName: "Test",
        lastName: "Member",
      },
      payment: {
        stripePaymentIntentId: "pi_existing",
        status: "FAILED",
      },
    });
    mockGetPaymentIntent.mockResolvedValue({
      id: "pi_existing",
      client_secret: "cs_existing",
      status: "requires_payment_method",
      amount: 12500,
    });

    const req = new NextRequest("http://localhost/api/payments/create-payment-intent", {
      method: "POST",
      body: JSON.stringify({ bookingId: "booking-1" }),
      headers: { "Content-Type": "application/json" },
    });

    const res = await createPaymentIntentRoute(req);
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.clientSecret).toBe("cs_existing");
    expect(mockStripeCreatePaymentIntent).not.toHaveBeenCalled();
  });

  it("supersedes a stale-amount intent and mints a fresh one at the current price (#1161)", async () => {
    mockPrisma.booking.findUnique.mockResolvedValue({
      id: "booking-1",
      memberId: "member-1",
      status: "PAYMENT_PENDING",
      finalPriceCents: 15000,
      member: {
        id: "member-1",
        email: "member@example.com",
        firstName: "Test",
        lastName: "Member",
      },
      payment: {
        id: "pay-1",
        stripePaymentIntentId: "pi_stale",
        status: "PENDING",
      },
    });
    // Minted at $125 before the member edited the unpaid booking to $150.
    mockGetPaymentIntent.mockResolvedValue({
      id: "pi_stale",
      client_secret: "cs_stale",
      status: "requires_payment_method",
      amount: 12500,
    });
    mockFindOrCreateCustomer.mockResolvedValue({ id: "cus_1" });
    mockStripeCreatePaymentIntent.mockResolvedValue({
      id: "pi_fresh",
      client_secret: "cs_fresh",
      amount: 15000,
    });
    mockPrisma.payment.upsert.mockResolvedValue({ id: "pay-1" });

    const req = new NextRequest("http://localhost/api/payments/create-payment-intent", {
      method: "POST",
      body: JSON.stringify({ bookingId: "booking-1" }),
      headers: { "Content-Type": "application/json" },
    });

    const res = await createPaymentIntentRoute(req);
    const data = await res.json();

    expect(res.status).toBe(200);
    // The stale secret is never disclosed; the fresh intent carries the
    // current price and the stale one is queued for cancellation.
    expect(data.clientSecret).toBe("cs_fresh");
    expect(mocks.queueSupersededPrimaryIntentCancellations).toHaveBeenCalledWith(
      expect.anything(),
      {
        bookingId: "booking-1",
        paymentId: "pay-1",
        newFinalPriceCents: 15000,
      },
    );
    expect(mockStripeCreatePaymentIntent).toHaveBeenCalledWith(
      expect.objectContaining({ amountCents: 15000 }),
    );
  });

  it("does not disclose an existing payment intent client secret to a non-owner", async () => {
    mockAuth.mockResolvedValue({ user: { id: "member-2", role: "MEMBER", accessRoles: [{ role: "USER" }] } });
    mockPrisma.booking.findUnique.mockResolvedValue({
      id: "booking-1",
      memberId: "member-1",
      status: "CONFIRMED",
      finalPriceCents: 12500,
      member: {
        id: "member-1",
        email: "member@example.com",
        firstName: "Test",
        lastName: "Member",
      },
      payment: {
        stripePaymentIntentId: "pi_existing",
        status: "FAILED",
      },
    });

    const req = new NextRequest("http://localhost/api/payments/create-payment-intent", {
      method: "POST",
      body: JSON.stringify({ bookingId: "booking-1" }),
      headers: { "Content-Type": "application/json" },
    });

    const res = await createPaymentIntentRoute(req);

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: "Forbidden" });
    expect(mockGetPaymentIntent).not.toHaveBeenCalled();
    expect(mockStripeCreatePaymentIntent).not.toHaveBeenCalled();
  });

  it("reconciles a succeeded Stripe payment before asking for another card", async () => {
    mockPrisma.booking.findUnique.mockResolvedValue({
      id: "booking-1",
      memberId: "member-1",
      status: "CONFIRMED",
      finalPriceCents: 12500,
      member: {
        id: "member-1",
        email: "member@example.com",
        firstName: "Test",
        lastName: "Member",
      },
      payment: {
        stripePaymentIntentId: "pi_existing",
        status: "PROCESSING",
      },
    });
    mockGetPaymentIntent.mockResolvedValue({
      id: "pi_existing",
      amount: 12500,
      payment_method: "pm_123",
      status: "succeeded",
    });

    const req = new NextRequest("http://localhost/api/payments/create-payment-intent", {
      method: "POST",
      body: JSON.stringify({ bookingId: "booking-1" }),
      headers: { "Content-Type": "application/json" },
    });

    const res = await createPaymentIntentRoute(req);
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.alreadyPaid).toBe(true);
    expect(mocks.markBookingPaymentSucceeded).toHaveBeenCalledWith({
      bookingId: "booking-1",
      paymentIntentId: "pi_existing",
      amountCents: 12500,
      paymentMethodId: "pm_123",
    });
    expect(mocks.queueXeroInvoiceForPaidBooking).toHaveBeenCalledWith({
      bookingId: "booking-1",
      createdByMemberId: "member-1",
    });
    expect(mockStripeCreatePaymentIntent).not.toHaveBeenCalled();
  });

  it("reuses an existing retryable setup intent", async () => {
    mockPrisma.booking.findUnique.mockResolvedValue({
      id: "booking-1",
      memberId: "member-1",
      status: "PENDING",
      hasNonMembers: true,
      finalPriceCents: 12500,
      member: {
        id: "member-1",
        email: "member@example.com",
        firstName: "Test",
        lastName: "Member",
      },
      payment: {
        stripeSetupIntentId: "seti_existing",
      },
    });
    mockGetSetupIntent.mockResolvedValue({
      id: "seti_existing",
      client_secret: "seti_secret",
      status: "requires_payment_method",
    });

    const req = new NextRequest("http://localhost/api/payments/create-setup-intent", {
      method: "POST",
      body: JSON.stringify({ bookingId: "booking-1" }),
      headers: { "Content-Type": "application/json" },
    });

    const res = await createSetupIntentRoute(req);
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.clientSecret).toBe("seti_secret");
    expect(mockStripeCreateSetupIntent).not.toHaveBeenCalled();
  });

  it("does not disclose an existing setup intent client secret to a non-owner", async () => {
    mockAuth.mockResolvedValue({ user: { id: "member-2", role: "MEMBER", accessRoles: [{ role: "USER" }] } });
    mockPrisma.booking.findUnique.mockResolvedValue({
      id: "booking-1",
      memberId: "member-1",
      status: "PENDING",
      hasNonMembers: true,
      finalPriceCents: 12500,
      member: {
        id: "member-1",
        email: "member@example.com",
        firstName: "Test",
        lastName: "Member",
      },
      payment: {
        stripeSetupIntentId: "seti_existing",
      },
    });

    const req = new NextRequest("http://localhost/api/payments/create-setup-intent", {
      method: "POST",
      body: JSON.stringify({ bookingId: "booking-1" }),
      headers: { "Content-Type": "application/json" },
    });

    const res = await createSetupIntentRoute(req);

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: "Forbidden" });
    expect(mockGetSetupIntent).not.toHaveBeenCalled();
    expect(mockStripeCreateSetupIntent).not.toHaveBeenCalled();
  });

  it("rejects immediate payment intents for pending non-member hold bookings", async () => {
    mockPrisma.booking.findUnique.mockResolvedValue({
      id: "booking-1",
      memberId: "member-1",
      status: "PENDING",
      hasNonMembers: true,
      finalPriceCents: 12500,
      member: {
        id: "member-1",
        email: "member@example.com",
        firstName: "Test",
        lastName: "Member",
      },
      guests: [{ id: "guest-1", isMember: false }],
      payment: null,
    });

    const req = new NextRequest("http://localhost/api/payments/create-payment-intent", {
      method: "POST",
      body: JSON.stringify({ bookingId: "booking-1" }),
      headers: { "Content-Type": "application/json" },
    });

    const res = await createPaymentIntentRoute(req);

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error:
        "This booking must stay in the saved-card flow until the non-member hold window expires",
    });
    expect(mockStripeCreatePaymentIntent).not.toHaveBeenCalled();
  });

  it("confirms a successful payment immediately for the booking page", async () => {
    mockPrisma.payment.findUnique.mockResolvedValue({
      id: "payment-1",
      stripePaymentIntentId: "pi_success",
      status: "PROCESSING",
      booking: {
        memberId: "member-1",
        finalPriceCents: 12500,
        status: "CONFIRMED",
      },
    });
    mockGetPaymentIntent.mockResolvedValue({
      id: "pi_success",
      amount: 12500,
      payment_method: "pm_123",
      status: "succeeded",
    });

    const req = new NextRequest("http://localhost/api/bookings/booking-1/confirm-payment", {
      method: "POST",
      body: JSON.stringify({ paymentIntentId: "pi_success" }),
      headers: { "Content-Type": "application/json" },
    });

    const res = await confirmPaymentRoute(req, {
      params: Promise.resolve({ id: "booking-1" }),
    });
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.success).toBe(true);
    expect(mocks.markBookingPaymentSucceeded).toHaveBeenCalledWith({
      bookingId: "booking-1",
      paymentIntentId: "pi_success",
      amountCents: 12500,
      paymentMethodId: "pm_123",
    });
    expect(mocks.queueXeroInvoiceForPaidBooking).toHaveBeenCalledWith({
      bookingId: "booking-1",
      createdByMemberId: "member-1",
    });
    expect(mocks.logAudit).toHaveBeenCalled();
  });
});

// Issue #772: the synchronous confirm-payment route must send the booking
// confirmation email when the webhook never arrives, but only once across both
// paths. The send is gated on a fresh "paid" reconciliation outcome; an
// "already_paid" outcome means the other path already reconciled and emailed.
describe("confirm-payment route: booking confirmation email (issue #772)", () => {
  function setupConfirmPayment() {
    mockPrisma.payment.findUnique.mockResolvedValue({
      id: "payment-1",
      stripePaymentIntentId: "pi_success",
      status: "PROCESSING",
      booking: {
        memberId: "member-1",
        finalPriceCents: 12500,
        status: "CONFIRMED",
        hasNonMembers: false,
      },
    });
    mockGetPaymentIntent.mockResolvedValue({
      id: "pi_success",
      amount: 12500,
      payment_method: "pm_123",
      status: "succeeded",
    });
    // Post-reconciliation lookup used to build the confirmation email.
    mockPrisma.booking.findUnique.mockResolvedValue({
      id: "booking-1",
      checkIn: new Date("2026-08-15"),
      checkOut: new Date("2026-08-17"),
      finalPriceCents: 12500,
      discountCents: 0,
      promoAdjustmentCents: 0,
      member: { email: "member@example.com", firstName: "Test" },
      guests: [{ id: "g1" }, { id: "g2" }],
      promoRedemption: null,
    });
  }

  function makeRequest() {
    return new NextRequest(
      "http://localhost/api/bookings/booking-1/confirm-payment",
      {
        method: "POST",
        body: JSON.stringify({ paymentIntentId: "pi_success" }),
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  it("sends exactly one confirmation email on a fresh paid outcome", async () => {
    setupConfirmPayment();
    mocks.markBookingPaymentSucceeded.mockResolvedValue({
      outcome: "paid",
      bookingId: "booking-1",
      bumpedBookingIds: [],
    });

    const res = await confirmPaymentRoute(makeRequest(), {
      params: Promise.resolve({ id: "booking-1" }),
    });

    expect(res.status).toBe(200);
    expect(mocks.sendBookingConfirmedEmail).toHaveBeenCalledTimes(1);
    expect(mocks.sendBookingConfirmedEmail).toHaveBeenCalledWith(
      "member@example.com",
      "Test",
      expect.any(Date),
      expect.any(Date),
      2,
      12500,
      // Multi-lodge phase 8: the options now carry the booking's lodge so
      // the email renders that lodge's identity (undefined here because the
      // fixture booking has no lodgeId).
      { lodgeId: undefined }
    );
  });

  it("does not send when the webhook already reconciled (already_paid)", async () => {
    setupConfirmPayment();
    mocks.markBookingPaymentSucceeded.mockResolvedValue({
      outcome: "already_paid",
      bookingId: "booking-1",
      bumpedBookingIds: [],
    });

    const res = await confirmPaymentRoute(makeRequest(), {
      params: Promise.resolve({ id: "booking-1" }),
    });

    expect(res.status).toBe(200);
    expect(mocks.sendBookingConfirmedEmail).not.toHaveBeenCalled();
  });

  it("sends exactly once when both paths run: the first wins, the second is a no-op", async () => {
    setupConfirmPayment();

    // First caller wins the advisory-locked transition and gets "paid".
    mocks.markBookingPaymentSucceeded.mockResolvedValueOnce({
      outcome: "paid",
      bookingId: "booking-1",
      bumpedBookingIds: [],
    });
    // Second caller (e.g. webhook arriving after the sync confirm) sees the
    // booking already PAID and gets "already_paid".
    mocks.markBookingPaymentSucceeded.mockResolvedValueOnce({
      outcome: "already_paid",
      bookingId: "booking-1",
      bumpedBookingIds: [],
    });

    await confirmPaymentRoute(makeRequest(), {
      params: Promise.resolve({ id: "booking-1" }),
    });
    await confirmPaymentRoute(makeRequest(), {
      params: Promise.resolve({ id: "booking-1" }),
    });

    expect(mocks.sendBookingConfirmedEmail).toHaveBeenCalledTimes(1);
  });

  it("does not fail the request if the confirmation email throws", async () => {
    setupConfirmPayment();
    mocks.markBookingPaymentSucceeded.mockResolvedValue({
      outcome: "paid",
      bookingId: "booking-1",
      bumpedBookingIds: [],
    });
    mocks.sendBookingConfirmedEmail.mockRejectedValueOnce(
      new Error("SMTP unavailable")
    );

    const res = await confirmPaymentRoute(makeRequest(), {
      params: Promise.resolve({ id: "booking-1" }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ success: true });
  });
});
