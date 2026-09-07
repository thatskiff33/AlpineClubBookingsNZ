import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// #2770 (INV-MOD-026), D2: the officer-facing half of the edit-time group
// discount switch, asserted on the WIRE. The collaborator mocks below are the
// same harness `modify-quote-recalc-override.test.ts` uses, because what is
// under test here is the route response rather than any of them.

const h = vi.hoisted(() => ({
  auth: vi.fn(),
  requireActiveSessionUser: vi.fn(),
  authorizationRole: vi.fn(),
  bookingFindUnique: vi.fn(),
  seasonFindMany: vi.fn(),
  groupDiscountFindUnique: vi.fn(),
  bookingRequestFindFirst: vi.fn(),
  checkCapacityForGuestRanges: vi.fn(),
  findConflicts: vi.fn(),
  getDefaultLodgeId: vi.fn(),
  getLodgeCapacity: vi.fn(),
  priceGuests: vi.fn(),
  calculateChangeFee: vi.fn(),
  loadModuleFlags: vi.fn(),
  isXeroConnected: vi.fn(),
  getXeroLockDates: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: h.auth }));
vi.mock("@/lib/session-guards", () => ({
  requireActiveSessionUser: h.requireActiveSessionUser,
}));
vi.mock("@/lib/admin-permissions", () => ({
  bookingManagementAuthorizationRole: h.authorizationRole,
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    // #3032: the preview half of the pending-review fence reads this. Empty by
    // default - no financial review is open - so this suite asserts exactly what
    // it asserted before.
    manualRefundTask: { findFirst: vi.fn().mockResolvedValue(null) },
    booking: { findUnique: h.bookingFindUnique },
    season: { findMany: h.seasonFindMany },
    groupDiscountSetting: { findUnique: h.groupDiscountFindUnique },
    bookingRequest: { findFirst: h.bookingRequestFindFirst },
  },
}));
vi.mock("@/lib/capacity", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/capacity")>();
  return { ...actual, checkCapacityForGuestRanges: h.checkCapacityForGuestRanges };
});
vi.mock("@/lib/booking-member-night-conflicts", () => ({
  findBookingMemberNightConflicts: h.findConflicts,
  getBookingMemberNightConflictResponse: (conflicts: unknown[]) => ({
    code: "BOOKING_MEMBER_NIGHT_CONFLICT",
    conflicts,
  }),
}));
vi.mock("@/lib/lodges", () => ({
  getDefaultLodgeId: h.getDefaultLodgeId,
  lodgeNullTolerantScope: () => ({}),
}));
// #3032: PARTIAL mock. The pending-review fence added an import to
// `modify-quote/route.ts`, which widened this suite's module graph until
// `club-identity.ts` read `FALLBACK_LODGE_CAPACITY` at import time and the whole
// file died before a single test ran. `importOriginal` keeps every other export
// real, so the next widening cannot break it the same way (docs/TESTING.md).
vi.mock("@/lib/lodge-capacity", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/lodge-capacity")>();
  return { ...actual, getLodgeCapacity: h.getLodgeCapacity };
});
vi.mock("@/lib/membership-type-policy", () => ({
  assertMembershipTypeBookingAllowed: vi.fn().mockResolvedValue(undefined),
  // #1930, E4: the resolver replaces applyMembershipTypeRatePolicyToGuests;
  // identity passthrough (stamping a non-member snapshot) is enough here since
  // priceBookingGuestsWithMembershipTypePolicy is also mocked.
  resolveGuestRateMembershipTypes: vi
    .fn()
    .mockImplementation((_db: unknown, { guests }: { guests: Array<Record<string, unknown>> }) =>
      Promise.resolve(
        guests.map((g) => ({
          ...g,
          rateMembershipTypeId: "type-nonmember",
          rateSource: "NON_MEMBER_DEFAULT",
        })),
      ),
    ),
  priceBookingGuestsWithMembershipTypePolicy: h.priceGuests,
  MembershipTypeBookingPolicyError: class extends Error {},
  getMembershipTypeBookingPolicyErrorBody: (e: Error) => ({ error: e.message }),
}));
vi.mock("@/lib/booking-modify", () => ({
  isQuotePricedBooking: vi.fn().mockResolvedValue(false),
  // #2337: no link in these fixtures, so both new gate collaborators are inert.
  isMemberWholeLodgeBooking: vi.fn().mockResolvedValue(false),
  resolveGuestMemberLinks: vi.fn().mockReturnValue([]),
  resolveGuestNameUpdates: vi.fn().mockReturnValue([]),
  lockedNightPricesForGuest: vi.fn().mockReturnValue(null),
  calculateModificationSettlementOptions: vi.fn().mockResolvedValue(null),
  QUOTE_PRICED_EDIT_BLOCK_MESSAGE: "quote-priced",
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
  normalizeBookingGuestInputs: vi.fn().mockReturnValue([]),
  BookingGuestValidationError: class extends Error {},
  getBookingGuestValidationErrorResponse: (e: Error) => ({ error: e.message }),
}));
vi.mock("@/lib/cancellation", () => ({
  loadCancellationPolicy: vi.fn().mockResolvedValue([]),
  daysUntilDate: vi.fn().mockReturnValue(5),
}));
vi.mock("@/lib/change-fee", () => ({ calculateChangeFee: h.calculateChangeFee }));
// Xero lock-date guard chain (#1697 override, #1729 ordinary edits).
// getEffectiveXeroLockDate stays real.
vi.mock("@/lib/module-settings", () => ({
  loadEffectiveModuleFlags: h.loadModuleFlags,
  // MG2 (#2307): the route now reaches `@/lib/admin-modules` through
  // `member-guest-add-policy` (it reads the memberGuests module flag before
  // opening any transaction), and admin-modules imports these two from this
  // module at module scope. A flags object without `memberGuests` leaves the
  // widening off, which is this test's world unchanged.
  CLUB_MODULE_SETTINGS_ID: "default",
  normalizeClubModuleSettings: (record: unknown) => record ?? {},
}));
vi.mock("@/lib/xero-token-store", () => ({
  isXeroConnected: h.isXeroConnected,
}));
vi.mock("@/lib/xero-organisation", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/xero-organisation")>();
  return { ...actual, getXeroLockDates: h.getXeroLockDates };
});
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));
vi.mock("@/lib/member-credit", () => ({
  getMemberCreditBalance: vi.fn().mockResolvedValue(0),
}));
vi.mock("@/lib/booking-policies", () => ({
  validateMinimumStay: vi.fn().mockResolvedValue({ valid: true, violations: [] }),
  formatViolationsDetail: (violations: unknown[]) =>
    `minimum-stay violations: ${violations.length}`,
  formatViolationMessage: () => "minimum-stay violation",
}));

