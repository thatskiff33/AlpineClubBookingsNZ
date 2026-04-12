import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// Mock prisma
vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: { count: vi.fn(), findUnique: vi.fn(), findMany: vi.fn() },
    booking: { create: vi.fn(), update: vi.fn(), findMany: vi.fn() },
    season: { findMany: vi.fn() },
    promoCode: { findUnique: vi.fn() },
    promoRedemption: { count: vi.fn() },
    familyGroupMember: { findMany: vi.fn() },
    memberSubscription: { findFirst: vi.fn() },
    payment: { create: vi.fn() },
    groupDiscountSetting: { findUnique: vi.fn().mockResolvedValue(null) },
    $transaction: vi.fn(),
    $executeRaw: vi.fn(),
  },
}));

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({
  applyRateLimit: vi.fn().mockReturnValue(null),
  rateLimiters: { bookingCreate: {}, bookingQuery: {} },
}));
vi.mock("@/lib/logger", () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/cancellation", () => ({
  getNonMemberHoldDays: vi.fn().mockResolvedValue(7),
}));
vi.mock("@/lib/email", () => ({
  sendBookingPendingEmail: vi.fn().mockResolvedValue(undefined),
  sendBookingConfirmedEmail: vi.fn().mockResolvedValue(undefined),
  sendAdminNewBookingAlert: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/xero", () => ({
  isXeroConnected: vi.fn().mockResolvedValue(false),
  createXeroInvoiceForBooking: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/bumping", () => ({
  bumpPendingBookings: vi.fn(),
  sendBumpedNotifications: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/promo", () => ({
  validatePromoCodeRules: vi.fn().mockReturnValue(null),
  redeemPromoCode: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/pricing", () => ({
  calculateBookingPrice: vi.fn().mockReturnValue({
    totalPriceCents: 5000,
    guests: [{ priceCents: 5000, perNightCents: [5000] }],
  }),
  calculatePromoDiscount: vi.fn().mockReturnValue(0),
}));
vi.mock("@/lib/member-credit", () => ({
  getMemberCreditBalance: vi.fn().mockResolvedValue(0),
  applyCreditToBooking: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/audit", () => ({
  logAudit: vi.fn(),
}));
vi.mock("@/lib/utils", () => ({
  getSeasonYear: vi.fn().mockReturnValue(2026),
}));
vi.mock("@/lib/booking-policies", () => ({
  validateMinimumStay: vi.fn().mockResolvedValue({ valid: true, violations: [] }),
  formatViolationsDetail: vi.fn().mockReturnValue(""),
}));

import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { getMemberCreditBalance } from "@/lib/member-credit";
import { calculateBookingPrice } from "@/lib/pricing";
import { POST } from "@/app/api/bookings/route";
import { POST as postQuote } from "@/app/api/bookings/quote/route";
import { POST as postPromoValidate } from "@/app/api/promo-codes/validate/route";

const mockedAuth = vi.mocked(auth);
const mockedPrisma = vi.mocked(prisma);
const mockedAudit = vi.mocked(logAudit);
const mockedGetCredit = vi.mocked(getMemberCreditBalance);
const mockedCalcPrice = vi.mocked(calculateBookingPrice);

