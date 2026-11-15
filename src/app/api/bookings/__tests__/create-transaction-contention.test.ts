import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { addDaysDateOnly, formatDateOnly } from "@/lib/date-only";
import { clubToday, dateOnlyInstantOf, requireClubTimeZone } from "@/lib/club-time";

/*
  #4933: a create that runs out of its lock(1) budget, or loses a write
  conflict, rolled back and saved nothing - so `POST /api/bookings` answers a
  retryable 503 with `Retry-After`, never the generic 400 "Failed to create
  booking". Prisma's P2028 / P2034 are thrown from each create path's service
  spy; the module mocks below are the ones `create-past-dates-admin.test.ts`
  uses to walk an admin's on-behalf create to the service.
*/
const { PERSISTED_CLUB_ZONE } = vi.hoisted(() => ({
  PERSISTED_CLUB_ZONE: "Pacific/Auckland",
}));

const h = vi.hoisted(() => ({
  auth: vi.fn(),
  requireActiveSessionUser: vi.fn(),
  managementRole: vi.fn(),
  hasAdminAccess: vi.fn(),
  hasAccessRole: vi.fn(),
  loadEffectiveModuleFlags: vi.fn(),
  createConfirmedBooking: vi.fn(),
  createDraftBooking: vi.fn(),
  createWaitlistedBooking: vi.fn(),
  isXeroConnected: vi.fn(),
  getXeroLockDates: vi.fn(),
  getEffectiveXeroLockDate: vi.fn(),
  memberFindUnique: vi.fn(),
  groupDiscountFindUnique: vi.fn(),
  resolveOptionalActiveLodgeId: vi.fn().mockResolvedValue("lodge-1"),
  // #2284 (S2): the route's family-add FYI dispatcher, spied so the wiring on
  // the confirmed and waitlisted create paths can be asserted here — the unit
  // suite in family-booking-add-notifications.test.ts exercises only the
  // dispatcher in isolation and cannot see whether the route ever calls it.
  sendFamilyAddNotifications: vi.fn(),
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/auth", () => ({ auth: h.auth }));
vi.mock("@/lib/session-guards", () => ({
  requireActiveSessionUser: h.requireActiveSessionUser,
}));
vi.mock("@/lib/rate-limit", () => ({
  applyRateLimit: vi.fn().mockResolvedValue(null),
  rateLimiters: { bookingCreate: {}, bookingQuery: {} },
}));
vi.mock("@/lib/logger", () => ({ default: h.logger }));
vi.mock("@/lib/access-roles", () => ({
  hasAdminAccess: h.hasAdminAccess,
  hasAccessRole: h.hasAccessRole,
}));
vi.mock("@/lib/admin-permissions", () => ({
  bookingManagementAuthorizationRole: h.managementRole,
}));
vi.mock("@/lib/module-settings", () => ({
  loadEffectiveModuleFlags: h.loadEffectiveModuleFlags,
  // MG2 (#2307): the route now reaches `@/lib/admin-modules` through
  // `member-guest-add-policy` (it reads the memberGuests module flag before
  // opening any transaction), and admin-modules imports these two from this
  // module at module scope. A flags object without `memberGuests` leaves the
  // widening off, which is this test's world unchanged.
  CLUB_MODULE_SETTINGS_ID: "default",
  normalizeClubModuleSettings: (record: unknown) => record ?? {},
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    // #3770 R2: the create route reads the booker's lodge restrictions before
    // its member lookup; nobody here has one.
    memberLodgeAccess: { findMany: vi.fn().mockResolvedValue([]) },
    // #3451: the own-dependant guard's parent-link read. This suite's party
    // carries member ids its mocked resolution does not return, so the shared
    // entry point reads them as free text and asks; nobody here has a dependant.
    member: { findUnique: h.memberFindUnique, findMany: vi.fn().mockResolvedValue([]) },
    groupDiscountSetting: { findUnique: h.groupDiscountFindUnique },
    // Member self-books (no admin bypass) run the minimum-stay policy check.
    minimumStayPolicy: { findMany: vi.fn().mockResolvedValue([]) },
    // #2364: an on-behalf create evaluates the hosting policy over the submitted
    // party before the transaction. No rows configured, so it never trips.
    adultMemberHostingPolicy: { findMany: vi.fn().mockResolvedValue([]) },
    // The club's persisted timezone. NOT optional on this mock: `getClubTimeZone`
    // degrades silently to the environment when the delegate is missing, so
    // leaving it off would put the route back on the environment's zone with nothing
    // failing.
    clubTimeSettings: {
      findUnique: vi.fn().mockResolvedValue({
        timeZone: PERSISTED_CLUB_ZONE,
        updatedByMemberId: null,
        updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      }),
    },
  },
}));
vi.mock("@/lib/booking-guests", () => ({
  // MG3 (#2308) C1: `markCrossFamilyGuestsOnBooking` re-derives the D-8 marker
  // over the WHOLE proposed party from this function. These fixtures are about
  // pricing/payment rather than family boundaries, and were written when every
  // member-linked guest in them was family scope, so an empty boundary states
  // that assumption explicitly. The C1 behaviour itself is covered by
  // `member-guest-cross-family-refusals.test.ts` and by the source contract in
  // `review-findings-contracts.test.ts`.
  computeMemberGuestBoundary: vi.fn().mockResolvedValue({
    scopeByMemberId: new Map(),
    beyondFamilyMemberIds: [],
  }),
  resolveLinkedBookingMembers: vi.fn().mockResolvedValue([]),
  // MG2 (#2307): the widened call sites use the boundary-returning variant. An
  // empty boundary is "everybody is inside the booker's family", which is this
  // test's world unchanged.
  resolveLinkedBookingMembersWithBoundary: vi.fn().mockResolvedValue({
    members: new Map(),
    boundary: { scopeByMemberId: new Map(), beyondFamilyMemberIds: [] },
  }),
  assertLinkedBookingMembersCanBeBooked: vi.fn().mockResolvedValue(undefined),
  normalizeBookingGuestInputs: (guests: unknown[]) => guests,
  BookingGuestValidationError: class extends Error {},
  getBookingGuestValidationErrorResponse: (e: { message: string }) => ({
    error: e.message,
  }),
}));
// The request schema's shared shapes stay real (#4199); only these are stubbed.
vi.mock("@/lib/booking-guest-stay-range-input", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/booking-guest-stay-range-input")),
  normalizeGuestStayRanges: (guests: unknown[]) => guests,
  BookingGuestStayRangeValidationError: class extends Error {},
}));
vi.mock("@/lib/booking-member-night-conflicts", () => ({
  findBookingMemberNightConflicts: vi.fn().mockResolvedValue([]),
  BookingMemberNightConflictError: class extends Error {
    conflicts: unknown[] = [];
  },
  getBookingMemberNightConflictResponse: () => ({ error: "conflict" }),
}));
vi.mock("@/lib/lodges", () => ({
  resolveOptionalActiveLodgeId: h.resolveOptionalActiveLodgeId,
  // The member self-book minimum-stay check filters policy rows per lodge.
  resolvePolicyRowsForLodge: () => [],
}));
vi.mock("@/lib/lodge-capacity", () => ({
  getLodgeCapacity: vi.fn().mockResolvedValue(30),
}));
vi.mock("@/lib/membership-type-policy", () => ({
  assertMembershipTypeBookingAllowed: vi.fn().mockResolvedValue(undefined),
  getMembershipTypeBookingPolicyErrorBody: (e: { message: string }) => ({
    error: e.message,
  }),
  MembershipTypeBookingPolicyError: class extends Error {
    status = 400;
  },
  requiresPaidSubscriptionForMemberForBooking: vi.fn().mockResolvedValue(false),
}));
vi.mock("@/lib/booking-member-guest-subscriptions", () => ({
  findUnpaidMemberGuests: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/lib/cancellation", () => ({
  getNonMemberHoldPolicy: vi
    .fn()
    .mockResolvedValue({ enabled: false, holdDays: 0, source: "default" }),
}));
vi.mock("@/lib/policies/booking-route-decisions", () => ({
  calculateBookingHoldDecision: () => ({
    shouldBePending: false,
    status: "PAYMENT_PENDING",
  }),
  toGroupDiscountConfig: () => ({}),
}));
vi.mock("@/lib/member-credit", () => ({
  getMemberCreditBalance: vi.fn().mockResolvedValue(0),
  // #3369: the one home for the account-credit refusal four settlement paths
  // share. Real, not stubbed: the mock must not turn a refusal into a pass.
  requireMemberCreditRecipient: (memberId: string | null) => {
    if (!memberId) throw new Error("no account to credit (#3369)");
    return memberId;
  },
}));
vi.mock("@/lib/internet-banking-settings", () => ({
  checkInternetBankingLeadTime: () => ({ allowed: true }),
  loadInternetBankingPaymentSettings: vi.fn().mockResolvedValue({}),
}));
// The lock guard (#1697 extraction) reads connectivity from the source
// domain module, not the @/lib/xero facade.
vi.mock("@/lib/xero-token-store", () => ({
  isXeroConnected: h.isXeroConnected,
}));
vi.mock("@/lib/xero-organisation", () => ({
  getXeroLockDates: h.getXeroLockDates,
  getEffectiveXeroLockDate: h.getEffectiveXeroLockDate,
  // #2543's lockout-mode read refreshes the financial-year config, which asks
  // Xero for the year-end month. Null is the documented "unavailable" answer
  // and falls back to the club default, so these tests stay about date gating.
  getXeroFinancialYearEndMonth: vi.fn(async () => null),
}));
// #3029: the route reads the dietary seeding toggle before any create service
// runs; the real module reaches access-role definitions this file mocks.
vi.mock("@/lib/member-dietary-booking-writes", () => ({
  resolveBookingGuestDietarySeeding: vi.fn(async () => ({ seedFromProfile: false })),
}));
vi.mock("@/lib/booking-create", async () => {
  // Re-export the REAL constant (the factory is hoisted, so it cannot see the
  // top-level import): the route must enforce the same value the test asserts.
  const { RETROACTIVE_BOOKING_MAX_LOOKBACK_DAYS } = (await vi.importActual("@/lib/booking-create-types")) as typeof import("@/lib/booking-create-types");
  return {
    createConfirmedBooking: h.createConfirmedBooking,
    createDraftBooking: h.createDraftBooking,
    createWaitlistedBooking: h.createWaitlistedBooking,
    RETROACTIVE_BOOKING_MAX_LOOKBACK_DAYS,
    BookingLodgeError: class extends Error {},
    BookingPromoError: class extends Error {},
    BookingReviewJustificationRequiredError: class extends Error {},
  };
});

