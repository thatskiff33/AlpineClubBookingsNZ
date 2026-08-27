import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// Mock prisma
vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: { count: vi.fn(), findUnique: vi.fn(), findMany: vi.fn() },
    booking: { create: vi.fn(), update: vi.fn(), findMany: vi.fn(), count: vi.fn(), findUnique: vi.fn() },
    // #2364: the hosting review is reconciled inside the booking write, and the
    // on-behalf create path evaluates the submitted party before it.
    adultMemberHostingPolicy: { findMany: vi.fn().mockResolvedValue([]) },
    // #2701: the create resolves the lodge the request NAMED (`findUnique`),
    // instead of falling through to the club default (`findFirst`).
    lodge: {
      findFirst: vi.fn(),
      findUnique: vi.fn().mockResolvedValue({ id: "lodge-1", active: true }),
    },
    // #1982: default lodge capacity is a self-healed DB override, not a
    // club.json runtime fallback.
    lodgeSettings: { findUnique: async () => ({ capacity: 20 }) },
    // #2286: the capacity engines read bed-holding hut-leader assignments
    // (custodian occupancy). None in these cases.
    hutLeaderAssignment: { findMany: vi.fn().mockResolvedValue([]) },
    memberLodgeAccess: { findMany: vi.fn() },
    bookingGuest: { findMany: vi.fn().mockResolvedValue([]) },
    membershipType: { findMany: vi.fn() },
    seasonalMembershipAssignment: { findMany: vi.fn() },
    season: { findMany: vi.fn() },
    promoCode: { findUnique: vi.fn() },
    promoCodeAssignment: { findMany: vi.fn() },
    promoRedemption: { count: vi.fn(), aggregate: vi.fn() },
    // #2306: the admin (skipAuthorization) path now READS these rows to compute
    // the member-guest family boundary, even though it still enforces nothing
    // with them — so the mock has to answer with a real array.
    familyGroupMember: { findMany: vi.fn().mockResolvedValue([]) },
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
const mockRequireActiveSessionUser = vi.fn<(...args: unknown[]) => Promise<Response | null>>(async () => null);
vi.mock("@/lib/session-guards", () => ({
  requireActiveSessionUser: (...args: Parameters<typeof mockRequireActiveSessionUser>) => mockRequireActiveSessionUser(...args),
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
  getNonMemberHoldPolicy: vi.fn().mockResolvedValue({
    enabled: true,
    holdDays: 7,
    source: "default",
  }),
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
    // #2701: a create must NAME its lodge — the route refuses one that does not
    // rather than resolving the blank to the club's default lodge. Named here,
    // once, because every real client now names it; a case may still override.
    body: JSON.stringify({ lodgeId: "lodge-1", ...body }),
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
    (mockedPrisma.lodge.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "lodge-1" });
    (mockedPrisma.memberLodgeAccess.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (mockedPrisma.bookingGuest.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    // Rate resolver (#1930, E4): the NON_MEMBER type is the default rate key.
    (mockedPrisma.member.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (mockedPrisma.seasonalMembershipAssignment.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (mockedPrisma.membershipType.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "type-nonmember", key: "NON_MEMBER" },
      { id: "type-full", key: "FULL" },
    ]);
  });

  it("rejects admin booking without forMemberId (must book on behalf)", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "admin1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] } } as never);

    const req = makeRequest(baseBookingPayload);
    const res = await POST(req);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("ADMIN_MUST_BOOK_ON_BEHALF");
    expect(body.error).toContain("Admins must book on behalf");
  });

  it("rejects forMemberId from non-admin users", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "m1", role: "MEMBER", accessRoles: [{ role: "USER" }] } } as never);
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
    mockedAuth.mockResolvedValue({ user: { id: "admin1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] } } as never);
    (mockedPrisma.member.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      active: true, emailVerified: true, xeroContactId: null,
    });

    const req = makeRequest({ ...baseBookingPayload, forMemberId: "admin1" });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain(
      "Booking managers cannot book for themselves — book your own stay through the member booking page",
    );
  });

  it("rejects booking for inactive target member", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "admin1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] } } as never);
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
    mockedAuth.mockResolvedValue({ user: { id: "admin1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] } } as never);
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
    mockedAuth.mockResolvedValue({ user: { id: "admin1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] } } as never);
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
    mockedAuth.mockResolvedValue({ user: { id: "admin1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] } } as never);
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

    // The admin bypass is a bypass of the CHECK, not of the read (#2306): the
    // family-group rows are still loaded so the member-guest boundary is
    // computed on this path too.
    //
    // BE PRECISE ABOUT WHOSE FAMILY. The boundary is computed against the
    // on-behalf TARGET (`effectiveMemberId`), never against the acting admin.
    // In this case the linked guest IS the target, so its scope is FAMILY by
    // construction — nothing cross-family is being allowed here. What this
    // assertion pins is only that the read HAPPENS on the skipAuthorization
    // path, which is what stops a later change from defaulting an admin-added
    // cross-family guest to consent-free. The genuinely-beyond-the-target's-
    // family case is the test immediately below.
    expect(mockedPrisma.familyGroupMember.findMany).toHaveBeenCalled();
  });

  it("adds a guest genuinely outside the TARGET's family, and computes the boundary against the target", async () => {
    // The case the four "read, not enforced" assertions do NOT cover: a guest
    // who is beyond the on-behalf target's family boundary. The admin path
    // still accepts it (pre-existing behaviour on main, unchanged by #2306 and
    // explicitly not tightened by MG4), and the boundary artifact this PR adds
    // is visible in the query: the family-group lookup is keyed on the TARGET.
    mockedAuth.mockResolvedValue({ user: { id: "admin1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] } } as never);
    (mockedPrisma.member.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      active: true,
    });
    (mockedPrisma.season.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    // The guest is a different member from the target, and nobody shares a
    // family group (familyGroupMember.findMany answers []), so the computed
    // scope for this guest is BEYOND_FAMILY.
    (mockedPrisma.member.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "outsider-m9", ageTier: "ADULT" },
    ]);
    (mockedPrisma.booking.create as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "b-outsider",
      memberId: "target-m1",
      status: "DRAFT",
      guests: [{ id: "g1" }],
    });

    const req = makeRequest({
      ...baseBookingPayload,
      guests: [
        { firstName: "Otto", lastName: "Sider", ageTier: "ADULT", isMember: true, memberId: "outsider-m9" },
      ],
      draft: true,
      forMemberId: "target-m1",
    });
    const res = await POST(req);
    expect(res.status).toBe(201);

    // The boundary was computed, and against the TARGET rather than the admin.
    expect(mockedPrisma.familyGroupMember.findMany).toHaveBeenCalledWith({
      where: { memberId: "target-m1" },
      select: { familyGroupId: true },
    });
    expect(mockedPrisma.familyGroupMember.findMany).not.toHaveBeenCalledWith({
      where: { memberId: "admin1" },
      select: { familyGroupId: true },
    });
  });

  it("creates an on-behalf draft for a legacy target member with unconfirmed profile details", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "admin1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] } } as never);
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
    // See the note above: since #2306 the admin path reads the family-group
    // rows to compute the consent boundary against the TARGET, and enforces
    // nothing with them. This guest is the target itself, so its scope is
    // FAMILY — this pins the read, not a cross-family allowance.
    expect(mockedPrisma.familyGroupMember.findMany).toHaveBeenCalled();
  });

  it("creates an on-behalf waitlist booking for a legacy target member with unconfirmed profile details", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "admin1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] } } as never);
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

describe("Dual-hat self-booking and officer on-behalf (#1442)", () => {
  const dualHatSession = {
    user: { id: "admin1", role: "ADMIN", accessRoles: [{ role: "USER" }, { role: "ADMIN" }] },
  } as never;
  const officerSession = {
    user: { id: "officer1", role: "USER", accessRoles: [{ role: "ADMIN_BOOKINGS" }] },
  } as never;
  const readOnlySession = {
    user: { id: "viewer1", role: "USER", accessRoles: [{ role: "ADMIN_READONLY" }] },
  } as never;

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
    (mockedPrisma.bookingGuest.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  });

  it("lets a dual-hat admin (USER + ADMIN) create their own draft booking", async () => {
    mockedAuth.mockResolvedValue(dualHatSession);
    // Self path runs the member lookups: email verification, Xero link, tier.
    (mockedPrisma.member.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      active: true, emailVerified: true, xeroContactId: "xero-a", ageTier: "ADULT",
    });
    (mockedPrisma.memberSubscription.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: "PAID",
    });
    (mockedPrisma.season.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (mockedPrisma.booking.create as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "b-self",
      memberId: "admin1",
      createdById: "admin1",
      status: "DRAFT",
      guests: [],
    });

    const req = makeRequest({
      checkIn,
      checkOut,
      draft: true,
      guests: [{ firstName: "Ada", lastName: "Admin", ageTier: "ADULT", isMember: true }],
    });
    const res = await POST(req);
    expect(res.status).toBe(201);

    const createCall = (mockedPrisma.booking.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(createCall.data.memberId).toBe("admin1");
  });

  it("applies member gates to a dual-hat admin's own booking (no admin leniency)", async () => {
    mockedAuth.mockResolvedValue(dualHatSession);
    // Unverified email must block the booking exactly as for a plain member.
    (mockedPrisma.member.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      active: true, emailVerified: false, xeroContactId: null, ageTier: "ADULT",
    });

    const req = makeRequest({
      checkIn,
      checkOut,
      draft: true,
      guests: [{ firstName: "Ada", lastName: "Admin", ageTier: "ADULT", isMember: true }],
    });
    const res = await POST(req);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toContain("Email not verified");
  });

  it("still forces admin-only accounts (no USER token) onto the on-behalf page", async () => {
    mockedAuth.mockResolvedValue({
      user: { id: "admin1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] },
    } as never);

    const req = makeRequest(baseBookingPayload);
    const res = await POST(req);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("ADMIN_MUST_BOOK_ON_BEHALF");
  });

  it("lets a Booking Officer (bookings:edit) create an on-behalf draft", async () => {
    mockedAuth.mockResolvedValue(officerSession);
    (mockedPrisma.member.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      active: true,
    });
    (mockedPrisma.member.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "target-m1", ageTier: "ADULT" },
    ]);
    (mockedPrisma.season.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (mockedPrisma.booking.create as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "b-officer",
      memberId: "target-m1",
      createdById: "officer1",
      status: "DRAFT",
      guests: [],
    });

    const req = makeRequest({
      ...baseBookingPayload,
      draft: true,
      forMemberId: "target-m1",
    });
    const res = await POST(req);
    expect(res.status).toBe(201);

    const createCall = (mockedPrisma.booking.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(createCall.data.memberId).toBe("target-m1");
    expect(createCall.data.createdById).toBe("officer1");
    // Authorized on-behalf keeps the admin-path behaviour: the family-group rows
    // are read (#2306, to compute the member-guest consent boundary against the
    // TARGET, "target-m1") but no family-group CHECK is enforced. The officer's
    // own family is irrelevant to that boundary, and the linked guest here IS
    // the target, so its scope is FAMILY — what the assertions above prove is
    // that the officer may book FOR an out-of-family member, which is a
    // different rule from the guest boundary.
    expect(mockedPrisma.familyGroupMember.findMany).toHaveBeenCalled();
  });

  it("blocks a Booking Officer from targeting themselves on-behalf", async () => {
    mockedAuth.mockResolvedValue(officerSession);

    const req = makeRequest({ ...baseBookingPayload, forMemberId: "officer1" });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("cannot book for themselves");
  });

  it("rejects on-behalf creation from bookings:view-only admins", async () => {
    mockedAuth.mockResolvedValue(readOnlySession);

    const req = makeRequest({ ...baseBookingPayload, forMemberId: "target-m1" });
    const res = await POST(req);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toContain("Only admins");
  });

  it("rejects an unauthorized quote forMemberId instead of silently pricing the caller", async () => {
    mockedAuth.mockResolvedValue({
      user: { id: "m1", role: "USER", accessRoles: [{ role: "USER" }] },
    } as never);

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
    expect(res.status).toBe(403);
    expect(mockedGetCredit).not.toHaveBeenCalled();
  });

  it("quotes against the target member for a Booking Officer", async () => {
    mockedAuth.mockResolvedValue(officerSession);
    (mockedPrisma.season.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    mockedGetCredit.mockResolvedValue(2500);

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
    expect(mockedGetCredit).toHaveBeenCalledWith("target-m1");
  });

  it("blocks a self-target quote for on-behalf actors", async () => {
    mockedAuth.mockResolvedValue(officerSession);

    const req = new NextRequest("http://localhost/api/bookings/quote", {
      method: "POST",
      body: JSON.stringify({
        checkIn,
        checkOut,
        guests: [{ ageTier: "ADULT", isMember: true }],
        forMemberId: "officer1",
      }),
      headers: { "Content-Type": "application/json" },
    });
    const res = await postQuote(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("cannot book for themselves");
  });

  it("rejects an unauthorized promo-validate forMemberId", async () => {
    mockedAuth.mockResolvedValue({
      user: { id: "m1", role: "USER", accessRoles: [{ role: "USER" }] },
    } as never);

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
    const res = await postPromoValidate(req);
    expect(res.status).toBe(403);
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
    (mockedPrisma.lodge.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "lodge-1" });
    (mockedPrisma.memberLodgeAccess.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  });

  it("forces manually typed guests to non-member pricing on create", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "m1", role: "MEMBER", accessRoles: [{ role: "USER" }] } } as never);
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
    mockedAuth.mockResolvedValue({ user: { id: "m1", role: "MEMBER", accessRoles: [{ role: "USER" }] } } as never);
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
    (mockedPrisma.bookingGuest.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  });

  it("uses target member credit balance when admin provides forMemberId", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "admin1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] } } as never);
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
    mockedAuth.mockResolvedValue({ user: { id: "admin1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] } } as never);
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
    // Read, not enforced — see the note on the first on-behalf draft test
    // (#2306). Boundary is against the target; this guest is the target, so
    // FAMILY.
    expect(mockedPrisma.familyGroupMember.findMany).toHaveBeenCalled();
  });

  it("uses session user credit balance when no forMemberId", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "m1", role: "MEMBER", accessRoles: [{ role: "USER" }] } } as never);
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

  it("Low 1: denies a restricted member quoting a forbidden lodge", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "m1", role: "MEMBER", accessRoles: [{ role: "USER" }] } } as never);
    (mockedPrisma.lodge.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "lodge-1" });
    (mockedPrisma.season.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    // A BOOKING_RESTRICTION list that excludes the resolved default lodge.
    (mockedPrisma.memberLodgeAccess.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      { lodgeId: "other-lodge" },
    ]);

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
    expect(res.status).toBe(403);
    // Rejected before pricing the forbidden lodge.
    expect(mockedGetCredit).not.toHaveBeenCalled();
  });

  it("Low 1: prices a restricted member for a lodge they may book", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "m1", role: "MEMBER", accessRoles: [{ role: "USER" }] } } as never);
    (mockedPrisma.lodge.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "lodge-1" });
    (mockedPrisma.season.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (mockedPrisma.memberLodgeAccess.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      { lodgeId: "lodge-1" },
    ]);
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
    expect(mockedGetCredit).toHaveBeenCalledWith("m1");
  });

  it("treats manually typed guests as non-members in quotes", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "m1", role: "MEMBER", accessRoles: [{ role: "USER" }] } } as never);
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
    mockedAuth.mockResolvedValue({ user: { id: "admin1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] } } as never);
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
    mockedAuth.mockResolvedValue({ user: { id: "m1", role: "MEMBER", accessRoles: [{ role: "USER" }] } } as never);
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
      guests: [{ ageTier: "ADULT" as const, isMember: true, rateMembershipTypeId: "type-member", nights: 1, priceCents: 5000, perNightCents: [5000], nightDates: [] }],
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