function makeRequest(body: Record<string, unknown>) {
  return new NextRequest("http://localhost/api/bookings", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

const futureDate = new Date();
futureDate.setDate(futureDate.getDate() + 30);
const checkIn = futureDate.toISOString();
const checkOutDate = new Date(futureDate);
checkOutDate.setDate(checkOutDate.getDate() + 2);
const checkOut = checkOutDate.toISOString();

const baseBookingPayload = {
  checkIn,
  checkOut,
  guests: [{ firstName: "Jane", lastName: "Doe", ageTier: "ADULT", isMember: true, memberId: "target-m1" }],
};

describe("Admin Book on Behalf", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects admin booking without forMemberId (must book on behalf)", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "admin1", role: "ADMIN" } } as never);

    const req = makeRequest(baseBookingPayload);
    const res = await POST(req);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("ADMIN_MUST_BOOK_ON_BEHALF");
    expect(body.error).toContain("Admins must book on behalf");
  });

  it("rejects forMemberId from non-admin users", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "m1", role: "MEMBER" } } as never);
    (mockedPrisma.member.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      active: true, emailVerified: true, xeroContactId: "xero1",
    });

    const req = makeRequest({ ...baseBookingPayload, forMemberId: "target-m1" });
    const res = await POST(req);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toContain("Only admins");
  });

  it("rejects admin booking for themselves", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "admin1", role: "ADMIN" } } as never);
    (mockedPrisma.member.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      active: true, emailVerified: true, xeroContactId: null,
    });

    const req = makeRequest({ ...baseBookingPayload, forMemberId: "admin1" });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("cannot book for themselves");
  });

  it("rejects booking for inactive target member", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "admin1", role: "ADMIN" } } as never);
    (mockedPrisma.member.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      active: false,
    });

    const req = makeRequest({ ...baseBookingPayload, forMemberId: "target-m1" });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("not found or inactive");
  });

  it("creates draft booking with correct memberId and createdById", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "admin1", role: "ADMIN" } } as never);
    (mockedPrisma.member.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      active: true,
    });
    (mockedPrisma.member.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "target-m1", ageTier: "ADULT" },
    ]);
    (mockedPrisma.season.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const createdBooking = {
      id: "b1",
      memberId: "target-m1",
      createdById: "admin1",
      status: "DRAFT",
      guests: [{ id: "g1", firstName: "Jane", lastName: "Doe" }],
    };
    (mockedPrisma.booking.create as ReturnType<typeof vi.fn>).mockResolvedValue(createdBooking);

    const req = makeRequest({
      ...baseBookingPayload,
      draft: true,
      forMemberId: "target-m1",
    });
    const res = await POST(req);
    expect(res.status).toBe(201);

    // Verify booking.create was called with target memberId and admin createdById
    const createCall = (mockedPrisma.booking.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(createCall.data.memberId).toBe("target-m1");
    expect(createCall.data.createdById).toBe("admin1");
  });

  it("logs audit for on-behalf draft booking", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "admin1", role: "ADMIN" } } as never);
    (mockedPrisma.member.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      active: true,
    });
    (mockedPrisma.member.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "target-m1", ageTier: "ADULT" },
    ]);
    (mockedPrisma.season.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (mockedPrisma.booking.create as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "b1",
      memberId: "target-m1",
      createdById: "admin1",
      status: "DRAFT",
      guests: [],
    });

    const req = makeRequest({
      ...baseBookingPayload,
      draft: true,
      forMemberId: "target-m1",
    });
    await POST(req);

    expect(mockedAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "booking.created_on_behalf",
        memberId: "admin1",
      })
    );
  });

  it("skips family group check for admin on-behalf", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "admin1", role: "ADMIN" } } as never);
    (mockedPrisma.member.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      active: true,
    });
    (mockedPrisma.season.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    // Member linked as guest is NOT in admin's family group
    (mockedPrisma.member.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "target-m1", ageTier: "ADULT" },
    ]);
    (mockedPrisma.booking.create as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "b2",
      memberId: "target-m1",
      status: "DRAFT",
      guests: [{ id: "g1" }],
    });

    const req = makeRequest({
      ...baseBookingPayload,
      draft: true,
      forMemberId: "target-m1",
    });
    const res = await POST(req);
    expect(res.status).toBe(201);

    // familyGroupMember.findMany should NOT have been called since admin bypasses
    expect(mockedPrisma.familyGroupMember.findMany).not.toHaveBeenCalled();
  });
});

