import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * CT-4 (#2870): the create ROUTE and the create SERVICE ask the same authority
 * what day it is — a cross-file frame pair, with a workflow-stopping straddle.
 *
 * ## What went wrong, in plain English
 *
 * A retroactive booking is one an officer records after the stay happened, and
 * it may reach back a fixed number of days. Two places enforce that: the route,
 * at the door, and `createConfirmedBooking`, which re-checks the RESOLVED stay
 * envelope because a guest's own nights can start earlier than the requested
 * check-in. The service comment calls this "defence in depth", and it only is
 * while both are measuring from the same day.
 *
 * CT-4 moved the route onto the club's persisted zone and left the service on
 * `getTodayDateOnly()` — the container's. Two "today"s from two authorities are
 * not defence in depth, they are a straddle: on a deployment whose container
 * runs a day AHEAD of the club, the route admits `clubToday - 365` and the
 * service then throws "Retroactive bookings can go back at most 365 days"
 * against `containerToday - 365`, one day later. The officer is refused for a
 * date the same request just accepted, and no wording anywhere tells them why.
 *
 * ## How this file proves it
 *
 * It does NOT mock `@/lib/booking-create`, which is what its sibling
 * `create-past-dates-admin.test.ts` does and why that suite cannot see this: a
 * spy has no guard to disagree with. The real service runs, and `$transaction`
 * — the first thing it touches after clearing its guard — throws a sentinel the
 * route reports as the generic "Failed to create booking". So:
 *
 *   - generic failure  => both guards passed, the pair agrees;
 *   - lookback message => one of them refused, and the boundary case says which.
 *
 * `APP_TIME_ZONE` is pinned a day ahead of the persisted zone under the frozen
 * clock, which is exactly the deployment shape that straddles. Nothing reads the
 * host's `TZ`, so this says the same thing on CI, where it is unset.
 */
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
const { PERSISTED_CLUB_ZONE, REACHED_THE_TRANSACTION } = vi.hoisted(() => ({
  PERSISTED_CLUB_ZONE: "America/Denver",
  REACHED_THE_TRANSACTION: "reached the create transaction",
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
vi.mock("@/lib/session-guards", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/session-guards")>()),
  requireActiveSessionUser: h.requireActiveSessionUser,
}));
vi.mock("@/lib/rate-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rate-limit")>()),
  applyRateLimit: vi.fn().mockResolvedValue(null),
  rateLimiters: { bookingCreate: {}, bookingQuery: {} },
}));
vi.mock("@/lib/logger", () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
/*
  EVERY LIBRARY MOCK IN THIS FILE IS PARTIAL, and that is load-bearing rather
  than tidy. Un-spying `@/lib/booking-create` widens this file's module graph as
  far as the email templates and the access-role catalogue, which read constants
  from these modules AT IMPORT TIME. A factory mock that looked complete for the
  narrower graph — `getLodgeCapacity` without `FALLBACK_LODGE_CAPACITY`,
  `hasAdminAccess` without `ACCESS_ROLE_LABELS` — kills the whole suite before a
  single test runs (`AGENTS.md`, "Focused tests miss mock completeness"). Keep
  the spread; override only what a case actually steers.
*/
vi.mock("@/lib/access-roles", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/access-roles")>()),
  hasAdminAccess: h.hasAdminAccess,
  hasAccessRole: h.hasAccessRole,
}));
vi.mock("@/lib/admin-permissions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/admin-permissions")>()),
  bookingManagementAuthorizationRole: h.managementRole,
}));
vi.mock("@/lib/module-settings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/module-settings")>()),
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
    /*
      The service's first act after its retroactive guard. Throwing a plain
      `Error` here is the probe: the route maps an untyped error to the generic
      "Failed to create booking", so that body means "both guards passed and the
      service got to work", while the lookback message means one of them refused.
    */
    $transaction: vi.fn(async () => {
      throw new Error(REACHED_THE_TRANSACTION);
    }),
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
vi.mock("@/lib/booking-guests", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/booking-guests")>()),
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
vi.mock("@/lib/booking-guest-stay-range-input", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/booking-guest-stay-range-input")>()),
  normalizeGuestStayRanges: (guests: unknown[]) => guests,
  BookingGuestStayRangeValidationError: class extends Error {},
}));
vi.mock("@/lib/booking-member-night-conflicts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/booking-member-night-conflicts")>()),
  findBookingMemberNightConflicts: vi.fn().mockResolvedValue([]),
  BookingMemberNightConflictError: class extends Error {
    conflicts: unknown[] = [];
  },
  getBookingMemberNightConflictResponse: () => ({ error: "conflict" }),
}));
vi.mock("@/lib/lodges", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/lodges")>()),
  resolveOptionalActiveLodgeId: h.resolveOptionalActiveLodgeId,
  // The member self-book minimum-stay check filters policy rows per lodge.
  resolvePolicyRowsForLodge: () => [],
}));
vi.mock("@/lib/lodge-capacity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/lodge-capacity")>()),
  getLodgeCapacity: vi.fn().mockResolvedValue(30),
}));
vi.mock("@/lib/membership-type-policy", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/membership-type-policy")>()),
  assertMembershipTypeBookingAllowed: vi.fn().mockResolvedValue(undefined),
  getMembershipTypeBookingPolicyErrorBody: (e: { message: string }) => ({
    error: e.message,
  }),
  MembershipTypeBookingPolicyError: class extends Error {
    status = 400;
  },
  requiresPaidSubscriptionForMemberForBooking: vi.fn().mockResolvedValue(false),
}));
vi.mock("@/lib/booking-member-guest-subscriptions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/booking-member-guest-subscriptions")>()),
  findUnpaidMemberGuests: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/lib/cancellation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/cancellation")>()),
  getNonMemberHoldPolicy: vi
    .fn()
    .mockResolvedValue({ enabled: false, holdDays: 0, source: "default" }),
}));
vi.mock("@/lib/policies/booking-route-decisions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/policies/booking-route-decisions")>()),
  calculateBookingHoldDecision: () => ({
    shouldBePending: false,
    status: "PAYMENT_PENDING",
  }),
  toGroupDiscountConfig: () => ({}),
}));
vi.mock("@/lib/member-credit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/member-credit")>()),
  getMemberCreditBalance: vi.fn().mockResolvedValue(0),
}));
vi.mock("@/lib/internet-banking-settings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/internet-banking-settings")>()),
  checkInternetBankingLeadTime: () => ({ allowed: true }),
  loadInternetBankingPaymentSettings: vi.fn().mockResolvedValue({}),
}));
// The lock guard (#1697 extraction) reads connectivity from the source
// domain module, not the @/lib/xero facade.
vi.mock("@/lib/xero-token-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/xero-token-store")>()),
  isXeroConnected: h.isXeroConnected,
}));
vi.mock("@/lib/xero-organisation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/xero-organisation")>()),
  getXeroLockDates: h.getXeroLockDates,
  getEffectiveXeroLockDate: h.getEffectiveXeroLockDate,
  // #2543's lockout-mode read refreshes the financial-year config, which asks
  // Xero for the year-end month. Null is the documented "unavailable" answer
  // and falls back to the club default, so these tests stay about date gating.
  getXeroFinancialYearEndMonth: vi.fn(async () => null),
}));

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
  {
    firstName: "Jane",
    lastName: "Doe",
    ageTier: "ADULT",
    isMember: true,
    memberId: "target-m1",
  },
];

