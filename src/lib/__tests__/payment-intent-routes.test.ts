import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  queueSupersededPrimaryIntentCancellations: vi.fn().mockResolvedValue([]),
  markBookingPaymentSucceeded: vi.fn(),
  markBookingSetupIntentSucceeded: vi.fn(),
  logAudit: vi.fn(),
  upsertPaymentIntentTransaction: vi.fn(),
  // #1765 — null = no prior transaction row; the refunded-history
  // discriminator then falls back to the Payment aggregate status, which in
  // these fixtures is never REFUNDED/PARTIALLY_REFUNDED, so every existing
  // recovery expectation is unchanged.
  findPaymentTransactionByIntentId: vi.fn().mockResolvedValue(null),
  sendBookingConfirmedEmail: vi.fn(),
  queueXeroInvoiceForPaidBooking: vi.fn(),
  // F31 (#1888) — DRAFT preflight-capacity path dependencies.
  acquireLodgeCapacityLock: vi.fn(),
  checkCapacityForGuestRanges: vi.fn(),
  getDefaultLodgeId: vi.fn().mockResolvedValue("lodge-1"),
  reconcileBedAllocationsForBooking: vi.fn(),
  // #1976 — split-parent describe helper. Default null = non-split, so every
  // pre-existing fixture keeps its single-total (non-split) response shape.
  getProvisionalNonMemberChildSummary: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    // #2265 — the pay transaction takes the global booking/money lock(1) before
    // anything else, so the client double has to answer $executeRaw.
    $executeRaw: vi.fn().mockResolvedValue(1),
    booking: {
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    payment: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
    memberCredit: {
      aggregate: vi.fn().mockResolvedValue({ _sum: { amountCents: 0 } }),
    },
    $transaction: vi.fn(),
  },
}));

vi.mock("@/lib/capacity", () => ({
  acquireLodgeCapacityLock: mocks.acquireLodgeCapacityLock,
  checkCapacityForGuestRanges: mocks.checkCapacityForGuestRanges,
}));

vi.mock("@/lib/lodges", () => ({
  getDefaultLodgeId: mocks.getDefaultLodgeId,
}));