describe("Create booking guest normalization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("forces manually typed guests to non-member pricing on create", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "m1", role: "MEMBER" } } as never);
    (mockedPrisma.member.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      active: true,
      emailVerified: true,
      xeroContactId: "xero-1",
    });
    (mockedPrisma.memberSubscription.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: "PAID",
    });
    (mockedPrisma.season.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (mockedPrisma.booking.create as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "b1",
      memberId: "m1",
      status: "DRAFT",
      guests: [],
    });

    const req = makeRequest({
      checkIn,
      checkOut,
      draft: true,
      guests: [{ firstName: "Manual", lastName: "Guest", ageTier: "ADULT", isMember: true }],
    });
    const res = await POST(req);
    expect(res.status).toBe(201);

    const createCall = (mockedPrisma.booking.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(createCall.data.guests.create[0]).toEqual(
      expect.objectContaining({
        firstName: "Manual",
        lastName: "Guest",
        isMember: false,
        memberId: null,
      })
    );
  });
});

describe("Quote API - forMemberId", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses target member credit balance when admin provides forMemberId", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "admin1", role: "ADMIN" } } as never);
    (mockedPrisma.season.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    mockedGetCredit.mockResolvedValue(1500);

    const req = new NextRequest("http://localhost/api/bookings/quote", {
      method: "POST",
      body: JSON.stringify({
        checkIn,
        checkOut,
        guests: [{ ageTier: "ADULT", isMember: true }],
        forMemberId: "target-m1",
      }),
      headers: { "Content-Type": "application/json" },
    });

    const res = await postQuote(req);
    expect(res.status).toBe(200);

    // getMemberCreditBalance should be called with target member, not admin
    expect(mockedGetCredit).toHaveBeenCalledWith("target-m1");
  });

  it("uses session user credit balance when no forMemberId", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "m1", role: "MEMBER" } } as never);
    (mockedPrisma.season.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    mockedGetCredit.mockResolvedValue(0);

    const req = new NextRequest("http://localhost/api/bookings/quote", {
      method: "POST",
      body: JSON.stringify({
        checkIn,
        checkOut,
        guests: [{ ageTier: "ADULT", isMember: true }],
      }),
      headers: { "Content-Type": "application/json" },
    });

    await postQuote(req);
    expect(mockedGetCredit).toHaveBeenCalledWith("m1");
  });

  it("treats manually typed guests as non-members in quotes", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "m1", role: "MEMBER" } } as never);
    (mockedPrisma.season.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    mockedGetCredit.mockResolvedValue(0);

    const req = new NextRequest("http://localhost/api/bookings/quote", {
      method: "POST",
      body: JSON.stringify({
        checkIn,
        checkOut,
        guests: [{ ageTier: "ADULT", isMember: true }],
      }),
      headers: { "Content-Type": "application/json" },
    });

    const res = await postQuote(req);
    expect(res.status).toBe(200);
    expect(mockedCalcPrice).toHaveBeenCalledWith(
      expect.any(Date),
      expect.any(Date),
      [expect.objectContaining({ ageTier: "ADULT", isMember: false })],
      expect.any(Array),
      undefined
    );
  });
});

describe("Promo Validate API - forMemberId", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("checks single-use against target member for admin on-behalf", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "admin1", role: "ADMIN" } } as never);
    (mockedPrisma.promoCode.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "pc1",
      code: "TEST10",
      singleUse: true,
      active: true,
      type: "PERCENTAGE",
      percentOff: 10,
      valueCents: null,
      freeNights: null,
    });
    (mockedPrisma.promoRedemption.count as ReturnType<typeof vi.fn>).mockResolvedValue(0);
    (mockedPrisma.season.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const req = new NextRequest("http://localhost/api/promo-codes/validate", {
      method: "POST",
      body: JSON.stringify({
        code: "TEST10",
        checkIn,
        checkOut,
        guests: [{ ageTier: "ADULT", isMember: true }],
        forMemberId: "target-m1",
      }),
      headers: { "Content-Type": "application/json" },
    });

    await postPromoValidate(req);

    // promoRedemption.count should check against target member, not admin
    expect(mockedPrisma.promoRedemption.count).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ memberId: "target-m1" }),
      })
    );
  });
});