/** The message the SERVICE raises when its own lookback guard refuses. */
const LOOKBACK_REFUSAL = `Retroactive bookings can go back at most ${MAX_LOOKBACK_DAYS} days.`;

/** What the route reports once an untyped error escapes the service. */
const REACHED_SERVICE_WORK = "Failed to create booking";

async function postRetroactive(checkInDelta: number) {
  const res = await POST(
    makeRequest({
      checkIn: daysFromTodayStr(checkInDelta),
      checkOut: daysFromTodayStr(checkInDelta + 2),
      guests,
      forMemberId: "target-m1",
      allowPastDates: true,
      confirmOverCapacity: true,
    }),
  );
  return { status: res.status, body: await res.json() };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.auth.mockResolvedValue(ADMIN_SESSION);
  h.requireActiveSessionUser.mockResolvedValue(null);
  h.managementRole.mockReturnValue("ADMIN");
  h.hasAdminAccess.mockReturnValue(true);
  h.hasAccessRole.mockReturnValue(false);
  h.loadEffectiveModuleFlags.mockResolvedValue({
    xeroIntegration: true,
    bedAllocation: false,
    internetBankingPayments: false,
  });
  h.memberFindUnique.mockResolvedValue({ active: true });
  h.groupDiscountFindUnique.mockResolvedValue(null);
  h.isXeroConnected.mockResolvedValue(false);
  h.getEffectiveXeroLockDate.mockReturnValue(null);
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

describe("the create route and the create service share one today (CT-4, #2870)", () => {
  it("PREMISE: the container is a day AHEAD of the club, which is what straddles", () => {
    // The ANSWERS must differ, not merely the zone identifiers, and in this
    // DIRECTION: a container BEHIND the club would make the service's guard the
    // looser of the two and hide the refusal entirely.
    expect(APP_TIME_ZONE).toBe("Pacific/Auckland");
    expect(clubToday(requireClubTimeZone(APP_TIME_ZONE))).toBe("2026-07-01");
    expect(clubToday(requireClubTimeZone(PERSISTED_CLUB_ZONE))).toBe("2026-06-30");
  });

  it("accepts a stay exactly at the lookback edge of the CLUB's day", async () => {
    /*
      MUTANT KILLED: `getTodayDateOnly()` restored in `createConfirmedBooking`.
      The route admits this check-in and the service then refuses it, so the
      officer is told the stay is too old for a date the same request accepted —
      and resubmitting reproduces it exactly.
    */
    const { status, body } = await postRetroactive(-MAX_LOOKBACK_DAYS);

    expect(body.error).not.toBe(LOOKBACK_REFUSAL);
    expect(body.error).toBe(REACHED_SERVICE_WORK);
    expect(status).toBe(400);
  });

  it("still refuses a stay one day beyond it, so the guard is not vacuous", async () => {
    // Deleting either guard outright would pass the case above. One day further
    // back is outside the window on ANY reading of today, so it must be refused.
    const { status, body } = await postRetroactive(-MAX_LOOKBACK_DAYS - 1);

    expect(body.error).toBe(LOOKBACK_REFUSAL);
    expect(status).toBe(400);
  });
});
