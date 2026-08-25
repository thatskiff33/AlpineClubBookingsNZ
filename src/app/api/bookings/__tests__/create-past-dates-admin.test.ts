import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { OverCapacityConfirmationRequiredError } from "@/lib/over-capacity-confirmation";
// The real lookback constant (365 at the time of writing). `@/lib/booking-create`
// is mocked below, so pull it from the types module it originates in; test dates
// and assertions derive from it so they can never drift from the enforced value.
import { RETROACTIVE_BOOKING_MAX_LOOKBACK_DAYS as MAX_LOOKBACK_DAYS } from "@/lib/booking-create-types";
import { addDaysDateOnly, formatDateOnly } from "@/lib/date-only";
import { clubToday, dateOnlyInstantOf, requireClubTimeZone } from "@/lib/club-time";
import { APP_TIME_ZONE } from "@/config/operational";

/*
  CT-4 (#2870): every date in this suite is relative to the CLUB's calendar day,
  taken from the persisted `ClubTimeSettings` row the prisma mock below serves —
  not from `APP_TIME_ZONE`, which this file pins to a DIFFERENT zone on purpose.

  Before CT-4 the route derived "today" from `getTodayDateOnly()`, i.e. the
  container's `TZ`, and this suite used the same helper as its oracle. The two
  agreed by construction, so the suite could not have failed however wrong the
  authority was. Under the frozen clock the persisted zone's day is 30 June and
  the environment's is 1 July, so every relative fixture below now moves if the
  route reads the wrong one — and the exact-lookback-boundary case turns that
  one-day difference into a 400.
*/
/*
  Hoisted so the prisma mock factory below can name it too. `vi.mock` factories
  hoist above every plain `const`, so the persisted zone used to be written out
  twice — here and as a literal in the mock — and only this one was pinned by the
  premise. One declaration, both call sites.
*/
const { PERSISTED_CLUB_ZONE } = vi.hoisted(() => ({
  PERSISTED_CLUB_ZONE: "America/Denver",
}));

function getTodayDateOnly() {
  return dateOnlyInstantOf(clubToday(requireClubTimeZone(PERSISTED_CLUB_ZONE)));
}

// Route-level gating test for retroactive create (#1695). The booking-create
// service is a spy so we can assert what the route threads and inject its
// structured errors; every pre-service helper is stubbed to pass through so the
// request reaches the past-date / lock-date guards deterministically.
// Deliberately NOT the persisted zone: the point of this file is that they can
// differ and the route must follow the persisted one. Inlined because `vi.mock`
// hoists above every const here.
vi.mock("@/config/operational", () => ({
  APP_CURRENCY: "NZD",
  APP_STRIPE_CURRENCY: "nzd",
  APP_TIME_ZONE: "Pacific/Auckland",
  APP_LOCALE: "en-NZ",
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
}));

