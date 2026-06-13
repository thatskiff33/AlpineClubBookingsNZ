import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// Mock prisma
vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: { count: vi.fn(), findUnique: vi.fn(), findMany: vi.fn() },
    booking: { create: vi.fn(), update: vi.fn(), findMany: vi.fn(), count: vi.fn() },
    season: { findMany: vi.fn() },
    promoCode: { findUnique: vi.fn() },
    promoCodeAssignment: { findMany: vi.fn() },
    promoRedemption: { count: vi.fn(), aggregate: vi.fn() },
    familyGroupMember: { findMany: vi.fn() },
    memberSubscription: { findFirst: vi.fn() },
    payment: { create: vi.fn() },
    groupDiscountSetting: { findUnique: vi.fn().mockResolvedValue(null) },
    $transaction: vi.fn(),
    $executeRaw: vi.fn(),
    $executeRawUnsafe: vi.fn(),
    $queryRaw: vi.fn(),
  },
}));

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
const mockRequireActiveSessionUser = vi.fn(async () => null);
vi.mock("@/lib/session-guards", () => ({
  requireActiveSessionUser: (...args: unknown[]) => mockRequireActiveSessionUser(...args),
}));
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
  sendWaitlistConfirmationEmail: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/xero", () => ({
  isXeroConnected: vi.fn().mockResolvedValue(false),
  createXeroInvoiceForBooking: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/xero-operation-outbox", () => ({
  enqueueXeroBookingInvoiceOperation: vi.fn().mockResolvedValue({
    queueOperationId: null,
    message: "already linked",
  }),
  kickQueuedXeroOutboxOperationsIfConnected: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/lib/bumping", () => ({
  bumpPendingBookings: vi.fn(),
  sendBumpedNotifications: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/promo", () => ({
  validatePromoCodeRules: vi.fn().mockReturnValue(null),
  validateAndCalculatePromoDiscount: vi.fn().mockResolvedValue({
    discount: {
      discountCents: 0,
      priceAdjustmentCents: 0,
      freeNightsUsed: 0,
      eligibleGuestCount: 0,
      allocations: [],
    },
    beneficiaryMemberIds: [],
  }),
  shouldPersistPromoRedemption: vi.fn().mockReturnValue(true),
  redeemPromoCode: vi.fn().mockResolvedValue(undefined),
  calculatePromoDiscountForGuestRates: vi.fn().mockReturnValue({
    discountCents: 0,
    priceAdjustmentCents: 0,
    freeNightsUsed: 0,
    eligibleGuestCount: 0,
    allocations: [],
  }),
  getMemberFreeNightsUsed: vi.fn().mockResolvedValue(0),
}));
vi.mock("@/lib/pricing", () => ({
  calculateBookingPrice: vi.fn().mockReturnValue({
    totalPriceCents: 5000,
    guests: [{ priceCents: 5000, perNightCents: [5000] }],
  }),
  calculatePromoDiscount: vi.fn().mockReturnValue({ discountCents: 0, freeNightsUsed: 0 }),
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
import { bumpPendingBookings } from "@/lib/bumping";
import { POST } from "@/app/api/bookings/route";
import { POST as postQuote } from "@/app/api/bookings/quote/route";
import { POST as postPromoValidate } from "@/app/api/promo-codes/validate/route";

const mockedAuth = vi.mocked(auth);
const mockedPrisma = vi.mocked(prisma);
const mockedAudit = vi.mocked(logAudit);
const mockedGetCredit = vi.mocked(getMemberCreditBalance);
const mockedCalcPrice = vi.mocked(calculateBookingPrice);
const mockedBumpPendingBookings = vi.mocked(bumpPendingBookings);

function makeRequest(body: Record<string, unknown>) {
  return new NextRequest("http://localhost/api/bookings", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

const futureDate = new Date();
futureDate.setDate(futureDate.getDate() + 30);
const checkIn = futureDate.toISOString().slice(0, 10);
const checkOutDate = new Date(futureDate);
checkOutDate.setDate(checkOutDate.getDate() + 2);
const checkOut = checkOutDate.toISOString().slice(0, 10);
const promoCheckIn = checkIn;
const promoCheckOut = checkOut;

const baseBookingPayload = {
  checkIn,
  checkOut,
  guests: [{ firstName: "Jane", lastName: "Doe", ageTier: "ADULT", isMember: true, memberId: "target-m1" }],
};

const legacyIncompleteTargetMember = {
  id: "target-m1",
  ageTier: "ADULT",
  active: true,
  canLogin: true,
  firstName: "Jane",
  lastName: "Doe",
  phoneCountryCode: null,
  phoneAreaCode: null,
  phoneNumber: null,
  dateOfBirth: null,
  streetAddressLine1: null,
  streetCity: null,
  streetRegion: null,
  streetPostalCode: null,
  streetCountry: null,
  postalAddressLine1: null,
  postalCity: null,
  postalRegion: null,
  postalPostalCode: null,
  postalCountry: null,
  role: "MEMBER",
  profileCompletedAt: null,
  detailsConfirmedAt: null,
  detailsConfirmedByMemberId: null,
  onboardingConfirmedAt: null,
};

describe("Admin Book on Behalf", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (mockedPrisma.$transaction as ReturnType<typeof vi.fn>).mockImplementation(
      async (fn: (tx: typeof mockedPrisma) => Promise<unknown>) => fn(mockedPrisma)
    );
    (mockedPrisma.$executeRaw as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (mockedPrisma.$executeRawUnsafe as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (mockedPrisma.$queryRaw as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (mockedPrisma.promoRedemption.aggregate as ReturnType<typeof vi.fn>).mockResolvedValue({
      _sum: { freeNightsUsed: 0 },
    });
    (mockedPrisma.promoCodeAssignment.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
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

  it("creates an on-behalf draft for a legacy target member with unconfirmed profile details", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "admin1", role: "ADMIN" } } as never);
    (mockedPrisma.member.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      active: true,
    });
    (mockedPrisma.member.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      legacyIncompleteTargetMember,
    ]);
    (mockedPrisma.season.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (mockedPrisma.booking.create as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "draft-legacy",
      memberId: "target-m1",
      createdById: "admin1",
      status: "DRAFT",
      guests: [{ id: "g1" }],
    });

    const req = makeRequest({
      ...baseBookingPayload,
      draft: true,
      forMemberId: "target-m1",
    });
    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.code).not.toBe("GUEST_PROFILE_REQUIRED");
    expect(mockedPrisma.familyGroupMember.findMany).not.toHaveBeenCalled();
  });

  it("creates an on-behalf waitlist booking for a legacy target member with unconfirmed profile details", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "admin1", role: "ADMIN" } } as never);
    (mockedPrisma.member.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      active: true,
    });
    (mockedPrisma.member.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      legacyIncompleteTargetMember,
    ]);
    (mockedPrisma.booking.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: "full-booking",
        checkIn: new Date(checkIn),
        checkOut: new Date(checkOut),
        guests: Array.from({ length: 29 }, (_, index) => ({ id: `occupied-${index}` })),
      },
    ]);
    mockedBumpPendingBookings.mockResolvedValue({
      capacityRestored: false,
      bumpedBookingIds: [],
    });
    (mockedPrisma.booking.count as ReturnType<typeof vi.fn>).mockResolvedValue(0);
    (mockedPrisma.season.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (mockedPrisma.booking.create as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "waitlist-legacy",
      memberId: "target-m1",
      checkIn: new Date(checkIn),
      checkOut: new Date(checkOut),
      createdAt: new Date(),
      status: "WAITLISTED",
      guests: [{ id: "g1" }],
    });
    (mockedPrisma.booking.update as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "waitlist-legacy",
      memberId: "target-m1",
      checkIn: new Date(checkIn),
      checkOut: new Date(checkOut),
      status: "WAITLISTED",
      waitlistPosition: 1,
      finalPriceCents: 5000,
      guests: [{ id: "g1" }],
    });

    const req = makeRequest({
      ...baseBookingPayload,
      waitlist: true,
      forMemberId: "target-m1",
    });
    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.status).toBe("WAITLISTED");
    expect(body.code).not.toBe("GUEST_PROFILE_REQUIRED");
    expect(mockedPrisma.booking.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          memberId: "target-m1",
          createdById: "admin1",
          status: "WAITLISTED",
        }),
      })
    );
  });
});