vi.mock("@/lib/bed-allocation-lifecycle", () => ({
  reconcileBedAllocationsForBookingWithLodgeLockHeld:
    mocks.reconcileBedAllocationsForBooking,
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
  // #3266 — read by `setup-intent-card.ts`, which is deliberately NOT mocked
  // here so the "is the card still attached" decision runs for real over this
  // double.
  getPaymentMethod: vi.fn(),
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
  findPaymentTransactionByIntentId: mocks.findPaymentTransactionByIntentId,
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

vi.mock("@/lib/booking-split-summary", () => ({
  getProvisionalNonMemberChildSummary:
    mocks.getProvisionalNonMemberChildSummary,
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
import logger from "@/lib/logger";
import {
  createPaymentIntent as stripeCreatePaymentIntent,
  createSetupIntent as stripeCreateSetupIntent,
  findOrCreateCustomer,
  getPaymentIntent,
  getPaymentMethod,
  getSetupIntent,
} from "@/lib/stripe";
import { POST as createPaymentIntentRoute } from "@/app/api/payments/create-payment-intent/route";
import { POST as createSetupIntentRoute } from "@/app/api/payments/create-setup-intent/route";
import { POST as confirmPaymentRoute } from "@/app/api/bookings/[id]/confirm-payment/route";
import {
  HOSTING_COVERAGE_RETRY_CODE,
  HOSTING_COVERAGE_RETRY_MESSAGE,
  HostingCoverageParticipantRetryError,
} from "@/lib/adult-member-hosting-queue-participants";
import {
  EXISTING_CARD_TRANSACTION_STATUS_UNCONFIRMED_BODY,
  PAYMENT_RECEIVED_STATUS_UNCONFIRMED_BODY,
  REFUNDED_CARD_TRANSACTION_REPAYMENT_REQUIRED_BODY,
} from "@/lib/payment-recovery-contract";

const mockPrisma = prisma as unknown as {
  booking: {
    findUnique: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    // #2820 — the pay transaction's status-guarded DRAFT -> PAYMENT_PENDING
    // claim goes through updateMany, and the DRAFT-arm case at the foot of this
    // file asserts on it directly.
    updateMany: ReturnType<typeof vi.fn>;
  };
  payment: {
    findUnique: ReturnType<typeof vi.fn>;
    upsert: ReturnType<typeof vi.fn>;
  };
  $transaction: ReturnType<typeof vi.fn>;
};

const mockAuth = auth as ReturnType<typeof vi.fn>;
const mockStripeCreatePaymentIntent = stripeCreatePaymentIntent as ReturnType<typeof vi.fn>;
const mockStripeCreateSetupIntent = stripeCreateSetupIntent as ReturnType<typeof vi.fn>;
const mockFindOrCreateCustomer = findOrCreateCustomer as ReturnType<typeof vi.fn>;
const mockGetPaymentIntent = getPaymentIntent as ReturnType<typeof vi.fn>;
const mockGetSetupIntent = getSetupIntent as ReturnType<typeof vi.fn>;
const mockGetPaymentMethod = getPaymentMethod as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  // clearAllMocks resets call history but not implementations, so restore the
  // non-split default here — a split-case test's mockResolvedValue would
  // otherwise leak into every following test (#1976).
  mocks.getProvisionalNonMemberChildSummary.mockResolvedValue(null);
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

  it("reuses a matching-amount intent and returns the split charge figures for a split parent (#1976)", async () => {
    // Reuse branch (route ~L271-285): an existing non-canceled intent whose
    // amount already equals effectivePriceCents is handed back as-is. The
    // response must still carry the split shape and the reused intent's own
    // amount as chargedAmountCents.
    mockPrisma.booking.findUnique.mockResolvedValue({
      id: "booking-1",
      memberId: "member-1",
      status: "PAYMENT_PENDING",
      hasNonMembers: false,
      organiserSettled: false,
      finalPriceCents: 12000,
      member: {
        id: "member-1",
        email: "member@example.com",
        firstName: "Test",
        lastName: "Member",
      },
      guests: [{ id: "guest-1", isMember: true }],
      payment: {
        stripePaymentIntentId: "pi_reuse",
        status: "FAILED",
      },
    });
    mocks.getProvisionalNonMemberChildSummary.mockResolvedValue({
      guestCount: 2,
      holdUntil: new Date("2026-08-01"),
      deferredAmountCents: 8000,
    });
    // Existing intent already priced at the member portion (12000c).
    mockGetPaymentIntent.mockResolvedValue({
      id: "pi_reuse",
      client_secret: "cs_reuse",
      status: "requires_payment_method",
      amount: 12000,
    });

    const req = new NextRequest("http://localhost/api/payments/create-payment-intent", {
      method: "POST",
      body: JSON.stringify({ bookingId: "booking-1" }),
      headers: { "Content-Type": "application/json" },
    });

    const res = await createPaymentIntentRoute(req);
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.clientSecret).toBe("cs_reuse");
    // chargedAmountCents is the reused intent's own amount (server-authoritative).
    expect(data.chargedAmountCents).toBe(12000);
    expect(data.isSplit).toBe(true);
    expect(data.deferredGuestAmountCents).toBe(8000);
    // No fresh intent minted — the existing one is reused.
    expect(mockStripeCreatePaymentIntent).not.toHaveBeenCalled();
  });

  it("reuses a matching-amount intent with the unchanged non-split shape (#1976)", async () => {
    mockPrisma.booking.findUnique.mockResolvedValue({
      id: "booking-1",
      memberId: "member-1",
      status: "PAYMENT_PENDING",
      hasNonMembers: false,
      organiserSettled: false,
      finalPriceCents: 12500,
      member: {
        id: "member-1",
        email: "member@example.com",
        firstName: "Test",
        lastName: "Member",
      },
      guests: [{ id: "guest-1", isMember: true }],
      payment: {
        stripePaymentIntentId: "pi_reuse",
        status: "FAILED",
      },
    });
    // Default getProvisionalNonMemberChildSummary mock returns null → non-split.
    mockGetPaymentIntent.mockResolvedValue({
      id: "pi_reuse",
      client_secret: "cs_reuse",
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
    expect(data.clientSecret).toBe("cs_reuse");
    expect(data.chargedAmountCents).toBe(12500);
    expect(data.isSplit).toBe(false);
    expect(data.deferredGuestAmountCents).toBeNull();
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

  it("returns the member-portion charge and deferred guest portion for a split parent (#1976)", async () => {
    // Split parent: priced on the member subset only (12000c). Its non-member
    // guests live on a provisional child priced at 8000c, charged later.
    mockPrisma.booking.findUnique.mockResolvedValue({
      id: "booking-1",
      memberId: "member-1",
      status: "PAYMENT_PENDING",
      hasNonMembers: false,
      organiserSettled: false,
      finalPriceCents: 12000,
      member: {
        id: "member-1",
        email: "member@example.com",
        firstName: "Test",
        lastName: "Member",
      },
      guests: [{ id: "guest-1", isMember: true }],
      payment: null,
    });
    mocks.getProvisionalNonMemberChildSummary.mockResolvedValue({
      guestCount: 2,
      holdUntil: new Date("2026-08-01"),
      deferredAmountCents: 8000,
    });
    mockStripeCreatePaymentIntent.mockResolvedValue({
      id: "pi_split",
      client_secret: "cs_split",
      amount: 12000,
    });
    mockPrisma.payment.upsert.mockResolvedValue({ id: "pay-split" });

    const req = new NextRequest("http://localhost/api/payments/create-payment-intent", {
      method: "POST",
      body: JSON.stringify({ bookingId: "booking-1" }),
      headers: { "Content-Type": "application/json" },
    });

    const res = await createPaymentIntentRoute(req);
    const data = await res.json();

    expect(res.status).toBe(200);
    // The card is charged the member portion, and that is the figure returned.
    expect(mockStripeCreatePaymentIntent).toHaveBeenCalledWith(
      expect.objectContaining({ amountCents: 12000 }),
    );
    expect(data.chargedAmountCents).toBe(12000);
    expect(data.isSplit).toBe(true);
    expect(data.deferredGuestAmountCents).toBe(8000);
  });

  it("returns the full charge and no deferred portion for a non-split booking (#1976)", async () => {
    mockPrisma.booking.findUnique.mockResolvedValue({
      id: "booking-1",
      memberId: "member-1",
      status: "PAYMENT_PENDING",
      hasNonMembers: false,
      organiserSettled: false,
      finalPriceCents: 12500,
      member: {
        id: "member-1",
        email: "member@example.com",
        firstName: "Test",
        lastName: "Member",
      },
      guests: [{ id: "guest-1", isMember: true }],
      payment: null,
    });
    // Default mock returns null → non-split.
    mockStripeCreatePaymentIntent.mockResolvedValue({
      id: "pi_full",
      client_secret: "cs_full",
      amount: 12500,
    });
    mockPrisma.payment.upsert.mockResolvedValue({ id: "pay-full" });

    const req = new NextRequest("http://localhost/api/payments/create-payment-intent", {
      method: "POST",
      body: JSON.stringify({ bookingId: "booking-1" }),
      headers: { "Content-Type": "application/json" },
    });

    const res = await createPaymentIntentRoute(req);
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.chargedAmountCents).toBe(12500);
    expect(data.isSplit).toBe(false);
    expect(data.deferredGuestAmountCents).toBeNull();
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
    expect(data).not.toHaveProperty("paymentIntentId");
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

  it("reports captured-card recovery when a succeeded intent hits participant contention", async () => {
    mockPrisma.booking.findUnique.mockResolvedValue({
      id: "booking-1",
      memberId: "member-1",
      status: "CONFIRMED",
      hasNonMembers: false,
      organiserSettled: false,
      finalPriceCents: 12500,
      member: {
        id: "member-1",
        email: "member@example.com",
        firstName: "Test",
        lastName: "Member",
      },
      guests: [],
      payment: {
        stripePaymentIntentId: "pi_captured_retry",
        status: "PROCESSING",
      },
    });
    mockGetPaymentIntent.mockResolvedValue({
      id: "pi_captured_retry",
      amount: 12500,
      payment_method: "pm_123",
      status: "succeeded",
    });
    mocks.markBookingPaymentSucceeded.mockRejectedValue(
      new HostingCoverageParticipantRetryError(),
    );

    const response = await createPaymentIntentRoute(
      new NextRequest(
        "http://localhost/api/payments/create-payment-intent",
        {
          method: "POST",
          body: JSON.stringify({ bookingId: "booking-1" }),
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: HOSTING_COVERAGE_RETRY_MESSAGE,
      code: HOSTING_COVERAGE_RETRY_CODE,
      paymentReceived: true,
      finalisationPending: true,
    });
    expect(mocks.queueXeroInvoiceForPaidBooking).not.toHaveBeenCalled();
    expect(mockStripeCreatePaymentIntent).not.toHaveBeenCalled();
  });

  it("suppresses repayment when refund history lookup fails after Stripe success is observed", async () => {
    mockPrisma.booking.findUnique.mockResolvedValue({
      id: "booking-1",
      memberId: "member-1",
      status: "CONFIRMED",
      hasNonMembers: false,
      organiserSettled: false,
      finalPriceCents: 12500,
      member: {
        id: "member-1",
        email: "member@example.com",
        firstName: "Test",
        lastName: "Member",
      },
      guests: [],
      payment: {
        stripePaymentIntentId: "pi_status_observed",
        status: "PROCESSING",
      },
    });
    mockGetPaymentIntent.mockResolvedValue({
      id: "pi_status_observed",
      amount: 12500,
      payment_method: "pm_123",
      status: "succeeded",
    });
    mocks.findPaymentTransactionByIntentId.mockRejectedValueOnce(
      new Error("private refund-ledger detail"),
    );

    const response = await createPaymentIntentRoute(
      new NextRequest("http://localhost/api/payments/create-payment-intent", {
        method: "POST",
        body: JSON.stringify({ bookingId: "booking-1" }),
        headers: { "Content-Type": "application/json" },
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body).toEqual(
      EXISTING_CARD_TRANSACTION_STATUS_UNCONFIRMED_BODY,
    );
    expect(body).not.toHaveProperty("paymentReceived");
    expect(body).not.toHaveProperty("finalisationPending");
    expect(JSON.stringify(body)).not.toContain("private refund-ledger detail");
    expect(mocks.markBookingPaymentSucceeded).not.toHaveBeenCalled();
    expect(mockStripeCreatePaymentIntent).not.toHaveBeenCalled();
  });

  it("keeps a proven-refunded replacement failure on the ordinary initialization retry path", async () => {
    mockPrisma.booking.findUnique.mockResolvedValue({
      id: "booking-1",
      memberId: "member-1",
      status: "CONFIRMED",
      hasNonMembers: false,
      organiserSettled: false,
      finalPriceCents: 12500,
      member: {
        id: "member-1",
        email: "member@example.com",
        firstName: "Test",
        lastName: "Member",
      },
      guests: [],
      payment: {
        id: "payment-1",
        stripePaymentIntentId: "pi_refunded",
        status: "REFUNDED",
      },
    });
    mockGetPaymentIntent.mockResolvedValue({
      id: "pi_refunded",
      amount: 12500,
      payment_method: "pm_123",
      status: "succeeded",
    });
    mocks.findPaymentTransactionByIntentId.mockResolvedValueOnce({
      status: "REFUNDED",
    });
    mockFindOrCreateCustomer.mockRejectedValueOnce(
      new Error("replacement customer lookup unavailable"),
    );

    const response = await createPaymentIntentRoute(
      new NextRequest("http://localhost/api/payments/create-payment-intent", {
        method: "POST",
        body: JSON.stringify({ bookingId: "booking-1" }),
        headers: { "Content-Type": "application/json" },
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toEqual({ error: "Failed to create payment intent" });
    expect(body).not.toEqual(EXISTING_CARD_TRANSACTION_STATUS_UNCONFIRMED_BODY);
    expect(mocks.queueSupersededPrimaryIntentCancellations).toHaveBeenCalled();
    expect(mockStripeCreatePaymentIntent).not.toHaveBeenCalled();
  });

  it("keeps proven-refunded replacement contention on the fixed retryable 409 path", async () => {
    mockPrisma.booking.findUnique.mockResolvedValue({
      id: "booking-1",
      memberId: "member-1",
      status: "CONFIRMED",
      hasNonMembers: false,
      organiserSettled: false,
      finalPriceCents: 12500,
      member: {
        id: "member-1",
        email: "member@example.com",
        firstName: "Test",
        lastName: "Member",
      },
      guests: [],
      payment: {
        id: "payment-1",
        stripePaymentIntentId: "pi_refunded",
        status: "REFUNDED",
      },
    });
    mockGetPaymentIntent.mockResolvedValue({
      id: "pi_refunded",
      amount: 12500,
      payment_method: "pm_123",
      status: "succeeded",
    });
    mocks.findPaymentTransactionByIntentId.mockResolvedValueOnce({
      status: "REFUNDED",
    });
    mocks.queueSupersededPrimaryIntentCancellations.mockRejectedValueOnce(
      new HostingCoverageParticipantRetryError(),
    );

    const response = await createPaymentIntentRoute(
      new NextRequest("http://localhost/api/payments/create-payment-intent", {
        method: "POST",
        body: JSON.stringify({ bookingId: "booking-1" }),
        headers: { "Content-Type": "application/json" },
      }),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: HOSTING_COVERAGE_RETRY_MESSAGE,
      code: HOSTING_COVERAGE_RETRY_CODE,
    });
    expect(mockFindOrCreateCustomer).not.toHaveBeenCalled();
    expect(mockStripeCreatePaymentIntent).not.toHaveBeenCalled();
  });

  it("returns privacy-safe status recovery when ordinary reconciliation fails after capture", async () => {
    mockPrisma.booking.findUnique.mockResolvedValue({
      id: "booking-1",
      memberId: "member-1",
      status: "CONFIRMED",
      hasNonMembers: false,
      organiserSettled: false,
      finalPriceCents: 12500,
      member: {
        id: "member-1",
        email: "member@example.com",
        firstName: "Test",
        lastName: "Member",
      },
      guests: [],
      payment: {
        stripePaymentIntentId: "pi_status_unknown",
        status: "PROCESSING",
      },
    });
    mockGetPaymentIntent.mockResolvedValue({
      id: "pi_status_unknown",
      amount: 12500,
      payment_method: "pm_123",
      status: "succeeded",
    });
    mocks.markBookingPaymentSucceeded.mockRejectedValue(
      new Error('constraint "Payment_secret_fkey" on postgres://private'),
    );

    const response = await createPaymentIntentRoute(
      new NextRequest("http://localhost/api/payments/create-payment-intent", {
        method: "POST",
        body: JSON.stringify({ bookingId: "booking-1" }),
        headers: { "Content-Type": "application/json" },
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body).toEqual(PAYMENT_RECEIVED_STATUS_UNCONFIRMED_BODY);
    expect(body).not.toHaveProperty("finalisationPending");
    expect(body).not.toHaveProperty("paymentIntentId");
    expect(JSON.stringify(body)).not.toContain("postgres://private");
    expect(mocks.queueXeroInvoiceForPaidBooking).not.toHaveBeenCalled();
    expect(mockStripeCreatePaymentIntent).not.toHaveBeenCalled();
  });

  it("keeps status unconfirmed when a post-reconciliation Xero queue step fails", async () => {
    mockPrisma.booking.findUnique.mockResolvedValue({
      id: "booking-1",
      memberId: "member-1",
      status: "CONFIRMED",
      hasNonMembers: false,
      organiserSettled: false,
      finalPriceCents: 12500,
      member: {
        id: "member-1",
        email: "member@example.com",
        firstName: "Test",
        lastName: "Member",
      },
      guests: [],
      payment: {
        stripePaymentIntentId: "pi_xero_queue_unknown",
        status: "PROCESSING",
      },
    });
    mockGetPaymentIntent.mockResolvedValue({
      id: "pi_xero_queue_unknown",
      amount: 12500,
      payment_method: "pm_123",
      status: "succeeded",
    });
    mocks.queueXeroInvoiceForPaidBooking.mockRejectedValue(
      new Error("Xero queue storage unavailable"),
    );

    const response = await createPaymentIntentRoute(
      new NextRequest("http://localhost/api/payments/create-payment-intent", {
        method: "POST",
        body: JSON.stringify({ bookingId: "booking-1" }),
        headers: { "Content-Type": "application/json" },
      }),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual(
      PAYMENT_RECEIVED_STATUS_UNCONFIRMED_BODY,
    );
    expect(mocks.markBookingPaymentSucceeded).toHaveBeenCalledTimes(1);
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

  // #3266 — a replacement SetupIntent retires the previous card, and a retired
  // card is never re-adopted from a stale succeeded SetupIntent (INV-PAY-052).
  describe("create-setup-intent: replacement mint and stale succeeded intent (#3266)", () => {
    const savedCardBooking = (payment: Record<string, unknown> | null) => ({
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
      payment,
    });

    const postSetupIntent = () =>
      createSetupIntentRoute(
        new NextRequest("http://localhost/api/payments/create-setup-intent", {
          method: "POST",
          body: JSON.stringify({ bookingId: "booking-1" }),
          headers: { "Content-Type": "application/json" },
        }),
      );

    const freshMint = { id: "seti_new", client_secret: "seti_new_secret" };

    beforeEach(() => {
      mockStripeCreateSetupIntent.mockResolvedValue(freshMint);
      mockPrisma.payment.upsert.mockResolvedValue({});
    });

    it("(a) minting a replacement clears the previous card from the row", async () => {
      mockPrisma.booking.findUnique.mockResolvedValue(
        savedCardBooking({
          stripeSetupIntentId: "seti_old",
          stripePaymentMethodId: "pm_old",
          stripeCustomerId: "cus_123",
        }),
      );
      // The stored intent is dead, so the route must mint afresh.
      mockGetSetupIntent.mockResolvedValue({
        id: "seti_old",
        status: "canceled",
        client_secret: null,
      });

      const res = await postSetupIntent();
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data).toEqual({ clientSecret: "seti_new_secret", setupIntentId: "seti_new" });
      expect(mockStripeCreateSetupIntent).toHaveBeenCalledWith(
        expect.objectContaining({ idempotencyKey: "seti_booking-1_seti_old" }),
      );
      expect(mockPrisma.payment.upsert).toHaveBeenCalledTimes(1);
      const upsert = mockPrisma.payment.upsert.mock.calls[0][0];
      expect(upsert.update).toEqual({
        stripeSetupIntentId: "seti_new",
        stripeCustomerId: "cus_123",
        stripePaymentMethodId: null,
      });
      expect(upsert.create).toEqual(
        expect.objectContaining({
          stripeSetupIntentId: "seti_new",
          stripeCustomerId: "cus_123",
          stripePaymentMethodId: null,
        }),
      );
      expect(mockGetPaymentMethod).not.toHaveBeenCalled();
      expect(mocks.markBookingSetupIntentSucceeded).not.toHaveBeenCalled();
    });

    it("(b) succeeded intent whose OWN card is on the row: alreadySaved, and Stripe is not asked about the card", async () => {
      mockPrisma.booking.findUnique.mockResolvedValue(
        savedCardBooking({
          stripeSetupIntentId: "seti_old",
          stripePaymentMethodId: "pm_old",
          stripeCustomerId: "cus_123",
        }),
      );
      mockGetSetupIntent.mockResolvedValue({
        id: "seti_old",
        status: "succeeded",
        payment_method: "pm_old",
        customer: "cus_123",
      });

      const res = await postSetupIntent();

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ alreadySaved: true, setupIntentId: "seti_old" });
      expect(mocks.markBookingSetupIntentSucceeded).toHaveBeenCalledWith({
        bookingId: "booking-1",
        setupIntentId: "seti_old",
        paymentMethodId: "pm_old",
      });
      expect(mockGetPaymentMethod).not.toHaveBeenCalled();
      expect(mockStripeCreateSetupIntent).not.toHaveBeenCalled();
      expect(mockPrisma.payment.upsert).not.toHaveBeenCalled();
    });

    // (b2) — the fast path is ONLY "the row carries this intent's own card". A
    // row naming a DIFFERENT card says nothing about the intent's card, so it
    // goes through the provider check exactly like an empty row (fix round 1).
    it("(b2) succeeded intent, row carries a DIFFERENT card, intent's card still attached: Stripe is asked, then stamp and alreadySaved", async () => {
      mockPrisma.booking.findUnique.mockResolvedValue(
        savedCardBooking({
          stripeSetupIntentId: "seti_old",
          stripePaymentMethodId: "pm_other",
          stripeCustomerId: "cus_123",
        }),
      );
      mockGetSetupIntent.mockResolvedValue({
        id: "seti_old",
        status: "succeeded",
        payment_method: "pm_intent",
        customer: "cus_123",
      });
      mockGetPaymentMethod.mockResolvedValue({ id: "pm_intent", customer: "cus_123" });

      const res = await postSetupIntent();

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ alreadySaved: true, setupIntentId: "seti_old" });
      expect(mockGetPaymentMethod).toHaveBeenCalledWith("pm_intent");
      // The stamp names the intent whose card it writes, so the guarded write
      // in markBookingSetupIntentSucceeded is satisfied by construction.
      expect(mocks.markBookingSetupIntentSucceeded).toHaveBeenCalledWith({
        bookingId: "booking-1",
        setupIntentId: "seti_old",
        paymentMethodId: "pm_intent",
      });
      expect(mockStripeCreateSetupIntent).not.toHaveBeenCalled();
    });

    it("(b2) succeeded intent, row carries a DIFFERENT card, intent's card detached: fresh mint, nothing re-adopted", async () => {
      mockPrisma.booking.findUnique.mockResolvedValue(
        savedCardBooking({
          stripeSetupIntentId: "seti_old",
          stripePaymentMethodId: "pm_other",
          stripeCustomerId: "cus_123",
        }),
      );
      mockGetSetupIntent.mockResolvedValue({
        id: "seti_old",
        status: "succeeded",
        payment_method: "pm_intent",
        customer: "cus_123",
      });
      mockGetPaymentMethod.mockResolvedValue({ id: "pm_intent", customer: null });

      const res = await postSetupIntent();

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({
        clientSecret: "seti_new_secret",
        setupIntentId: "seti_new",
      });
      expect(mockGetPaymentMethod).toHaveBeenCalledWith("pm_intent");
      expect(mocks.markBookingSetupIntentSucceeded).not.toHaveBeenCalled();
      expect(mockStripeCreateSetupIntent).toHaveBeenCalledWith(
        expect.objectContaining({ idempotencyKey: "seti_booking-1_seti_old" }),
      );
      const upsert = mockPrisma.payment.upsert.mock.calls[0][0];
      expect(upsert.update.stripePaymentMethodId).toBeNull();
    });

    it("(c) succeeded intent, no card on the row, card still attached at Stripe (webhook race): stamp and alreadySaved", async () => {
      mockPrisma.booking.findUnique.mockResolvedValue(
        savedCardBooking({
          stripeSetupIntentId: "seti_old",
          stripePaymentMethodId: null,
          stripeCustomerId: "cus_123",
        }),
      );
      mockGetSetupIntent.mockResolvedValue({
        id: "seti_old",
        status: "succeeded",
        payment_method: "pm_new",
        customer: "cus_123",
      });
      mockGetPaymentMethod.mockResolvedValue({ id: "pm_new", customer: "cus_123" });

      const res = await postSetupIntent();

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ alreadySaved: true, setupIntentId: "seti_old" });
      expect(mockGetPaymentMethod).toHaveBeenCalledWith("pm_new");
      expect(mocks.markBookingSetupIntentSucceeded).toHaveBeenCalledWith({
        bookingId: "booking-1",
        setupIntentId: "seti_old",
        paymentMethodId: "pm_new",
      });
      expect(mockStripeCreateSetupIntent).not.toHaveBeenCalled();
      expect(mockPrisma.payment.upsert).not.toHaveBeenCalled();
    });

    it("(d) succeeded intent, no card on the row, card detached at Stripe: mint a fresh intent and leave the card empty", async () => {
      mockPrisma.booking.findUnique.mockResolvedValue(
        savedCardBooking({
          stripeSetupIntentId: "seti_old",
          stripePaymentMethodId: null,
          stripeCustomerId: "cus_123",
        }),
      );
      mockGetSetupIntent.mockResolvedValue({
        id: "seti_old",
        status: "succeeded",
        payment_method: "pm_dead",
        customer: "cus_123",
      });
      mockGetPaymentMethod.mockResolvedValue({ id: "pm_dead", customer: null });

      const res = await postSetupIntent();
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data).toEqual({ clientSecret: "seti_new_secret", setupIntentId: "seti_new" });
      expect(mocks.markBookingSetupIntentSucceeded).not.toHaveBeenCalled();
      expect(mockStripeCreateSetupIntent).toHaveBeenCalledWith(
        expect.objectContaining({ idempotencyKey: "seti_booking-1_seti_old" }),
      );
      const upsert = mockPrisma.payment.upsert.mock.calls[0][0];
      expect(upsert.update).toEqual({
        stripeSetupIntentId: "seti_new",
        stripeCustomerId: "cus_123",
        stripePaymentMethodId: null,
      });
    });

    it("(d2) a card attached to a DIFFERENT customer is not this booking's card: mint afresh", async () => {
      mockPrisma.booking.findUnique.mockResolvedValue(
        savedCardBooking({
          stripeSetupIntentId: "seti_old",
          stripePaymentMethodId: null,
          stripeCustomerId: "cus_123",
        }),
      );
      mockGetSetupIntent.mockResolvedValue({
        id: "seti_old",
        status: "succeeded",
        payment_method: "pm_other",
        customer: "cus_123",
      });
      mockGetPaymentMethod.mockResolvedValue({ id: "pm_other", customer: "cus_someone_else" });

      const res = await postSetupIntent();

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({
        clientSecret: "seti_new_secret",
        setupIntentId: "seti_new",
      });
      expect(mocks.markBookingSetupIntentSucceeded).not.toHaveBeenCalled();
      expect(mockStripeCreateSetupIntent).toHaveBeenCalledTimes(1);
    });

    it("(e) Stripe no longer has the payment method (resource_missing): mint a fresh intent", async () => {
      mockPrisma.booking.findUnique.mockResolvedValue(
        savedCardBooking({
          stripeSetupIntentId: "seti_old",
          stripePaymentMethodId: null,
          stripeCustomerId: "cus_123",
        }),
      );
      mockGetSetupIntent.mockResolvedValue({
        id: "seti_old",
        status: "succeeded",
        payment_method: "pm_gone",
        customer: "cus_123",
      });
      mockGetPaymentMethod.mockRejectedValue(
        Object.assign(new Error("No such PaymentMethod: 'pm_gone'"), {
          type: "StripeInvalidRequestError",
          code: "resource_missing",
          statusCode: 404,
        }),
      );

      const res = await postSetupIntent();

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({
        clientSecret: "seti_new_secret",
        setupIntentId: "seti_new",
      });
      expect(mocks.markBookingSetupIntentSucceeded).not.toHaveBeenCalled();
      expect(mockStripeCreateSetupIntent).toHaveBeenCalledWith(
        expect.objectContaining({ idempotencyKey: "seti_booking-1_seti_old" }),
      );
      const upsert = mockPrisma.payment.upsert.mock.calls[0][0];
      expect(upsert.update.stripePaymentMethodId).toBeNull();
    });

    it("(f) any OTHER Stripe failure while asking about the card is not a verdict: 500, no mint, no re-adopt", async () => {
      mockPrisma.booking.findUnique.mockResolvedValue(
        savedCardBooking({
          stripeSetupIntentId: "seti_old",
          stripePaymentMethodId: null,
          stripeCustomerId: "cus_123",
        }),
      );
      mockGetSetupIntent.mockResolvedValue({
        id: "seti_old",
        status: "succeeded",
        payment_method: "pm_unknown",
        customer: "cus_123",
      });
      mockGetPaymentMethod.mockRejectedValue(
        Object.assign(new Error("Stripe is unavailable"), {
          type: "StripeAPIError",
          statusCode: 503,
        }),
      );

      const res = await postSetupIntent();

      expect(res.status).toBe(500);
      expect(mocks.markBookingSetupIntentSucceeded).not.toHaveBeenCalled();
      expect(mockStripeCreateSetupIntent).not.toHaveBeenCalled();
      expect(mockPrisma.payment.upsert).not.toHaveBeenCalled();
    });

    it("(g) a succeeded intent that names no payment method cannot be re-adopted: mint afresh without asking Stripe", async () => {
      mockPrisma.booking.findUnique.mockResolvedValue(
        savedCardBooking({
          stripeSetupIntentId: "seti_old",
          stripePaymentMethodId: null,
          stripeCustomerId: "cus_123",
        }),
      );
      mockGetSetupIntent.mockResolvedValue({
        id: "seti_old",
        status: "succeeded",
        payment_method: null,
        customer: "cus_123",
      });

      const res = await postSetupIntent();

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({
        clientSecret: "seti_new_secret",
        setupIntentId: "seti_new",
      });
      expect(mockGetPaymentMethod).not.toHaveBeenCalled();
      expect(mocks.markBookingSetupIntentSucceeded).not.toHaveBeenCalled();
      expect(mockStripeCreateSetupIntent).toHaveBeenCalledTimes(1);
    });
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
      { bookingId: "booking-1" },
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

// F31 (#1888): the generic fallback catch on money routes must never echo an
// unexpected error's message (Prisma constraint names, connection-string
// fragments, ...) back to the client. The raw error stays in the pino log
// only; intentional user-facing messages (typed/domain branches) are
// unchanged.
describe("generic-catch error-message leak (F31 #1888)", () => {
  it("confirm-payment returns a fixed recovery 409 after a succeeded Stripe payment hits participant contention", async () => {
    mockPrisma.payment.findUnique.mockResolvedValue({
      id: "payment-1",
      stripePaymentIntentId: "pi_hosting_retry",
      status: "PROCESSING",
      booking: {
        memberId: "member-1",
        finalPriceCents: 12500,
        status: "CONFIRMED",
      },
    });
    mockGetPaymentIntent.mockResolvedValue({
      id: "pi_hosting_retry",
      amount: 12500,
      payment_method: "pm_123",
      status: "succeeded",
    });
    mocks.markBookingPaymentSucceeded.mockRejectedValue(
      new HostingCoverageParticipantRetryError(),
    );

    const response = await confirmPaymentRoute(
      new NextRequest(
        "http://localhost/api/bookings/booking-1/confirm-payment",
        {
          method: "POST",
          body: JSON.stringify({ paymentIntentId: "pi_hosting_retry" }),
          headers: { "Content-Type": "application/json" },
        },
      ),
      { params: Promise.resolve({ id: "booking-1" }) },
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: HOSTING_COVERAGE_RETRY_MESSAGE,
      code: HOSTING_COVERAGE_RETRY_CODE,
      paymentReceived: true,
      finalisationPending: true,
    });
    expect(mocks.queueXeroInvoiceForPaidBooking).not.toHaveBeenCalled();
  });

  it("confirm-payment does not invent payment receipt when participant contention occurs before Stripe success is observed", async () => {
    mockPrisma.payment.findUnique.mockResolvedValue({
      id: "payment-1",
      stripePaymentIntentId: "pi_hosting_retry",
      status: "PROCESSING",
      booking: {
        memberId: "member-1",
        finalPriceCents: 12500,
        status: "CONFIRMED",
      },
    });
    mockGetPaymentIntent.mockRejectedValue(
      new HostingCoverageParticipantRetryError(),
    );

    const response = await confirmPaymentRoute(
      new NextRequest(
        "http://localhost/api/bookings/booking-1/confirm-payment",
        {
          method: "POST",
          body: JSON.stringify({ paymentIntentId: "pi_hosting_retry" }),
          headers: { "Content-Type": "application/json" },
        },
      ),
      { params: Promise.resolve({ id: "booking-1" }) },
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: HOSTING_COVERAGE_RETRY_MESSAGE,
      code: HOSTING_COVERAGE_RETRY_CODE,
    });
    expect(mocks.markBookingPaymentSucceeded).not.toHaveBeenCalled();
  });

  it("confirm-payment returns fixed status-unconfirmed recovery after an unexpected post-capture reconciliation error", async () => {
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
    mocks.markBookingPaymentSucceeded.mockRejectedValue(
      new Error(
        'insert or update on table "Payment" violates foreign key constraint "Payment_secret_col_fkey"'
      )
    );

    const req = new NextRequest(
      "http://localhost/api/bookings/booking-1/confirm-payment",
      {
        method: "POST",
        body: JSON.stringify({ paymentIntentId: "pi_success" }),
        headers: { "Content-Type": "application/json" },
      }
    );
    const res = await confirmPaymentRoute(req, {
      params: Promise.resolve({ id: "booking-1" }),
    });
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body).toEqual(PAYMENT_RECEIVED_STATUS_UNCONFIRMED_BODY);
    expect(JSON.stringify(body)).not.toContain("secret_col");
    // The raw error is still logged for operators.
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      "Failed to confirm primary booking payment"
    );
  });

  it.each(["REFUNDED", "PARTIALLY_REFUNDED"])(
    "confirm-payment reports a locally proven %s intent as refunded, not newly received",
    async (status) => {
      mockPrisma.payment.findUnique.mockResolvedValue({
        id: "payment-1",
        stripePaymentIntentId: "pi_refunded",
        status: "PROCESSING",
        booking: {
          memberId: "member-1",
          finalPriceCents: 12500,
          status: "CONFIRMED",
          hasNonMembers: false,
        },
      });
      mockGetPaymentIntent.mockResolvedValue({
        id: "pi_refunded",
        amount: 12500,
        payment_method: "pm_old",
        status: "succeeded",
      });
      mocks.findPaymentTransactionByIntentId.mockResolvedValueOnce({ status });

      const response = await confirmPaymentRoute(
        new NextRequest(
          "http://localhost/api/bookings/booking-1/confirm-payment",
          {
            method: "POST",
            body: JSON.stringify({ paymentIntentId: "pi_refunded" }),
            headers: { "Content-Type": "application/json" },
          },
        ),
        { params: Promise.resolve({ id: "booking-1" }) },
      );

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual(
        REFUNDED_CARD_TRANSACTION_REPAYMENT_REQUIRED_BODY,
      );
      expect(mocks.markBookingPaymentSucceeded).not.toHaveBeenCalled();
      expect(mocks.queueXeroInvoiceForPaidBooking).not.toHaveBeenCalled();
    },
  );

  it("confirm-payment does not claim receipt when local refund classification fails", async () => {
    mockPrisma.payment.findUnique.mockResolvedValue({
      id: "payment-1",
      stripePaymentIntentId: "pi_unknown",
      status: "PROCESSING",
      booking: {
        memberId: "member-1",
        finalPriceCents: 12500,
        status: "CONFIRMED",
        hasNonMembers: false,
      },
    });
    mockGetPaymentIntent.mockResolvedValue({
      id: "pi_unknown",
      amount: 12500,
      payment_method: "pm_old",
      status: "succeeded",
    });
    mocks.findPaymentTransactionByIntentId.mockRejectedValueOnce(
      new Error("private ledger detail"),
    );

    const response = await confirmPaymentRoute(
      new NextRequest(
        "http://localhost/api/bookings/booking-1/confirm-payment",
        {
          method: "POST",
          body: JSON.stringify({ paymentIntentId: "pi_unknown" }),
          headers: { "Content-Type": "application/json" },
        },
      ),
      { params: Promise.resolve({ id: "booking-1" }) },
    );
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body).toEqual(EXISTING_CARD_TRANSACTION_STATUS_UNCONFIRMED_BODY);
    expect(body).not.toHaveProperty("paymentReceived");
    expect(JSON.stringify(body)).not.toContain("private ledger detail");
    expect(mocks.markBookingPaymentSucceeded).not.toHaveBeenCalled();
  });

  it("confirm-payment preserves the captured-payment fact when the booking amount drifted", async () => {
    mockPrisma.payment.findUnique.mockResolvedValue({
      id: "payment-1",
      stripePaymentIntentId: "pi_amount_drift",
      status: "PROCESSING",
      booking: {
        memberId: "member-1",
        finalPriceCents: 12500,
        status: "CONFIRMED",
      },
    });
    mockGetPaymentIntent.mockResolvedValue({
      id: "pi_amount_drift",
      amount: 12000,
      payment_method: "pm_private",
      status: "succeeded",
    });

    const response = await confirmPaymentRoute(
      new NextRequest(
        "http://localhost/api/bookings/booking-1/confirm-payment",
        {
          method: "POST",
          body: JSON.stringify({ paymentIntentId: "pi_amount_drift" }),
          headers: { "Content-Type": "application/json" },
        },
      ),
      { params: Promise.resolve({ id: "booking-1" }) },
    );
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body).toEqual(PAYMENT_RECEIVED_STATUS_UNCONFIRMED_BODY);
    expect(JSON.stringify(body)).not.toContain("pi_amount_drift");
    expect(JSON.stringify(body)).not.toContain("pm_private");
    expect(mocks.markBookingPaymentSucceeded).not.toHaveBeenCalled();
    expect(mocks.queueXeroInvoiceForPaidBooking).not.toHaveBeenCalled();
  });

  it("confirm-payment: an unexpected pre-capture provider error stays on the fixed generic response", async () => {
    mockPrisma.payment.findUnique.mockResolvedValue({
      id: "payment-1",
      stripePaymentIntentId: "pi_unconfirmed",
      status: "PROCESSING",
      booking: {
        memberId: "member-1",
        finalPriceCents: 12500,
        status: "CONFIRMED",
      },
    });
    mockGetPaymentIntent.mockRejectedValue(
      new Error("Stripe provider detail must remain private"),
    );

    const response = await confirmPaymentRoute(
      new NextRequest(
        "http://localhost/api/bookings/booking-1/confirm-payment",
        {
          method: "POST",
          body: JSON.stringify({ paymentIntentId: "pi_unconfirmed" }),
          headers: { "Content-Type": "application/json" },
        },
      ),
      { params: Promise.resolve({ id: "booking-1" }) },
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: "Failed to confirm payment",
    });
    expect(mocks.markBookingPaymentSucceeded).not.toHaveBeenCalled();
  });

  it("create-payment-intent: unexpected infrastructure error returns the fixed generic message, not the raw error", async () => {
    mockPrisma.booking.findUnique.mockResolvedValue({
      id: "booking-1",
      memberId: "member-1",
      status: "CONFIRMED",
      hasNonMembers: false,
      organiserSettled: false,
      finalPriceCents: 12500,
      member: {
        id: "member-1",
        email: "member@example.com",
        firstName: "Test",
        lastName: "Member",
      },
      guests: [],
      payment: null,
    });
    mockFindOrCreateCustomer.mockRejectedValue(
      new Error(
        'connection to server at "10.1.2.3", port 5432 failed: password authentication failed for user "app_rw"'
      )
    );

    const req = new NextRequest("http://localhost/api/payments/create-payment-intent", {
      method: "POST",
      body: JSON.stringify({ bookingId: "booking-1" }),
      headers: { "Content-Type": "application/json" },
    });
    const res = await createPaymentIntentRoute(req);
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body).toEqual({ error: "Failed to create payment intent" });
    expect(JSON.stringify(body)).not.toContain("app_rw");
    expect(JSON.stringify(body)).not.toContain("10.1.2.3");
  });

  it("create-payment-intent: the intentional DRAFT capacity-race message still reaches the client at 409", async () => {
    // Outer route read: a DRAFT booking owned by the caller.
    mockPrisma.booking.findUnique.mockResolvedValueOnce({
      id: "booking-1",
      memberId: "member-1",
      status: "DRAFT",
      hasNonMembers: false,
      organiserSettled: false,
      finalPriceCents: 12500,
      lodgeId: "lodge-1",
      member: {
        id: "member-1",
        email: "member@example.com",
        firstName: "Test",
        lastName: "Member",
      },
      guests: [],
      payment: null,
    });
    // In-transaction re-read: still DRAFT, but the beds are gone.
    mockPrisma.booking.findUnique.mockResolvedValueOnce({
      id: "booking-1",
      status: "DRAFT",
      checkIn: new Date("2026-08-15"),
      checkOut: new Date("2026-08-17"),
      guests: [],
    });
    mockPrisma.$transaction.mockImplementation(
      async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => fn(mockPrisma)
    );
    mocks.checkCapacityForGuestRanges.mockResolvedValue({ available: false });

    const req = new NextRequest("http://localhost/api/payments/create-payment-intent", {
      method: "POST",
      body: JSON.stringify({ bookingId: "booking-1" }),
      headers: { "Content-Type": "application/json" },
    });
    const res = await createPaymentIntentRoute(req);
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body).toEqual({
      error:
        "Not enough beds available for your dates. Please choose different dates.",
    });
  });

  // #2820 — the DRAFT arm's unconfigured-provider contract, pinned here because
  // an E2E now depends on it. `e2e/locked-out-pickup-and-pay.spec.ts` runs its
  // pay step in BOTH provider modes, and the required `Playwright E2E` check on
  // a FORK's pull request always runs without the repository's Stripe secrets —
  // so on every fork run that spec asserts exactly this pairing: a priced DRAFT
  // whose provider call fails answers 500 with the fixed generic body, AND the
  // status-guarded DRAFT -> PAYMENT_PENDING move has already COMMITTED, because
  // the pay transaction closes before the first Stripe call (the transaction at
  // route L209-393; `findOrCreateCustomer` at L663, one call before the mint at
  // L679). Mapping the unconfigured-provider error to a different status, or
  // reordering a provider call ahead of the pay transaction, must fail HERE
  // first — with a readable diagnosis — instead of turning fork CI red inside a
  // browser journey.
  it("create-payment-intent: an unconfigured provider fails a priced DRAFT generically, after the PAYMENT_PENDING transition has committed (#2820)", async () => {
    // Outer route read: a priced DRAFT owned by the caller, carrying no credit
    // election, no Payment row and no intent pointer — the shape of the
    // on-behalf draft the E2E's locked-out member picks up and pays.
    mockPrisma.booking.findUnique.mockResolvedValueOnce({
      id: "booking-1",
      memberId: "member-1",
      status: "DRAFT",
      hasNonMembers: false,
      organiserSettled: false,
      finalPriceCents: 12500,
      creditElectionCents: null,
      lodgeId: "lodge-1",
      member: {
        id: "member-1",
        email: "member@example.com",
        firstName: "Test",
        lastName: "Member",
      },
      guests: [],
      payment: null,
    });
    // In-transaction re-read under the two-tier locks: still DRAFT, no pending
    // review, and the beds are there.
    mockPrisma.booking.findUnique.mockResolvedValueOnce({
      id: "booking-1",
      status: "DRAFT",
      checkIn: new Date("2026-08-15"),
      checkOut: new Date("2026-08-17"),
      finalPriceCents: 12500,
      requiresAdminReview: false,
      guests: [],
    });
    mockPrisma.$transaction.mockImplementation(
      async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => fn(mockPrisma)
    );
    mocks.checkCapacityForGuestRanges.mockResolvedValue({ available: true });
    // The real `getStripe()` throw when the credential store resolves no secret
    // key (src/lib/stripe.ts) — surfacing at the route's FIRST provider call,
    // the customer lookup that precedes the intent mint.
    mockFindOrCreateCustomer.mockRejectedValue(
      new Error("Stripe secret key is not configured"),
    );

    const res = await createPaymentIntentRoute(
      new NextRequest("http://localhost/api/payments/create-payment-intent", {
        method: "POST",
        body: JSON.stringify({ bookingId: "booking-1" }),
        headers: { "Content-Type": "application/json" },
      }),
    );
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body).toEqual({ error: "Failed to create payment intent" });
    // The provider's own words never reach the client (#1888).
    expect(JSON.stringify(body)).not.toContain("Stripe secret key");

    // And the member WAS admitted before that failure: the status-guarded
    // transition ran, and it ran ahead of the provider call.
    expect(mockPrisma.booking.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "booking-1", status: "DRAFT" }),
        data: expect.objectContaining({ status: "PAYMENT_PENDING" }),
      }),
    );
    expect(
      mockPrisma.booking.updateMany.mock.invocationCallOrder[0],
    ).toBeLessThan(mockFindOrCreateCustomer.mock.invocationCallOrder[0]);
    // The mint is never reached — the customer lookup fails one call earlier.
    expect(mockStripeCreatePaymentIntent).not.toHaveBeenCalled();
  });
});
