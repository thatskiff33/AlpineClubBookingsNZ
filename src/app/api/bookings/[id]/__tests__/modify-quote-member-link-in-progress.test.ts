import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GUEST_MEMBER_LINK_IN_PROGRESS_MESSAGE } from "@/lib/booking-modify-validation";

// #2337 — the quote route MUST refuse a placeholder→member link on an
// in-progress (mid-stay) booking with the SAME message the apply path throws, so
// the officer sees the refusal in the preview instead of a phantom $0 quote (a
// mid-stay link never reaches the in-progress pricing plan, so the re-rate would
// silently settle nothing). This pins the quote half of the parity; the apply
// half is pinned in `booking-batch-modification-member-link.test.ts` and
// `resolve-target-dates-admin-override.test.ts`.

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
  validateMinimumStay: vi.fn(),
  isMemberWholeLodgeBooking: vi.fn(),
  resolveGuestMemberLinks: vi.fn(),
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
// #2337: the barrel is mocked, so the real in-progress refusal message is
// imported from the validation module and re-provided here — preview and apply
// therefore assert against ONE source of truth.
vi.mock("@/lib/booking-modify", async () => {
  const { GUEST_MEMBER_LINK_IN_PROGRESS_MESSAGE } = await vi.importActual<
    typeof import("@/lib/booking-modify-validation")
  >("@/lib/booking-modify-validation");
  return {
    isQuotePricedBooking: vi.fn().mockResolvedValue(false),
    isMemberWholeLodgeBooking: h.isMemberWholeLodgeBooking,
    resolveGuestMemberLinks: h.resolveGuestMemberLinks,
    resolveGuestNameUpdates: vi.fn().mockReturnValue([]),
    lockedNightPricesForGuest: vi.fn().mockReturnValue(null),
    calculateModificationSettlementOptions: vi.fn().mockResolvedValue(null),
    QUOTE_PRICED_EDIT_BLOCK_MESSAGE: "quote-priced",
    GUEST_MEMBER_LINK_IN_PROGRESS_MESSAGE,
  };
});
vi.mock("@/lib/booking-guests", () => ({
  computeMemberGuestBoundary: vi.fn().mockResolvedValue({
    scopeByMemberId: new Map(),
    beyondFamilyMemberIds: [],
  }),
  resolveLinkedBookingMembers: vi.fn().mockResolvedValue([]),
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
vi.mock("@/lib/module-settings", () => ({
  loadEffectiveModuleFlags: h.loadModuleFlags,
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
vi.mock("@/lib/booking-policies", () => ({
  validateMinimumStay: h.validateMinimumStay,
  formatViolationsDetail: (violations: unknown[]) =>
    `minimum-stay violations: ${violations.length}`,
  formatViolationMessage: () => "minimum-stay violation",
}));
vi.mock("@/lib/member-credit", () => ({
  getMemberCreditBalance: vi.fn().mockResolvedValue(0),
}));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import { POST } from "@/app/api/bookings/[id]/modify-quote/route";

const D = (s: string) => new Date(`${s}T00:00:00.000Z`);

// A fixed NZ "today" inside the in-progress stay, with multi-day margins so the
// Pacific/Auckland date-only normalization can never flip the edit-policy branch.
const NOW = new Date("2026-08-15T06:00:00.000Z");

function req(body: unknown) {
  return new NextRequest("http://localhost/api/bookings/b1/modify-quote", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

const params = Promise.resolve({ id: "b1" });

// In-progress member whole-lodge booking: check-in 2026-08-14 <= today
// 2026-08-15 < check-out 2026-08-18, with an unnamed non-member placeholder.
function inProgressWholeLodgeBooking() {
  return {
    id: "b1",
    status: "PAID",
    memberId: "m1",
    lodgeId: "lodge-1",
    wholeLodgeHold: true,
    checkIn: D("2026-08-14"),
    checkOut: D("2026-08-18"),
    totalPriceCents: 30000,
    discountCents: 0,
    promoAdjustmentCents: 0,
    finalPriceCents: 30000,
    payment: null,
    promoRedemption: null,
    guests: [
      {
        id: "g1",
        firstName: "Guest",
        lastName: "1",
        ageTier: "ADULT",
        isMember: false,
        memberId: null,
        stayStart: D("2026-08-14"),
        stayEnd: D("2026-08-18"),
        priceCents: 30000,
        nights: [
          { stayDate: D("2026-08-14"), priceCents: 7500 },
          { stayDate: D("2026-08-15"), priceCents: 7500 },
          { stayDate: D("2026-08-16"), priceCents: 7500 },
          { stayDate: D("2026-08-17"), priceCents: 7500 },
        ],
      },
    ],
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.clearAllMocks();
  // Admin officer — the only actor who can reach the link at all.
  h.auth.mockResolvedValue({ user: { id: "admin1" } });
  h.requireActiveSessionUser.mockResolvedValue(null);
  h.authorizationRole.mockReturnValue("ADMIN");
  h.bookingFindUnique.mockResolvedValue(inProgressWholeLodgeBooking());
  h.seasonFindMany.mockResolvedValue([]);
  h.groupDiscountFindUnique.mockResolvedValue(null);
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
    totalPriceCents: 30000,
    guests: [{ priceCents: 30000, perNightCents: [7500], nightDates: [] }],
  });
  h.calculateChangeFee.mockReturnValue({ feeCents: 0 });
  h.loadModuleFlags.mockResolvedValue({ xeroIntegration: false });
  h.isXeroConnected.mockResolvedValue(true);
  h.getXeroLockDates.mockResolvedValue({
    periodLockDate: null,
    endOfYearLockDate: null,
  });
  h.validateMinimumStay.mockResolvedValue({ valid: true, violations: [] });
  // Member-origin (member whole-lodge) so the request clears the origin fence and
  // reaches the in-progress guard. The resolver's synchronous gate passes.
  h.isMemberWholeLodgeBooking.mockResolvedValue(true);
  h.resolveGuestMemberLinks.mockReturnValue([]);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("POST /api/bookings/[id]/modify-quote — #2337 mid-stay link refusal", () => {
  it("refuses a placeholder→member link on an in-progress booking with the shared message (not a $0 quote)", async () => {
    const res = await POST(
      req({ linkGuestToMember: [{ guestId: "g1", memberId: "member-9" }] }),
      { params },
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe(GUEST_MEMBER_LINK_IN_PROGRESS_MESSAGE);
    // The refusal is the officer-facing remove-and-re-add guidance, never $0.
    expect(body.priceDiffCents).toBeUndefined();
    // Pricing never ran — the refusal precedes it.
    expect(h.priceGuests).not.toHaveBeenCalled();
  });
});
