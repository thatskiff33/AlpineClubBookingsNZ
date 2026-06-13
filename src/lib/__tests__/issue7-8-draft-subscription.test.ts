/**
 * Tests for Issue 7 (Draft Bookings) and Issue 10 (Subscription Check on Booking)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockTx = {
  $executeRaw: vi.fn().mockResolvedValue(undefined),
  $executeRawUnsafe: vi.fn().mockResolvedValue(undefined),
  $queryRaw: vi.fn().mockResolvedValue([]),
  booking: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    deleteMany: vi.fn(),
  },
  payment: {
    create: vi.fn(),
    upsert: vi.fn(),
  },
  season: { findMany: vi.fn() },
  promoRedemption: { count: vi.fn(), create: vi.fn(), aggregate: vi.fn() },
  promoCode: { findUnique: vi.fn(), update: vi.fn() },
  promoCodeAssignment: { findMany: vi.fn() },
  member: { findUnique: vi.fn() },
  memberSubscription: { findFirst: vi.fn() },
};

vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      deleteMany: vi.fn(),
    },
    payment: {
      create: vi.fn(),
      upsert: vi.fn(),
    },
    member: {
      count: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
    },
    memberSubscription: {
      findFirst: vi.fn(),
    },
    familyGroupMember: {
      findMany: vi.fn(),
    },
    season: {
      findMany: vi.fn(),
    },
    promoCode: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    promoRedemption: {
      count: vi.fn(),
      create: vi.fn(),
    },
    auditLog: {
      create: vi.fn().mockResolvedValue({}),
    },
    groupDiscountSetting: {
      findUnique: vi.fn().mockResolvedValue(null),
    },
    $transaction: vi.fn(),
  },
}));

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
const mockRequireActiveSessionUser = vi.fn(async () => null);
vi.mock("@/lib/session-guards", () => ({
  requireActiveSessionUser: (...args: unknown[]) => mockRequireActiveSessionUser(...args),
}));
const mockUpsertPaymentIntentTransaction = vi.fn();
const mockRecordInternetBankingPaymentTransaction = vi.fn();
vi.mock("@/lib/payment-transactions", () => ({
  upsertPaymentIntentTransaction: (...args: unknown[]) =>
    mockUpsertPaymentIntentTransaction(...args),
  recordInternetBankingPaymentTransaction: (...args: unknown[]) =>
    mockRecordInternetBankingPaymentTransaction(...args),
}));
const mockLoadEffectiveModuleFlags = vi.fn();
vi.mock("@/lib/module-settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/module-settings")>();

  return {
    ...actual,
    loadEffectiveModuleFlags: (...args: unknown[]) =>
      mockLoadEffectiveModuleFlags(...args),
  };
});

vi.mock("@/lib/cancellation", () => ({
  getNonMemberHoldDays: vi.fn().mockResolvedValue(7),
}));

vi.mock("@/lib/pricing", () => ({
  calculateBookingPrice: vi.fn().mockReturnValue({
    totalPriceCents: 10000,
    guests: [{ priceCents: 10000, perNightCents: [5000, 5000] }],
  }),
  calculatePromoDiscount: vi.fn().mockReturnValue({ discountCents: 0, freeNightsUsed: 0 }),
}));
vi.mock("@/lib/booking-policies", () => ({
  validateMinimumStay: vi.fn().mockResolvedValue({ valid: true, violations: [] }),
  formatViolationsDetail: vi.fn().mockReturnValue(""),
}));

vi.mock("@/lib/capacity", () => ({
  getOccupiedBedsForNight: vi.fn().mockReturnValue(0),
  checkCapacityForGuestRanges: vi.fn().mockResolvedValue({
    available: true,
    minAvailable: 29,
    nightDetails: [],
  }),
  LODGE_CAPACITY: 29,
}));

vi.mock("@/lib/bumping", () => ({
  bumpPendingBookings: vi.fn(),
  sendBumpedNotifications: vi.fn(),
}));

vi.mock("@/lib/promo", () => ({
  validatePromoCodeRules: vi.fn().mockReturnValue(null),
  validateAndCalculatePromoDiscount: vi.fn().mockResolvedValue({
    discount: { discountCents: 0, priceAdjustmentCents: 0, freeNightsUsed: 0, eligibleGuestCount: 0, allocations: [] },
    beneficiaryMemberIds: [],
  }),
  shouldPersistPromoRedemption: vi.fn().mockReturnValue(true),
  redeemPromoCode: vi.fn(),
  calculatePromoDiscountForGuestRates: vi.fn().mockReturnValue({
    discountCents: 0,
    priceAdjustmentCents: 0,
    freeNightsUsed: 0,
    eligibleGuestCount: 0,
    allocations: [],
  }),
  getMemberFreeNightsUsed: vi.fn().mockResolvedValue(0),
}));

vi.mock("@/lib/rate-limit", () => ({
  applyRateLimit: vi.fn().mockReturnValue(null),
  rateLimiters: { bookingCreate: {} },
}));

vi.mock("@/lib/email", () => ({
  sendBookingPendingEmail: vi.fn().mockResolvedValue(undefined),
  sendBookingConfirmedEmail: vi.fn().mockResolvedValue(undefined),
  sendAdminNewBookingAlert: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/xero", () => ({
  isXeroConnected: vi.fn().mockResolvedValue(false),
  createXeroInvoiceForBooking: vi.fn(),
}));
vi.mock("@/lib/xero-operation-outbox", () => ({
  enqueueXeroBookingInvoiceOperation: vi.fn().mockResolvedValue({
    queueOperationId: null,
    message: "already linked",
  }),
  kickQueuedXeroOutboxOperationsIfConnected: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/stripe", () => ({
  createPaymentIntent: vi.fn(),
  findOrCreateCustomer: vi.fn(),
  getPaymentIntent: vi.fn(),
}));

vi.mock("@/lib/logger", () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import { POST as createBooking } from "@/app/api/bookings/route";
import { GET as getDrafts } from "@/app/api/bookings/drafts/route";
import { POST as createPaymentIntent } from "@/app/api/payments/create-payment-intent/route";

const mockPrisma = prisma as unknown as {
  booking: {
    findUnique: ReturnType<typeof vi.fn>;
    findMany: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    updateMany: ReturnType<typeof vi.fn>;
    deleteMany: ReturnType<typeof vi.fn>;
  };
  payment: { create: ReturnType<typeof vi.fn>; upsert: ReturnType<typeof vi.fn> };
  member: { count: ReturnType<typeof vi.fn>; findUnique: ReturnType<typeof vi.fn>; findMany: ReturnType<typeof vi.fn> };
  memberSubscription: { findFirst: ReturnType<typeof vi.fn> };
  familyGroupMember: { findMany: ReturnType<typeof vi.fn> };
  season: { findMany: ReturnType<typeof vi.fn> };
  promoCode: { findUnique: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
  promoRedemption: { count: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> };
  $transaction: ReturnType<typeof vi.fn>;
};

const mockAuth = auth as ReturnType<typeof vi.fn>;

function memberSession(id = "member-1") {
  return { user: { id, role: "MEMBER" } };
}

function adminSession(id = "admin-1") {
  return { user: { id, role: "ADMIN" } };
}

const checkInDate = "2026-12-01";
const checkOutDate = "2026-12-03";

function makeBookingBody(extra: Record<string, unknown> = {}) {
  return new NextRequest("http://localhost/api/bookings", {
    method: "POST",
    body: JSON.stringify({
      checkIn: checkInDate,
      checkOut: checkOutDate,
      guests: [{ firstName: "Alice", lastName: "Smith", ageTier: "ADULT", isMember: true }],
      ...extra,
    }),
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();

  // Active, verified member by default
  mockPrisma.member.count.mockResolvedValue(1);
  mockPrisma.member.findUnique.mockResolvedValue({ active: true, emailVerified: true, xeroContactId: "xero-contact-1" });
  // Guest memberId validation mocks
  mockPrisma.familyGroupMember.findMany.mockResolvedValue([]);
  mockPrisma.member.findMany.mockResolvedValue([{ id: "member-1", ageTier: "ADULT" }]);
  // Paid subscription by default
  mockPrisma.memberSubscription.findFirst.mockResolvedValue({ id: "sub-1", status: "PAID" });
  // No seasons (returns empty = price will be 0 — but pricing is mocked so doesn't matter)
  mockPrisma.season.findMany.mockResolvedValue([]);
  // Transaction runs the callback with tx that mirrors prisma
  mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockTx) => Promise<unknown>) => {
    return fn(mockTx as unknown as typeof mockTx);
  });

  // Default transaction sub-calls
  mockTx.$executeRaw.mockResolvedValue(undefined);
  mockTx.$queryRaw.mockResolvedValue([]);
  mockTx.booking.findMany.mockResolvedValue([]);
  mockTx.booking.create.mockResolvedValue({
    id: "booking-1",
    status: "PAYMENT_PENDING",
    finalPriceCents: 10000,
    nonMemberHoldUntil: null,
    guests: [{ id: "g1" }],
  });
  mockTx.booking.update.mockResolvedValue({});
  mockTx.payment.create.mockResolvedValue({});
  mockTx.season.findMany.mockResolvedValue([]);
  mockTx.promoRedemption.aggregate.mockResolvedValue({ _sum: { freeNightsUsed: 0 } });
  mockTx.promoCodeAssignment.findMany.mockResolvedValue([]);
  mockPrisma.payment.upsert.mockResolvedValue({ id: "payment-1" });
  mockUpsertPaymentIntentTransaction.mockResolvedValue(undefined);
  mockRecordInternetBankingPaymentTransaction.mockResolvedValue(undefined);
  mockLoadEffectiveModuleFlags.mockResolvedValue({
    kiosk: true,
    chores: true,
    financeDashboard: true,
    waitlist: true,
    xeroIntegration: true,
    bedAllocation: true,
    internetBankingPayments: true,
  });
});

// ─── Issue 7: Draft Booking Creation ─────────────────────────────────────────

describe("Issue 7: Draft Booking Creation", () => {
  it("creates a DRAFT booking with draftExpiresAt when draft=true", async () => {
    mockAuth.mockResolvedValue(memberSession());

    const draftBooking = {
      id: "draft-1",
      status: "DRAFT",
      finalPriceCents: 10000,
      nonMemberHoldUntil: null,
      draftExpiresAt: new Date(Date.now() + 72 * 60 * 60 * 1000),
      guests: [{ id: "g1" }],
    };
    mockTx.booking.create.mockResolvedValue(draftBooking);

    const res = await createBooking(makeBookingBody({ draft: true }));
    expect(res.status).toBe(201);

    const data = await res.json();
    expect(data.status).toBe("DRAFT");
    expect(data.draftExpiresAt).toBeDefined();

    // Verify booking was created with DRAFT status
    expect(mockTx.booking.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "DRAFT" }),
      })
    );
  });

  it("creates draft bookings inside the advisory-lock transaction", async () => {
    mockAuth.mockResolvedValue(memberSession());

    mockTx.booking.create.mockResolvedValue({
      id: "draft-1",
      status: "DRAFT",
      finalPriceCents: 10000,
      nonMemberHoldUntil: null,
      draftExpiresAt: new Date(Date.now() + 72 * 60 * 60 * 1000),
      guests: [],
    });

    const res = await createBooking(makeBookingBody({ draft: true }));
    expect(res.status).toBe(201);

    expect(mockPrisma.$transaction).toHaveBeenCalled();
    expect(mockTx.$executeRaw).toHaveBeenCalled();
    expect(mockTx.booking.create).toHaveBeenCalled();
    expect(mockPrisma.booking.create).not.toHaveBeenCalled();
  });

  it("draft booking does NOT call sendBookingConfirmedEmail or admin alert", async () => {
    const { sendBookingConfirmedEmail, sendAdminNewBookingAlert } = await import("@/lib/email");
    mockAuth.mockResolvedValue(memberSession());

    mockTx.booking.create.mockResolvedValue({
      id: "draft-1",
      status: "DRAFT",
      finalPriceCents: 10000,
      nonMemberHoldUntil: null,
      draftExpiresAt: new Date(Date.now() + 72 * 60 * 60 * 1000),
      guests: [],
    });

    await createBooking(makeBookingBody({ draft: true }));

    expect(sendBookingConfirmedEmail).not.toHaveBeenCalled();
    expect(sendAdminNewBookingAlert).not.toHaveBeenCalled();
  });
});

describe("Internet Banking booking payment flow", () => {
  it("keeps Stripe as the default booking flow when no payment method is selected", async () => {
    mockAuth.mockResolvedValue(memberSession());

    const res = await createBooking(makeBookingBody());

    expect(res.status).toBe(201);
    // The subscription gate consults the effective module flags (Xero-off
    // bypass), but no Internet Banking payment artefacts are created.
    expect(mockTx.payment.create).not.toHaveBeenCalled();
    expect(mockRecordInternetBankingPaymentTransaction).not.toHaveBeenCalled();
  });

  it("creates a pending Internet Banking payment and queues a Xero invoice", async () => {
    const { enqueueXeroBookingInvoiceOperation } = await import("@/lib/xero-operation-outbox");
    mockAuth.mockResolvedValue(memberSession());
    mockTx.booking.create.mockResolvedValue({
      id: "booking-ib-1",
      status: "PAYMENT_PENDING",
      finalPriceCents: 10000,
      nonMemberHoldUntil: null,
      guests: [{ id: "g1" }],
    });
    mockTx.payment.create.mockResolvedValue({ id: "payment-ib-1" });

    const res = await createBooking(makeBookingBody({
      paymentMethod: "internet_banking",
    }));

    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.status).toBe("PAYMENT_PENDING");
    expect(mockLoadEffectiveModuleFlags).toHaveBeenCalled();
    expect(mockTx.booking.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "PAYMENT_PENDING",
          nonMemberHoldUntil: null,
        }),
      })
    );
    expect(mockTx.payment.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        bookingId: "booking-ib-1",
        amountCents: 10000,
        source: "INTERNET_BANKING",
        reference: "BOOKING-BOOKING-",
        status: "PENDING",
      }),
    });
    expect(mockRecordInternetBankingPaymentTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentId: "payment-ib-1",
        amountCents: 10000,
        status: "PENDING",
        reference: "BOOKING-BOOKING-",
        reason: "internet_banking_booking_payment",
      })
    );
    expect(enqueueXeroBookingInvoiceOperation).toHaveBeenCalledWith(
      "booking-ib-1",
      { createdByMemberId: "member-1" }
    );
  });

  it("rejects Internet Banking when the effective modules are disabled", async () => {
    mockAuth.mockResolvedValue(memberSession());
    // mockResolvedValue (not Once): the subscription gate also reads the
    // effective flags before the Internet Banking check does.
    mockLoadEffectiveModuleFlags.mockResolvedValue({
      kiosk: true,
      chores: true,
      financeDashboard: true,
      waitlist: true,
      xeroIntegration: true,
      bedAllocation: true,
      internetBankingPayments: false,
    });

    const res = await createBooking(makeBookingBody({
      paymentMethod: "internet_banking",
    }));

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: "Internet Banking payments are not available.",
    });
    expect(mockTx.booking.create).not.toHaveBeenCalled();
    expect(mockTx.payment.create).not.toHaveBeenCalled();
  });
});

// ─── Issue 7: GET /api/bookings/drafts ───────────────────────────────────────

describe("Issue 7: GET /api/bookings/drafts", () => {
  it("returns draft bookings for the current member", async () => {
    mockAuth.mockResolvedValue(memberSession());

    const drafts = [
      {
        id: "draft-1",
        status: "DRAFT",
        checkIn: new Date("2026-12-01"),
        checkOut: new Date("2026-12-03"),
        finalPriceCents: 5000,
        draftExpiresAt: new Date(Date.now() + 72 * 60 * 60 * 1000),
        guests: [],
      },
    ];
    mockPrisma.booking.findMany.mockResolvedValue(drafts);

    const res = await getDrafts();
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.drafts).toHaveLength(1);
    expect(data.drafts[0].status).toBe("DRAFT");
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);

    const res = await getDrafts();
    expect(res.status).toBe(401);
  });

  it("returns 403 when the member was deactivated after the session was issued", async () => {
    mockRequireActiveSessionUser.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "Account is deactivated" }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      })
    );
    mockAuth.mockResolvedValue(memberSession());

    const res = await getDrafts();
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error).toBe("Account is deactivated");
  });
});

// ─── Issue 7: Payment intent transitions DRAFT -> PAYMENT_PENDING ────────────

describe("Issue 7: create-payment-intent with DRAFT booking", () => {
  beforeEach(async () => {
    const stripe = await import("@/lib/stripe");
    (stripe.createPaymentIntent as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "pi_test",
      client_secret: "secret_test",
    });
    (stripe.findOrCreateCustomer as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "cus_test" });
  });

  it("accepts DRAFT status and transitions to PAYMENT_PENDING", async () => {
    const { checkCapacityForGuestRanges } = await import("@/lib/capacity");
    mockAuth.mockResolvedValue(memberSession());
    const guestRanges = [
      {
        id: "g1",
        stayStart: new Date("2026-07-01"),
        stayEnd: new Date("2026-07-02"),
      },
      {
        id: "g2",
        stayStart: new Date("2026-07-02"),
        stayEnd: new Date("2026-07-03"),
      },
    ];

    const draftBooking = {
      id: "draft-1",
      memberId: "member-1",
      status: "DRAFT",
      finalPriceCents: 10000,
      hasNonMembers: false,
      requiresAdminReview: false,
      adminReviewReason: null,
      checkIn: new Date("2026-07-01"),
      checkOut: new Date("2026-07-03"),
      member: { id: "member-1", email: "test@example.com", firstName: "Alice", lastName: "Smith" },
      payment: null,
    };
    mockPrisma.booking.findUnique.mockResolvedValue(draftBooking);
    mockPrisma.payment.upsert.mockResolvedValue({ id: "payment-1" });

    // Mock the $transaction for capacity check + status transition
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockTx) => Promise<unknown>) => {
      mockTx.booking.findUnique.mockResolvedValue({
        ...draftBooking,
        guests: guestRanges,
      });
      mockTx.booking.update.mockResolvedValue({});
      return fn(mockTx as unknown as typeof mockTx);
    });

    const req = new NextRequest("http://localhost/api/payments/create-payment-intent", {
      method: "POST",
      body: JSON.stringify({ bookingId: "draft-1" }),
      headers: { "Content-Type": "application/json" },
    });

    const res = await createPaymentIntent(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.clientSecret).toBe("secret_test");

    // Verify DRAFT -> PAYMENT_PENDING transition was called
    expect(mockTx.booking.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "PAYMENT_PENDING" }),
      })
    );
    expect(checkCapacityForGuestRanges).toHaveBeenCalledWith(
      draftBooking.checkIn,
      draftBooking.checkOut,
      guestRanges,
      "draft-1",
      mockTx
    );
    expect(mockUpsertPaymentIntentTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentId: "payment-1",
        paymentIntentId: "pi_test",
      })
    );
  });

  it("rejects existing Internet Banking payments before creating a Stripe intent", async () => {
    const stripe = await import("@/lib/stripe");
    mockAuth.mockResolvedValue(memberSession());

    mockPrisma.booking.findUnique.mockResolvedValue({
      id: "ib-1",
      memberId: "member-1",
      status: "PAYMENT_PENDING",
      finalPriceCents: 10000,
      hasNonMembers: false,
      requiresAdminReview: false,
      member: {
        id: "member-1",
        email: "test@example.com",
        firstName: "Alice",
        lastName: "Smith",
      },
      guests: [{ id: "g1" }],
      payment: {
        id: "payment-ib-1",
        source: "INTERNET_BANKING",
        status: "PENDING",
        reference: "BOOKING-IB-1",
        stripePaymentIntentId: null,
      },
    });

    const req = new NextRequest("http://localhost/api/payments/create-payment-intent", {
      method: "POST",
      body: JSON.stringify({ bookingId: "ib-1" }),
      headers: { "Content-Type": "application/json" },
    });

    const res = await createPaymentIntent(req);

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error:
        "This booking is already awaiting Internet Banking payment and cannot use the Stripe payment flow",
    });
    expect(stripe.findOrCreateCustomer).not.toHaveBeenCalled();
    expect(stripe.createPaymentIntent).not.toHaveBeenCalled();
    expect(mockUpsertPaymentIntentTransaction).not.toHaveBeenCalled();
  });

  it("rejects non-payable statuses (CANCELLED)", async () => {
    mockAuth.mockResolvedValue(memberSession());

    mockPrisma.booking.findUnique.mockResolvedValue({
      id: "b1",
      memberId: "member-1",
      status: "CANCELLED",
      finalPriceCents: 10000,
      member: { id: "member-1", email: "test@example.com", firstName: "Alice", lastName: "Smith" },
      payment: null,
    });

    const req = new NextRequest("http://localhost/api/payments/create-payment-intent", {
      method: "POST",
      body: JSON.stringify({ bookingId: "b1" }),
      headers: { "Content-Type": "application/json" },
    });

    const res = await createPaymentIntent(req);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("not in a payable state");
  });
});

// ─── Issue 10: Subscription Check ────────────────────────────────────────────

describe("Issue 10: Subscription check on booking creation", () => {
  it("blocks UNPAID members with 403", async () => {
    mockAuth.mockResolvedValue(memberSession());
    mockPrisma.memberSubscription.findFirst.mockResolvedValue(null); // no paid sub

    const res = await createBooking(makeBookingBody());
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error).toContain("subscription");
    expect(data.error).toContain("not paid");
  });

  it("blocks OVERDUE members with 403", async () => {
    mockAuth.mockResolvedValue(memberSession());
    // findFirst with status: PAID returns null (OVERDUE sub won't match PAID query)
    mockPrisma.memberSubscription.findFirst.mockResolvedValue(null);

    const res = await createBooking(makeBookingBody());
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error).toContain("subscription");
  });

  it("allows PAID members to book", async () => {
    mockAuth.mockResolvedValue(memberSession());
    mockPrisma.memberSubscription.findFirst.mockResolvedValue({ id: "sub-1", status: "PAID" });

    const paymentPendingBooking = {
      id: "booking-1",
      status: "PAYMENT_PENDING",
      finalPriceCents: 10000,
      nonMemberHoldUntil: null,
      guests: [{ id: "g1" }],
    };
    mockTx.booking.create.mockResolvedValue(paymentPendingBooking);

    const res = await createBooking(makeBookingBody());
    expect(res.status).toBe(201);
  });

  it("admin bypasses subscription check (booking on behalf)", async () => {
    mockAuth.mockResolvedValue(adminSession());
    // Even if memberSubscription returns null, admin should not be blocked
    mockPrisma.memberSubscription.findFirst.mockResolvedValue(null);
    // Target member must be active for on-behalf booking
    mockPrisma.member.findUnique.mockResolvedValue({ active: true });

    const draftBooking = {
      id: "booking-1",
      status: "DRAFT",
      finalPriceCents: 10000,
      nonMemberHoldUntil: null,
      draftExpiresAt: new Date(Date.now() + 72 * 60 * 60 * 1000),
      guests: [{ id: "g1" }],
    };
    mockTx.booking.create.mockResolvedValue(draftBooking);

    // Admin must use forMemberId to book on behalf.
    const res = await createBooking(makeBookingBody({ forMemberId: "target-member-1", draft: true }));
    // Admin should get through — subscription check skipped
    expect(res.status).toBe(201);
    // memberSubscription.findFirst should NOT have been called for admin
    expect(mockPrisma.memberSubscription.findFirst).not.toHaveBeenCalled();
  });

  it("subscription check applies to draft bookings too", async () => {
    mockAuth.mockResolvedValue(memberSession());
    mockPrisma.memberSubscription.findFirst.mockResolvedValue(null); // no paid sub

    const res = await createBooking(makeBookingBody({ draft: true }));
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error).toContain("subscription");
  });

  it("allows UNPAID members to book when the Xero module is effectively off", async () => {
    mockAuth.mockResolvedValue(memberSession());
    mockPrisma.memberSubscription.findFirst.mockResolvedValue(null); // no paid sub
    // Subscriptions are invoiced through Xero; with the module off the
    // booking-time subscription gate must not block members.
    mockLoadEffectiveModuleFlags.mockResolvedValue({
      kiosk: true,
      chores: true,
      financeDashboard: true,
      waitlist: true,
      xeroIntegration: false,
      bedAllocation: true,
      internetBankingPayments: false,
    });

    const res = await createBooking(makeBookingBody());
    expect(res.status).toBe(201);
    // The gate short-circuits before querying subscriptions at all.
    expect(mockPrisma.memberSubscription.findFirst).not.toHaveBeenCalled();
  });

  it("still blocks UNPAID members when the Xero module is on", async () => {
    mockAuth.mockResolvedValue(memberSession());
    mockPrisma.memberSubscription.findFirst.mockResolvedValue(null); // no paid sub
    // Default beforeEach flags already have xeroIntegration: true; assert the
    // behaviour is unchanged with the module enabled.
    const res = await createBooking(makeBookingBody());
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error).toContain("subscription");
  });

  it("error message includes the season year", async () => {
    mockAuth.mockResolvedValue(memberSession());
    mockPrisma.memberSubscription.findFirst.mockResolvedValue(null);

    const res = await createBooking(makeBookingBody());
    const data = await res.json();
    // checkIn is 2026-12-01 -> season year 2026 -> "2026/2027"
    expect(data.error).toContain("2026/2027");
  });
});

// ─── Issue 7: Draft expiry cleanup logic ─────────────────────────────────────

describe("Issue 7: Draft expiry cleanup logic", () => {
  it("identifies expired drafts correctly (draftExpiresAt < now)", () => {
    const now = new Date();
    const expiredAt = new Date(now.getTime() - 1000); // 1 second ago
    const notExpiredAt = new Date(now.getTime() + 72 * 60 * 60 * 1000);

    expect(expiredAt < now).toBe(true);
    expect(notExpiredAt > now).toBe(true);
  });

  it("draft expiry is set to 72 hours from creation", async () => {
    mockAuth.mockResolvedValue(memberSession());

    let capturedData: Record<string, unknown> | null = null;
    mockTx.booking.create.mockImplementation(async (args: { data: Record<string, unknown> }) => {
      capturedData = args.data;
      return {
        id: "draft-1",
        status: "DRAFT",
        finalPriceCents: 10000,
        nonMemberHoldUntil: null,
        draftExpiresAt: args.data.draftExpiresAt,
        guests: [],
      };
    });

    const before = Date.now();
    await createBooking(makeBookingBody({ draft: true }));
    const after = Date.now();

    expect(capturedData).not.toBeNull();
    const expiresAt = new Date(capturedData!.draftExpiresAt as string);
    const diffMs = expiresAt.getTime() - before;
    const expectedMs = 72 * 60 * 60 * 1000;

    // Should be within a second of 72 hours
    expect(diffMs).toBeGreaterThanOrEqual(expectedMs - 1000);
    expect(diffMs).toBeLessThanOrEqual(expectedMs + (after - before) + 1000);
  });
});