import { POST } from "@/app/api/bookings/[id]/modify-quote/route";
import { GROUP_DISCOUNT_EDIT_OFF_NOTICE } from "@/lib/policies/booking-route-decisions";

const D = (s: string) => new Date(`${s}T00:00:00.000Z`);

/** A fixed NZ "today" months before the stay, so this is an ORDINARY edit. */
const NOW = new Date("2026-08-15T06:00:00.000Z");

function req(body: unknown) {
  return new NextRequest("http://localhost/api/bookings/b1/modify-quote", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

const params = Promise.resolve({ id: "b1" });

/**
 * A summer stay held by a party of five, which is the only shape where the note
 * has anything to explain: five meets the club's `minGroupSize`, and the season
 * carries `type: "SUMMER"` so a `summerOnly` discount reaches it.
 */
const PARTY_SIZE = 5;

function booking() {
  return {
    id: "b1",
    status: "PAID",
    memberId: "m1",
    lodgeId: "lodge-1",
    checkIn: D("2026-12-10"),
    checkOut: D("2026-12-13"),
    totalPriceCents: 150000,
    discountCents: 0,
    promoAdjustmentCents: 0,
    finalPriceCents: 150000,
    payment: null,
    promoRedemption: null,
    guests: Array.from({ length: PARTY_SIZE }, (_, index) => ({
      id: `g${index + 1}`,
      ageTier: "ADULT",
      isMember: index === 0,
      memberId: index === 0 ? "m1" : null,
      stayStart: D("2026-12-10"),
      stayEnd: D("2026-12-13"),
      priceCents: 30000,
      nights: [
        { stayDate: D("2026-12-10"), priceCents: 10000, priceSource: "SOLD" },
        { stayDate: D("2026-12-11"), priceCents: 10000, priceSource: "SOLD" },
        { stayDate: D("2026-12-12"), priceCents: 10000, priceSource: "SOLD" },
      ],
    })),
  };
}

/** One SUMMER season covering the stay, loaded the way the route loads them. */
function summerSeasons() {
  return [
    {
      id: "s-summer",
      startDate: D("2026-11-01"),
      endDate: D("2027-03-31"),
      type: "SUMMER",
      membershipTypeRates: [
        {
          membershipTypeId: "type-nonmember",
          ageTier: null,
          pricePerNightCents: 10000,
        },
      ],
    },
  ];
}

function groupDiscount(overrides: {
  enabled: boolean;
  applyToEdits: boolean;
  minGroupSize?: number;
}) {
  return {
    id: "default",
    minGroupSize: overrides.minGroupSize ?? PARTY_SIZE,
    summerOnly: true,
    enabled: overrides.enabled,
    rateMembershipTypeId: "type-full",
    applyToEdits: overrides.applyToEdits,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.clearAllMocks();
  h.auth.mockResolvedValue({ user: { id: "admin1" } });
  h.requireActiveSessionUser.mockResolvedValue(null);
  h.authorizationRole.mockReturnValue("ADMIN");
  h.bookingFindUnique.mockResolvedValue(booking());
  h.seasonFindMany.mockResolvedValue(summerSeasons());
  h.bookingRequestFindFirst.mockResolvedValue(null);
  h.getDefaultLodgeId.mockResolvedValue("lodge-1");
  h.getLodgeCapacity.mockResolvedValue(29);
  h.findConflicts.mockResolvedValue([]);
  h.checkCapacityForGuestRanges.mockResolvedValue({
    available: true,
    minAvailable: 5,
    nightDetails: [],
  });
  h.priceGuests.mockResolvedValue({
    totalPriceCents: 200000,
    guests: Array.from({ length: PARTY_SIZE }, () => ({
      priceCents: 40000,
      perNightCents: [],
      nightDates: [],
    })),
  });
  h.calculateChangeFee.mockReturnValue({ feeCents: 0 });
  h.loadModuleFlags.mockResolvedValue({ xeroIntegration: false });
  h.isXeroConnected.mockResolvedValue(true);
  h.getXeroLockDates.mockResolvedValue({
    periodLockDate: null,
    endOfYearLockDate: null,
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/**
 * #2770 D2, at the ROUTE rather than at the resolver.
 *
 * The resolver's own truth table is in
 * `src/lib/policies/__tests__/booking-route-decisions.test.ts`, and the panel's
 * rendering of the field is in
 * `edit-booking-panel-group-discount-edit-notice.test.tsx`. Neither of those
 * touches the wire between them: deleting `groupDiscountEditNotice` from this
 * route's response body left all twelve of the suites around it green, which is
 * the definition of an untested contract. This file drives the real POST and
 * asserts the field, so the officer-facing half of the switch cannot be dropped
 * silently.
 */
async function quoteNotice(setting: ReturnType<typeof groupDiscount> | null) {
  h.groupDiscountFindUnique.mockResolvedValue(setting);
  const res = await POST(req({ checkOut: "2026-12-14" }), { params });
  expect(res.status).toBe(200);
  const body = await res.json();
  return body.groupDiscountEditNotice;
}

describe("POST /api/bookings/[id]/modify-quote — the edit-time group-discount notice (#2770, INV-MOD-026)", () => {
  it("tells the officer when the club has switched the discount off for edits", async () => {
    await expect(
      quoteNotice(groupDiscount({ enabled: true, applyToEdits: false })),
    ).resolves.toBe(GROUP_DISCOUNT_EDIT_OFF_NOTICE);
  });

  it("says nothing when the switch is on, because the discount is being given", async () => {
    await expect(
      quoteNotice(groupDiscount({ enabled: true, applyToEdits: true })),
    ).resolves.toBeNull();
  });

  it("says nothing when the club runs no group discount at all", async () => {
    await expect(
      quoteNotice(groupDiscount({ enabled: false, applyToEdits: false })),
    ).resolves.toBeNull();
    await expect(quoteNotice(null)).resolves.toBeNull();
  });

  it("says nothing when this edit's party could not have qualified anyway", async () => {
    // The narrowing: five guests against a minimum of nine. The switch withholds
    // nothing here, the price is what it would have been either way, and a note
    // would blame the switch for a number it did not move.
    await expect(
      quoteNotice(
        groupDiscount({ enabled: true, applyToEdits: false, minGroupSize: 9 }),
      ),
    ).resolves.toBeNull();
  });
});