// #2284 (S2): intercept the lazily-imported family-add dispatcher. The route
// `await import(...)`s this module inside `notifyFamilyAdds`; the mock captures
// that dynamic import too.
vi.mock("@/lib/family-booking-add-notifications", () => ({
  sendFamilyMemberBookingAddNotifications: h.sendFamilyAddNotifications,
}));

import { POST } from "@/app/api/bookings/route";

const BUSY_MESSAGE =
  "The booking system is busy right now. Nothing was saved, so please try again in a moment.";
const RAW_PRISMA_MESSAGE = "Transaction API error: Unable to start a transaction in the given time.";

function prismaError(code: "P2028" | "P2034" | "P2002") {
  return Object.assign(new Error(RAW_PRISMA_MESSAGE), { code });
}

function makeRequest(extra: Record<string, unknown> = {}) {
  const today = dateOnlyInstantOf(clubToday(requireClubTimeZone(PERSISTED_CLUB_ZONE)));
  return new NextRequest("http://localhost/api/bookings", {
    method: "POST",
    body: JSON.stringify({
      lodgeId: "lodge-1",
      checkIn: formatDateOnly(addDaysDateOnly(today, 30)),
      checkOut: formatDateOnly(addDaysDateOnly(today, 32)),
      guests: [
        { firstName: "Jane", lastName: "Doe", ageTier: "ADULT", isMember: true, memberId: "target-m1" },
      ],
      forMemberId: "target-m1",
      ...extra,
    }),
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.auth.mockResolvedValue({
    user: { id: "admin1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] },
  });
  h.requireActiveSessionUser.mockResolvedValue(null);
  h.managementRole.mockReturnValue("ADMIN");
  h.hasAdminAccess.mockReturnValue(true);
  h.hasAccessRole.mockReturnValue(false);
  h.loadEffectiveModuleFlags.mockResolvedValue({
    xeroIntegration: false,
    bedAllocation: false,
    internetBankingPayments: false,
  });
  h.memberFindUnique.mockResolvedValue({ active: true });
  h.groupDiscountFindUnique.mockResolvedValue(null);
  h.isXeroConnected.mockResolvedValue(false);
  h.getEffectiveXeroLockDate.mockReturnValue(null);
});

async function expectBusy(res: Response, logMessage: string) {
  expect(res.status).toBe(503);
  expect(res.headers.get("Retry-After")).toBe("2");
  const body = await res.json();
  expect(body).toEqual({ error: BUSY_MESSAGE, code: "BOOKING_CREATE_CONTENDED" });
  // #1888: the raw Prisma message reaches the log, never the member.
  expect(JSON.stringify(body)).not.toContain(RAW_PRISMA_MESSAGE);
  expect(h.logger.warn).toHaveBeenCalledWith(
    { err: expect.objectContaining({ message: RAW_PRISMA_MESSAGE }) },
    logMessage,
  );
}

describe("POST /api/bookings answers transaction contention as a retryable 503 (#4933)", () => {
  it.each(["P2028", "P2034"] as const)(
    "confirmed create rejecting with %s -> 503 + Retry-After",
    async (code) => {
      h.createConfirmedBooking.mockRejectedValue(prismaError(code));

      const res = await POST(makeRequest());

      expect(h.createConfirmedBooking).toHaveBeenCalledTimes(1);
      await expectBusy(res, "Booking create contended; nothing was saved");
    },
  );

  it.each(["P2028", "P2034"] as const)(
    "draft create rejecting with %s -> 503 + Retry-After",
    async (code) => {
      h.createDraftBooking.mockRejectedValue(prismaError(code));

      const res = await POST(makeRequest({ draft: true }));

      expect(h.createDraftBooking).toHaveBeenCalledTimes(1);
      await expectBusy(res, "Draft booking create contended; nothing was saved");
    },
  );

  it.each(["P2028", "P2034"] as const)(
    "waitlisted create rejecting with %s -> 503 + Retry-After",
    async (code) => {
      h.createConfirmedBooking.mockResolvedValue({
        type: "capacityExceeded",
        fullNights: ["2026-07-31"],
      });
      h.createWaitlistedBooking.mockRejectedValue(prismaError(code));

      const res = await POST(makeRequest({ waitlist: true }));

      expect(h.createWaitlistedBooking).toHaveBeenCalledTimes(1);
      await expectBusy(res, "Waitlisted booking create contended; nothing was saved");
    },
  );

  it("a non-contention error on the confirmed path keeps the existing 400", async () => {
    h.createConfirmedBooking.mockRejectedValue(prismaError("P2002"));

    const res = await POST(makeRequest());

    expect(res.status).toBe(400);
    expect(res.headers.get("Retry-After")).toBeNull();
    expect(await res.json()).toEqual({ error: "Failed to create booking" });
  });

  it("a non-contention error on the draft path keeps the existing 400", async () => {
    h.createDraftBooking.mockRejectedValue(prismaError("P2002"));

    const res = await POST(makeRequest({ draft: true }));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Failed to create draft booking" });
  });
});