describe("Create booking guest normalization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (mockedPrisma.$transaction as ReturnType<typeof vi.fn>).mockImplementation(
      async (fn: (tx: typeof mockedPrisma) => Promise<unknown>) => fn(mockedPrisma)
    );
    (mockedPrisma.$executeRaw as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (mockedPrisma.$executeRawUnsafe as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (mockedPrisma.$queryRaw as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (mockedPrisma.promoRedemption.aggregate as ReturnType<typeof vi.fn>).mockResolvedValue({
      _sum: { freeNightsUsed: 0 },
    });
    (mockedPrisma.promoCodeAssignment.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
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

  it("requires a member justification when a minor-only draft is created by a member", async () => {
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
      id: "b2",
      memberId: "m1",
      status: "AWAITING_REVIEW",
      guests: [],
    });

    // First: no justification — should be rejected with 400.
    const reqMissing = makeRequest({
      checkIn,
      checkOut,
      draft: true,
      guests: [{ firstName: "Junior", lastName: "Guest", ageTier: "YOUTH", isMember: false }],
    });
    const resMissing = await POST(reqMissing);
    expect(resMissing.status).toBe(400);

    // Then: with justification — should land as AWAITING_REVIEW with PENDING review status.
    const reqOk = makeRequest({
      checkIn,
      checkOut,
      draft: true,
      memberReviewJustification: "Both grandparents are taking the kids and have stayed before.",
      guests: [{ firstName: "Junior", lastName: "Guest", ageTier: "YOUTH", isMember: false }],
    });
    const resOk = await POST(reqOk);
    expect(resOk.status).toBe(201);

    const createCall = (mockedPrisma.booking.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(createCall.data.requiresAdminReview).toBe(true);
    expect(createCall.data.adminReviewReason).toContain("does not include an adult");
    expect(createCall.data.adminReviewStatus).toBe("PENDING");
    expect(createCall.data.memberReviewJustification).toBe(
      "Both grandparents are taking the kids and have stayed before."
    );
    expect(createCall.data.status).toBe("AWAITING_REVIEW");
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

  it("allows an admin on-behalf quote for a legacy target member with unconfirmed profile details", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "admin1", role: "ADMIN" } } as never);
    (mockedPrisma.member.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      legacyIncompleteTargetMember,
    ]);
    (mockedPrisma.season.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    mockedGetCredit.mockResolvedValue(1500);

    const req = new NextRequest("http://localhost/api/bookings/quote", {
      method: "POST",
      body: JSON.stringify({
        checkIn,
        checkOut,
        guests: [{ ageTier: "ADULT", isMember: true, memberId: "target-m1" }],
        forMemberId: "target-m1",
      }),
      headers: { "Content-Type": "application/json" },
    });

    const res = await postQuote(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.code).not.toBe("GUEST_PROFILE_REQUIRED");
    expect(mockedGetCredit).toHaveBeenCalledWith("target-m1");
    expect(mockedPrisma.familyGroupMember.findMany).not.toHaveBeenCalled();
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

  it("checks usage caps against target member for admin on-behalf", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "admin1", role: "ADMIN" } } as never);
    (mockedPrisma.promoCode.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "pc1",
      code: "TEST10",
      maxUsesPerMember: 1,
      active: true,
      type: "PERCENTAGE",
      percentOff: 10,
      valueCents: null,
      freeNightsPerIndividual: null,
      maxRedemptionsTotal: null,
      maxUniqueMembersTotal: null,
      maxGuestsPerBooking: null,
      maxNightlyValueCents: null,
      memberGuestsOnly: false,
      membersOnly: false,
      currentRedemptions: 0,
      validFrom: null,
      validUntil: null,
      bookingStartFrom: null,
      bookingStartUntil: null,
      assignments: [],
    });
    (mockedPrisma.season.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    const { validateAndCalculatePromoDiscount } = await import("@/lib/promo");

    const req = new NextRequest("http://localhost/api/promo-codes/validate", {
      method: "POST",
      body: JSON.stringify({
        code: "TEST10",
        checkIn: promoCheckIn,
        checkOut: promoCheckOut,
        guests: [{ ageTier: "ADULT", isMember: true }],
        forMemberId: "target-m1",
      }),
      headers: { "Content-Type": "application/json" },
    });

    await postPromoValidate(req);

    expect(validateAndCalculatePromoDiscount).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ memberId: "target-m1" }),
      null,
      expect.objectContaining({ db: mockedPrisma }),
    );
  });

  it("returns signed promo adjustments and final price for fixed-nightly validation", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "m1", role: "MEMBER" } } as never);
    (mockedPrisma.promoCode.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "pc-fixed",
      code: "SET30",
      description: "Set eligible nights to $30",
      active: true,
      type: "FIXED_NIGHTLY_PRICE",
      percentOff: null,
      valueCents: null,
      freeNightsPerIndividual: null,
      fixedNightlyPriceCents: 3000,
      fixedNightlyMode: "SET_PRICE",
      maxRedemptionsTotal: null,
      maxUniqueMembersTotal: null,
      maxGuestsPerBooking: null,
      maxNightlyValueCents: null,
      memberGuestsOnly: false,
      membersOnly: false,
      currentRedemptions: 0,
      validFrom: null,
      validUntil: null,
      bookingStartFrom: null,
      bookingStartUntil: null,
      assignments: [],
    });
    (mockedPrisma.season.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    mockedCalcPrice.mockReturnValueOnce({
      totalPriceCents: 5000,
      guests: [{ priceCents: 5000, perNightCents: [5000] }],
    });
    const { validateAndCalculatePromoDiscount } = await import("@/lib/promo");
    vi.mocked(validateAndCalculatePromoDiscount).mockResolvedValueOnce({
      discount: {
        discountCents: 0,
        priceAdjustmentCents: 2000,
        freeNightsUsed: 0,
        eligibleGuestCount: 1,
        allocations: [
          { memberId: "m1", discountCents: 0, priceAdjustmentCents: 2000, freeNightsUsed: 0 },
        ],
      },
      beneficiaryMemberIds: ["m1"],
    });

    const req = new NextRequest("http://localhost/api/promo-codes/validate", {
      method: "POST",
      body: JSON.stringify({
        code: "SET30",
        checkIn: promoCheckIn,
        checkOut: promoCheckOut,
        guests: [{ ageTier: "ADULT", isMember: true, memberId: "m1" }],
      }),
      headers: { "Content-Type": "application/json" },
    });

    const response = await postPromoValidate(req);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual(expect.objectContaining({
      valid: true,
      code: "SET30",
      type: "FIXED_NIGHTLY_PRICE",
      discountCents: 0,
      promoAdjustmentCents: 2000,
      totalPriceCents: 5000,
      finalPriceCents: 7000,
    }));
  });
});