vi.mock("@/lib/auth", () => ({ auth: h.auth }));
vi.mock("@/lib/session-guards", () => ({
  requireActiveSessionUser: h.requireActiveSessionUser,
}));
vi.mock("@/lib/rate-limit", () => ({
  applyRateLimit: vi.fn().mockResolvedValue(null),
  rateLimiters: { bookingCreate: {}, bookingQuery: {} },
}));
vi.mock("@/lib/logger", () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
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
    member: { findUnique: h.memberFindUnique },
    groupDiscountSetting: { findUnique: h.groupDiscountFindUnique },
    // Member self-books (no admin bypass) run the minimum-stay policy check.
    minimumStayPolicy: { findMany: vi.fn().mockResolvedValue([]) },
    // #2364: an on-behalf create evaluates the hosting policy over the submitted
    // party before the transaction. No rows configured, so it never trips.
    adultMemberHostingPolicy: { findMany: vi.fn().mockResolvedValue([]) },
    // The club's persisted timezone. NOT optional on this mock: `getClubTimeZone`
    // degrades silently to the environment when the delegate is missing, so
    // leaving it off would put the route back on `APP_TIME_ZONE` with nothing
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
vi.mock("@/lib/booking-guest-stay-range-input", () => ({
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
vi.mock("@/lib/booking-create", async () => {
  // Re-export the REAL constant (the factory is hoisted, so it cannot see the
  // top-level import): the route must enforce the same value the test asserts.
  const { RETROACTIVE_BOOKING_MAX_LOOKBACK_DAYS } = await vi.importActual<
    typeof import("@/lib/booking-create-types")
  >("@/lib/booking-create-types");
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

const ADMIN_SESSION = {
  user: { id: "admin1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] },
};

function daysFromTodayStr(delta: number) {
  return formatDateOnly(addDaysDateOnly(getTodayDateOnly(), delta));
}

const guests = [
  { firstName: "Jane", lastName: "Doe", ageTier: "ADULT", isMember: true, memberId: "target-m1" },
];

function pastPayload(extra: Record<string, unknown> = {}) {
  const checkIn = daysFromTodayStr(-10);
  const checkOut = daysFromTodayStr(-8);
  return { checkIn, checkOut, guests, forMemberId: "target-m1", ...extra };
}

function futurePayload(extra: Record<string, unknown> = {}) {
  const checkIn = daysFromTodayStr(30);
  const checkOut = daysFromTodayStr(32);
  return { checkIn, checkOut, guests, forMemberId: "target-m1", ...extra };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.auth.mockResolvedValue(ADMIN_SESSION);
  h.requireActiveSessionUser.mockResolvedValue(null);
  h.managementRole.mockReturnValue("ADMIN");
  h.hasAdminAccess.mockReturnValue(true);
  h.hasAccessRole.mockReturnValue(false); // admin-only account (no USER token)
  h.loadEffectiveModuleFlags.mockResolvedValue({
    xeroIntegration: true,
    bedAllocation: false,
    internetBankingPayments: false,
  });
  h.memberFindUnique.mockResolvedValue({ active: true });
  h.groupDiscountFindUnique.mockResolvedValue(null);
  h.isXeroConnected.mockResolvedValue(false);
  h.getEffectiveXeroLockDate.mockReturnValue(null);
  // A real `createConfirmedBooking` returns `BookingWithGuests`, so `guests` is
  // always present; the S2 family-add wiring reads it, so the fixture must carry
  // it. Empty here — these retroactive-gating cases add no family co-member — so
  // `notifyFamilyAdds` no-ops and never reaches the dispatcher.
  h.createConfirmedBooking.mockResolvedValue({
    type: "created",
    booking: { id: "b-new", status: "PAID", guests: [] },
  });
  h.sendFamilyAddNotifications.mockResolvedValue({
    notifiedTargetMemberIds: [],
    failedTargetMemberIds: [],
    unreachableTargetMemberIds: [],
    suppressedByPreferenceMemberIds: [],
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("CT-4 (#2870): the past-date gate runs on the club's day", () => {
  it("PREMISE: the persisted zone and APP_TIME_ZONE disagree about today", () => {
    /*
      The ANSWERS must differ, not merely the identifiers — `America/Chicago` is
      a different string from `America/Denver` and gives the same day, so a guard
      written that way would pass while every fixture in this file quietly went
      back to agreeing with the environment.

      The exact-lookback-boundary case below is what turns that disagreement into
      a failure: a check-in exactly MAX_LOOKBACK_DAYS before the CLUB's day is one
      day further back than MAX_LOOKBACK_DAYS before the ENVIRONMENT's, so a route
      that still reads `APP_TIME_ZONE` refuses it with a 400.
    */
    expect(APP_TIME_ZONE).toBe("Pacific/Auckland");
    expect(clubToday(requireClubTimeZone("Pacific/Auckland"))).toBe("2026-07-01");
    expect(clubToday(requireClubTimeZone(PERSISTED_CLUB_ZONE))).toBe("2026-06-30");
    expect(formatDateOnly(getTodayDateOnly())).toBe("2026-06-30");
  });
});

describe("POST /api/bookings retroactive create gating (#1695)", () => {
  it("refuses a missing lodge before resolution or any create service (#2701)", async () => {
    const res = await POST(
      makeRequest(futurePayload({ lodgeId: undefined })),
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      code: "BOOKING_LODGE_REQUIRED",
    });
    expect(h.resolveOptionalActiveLodgeId).not.toHaveBeenCalled();
    expect(h.createDraftBooking).not.toHaveBeenCalled();
    expect(h.createConfirmedBooking).not.toHaveBeenCalled();
    expect(h.createWaitlistedBooking).not.toHaveBeenCalled();
  });

  it("rejects override flags when the management role is not ADMIN (403), service not called", async () => {
    h.managementRole.mockReturnValue("USER");
    h.hasAdminAccess.mockReturnValue(false);
    h.hasAccessRole.mockReturnValue(true);

    const res = await POST(makeRequest(futurePayload({ allowPastDates: false })));

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toContain("Admin override is not available");
    expect(h.createConfirmedBooking).not.toHaveBeenCalled();
  });

  it("rejects allowPastDates without forMemberId (400)", async () => {
    const checkIn = daysFromTodayStr(-10);
    const checkOut = daysFromTodayStr(-8);
    const res = await POST(
      makeRequest({ checkIn, checkOut, guests, allowPastDates: true }),
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("booking on behalf");
    expect(h.createConfirmedBooking).not.toHaveBeenCalled();
  });

  it("rejects confirmOverCapacity without forMemberId (400) — #1767 gating", async () => {
    const checkIn = daysFromTodayStr(30);
    const checkOut = daysFromTodayStr(32);
    const res = await POST(
      makeRequest({ checkIn, checkOut, guests, confirmOverCapacity: true }),
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("booking on behalf");
    expect(h.createConfirmedBooking).not.toHaveBeenCalled();
  });

  it("rejects confirmOverCapacity combined with waitlist (400)", async () => {
    const res = await POST(
      makeRequest(futurePayload({ confirmOverCapacity: true, waitlist: true })),
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("cannot be combined with draft or waitlist");
    expect(h.createConfirmedBooking).not.toHaveBeenCalled();
  });

  it("rejects confirmOverCapacity combined with draft (400)", async () => {
    const res = await POST(
      makeRequest(futurePayload({ confirmOverCapacity: true, draft: true })),
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("cannot be combined with draft or waitlist");
    expect(h.createConfirmedBooking).not.toHaveBeenCalled();
  });

  it("threads confirmOverCapacity on a forward-dated on-behalf create with waitlistIntent false (#1767)", async () => {
    const res = await POST(
      makeRequest(futurePayload({ confirmOverCapacity: true })),
    );

    expect(res.status).toBe(201);
    expect(h.createConfirmedBooking).toHaveBeenCalledTimes(1);
    expect(h.createConfirmedBooking.mock.calls[0][0]).toMatchObject({
      allowPastDates: false,
      confirmOverCapacity: true,
      waitlistIntent: false,
      isOnBehalf: true,
    });
  });

  it("member self-book over capacity keeps the hard 409 CAPACITY_EXCEEDED with canWaitlist — members can never overbook", async () => {
    h.managementRole.mockReturnValue("USER");
    h.hasAdminAccess.mockReturnValue(false);
    h.hasAccessRole.mockReturnValue(true);
    // The self-book path re-reads the session member for the verified-email
    // and Xero-link guards.
    h.memberFindUnique.mockResolvedValue({
      active: true,
      emailVerified: new Date(),
      xeroContactId: "xc-1",
      ageTier: "ADULT",
    });
    h.createConfirmedBooking.mockResolvedValue({
      type: "capacityExceeded",
      fullNights: [daysFromTodayStr(31)],
    });

    const checkIn = daysFromTodayStr(30);
    const checkOut = daysFromTodayStr(32);
    const res = await POST(makeRequest({ checkIn, checkOut, guests }));

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("CAPACITY_EXCEEDED");
    expect(body.canWaitlist).toBe(true);
    expect(h.createConfirmedBooking.mock.calls[0][0]).toMatchObject({
      isOnBehalf: false,
    });
  });

  it("rejects a past check-in without the flag — 400 regression pin", async () => {
    const res = await POST(makeRequest(pastPayload()));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Cannot book in the past");
    expect(h.createConfirmedBooking).not.toHaveBeenCalled();
  });

  it("rejects allowPastDates combined with draft (400)", async () => {
    const res = await POST(
      makeRequest(pastPayload({ allowPastDates: true, draft: true })),
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("cannot be saved as a draft");
    expect(h.createConfirmedBooking).not.toHaveBeenCalled();
  });

  it("passes a past on-behalf create with the flag, threading the three flags", async () => {
    const res = await POST(
      makeRequest(
        pastPayload({ allowPastDates: true, notifyMember: false }),
      ),
    );

    expect(res.status).toBe(201);
    expect(h.createConfirmedBooking).toHaveBeenCalledTimes(1);
    expect(h.createConfirmedBooking.mock.calls[0][0]).toMatchObject({
      allowPastDates: true,
      notifyMember: false,
      isOnBehalf: true,
    });
  });

  it(`rejects ${MAX_LOOKBACK_DAYS + 1} days back but allows exactly ${MAX_LOOKBACK_DAYS}`, async () => {
    const tooFarIn = daysFromTodayStr(-(MAX_LOOKBACK_DAYS + 1));
    const tooFarOut = daysFromTodayStr(-(MAX_LOOKBACK_DAYS - 1));
    const resTooFar = await POST(
      makeRequest({
        checkIn: tooFarIn,
        checkOut: tooFarOut,
        guests,
        forMemberId: "target-m1",
        allowPastDates: true,
      }),
    );
    expect(resTooFar.status).toBe(400);
    expect((await resTooFar.json()).error).toContain(
      `at most ${MAX_LOOKBACK_DAYS} days`,
    );
    expect(h.createConfirmedBooking).not.toHaveBeenCalled();

    const boundaryIn = daysFromTodayStr(-MAX_LOOKBACK_DAYS);
    const boundaryOut = daysFromTodayStr(-(MAX_LOOKBACK_DAYS - 2));
    const resBoundary = await POST(
      makeRequest({
        checkIn: boundaryIn,
        checkOut: boundaryOut,
        guests,
        forMemberId: "target-m1",
        allowPastDates: true,
      }),
    );
    expect(resBoundary.status).toBe(201);
    expect(h.createConfirmedBooking).toHaveBeenCalledTimes(1);
  });

  it("rejects with 409 XERO_PERIOD_LOCKED when the lock date is on/after the check-in", async () => {
    h.isXeroConnected.mockResolvedValue(true);
    const checkIn = daysFromTodayStr(-10);
    h.getXeroLockDates.mockResolvedValue({
      periodLockDate: addDaysDateOnly(getTodayDateOnly(), -5),
      endOfYearLockDate: null,
    });
    h.getEffectiveXeroLockDate.mockReturnValue(
      addDaysDateOnly(getTodayDateOnly(), -5),
    );

    const res = await POST(
      makeRequest({
        checkIn,
        checkOut: daysFromTodayStr(-8),
        guests,
        forMemberId: "target-m1",
        allowPastDates: true,
      }),
    );

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("XERO_PERIOD_LOCKED");
    expect(body.lockDate).toBe(formatDateOnly(addDaysDateOnly(getTodayDateOnly(), -5)));
    expect(h.createConfirmedBooking).not.toHaveBeenCalled();
  });

  it("proceeds when the lock date is before the check-in", async () => {
    h.isXeroConnected.mockResolvedValue(true);
    h.getXeroLockDates.mockResolvedValue({
      periodLockDate: addDaysDateOnly(getTodayDateOnly(), -30),
      endOfYearLockDate: null,
    });
    h.getEffectiveXeroLockDate.mockReturnValue(
      addDaysDateOnly(getTodayDateOnly(), -30),
    );

    const res = await POST(
      makeRequest(pastPayload({ allowPastDates: true })),
    );

    expect(res.status).toBe(201);
    expect(h.createConfirmedBooking).toHaveBeenCalledTimes(1);
  });

  it("fails closed with 503 and an admin transient reason when the lock-date fetch throws", async () => {
    h.isXeroConnected.mockResolvedValue(true);
    h.getXeroLockDates.mockRejectedValue(new Error("xero down"));

    const res = await POST(
      makeRequest(pastPayload({ allowPastDates: true })),
    );

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.code).toBe("XERO_LOCK_DATE_CHECK_FAILED");
    // Admin create path → the classified reason is disclosed in the body (#2105).
    expect(body.reason).toBe("transient");
    expect(body.error).toBe("Could not verify the Xero lock dates. Please try again.");
    expect(h.createConfirmedBooking).not.toHaveBeenCalled();
  });

  it("classifies a reconnect-required lock-date failure with the admin reconnect reason + copy (#2105)", async () => {
    h.isXeroConnected.mockResolvedValue(true);
    h.getXeroLockDates.mockRejectedValue(
      Object.assign(
        new Error("Xero is not connected. Please connect via admin panel."),
        { name: "XeroReconnectRequiredError" },
      ),
    );

    const res = await POST(
      makeRequest(pastPayload({ allowPastDates: true })),
    );

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.code).toBe("XERO_LOCK_DATE_CHECK_FAILED");
    expect(body.reason).toBe("reconnect_required");
    expect(body.error).toContain("needs re-authorising");
    expect(h.createConfirmedBooking).not.toHaveBeenCalled();
  });

  it("skips the lock-date helper entirely when Xero is not connected", async () => {
    h.isXeroConnected.mockResolvedValue(false);

    const res = await POST(
      makeRequest(pastPayload({ allowPastDates: true })),
    );

    expect(res.status).toBe(201);
    expect(h.getXeroLockDates).not.toHaveBeenCalled();
    expect(h.createConfirmedBooking).toHaveBeenCalledTimes(1);
  });

  it("maps OverCapacityConfirmationRequiredError to a 409 with code + nightDetails", async () => {
    const nightDetails = [{ date: "2026-07-01", availableBeds: -2 }];
    h.createConfirmedBooking.mockRejectedValue(
      new OverCapacityConfirmationRequiredError(nightDetails),
    );

    const res = await POST(
      makeRequest(pastPayload({ allowPastDates: true })),
    );

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("OVER_CAPACITY_CONFIRM_REQUIRED");
    expect(body.nightDetails).toEqual(nightDetails);
  });

  it("threads notifyMember on a plain (future-dated) on-behalf create without allowPastDates", async () => {
    const res = await POST(
      makeRequest(futurePayload({ notifyMember: false })),
    );

    expect(res.status).toBe(201);
    expect(h.createConfirmedBooking).toHaveBeenCalledTimes(1);
    expect(h.createConfirmedBooking.mock.calls[0][0]).toMatchObject({
      allowPastDates: false,
      notifyMember: false,
    });
  });

  it("rejects allowPastDates with a today-or-future check-in (400) — the flag is strictly retroactive", async () => {
    const res = await POST(
      makeRequest(futurePayload({ allowPastDates: true })),
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("requires a check-in in the past");
    expect(h.createConfirmedBooking).not.toHaveBeenCalled();
  });

  it("runs the lock-date guard on the RESOLVED envelope: a guest night before the lock is a 409 even when the requested check-in clears it", async () => {
    h.isXeroConnected.mockResolvedValue(true);
    h.getXeroLockDates.mockResolvedValue({});
    // Lock at -15: the requested check-in (-10) clears it, but a guest night
    // expands the envelope back to -20 (#713), which must trip the guard.
    h.getEffectiveXeroLockDate.mockReturnValue(
      addDaysDateOnly(getTodayDateOnly(), -15),
    );

    const res = await POST(
      makeRequest(
        pastPayload({
          allowPastDates: true,
          guests: [{ ...guests[0], nights: [daysFromTodayStr(-20)] }],
        }),
      ),
    );

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("XERO_PERIOD_LOCKED");
    expect(h.createConfirmedBooking).not.toHaveBeenCalled();
  });

  it(`runs the ${MAX_LOOKBACK_DAYS}-day lookback on the RESOLVED envelope: a guest night ${MAX_LOOKBACK_DAYS + 5} days back is a 400`, async () => {
    const res = await POST(
      makeRequest(
        pastPayload({
          allowPastDates: true,
          guests: [
            { ...guests[0], nights: [daysFromTodayStr(-(MAX_LOOKBACK_DAYS + 5))] },
          ],
        }),
      ),
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain(`at most ${MAX_LOOKBACK_DAYS} days`);
    expect(h.createConfirmedBooking).not.toHaveBeenCalled();
  });

  it("threads notifyMember into the waitlist fallback so the choice covers the waitlist confirmation email too", async () => {
    h.createConfirmedBooking.mockResolvedValue({
      type: "capacityExceeded",
      fullNights: [daysFromTodayStr(31)],
    });
    h.createWaitlistedBooking.mockResolvedValue({
      booking: { id: "wl-1", status: "WAITLISTED", guests: [] },
    });

    const res = await POST(
      makeRequest(
        futurePayload({ waitlist: true, notifyMember: false }),
      ),
    );

    expect(res.status).toBe(201);
    // waitlistIntent suppresses the on-behalf warn-and-confirm so the
    // capacityExceeded outcome reaches this fallback (#1767).
    expect(h.createConfirmedBooking.mock.calls[0][0]).toMatchObject({
      waitlistIntent: true,
    });
    expect(h.createWaitlistedBooking).toHaveBeenCalledTimes(1);
    expect(h.createWaitlistedBooking.mock.calls[0][0]).toMatchObject({
      notifyMember: false,
    });
  });
});

// #2284 (S2): the family-add FYI must fire on EVERY persisting create path, not
// just the draft branch. It shipped wired into `if (draft)` only, so a confirmed
// or waitlisted create that put a family co-member on a booking sent nothing —
// the dominant member flow. These are route-level tests on purpose: the unit
// suite (family-booking-add-notifications.test.ts) drives only the dispatcher and
// is structurally blind to whether the route ever calls it. A family co-member is
// added by returning a guest row carrying their `memberId`; the dispatcher itself
// is stubbed (it is proven in isolation elsewhere), so these assert only that the
// route hands it the added member on each path.
describe("POST /api/bookings — S2 family-add notification wiring (#2284)", () => {
  const FAMILY_CHILD = "fam-child-m2";

  it("fires the family-add FYI on the CONFIRMED create path", async () => {
    h.createConfirmedBooking.mockResolvedValue({
      type: "created",
      booking: {
        id: "b-confirmed",
        status: "PAID",
        guests: [{ id: "bg-1", memberId: FAMILY_CHILD }],
      },
    });

    const res = await POST(makeRequest(futurePayload()));

    expect(res.status).toBe(201);
    expect(h.createConfirmedBooking).toHaveBeenCalledTimes(1);
    // The wiring under test: the confirmed branch must reach the dispatcher.
    expect(h.sendFamilyAddNotifications).toHaveBeenCalledTimes(1);
    expect(h.sendFamilyAddNotifications).toHaveBeenCalledWith(
      expect.objectContaining({
        bookingId: "b-confirmed",
        actorMemberId: "admin1",
        addedMemberIds: [FAMILY_CHILD],
      }),
    );
  });

  it("fires the family-add FYI on the WAITLISTED create path", async () => {
    // Capacity is exceeded, and the caller opted into the waitlist, so the create
    // falls through to createWaitlistedBooking — the second omitted branch.
    h.createConfirmedBooking.mockResolvedValue({
      type: "capacityExceeded",
      fullNights: [daysFromTodayStr(31)],
    });
    h.createWaitlistedBooking.mockResolvedValue({
      booking: {
        id: "b-waitlisted",
        status: "WAITLISTED",
        guests: [{ id: "bg-2", memberId: FAMILY_CHILD }],
      },
      position: 1,
    });

    const res = await POST(makeRequest(futurePayload({ waitlist: true })));

    expect(res.status).toBe(201);
    expect(h.createWaitlistedBooking).toHaveBeenCalledTimes(1);
    expect(h.sendFamilyAddNotifications).toHaveBeenCalledTimes(1);
    expect(h.sendFamilyAddNotifications).toHaveBeenCalledWith(
      expect.objectContaining({
        bookingId: "b-waitlisted",
        actorMemberId: "admin1",
        addedMemberIds: [FAMILY_CHILD],
      }),
    );
  });

  it("no family co-member on the party means no FYI (guard against a spurious send)", async () => {
    // The default fixture returns an empty guest list; the confirmed path still
    // no-ops rather than calling the dispatcher with nobody.
    const res = await POST(makeRequest(futurePayload()));

    expect(res.status).toBe(201);
    expect(h.sendFamilyAddNotifications).not.toHaveBeenCalled();
  });
});
