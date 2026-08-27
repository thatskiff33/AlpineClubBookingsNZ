import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * CT-4 (#2870): a member who changed nothing is quoted for the nights their
 * booking actually holds — a cross-file frame pair, priced.
 *
 * ## What went wrong, in plain English
 *
 * The edit preview asks one question twice. It reads the guest's stored stay
 * range off the booking to see whether the member moved anything, and it reads
 * the SAME stored range through the shared planner
 * (`resolveModificationStayRanges`) to decide what to price. CT-4 corrected the
 * first read and left the second projecting through `APP_TIME_ZONE`, so for a
 * club BEHIND Greenwich the planner handed back a window one night earlier than
 * the columns hold.
 *
 * Two things follow, and both reach the member:
 *
 *  - the route concludes the guest's range CHANGED when nothing changed, so
 *    `guestRangesChanged` is true on every edit and the repricing branch always
 *    runs;
 *  - it then prices the corrected window against the projected one. Those two
 *    windows are one night apart, so as soon as the shift crosses a season or
 *    rate boundary the preview shows a date-change charge for a date change
 *    nobody made.
 *
 * The fixture puts a rate boundary exactly on the check-in day, which is the
 * cheapest way to make a one-night shift visible as money rather than as an
 * internal flag. Pricing is mocked to answer from the WINDOW it is handed: a
 * flat mock would return the same cents either way and the defect would stay
 * invisible, which is how it survived in the first place.
 *
 * `APP_TIME_ZONE` is pinned in the mock, so this says the same thing on any
 * machine and on CI, where `TZ` is unset. The harness is
 * `modify-quote-in-stay-min-stay.test.ts`'s, kept deliberately close so the two
 * read as the same route under two lenses.
 */

/*
 * The zone behind UTC, declared ONCE (#3123). `vi.mock` factories hoist above
 * every plain `const`, which is why the literals below are inlined; `vi.hoisted`
 * lets the factory and the premise assertion share one declaration, so the zone
 * the mock pins and the zone the legacy projection is measured in cannot drift.
 */
const { LEGACY_PROJECTION_ZONE } = vi.hoisted(() => ({
  LEGACY_PROJECTION_ZONE: "America/Denver",
}));

// Inlined literals: `vi.mock` factories hoist above every const in this file.
vi.mock("@/config/operational", () => ({
  APP_CURRENCY: "NZD",
  APP_STRIPE_CURRENCY: "nzd",
  APP_TIME_ZONE: LEGACY_PROJECTION_ZONE,
  APP_LOCALE: "en-NZ",
}));

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
vi.mock("@/lib/lodge-capacity", () => ({ getLodgeCapacity: h.getLodgeCapacity }));
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
vi.mock("@/lib/booking-modify", () => ({
  isQuotePricedBooking: vi.fn().mockResolvedValue(false),
  isMemberWholeLodgeBooking: vi.fn().mockResolvedValue(false),
  resolveGuestMemberLinks: vi.fn().mockReturnValue([]),
  resolveGuestNameUpdates: vi.fn().mockReturnValue([]),
  lockedNightPricesForGuest: vi.fn().mockReturnValue(null),
  calculateModificationSettlementOptions: vi.fn().mockResolvedValue(null),
  QUOTE_PRICED_EDIT_BLOCK_MESSAGE: "quote-priced",
}));
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

import { formatDateOnlyForTimeZone } from "@/lib/date-only";
import { POST } from "@/app/api/bookings/[id]/modify-quote/route";

const D = (s: string) => new Date(`${s}T00:00:00.000Z`);
const iso = (d: Date) => d.toISOString().slice(0, 10);

/** Well before the stay, so the booking is squarely in the "future edit" mode. */
const NOW = new Date("2026-08-15T06:00:00.000Z");

/** The stored `@db.Date` days on the fixture booking. */
const STORED_CHECK_IN = "2026-09-01";
const STORED_CHECK_OUT = "2026-09-03";

/**
 * A rate boundary ON the check-in day: the shoulder night before 1 September is
 * half price. A window shifted one night earlier therefore costs a different
 * number, which is what turns an internal frame slip into a member-visible
 * charge.
 */
const PEAK_NIGHT_CENTS = 10000;
const SHOULDER_NIGHT_CENTS = 5000;
const STORED_TOTAL_CENTS = PEAK_NIGHT_CENTS * 2;

function rateFor(night: string) {
  return night >= STORED_CHECK_IN ? PEAK_NIGHT_CENTS : SHOULDER_NIGHT_CENTS;
}

/** Plain UTC night expansion — deliberately not the pricing helper under test. */
function nightsOf(stayStart: Date, stayEnd: Date): string[] {
  const nights: string[] = [];
  for (
    let cursor = new Date(stayStart);
    cursor < stayEnd;
    cursor = new Date(cursor.getTime() + 86_400_000)
  ) {
    nights.push(iso(cursor));
  }
  return nights;
}

type PricedGuest = { stayStart: Date; stayEnd: Date };

function req(body: unknown) {
  return new NextRequest("http://localhost/api/bookings/b1/modify-quote", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

const params = Promise.resolve({ id: "b1" });

function futureBooking() {
  return {
    id: "b1",
    status: "CONFIRMED",
    memberId: "m1",
    lodgeId: "lodge-1",
    checkIn: D(STORED_CHECK_IN),
    checkOut: D(STORED_CHECK_OUT),
    totalPriceCents: STORED_TOTAL_CENTS,
    discountCents: 0,
    promoAdjustmentCents: 0,
    finalPriceCents: STORED_TOTAL_CENTS,
    payment: null,
    promoRedemption: null,
    guests: [
      {
        id: "g1",
        ageTier: "ADULT",
        isMember: true,
        memberId: "m1",
        stayStart: D(STORED_CHECK_IN),
        stayEnd: D(STORED_CHECK_OUT),
        priceCents: STORED_TOTAL_CENTS,
        nights: [
          { stayDate: D("2026-09-01"), priceCents: PEAK_NIGHT_CENTS },
          { stayDate: D("2026-09-02"), priceCents: PEAK_NIGHT_CENTS },
        ],
      },
    ],
  };
}

/** Every stay window this request priced, in call order. */
function pricedWindows(): Array<{ stayStart: string; stayEnd: string }> {
  return h.priceGuests.mock.calls.flatMap(([, args]) =>
    ((args as { guests: PricedGuest[] }).guests ?? []).map((guest) => ({
      stayStart: iso(guest.stayStart),
      stayEnd: iso(guest.stayEnd),
    })),
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.clearAllMocks();
  h.auth.mockResolvedValue({ user: { id: "m1" } });
  h.requireActiveSessionUser.mockResolvedValue(null);
  h.authorizationRole.mockReturnValue("USER");
  h.bookingFindUnique.mockResolvedValue(futureBooking());
  h.seasonFindMany.mockResolvedValue([
    {
      id: "season-shoulder",
      startDate: D("2026-06-01"),
      endDate: D("2026-08-31"),
      membershipTypeRates: [
        {
          membershipTypeId: "type-nonmember",
          ageTier: "ADULT",
          pricePerNightCents: SHOULDER_NIGHT_CENTS,
        },
      ],
    },
    {
      id: "season-peak",
      startDate: D("2026-09-01"),
      endDate: D("2026-10-31"),
      membershipTypeRates: [
        {
          membershipTypeId: "type-nonmember",
          ageTier: "ADULT",
          pricePerNightCents: PEAK_NIGHT_CENTS,
        },
      ],
    },
  ]);
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
  h.priceGuests.mockImplementation(async (_db: unknown, args: unknown) => {
    const guests = (args as { guests: PricedGuest[] }).guests ?? [];
    const priced = guests.map((guest) => {
      const perNightCents = nightsOf(guest.stayStart, guest.stayEnd).map(rateFor);
      return {
        priceCents: perNightCents.reduce((sum, cents) => sum + cents, 0),
        perNightCents,
        nightDates: [],
      };
    });
    return {
      totalPriceCents: priced.reduce((sum, guest) => sum + guest.priceCents, 0),
      guests: priced,
    };
  });
  h.calculateChangeFee.mockReturnValue({ feeCents: 0 });
  h.loadModuleFlags.mockResolvedValue({ xeroIntegration: false });
  h.isXeroConnected.mockResolvedValue(true);
  h.getXeroLockDates.mockResolvedValue({
    periodLockDate: null,
    endOfYearLockDate: null,
  });
  h.validateMinimumStay.mockResolvedValue({ valid: true, violations: [] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** The delta that moves nothing: the days the booking already holds. */
const NO_OP_DELTA = { checkIn: STORED_CHECK_IN, checkOut: STORED_CHECK_OUT };

describe("modify-quote prices the stored window, not a projected one (CT-4, #2870)", () => {
  it("PREMISE: this zone really does move a stored day", () => {
    // The LEGACY answer, measured. If it ever equals the stored day the fixture
    // has stopped discriminating and every assertion below is worthless. The
    // zone is named rather than defaulted (#3123): this line models the REPLACED
    // helper, so it has to say which zone it models.
    expect(formatDateOnlyForTimeZone(D(STORED_CHECK_IN), LEGACY_PROJECTION_ZONE)).toBe("2026-08-31");
  });

  it("never prices a stay window the booking does not hold", async () => {
    // MUTANT KILLED: `normalizeDateOnlyForTimeZone` restored in `storedRange`
    // (`booking-modification-stay-ranges.ts`) or in this route's
    // `storedDateOnly`. Either one puts `2026-08-31` in this list.
    const res = await POST(req(NO_OP_DELTA), { params });
    expect(res.status).toBe(200);

    const windows = pricedWindows();
    expect(windows.length).toBeGreaterThan(0);
    for (const window of windows) {
      expect(window).toEqual({
        stayStart: STORED_CHECK_IN,
        stayEnd: STORED_CHECK_OUT,
      });
    }
  });

  it("quotes no change at all for a delta that changes nothing", async () => {
    const res = await POST(req(NO_OP_DELTA), { params });
    expect(res.status).toBe(200);
    const body = await res.json();

    // The member-visible symptom: a date-change charge for no date change.
    expect(body.newTotalPriceCents).toBe(STORED_TOTAL_CENTS);
    expect(body.priceDiffCents).toBe(0);
    expect(body.netChargeCents).toBe(0);
    expect(body.itemizedChanges).toEqual([]);
  });

  it("still quotes a real date change, so the guard is not vacuous", async () => {
    // Deleting the repricing branch outright would pass both cases above. Moving
    // the stay onto the cheap shoulder nights must still produce a charge line.
    const res = await POST(
      req({ checkIn: "2026-08-29", checkOut: "2026-08-31" }),
      { params },
    );
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.newTotalPriceCents).toBe(SHOULDER_NIGHT_CENTS * 2);
    expect(body.priceDiffCents).toBe(SHOULDER_NIGHT_CENTS * 2 - STORED_TOTAL_CENTS);
    // Same night COUNT, cheaper nights, and the guest's range really did move —
    // so the repricing line is the "Guest stay range change" wording rather than
    // "Date change: N nights → M nights". Either is the branch firing; what
    // matters is that it fired and carries the real difference.
    expect(body.itemizedChanges).toEqual([
      {
        label: "Guest stay range change",
        amountCents: SHOULDER_NIGHT_CENTS * 2 - STORED_TOTAL_CENTS,
      },
    ]);
  });
});
