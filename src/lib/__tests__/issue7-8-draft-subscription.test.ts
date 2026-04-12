/**
 * Tests for Issue 7 (Draft Bookings) and Issue 10 (Subscription Check on Booking)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockTx = {
  $executeRaw: vi.fn().mockResolvedValue(undefined),
  $executeRawUnsafe: vi.fn().mockResolvedValue(undefined),
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
  promoRedemption: { count: vi.fn(), create: vi.fn() },
  promoCode: { findUnique: vi.fn(), update: vi.fn() },
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

vi.mock("@/lib/cancellation", () => ({
  getNonMemberHoldDays: vi.fn().mockResolvedValue(7),
}));

vi.mock("@/lib/pricing", () => ({
  calculateBookingPrice: vi.fn().mockReturnValue({
    totalPriceCents: 10000,
    guests: [{ priceCents: 10000, perNightCents: [5000, 5000] }],
  }),
  calculatePromoDiscount: vi.fn().mockReturnValue(0),
}));
vi.mock("@/lib/booking-policies", () => ({
  validateMinimumStay: vi.fn().mockResolvedValue({ valid: true, violations: [] }),
  formatViolationsDetail: vi.fn().mockReturnValue(""),
}));

vi.mock("@/lib/capacity", () => ({
  LODGE_CAPACITY: 29,
}));

vi.mock("@/lib/bumping", () => ({
  bumpPendingBookings: vi.fn(),
  sendBumpedNotifications: vi.fn(),
}));

vi.mock("@/lib/promo", () => ({
  validatePromoCodeRules: vi.fn().mockReturnValue(null),
  redeemPromoCode: vi.fn(),
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

const checkIn = new Date("2026-12-01");
const checkOut = new Date("2026-12-03");

function makeBookingBody(extra: Record<string, unknown> = {}) {
  return new NextRequest("http://localhost/api/bookings", {
    method: "POST",
    body: JSON.stringify({
      checkIn: checkIn.toISOString(),
      checkOut: checkOut.toISOString(),
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
  mockTx.booking.findMany.mockResolvedValue([]);
  mockTx.booking.create.mockResolvedValue({
    id: "booking-1",
    status: "CONFIRMED",
    finalPriceCents: 10000,
    nonMemberHoldUntil: null,
    guests: [{ id: "g1" }],
  });
  mockTx.booking.update.mockResolvedValue({});
  mockTx.payment.create.mockResolvedValue({});
  mockTx.season.findMany.mockResolvedValue([]);
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
    mockPrisma.booking.create.mockResolvedValue(draftBooking);

    const res = await createBooking(makeBookingBody({ draft: true }));
    expect(res.status).toBe(201);

    const data = await res.json();
    expect(data.status).toBe("DRAFT");
    expect(data.draftExpiresAt).toBeDefined();

    // Verify booking was created with DRAFT status
    expect(mockPrisma.booking.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "DRAFT" }),
      })
    );
  });

  it("draft booking does NOT go through capacity transaction", async () => {
    mockAuth.mockResolvedValue(memberSession());

    mockPrisma.booking.create.mockResolvedValue({
      id: "draft-1",
      status: "DRAFT",
      finalPriceCents: 10000,
      nonMemberHoldUntil: null,
      draftExpiresAt: new Date(Date.now() + 72 * 60 * 60 * 1000),
      guests: [],
    });

    const res = await createBooking(makeBookingBody({ draft: true }));
    expect(res.status).toBe(201);

    // The $transaction (capacity check) must NOT have been called for a draft
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it("draft booking does NOT call sendBookingConfirmedEmail or admin alert", async () => {
    const { sendBookingConfirmedEmail, sendAdminNewBookingAlert } = await import("@/lib/email");
    mockAuth.mockResolvedValue(memberSession());

    mockPrisma.booking.create.mockResolvedValue({
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
    mockAuth.mockResolvedValue(memberSession());
    mockPrisma.member.count.mockResolvedValue(0);

    const res = await getDrafts();
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error).toBe("Account is deactivated");
  });
});

// ─── Issue 7: Payment intent transitions DRAFT -> CONFIRMED ──────────────────

describe("Issue 7: create-payment-intent with DRAFT booking", () => {
  beforeEach(async () => {
    const stripe = await import("@/lib/stripe");
    (stripe.createPaymentIntent as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "pi_test",
      client_secret: "secret_test",
    });
    (stripe.findOrCreateCustomer as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "cus_test" });
  });

  it("accepts DRAFT status and transitions to CONFIRMED", async () => {
    mockAuth.mockResolvedValue(memberSession());

    const draftBooking = {
      id: "draft-1",
      memberId: "member-1",
      status: "DRAFT",
      finalPriceCents: 10000,
      member: { id: "member-1", email: "test@example.com", firstName: "Alice", lastName: "Smith" },
      payment: null,
    };
    mockPrisma.booking.findUnique.mockResolvedValue(draftBooking);
    mockPrisma.payment.upsert.mockResolvedValue({});

    // Mock the $transaction for capacity check + status transition
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockTx) => Promise<unknown>) => {
      mockTx.booking.findUnique.mockResolvedValue({
        ...draftBooking,
        guests: [{ id: "g1" }],
      });
      mockTx.booking.findMany.mockResolvedValue([]); // no overlapping
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

    // Verify DRAFT -> CONFIRMED transition was called
    expect(mockTx.booking.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "CONFIRMED" }),
      })
    );
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

    const confirmedBooking = {
      id: "booking-1",
      status: "CONFIRMED",
      finalPriceCents: 10000,
      nonMemberHoldUntil: null,
      guests: [{ id: "g1" }],
    };
    mockTx.booking.create.mockResolvedValue(confirmedBooking);

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
    mockPrisma.booking.create.mockResolvedValue(draftBooking);

    // Admin must use forMemberId to book on behalf (use draft to skip capacity tx)
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
    mockPrisma.booking.create.mockImplementation(async (args: { data: Record<string, unknown> }) => {
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
