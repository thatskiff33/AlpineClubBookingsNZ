/**
 * P2.3: Subscription check for member guests on booking creation
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockTx = {
  $executeRaw: vi.fn().mockResolvedValue(undefined),
  $executeRawUnsafe: vi.fn().mockResolvedValue(undefined),
  booking: {
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  },
  payment: { create: vi.fn() },
  season: { findMany: vi.fn() },
  promoRedemption: { count: vi.fn(), create: vi.fn() },
  promoCode: { findUnique: vi.fn(), update: vi.fn() },
  member: { findUnique: vi.fn() },
  memberSubscription: { findFirst: vi.fn(), findMany: vi.fn() },
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
    },
    payment: { create: vi.fn() },
    member: {
      count: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
    },
    memberSubscription: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
    },
    familyGroupMember: { findMany: vi.fn() },
    season: { findMany: vi.fn() },
    promoCode: { findUnique: vi.fn(), update: vi.fn() },
    promoRedemption: { count: vi.fn(), create: vi.fn() },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
    groupDiscountSetting: { findUnique: vi.fn().mockResolvedValue(null) },
    $transaction: vi.fn(),
  },
}));

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/cancellation", () => ({ getNonMemberHoldDays: vi.fn().mockResolvedValue(7) }));
vi.mock("@/lib/pricing", () => ({
  calculateBookingPrice: vi.fn().mockReturnValue({
    totalPriceCents: 10000,
    guests: [
      { priceCents: 5000, perNightCents: [2500, 2500] },
      { priceCents: 5000, perNightCents: [2500, 2500] },
    ],
  }),
}));
vi.mock("@/lib/booking-policies", () => ({
  validateMinimumStay: vi.fn().mockResolvedValue({ valid: true, violations: [] }),
  formatViolationsDetail: vi.fn().mockReturnValue(""),
}));
vi.mock("@/lib/capacity", () => ({ LODGE_CAPACITY: 29 }));
vi.mock("@/lib/bumping", () => ({ bumpPendingBookings: vi.fn(), sendBumpedNotifications: vi.fn() }));
vi.mock("@/lib/promo", () => ({ validatePromoCodeRules: vi.fn().mockReturnValue(null), redeemPromoCode: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({ applyRateLimit: vi.fn().mockReturnValue(null), rateLimiters: { bookingCreate: {} } }));
vi.mock("@/lib/email", () => ({
  sendBookingPendingEmail: vi.fn().mockResolvedValue(undefined),
  sendBookingConfirmedEmail: vi.fn().mockResolvedValue(undefined),
  sendAdminNewBookingAlert: vi.fn().mockResolvedValue(undefined),
  sendWaitlistConfirmationEmail: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/xero", () => ({ isXeroConnected: vi.fn().mockResolvedValue(false), createXeroInvoiceForBooking: vi.fn() }));
vi.mock("@/lib/stripe", () => ({ createPaymentIntent: vi.fn(), findOrCreateCustomer: vi.fn(), getPaymentIntent: vi.fn() }));
vi.mock("@/lib/logger", () => ({ default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/waitlist", () => ({ getWaitlistPosition: vi.fn().mockResolvedValue(1) }));
vi.mock("@/lib/member-credit", () => ({ getMemberCreditBalance: vi.fn().mockResolvedValue(0), applyCreditToBooking: vi.fn() }));
vi.mock("@/lib/session-guards", () => ({ requireActiveSessionUser: vi.fn().mockResolvedValue(null) }));

// ─── Imports ──────────────────────────────────────────────────────────────────

import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import { POST as createBooking } from "@/app/api/bookings/route";
import { POST as getModifyQuote } from "@/app/api/bookings/[id]/modify-quote/route";

const mockPrisma = prisma as unknown as {
  booking: { findUnique: ReturnType<typeof vi.fn>; findMany: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
  payment: { create: ReturnType<typeof vi.fn> };
  member: { count: ReturnType<typeof vi.fn>; findUnique: ReturnType<typeof vi.fn>; findMany: ReturnType<typeof vi.fn> };
  memberSubscription: { findFirst: ReturnType<typeof vi.fn>; findMany: ReturnType<typeof vi.fn> };
  familyGroupMember: { findMany: ReturnType<typeof vi.fn> };
  season: { findMany: ReturnType<typeof vi.fn> };
  $transaction: ReturnType<typeof vi.fn>;
};

const mockAuth = auth as ReturnType<typeof vi.fn>;

const checkIn = new Date("2026-12-01");
const checkOut = new Date("2026-12-03");

function makeRequest(guests: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) {
  return new NextRequest("http://localhost/api/bookings", {
    method: "POST",
    body: JSON.stringify({
      checkIn: checkIn.toISOString(),
      checkOut: checkOut.toISOString(),
      guests,
      ...extra,
    }),
    headers: { "Content-Type": "application/json" },
  });
}

function makeModifyQuoteRequest(body: Record<string, unknown>) {
  return new NextRequest("http://localhost/api/bookings/booking-1/modify-quote", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();

  // Active, verified member by default
  mockPrisma.member.count.mockResolvedValue(1);
  mockPrisma.member.findUnique.mockResolvedValue({ id: "member-1", active: true, emailVerified: true, xeroContactId: "xero-1" });
  // Guest memberId resolution — member-1 and guest-member-1 share a family group
  mockPrisma.familyGroupMember.findMany.mockImplementation(async (args: { where?: { memberId?: string; familyGroupId?: { in?: string[] } } }) => {
    if (args?.where?.memberId === "member-1") {
      return [{ familyGroupId: "family-1", memberId: "member-1" }];
    }
    if (args?.where?.familyGroupId) {
      return [
        { familyGroupId: "family-1", memberId: "member-1" },
        { familyGroupId: "family-1", memberId: "guest-member-1" },
        { familyGroupId: "family-1", memberId: "guest-member-2" },
      ];
    }
    return [];
  });
  mockPrisma.member.findMany.mockResolvedValue([
    { id: "member-1", ageTier: "ADULT" },
    { id: "guest-member-1", ageTier: "ADULT", firstName: "Bob", lastName: "Jones" },
  ]);
  mockPrisma.booking.findUnique.mockResolvedValue({
    id: "booking-1",
    memberId: "member-1",
    checkIn,
    checkOut,
    status: "CONFIRMED",
    finalPriceCents: 10000,
    discountCents: 0,
    guests: [
      {
        id: "existing-1",
        firstName: "Alice",
        lastName: "Smith",
        ageTier: "ADULT",
        isMember: true,
        memberId: "member-1",
        priceCents: 5000,
      },
    ],
    payment: null,
    promoRedemption: null,
  });
  // Owner has paid subscription
  mockPrisma.memberSubscription.findFirst.mockResolvedValue({ id: "sub-1", status: "PAID" });
  // Guest subscription check — default: all paid
  mockPrisma.memberSubscription.findMany.mockResolvedValue([{ memberId: "guest-member-1" }]);
  mockPrisma.season.findMany.mockResolvedValue([]);

  mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockTx) => Promise<unknown>) => fn(mockTx as unknown as typeof mockTx));
  mockTx.$executeRaw.mockResolvedValue(undefined);
  mockTx.booking.findMany.mockResolvedValue([]);
  mockTx.booking.create.mockResolvedValue({
    id: "booking-1",
    status: "CONFIRMED",
    finalPriceCents: 10000,
    nonMemberHoldUntil: null,
    guests: [{ id: "g1" }, { id: "g2" }],
  });
  mockTx.season.findMany.mockResolvedValue([]);
});

describe("P2.3: Guest subscription check", () => {
  it("blocks booking when a member-guest has unpaid subscription", async () => {
    mockAuth.mockResolvedValue({ user: { id: "member-1", role: "MEMBER" } });
    // Guest subscription check returns empty (no paid subs found for guests)
    mockPrisma.memberSubscription.findMany.mockResolvedValue([]);
    // member.findMany is called multiple times:
    // 1. resolveLinkedBookingMembers (needs ageTier for linked members)
    // 2. unpaid member name lookup (needs firstName/lastName)
    mockPrisma.member.findMany.mockResolvedValue([
      { id: "member-1", ageTier: "ADULT", firstName: "Alice", lastName: "Smith" },
      { id: "guest-member-1", ageTier: "ADULT", firstName: "Bob", lastName: "Jones" },
    ]);

    const req = makeRequest([
      { firstName: "Alice", lastName: "Smith", ageTier: "ADULT", isMember: true },
      { firstName: "Bob", lastName: "Jones", ageTier: "ADULT", isMember: true, memberId: "guest-member-1" },
    ]);

    const res = await createBooking(req);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("GUEST_SUBSCRIPTION_REQUIRED");
    expect(body.unpaidMembers).toContain("Bob Jones");
  });

  it("allows booking when all member-guests have paid subscriptions", async () => {
    mockAuth.mockResolvedValue({ user: { id: "member-1", role: "MEMBER" } });
    // findMany returns paid sub for guest-member-1
    mockPrisma.memberSubscription.findMany.mockResolvedValue([{ memberId: "guest-member-1" }]);

    const req = makeRequest([
      { firstName: "Alice", lastName: "Smith", ageTier: "ADULT", isMember: true },
      { firstName: "Bob", lastName: "Jones", ageTier: "ADULT", isMember: true, memberId: "guest-member-1" },
    ]);

    const res = await createBooking(req);
    // Should not be 403 — either 201 or other valid response
    expect(res.status).not.toBe(403);
  });

  it("admin-created bookings bypass guest subscription check", async () => {
    mockAuth.mockResolvedValue({ user: { id: "admin-1", role: "ADMIN" } });
    // No paid subs for guest
    mockPrisma.memberSubscription.findMany.mockResolvedValue([]);

    const req = makeRequest(
      [
        { firstName: "Alice", lastName: "Smith", ageTier: "ADULT", isMember: true },
        { firstName: "Bob", lastName: "Jones", ageTier: "ADULT", isMember: true, memberId: "guest-member-1" },
      ],
      { forMemberId: "member-1" }
    );

    const res = await createBooking(req);
    // Admin bypass — should not be 403 GUEST_SUBSCRIPTION_REQUIRED
    const body = await res.json();
    expect(body.code).not.toBe("GUEST_SUBSCRIPTION_REQUIRED");
  });

  it("non-member guests are not checked for subscriptions", async () => {
    mockAuth.mockResolvedValue({ user: { id: "member-1", role: "MEMBER" } });

    const req = makeRequest([
      { firstName: "Alice", lastName: "Smith", ageTier: "ADULT", isMember: true },
      { firstName: "Random", lastName: "Visitor", ageTier: "ADULT", isMember: false },
    ]);

    const res = await createBooking(req);
    // memberSubscription.findMany should NOT be called for non-member guests
    // The call is only made when there are member guests with memberIds
    expect(res.status).not.toBe(403);
  });

  it("error message includes names of all unpaid members", async () => {
    mockAuth.mockResolvedValue({ user: { id: "member-1", role: "MEMBER" } });
    mockPrisma.memberSubscription.findMany.mockResolvedValue([]);
    mockPrisma.member.findMany.mockImplementation(async (args: { where?: { id?: { in?: string[] } } }) => {
      const ids = args?.where?.id?.in;
      if (ids && (ids.includes("guest-member-1") || ids.includes("guest-member-2"))) {
        return [
          { id: "guest-member-1", ageTier: "ADULT", firstName: "Bob", lastName: "Jones" },
          { id: "guest-member-2", ageTier: "ADULT", firstName: "Carol", lastName: "White" },
        ];
      }
      return [{ id: "member-1", ageTier: "ADULT" }];
    });

    const req = makeRequest([
      { firstName: "Alice", lastName: "Smith", ageTier: "ADULT", isMember: true },
      { firstName: "Bob", lastName: "Jones", ageTier: "ADULT", isMember: true, memberId: "guest-member-1" },
      { firstName: "Carol", lastName: "White", ageTier: "ADULT", isMember: true, memberId: "guest-member-2" },
    ]);

    const res = await createBooking(req);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("GUEST_SUBSCRIPTION_REQUIRED");
    expect(body.unpaidMembers).toContain("Bob Jones");
    expect(body.unpaidMembers).toContain("Carol White");
    expect(body.error).toContain("Bob Jones");
    expect(body.error).toContain("Carol White");
  });

  it("blocks the modify quote flow from adding an unpaid member-guest later", async () => {
    mockAuth.mockResolvedValue({ user: { id: "member-1", role: "MEMBER" } });
    mockPrisma.memberSubscription.findMany.mockResolvedValue([]);
    mockPrisma.member.findMany.mockResolvedValue([
      { id: "member-1", ageTier: "ADULT", firstName: "Alice", lastName: "Smith" },
      { id: "guest-member-1", ageTier: "ADULT", firstName: "Bob", lastName: "Jones" },
    ]);

    const req = makeModifyQuoteRequest({
      addGuests: [
        {
          firstName: "Bob",
          lastName: "Jones",
          ageTier: "ADULT",
          isMember: true,
          memberId: "guest-member-1",
        },
      ],
    });

    const res = await getModifyQuote(req, {
      params: Promise.resolve({ id: "booking-1" }),
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("GUEST_SUBSCRIPTION_REQUIRED");
    expect(body.unpaidMembers).toContain("Bob Jones");
  });
});
