import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";

/*
  #2563 — THE PREVIEW AND THE SAVE RESOLVE ONE PARTY.

  `POST /api/bookings/[id]/modify-quote` used to assemble its own stay-range
  resolution: private `hasStayRangeInput` / `hasStayRangeValue` / `minDate` /
  `maxDate`, its own envelope-expansion loop, its own per-guest pass. #2526 had
  already extracted the canonical resolution to
  `resolveModificationStayRanges` and routed `resolveTargetDates` and
  `prepareGuestPlan` through it, but the preview kept its copy, held in step by
  inspection. That copy is now GONE (owner decision, Option 1, 3 Aug 2026): the
  preview makes the same two resolver calls the apply path makes.

  This suite is the gate that keeps it that way. It is not a unit test of the
  resolver (`booking-modification-stay-ranges.test.ts` owns that) and not a
  source-shape assertion (`review-findings-contracts.test.ts` owns the "no local
  copy" claim). It drives THREE REAL SURFACES over the SAME delta —

    1. the modify-quote route (the preview the member reads),
    2. `resolveTargetDates` -> `prepareGuestPlan` (the party the save WRITES),
    3. `buildModificationProposalParties` (the party an officer REVIEWS),

  — and requires them to agree on the envelope, on every guest's nights, on the
  capacity input, on the adult-supervision input, on the refusal message
  (including its member-facing "Guest N" number) and on the quoted cents.

  Pricing is a deterministic fake (a flat adult night rate, a lower child rate,
  and a guest's stored per-night price honoured as a #1036 lock) applied by the
  SAME function to the route's party and to the planner's party. That is what
  makes "identical to the cent" a real claim rather than a mocked constant: the
  cents are a pure function of the resolved party, so any drift in the resolution
  moves them. The `naive per-guest rule` control at the end of the first suite
  proves the comparison has teeth — the pre-#2526 rule prices the same delta
  differently.

  Three-way equality alone would be a RELATIVE gate, since all three surfaces now
  call the one resolver and a change to the RULE moves them together. So every
  matrix case also carries a hand-checked GOLDEN answer (envelope, nights by
  guest, total cents), and a separate suite drives the in-progress branch, where
  the two resolver calls are the only place they receive different `requested`
  envelopes.
*/

const h = vi.hoisted(() => ({
  auth: vi.fn(),
  requireActiveSessionUser: vi.fn(),
  authorizationRole: vi.fn(),
  bookingFindUnique: vi.fn(),
  bookingFindMany: vi.fn(),
  bookingUpdate: vi.fn(),
  bookingGuestCreate: vi.fn(),
  bookingGuestUpdate: vi.fn(),
  bookingGuestDeleteMany: vi.fn(),
  transaction: vi.fn(),
  seasonFindMany: vi.fn(),
  groupDiscountFindUnique: vi.fn(),
  bookingRequestFindFirst: vi.fn(),
  checkCapacityForGuestRanges: vi.fn(),
  findConflicts: vi.fn(),
  assertNoConflicts: vi.fn(),
  getDefaultLodgeId: vi.fn(),
  getLodgeCapacity: vi.fn(),
  priceGuests: vi.fn(),
  resolveGuestRates: vi.fn(),
  calculateChangeFee: vi.fn(),
  loadModuleFlags: vi.fn(),
  isXeroConnected: vi.fn(),
  getXeroLockDates: vi.fn(),
  validateMinimumStay: vi.fn(),
  findUnpaidMemberGuestNames: vi.fn(),
  resolveLinkedBookingMembersWithBoundary: vi.fn(),
  assertLinkedBookingMembersCanBeBooked: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: h.auth }));
vi.mock("@/lib/session-guards", () => ({
  requireActiveSessionUser: h.requireActiveSessionUser,
}));
vi.mock("@/lib/admin-permissions", () => ({
  bookingManagementAuthorizationRole: h.authorizationRole,
}));
// Every WRITE the route's Prisma client could reach is a spy that fails the test
// if it is ever called: the owner's "a quote request produces no writes or side
// effects" requirement is asserted, not assumed (see the zero-write suite).
vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: {
      findUnique: h.bookingFindUnique,
      findMany: h.bookingFindMany,
      update: h.bookingUpdate,
    },
    bookingGuest: {
      create: h.bookingGuestCreate,
      update: h.bookingGuestUpdate,
      deleteMany: h.bookingGuestDeleteMany,
    },
    season: { findMany: h.seasonFindMany },
    groupDiscountSetting: { findUnique: h.groupDiscountFindUnique },
    bookingRequest: { findFirst: h.bookingRequestFindFirst },
    $transaction: h.transaction,
  },
}));
vi.mock("@/lib/capacity", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/capacity")>();
  return { ...actual, checkCapacityForGuestRanges: h.checkCapacityForGuestRanges };
});
// Both halves: the route reads conflicts, `prepareGuestPlan` asserts them.
vi.mock("@/lib/booking-member-night-conflicts", () => ({
  findBookingMemberNightConflicts: h.findConflicts,
  assertNoBookingMemberNightConflicts: h.assertNoConflicts,
  getBookingMemberNightConflictResponse: (conflicts: unknown[]) => ({
    code: "BOOKING_MEMBER_NIGHT_CONFLICT",
    conflicts,
  }),
}));
vi.mock("@/lib/lodges", () => ({
  getDefaultLodgeId: h.getDefaultLodgeId,
  lodgeNullTolerantScope: () => ({}),
}));
// Partial: the REAL `@/lib/booking-modify` barrel pulls the email templates in,
// which read `FALLBACK_LODGE_CAPACITY` from this module at import time.
vi.mock("@/lib/lodge-capacity", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/lodge-capacity")>();
  return { ...actual, getLodgeCapacity: h.getLodgeCapacity };
});
vi.mock("@/lib/membership-type-policy", () => ({
  assertMembershipTypeBookingAllowed: vi.fn().mockResolvedValue(undefined),
  // A pass-through so the party that reaches pricing and capacity is exactly the
  // party the resolution produced — nothing is re-derived on the way. Spied
  // (rather than inlined) because its FIRST call carries the route's whole
  // proposed party, `guestsForPricing`, on every branch — including the
  // in-progress one, where the main pricing pass is replaced by
  // `buildInProgressGuestRangePlan` and never sees the party at all.
  resolveGuestRateMembershipTypes: h.resolveGuestRates,
  priceBookingGuestsWithMembershipTypePolicy: h.priceGuests,
  MembershipTypeBookingPolicyError: class extends Error {},
  getMembershipTypeBookingPolicyErrorBody: (e: Error) => ({ error: e.message }),
}));
// The REAL barrel, so `resolveGuestMemberLinks`, `resolveGuestNameUpdates` and
// `lockedNightPricesForGuest` behave identically on both sides of the
// comparison. Only the settlement read (a Xero/payment surface irrelevant to
// stay ranges) is stubbed.
vi.mock("@/lib/booking-modify", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/booking-modify")>();
  return {
    ...actual,
    calculateModificationSettlementOptions: vi.fn().mockResolvedValue(null),
  };
});
// Partial: `normalizeBookingGuestInputs` stays REAL because the parity claim for
// added guests rests on it preserving input order and length.
vi.mock("@/lib/booking-guests", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/booking-guests")>();
  return {
    ...actual,
    resolveLinkedBookingMembersWithBoundary:
      h.resolveLinkedBookingMembersWithBoundary,
    assertLinkedBookingMembersCanBeBooked: h.assertLinkedBookingMembersCanBeBooked,
  };
});
vi.mock("@/lib/booking-member-guest-subscriptions", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@/lib/booking-member-guest-subscriptions")
  >();
  return { ...actual, findUnpaidMemberGuestNames: h.findUnpaidMemberGuestNames };
});
vi.mock("@/lib/cancellation", () => ({
  loadCancellationPolicy: vi.fn().mockResolvedValue([]),
  daysUntilDate: vi.fn().mockReturnValue(30),
}));
vi.mock("@/lib/change-fee", () => ({ calculateChangeFee: h.calculateChangeFee }));
vi.mock("@/lib/module-settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/module-settings")>();
  return { ...actual, loadEffectiveModuleFlags: h.loadModuleFlags };
});
vi.mock("@/lib/xero-token-store", () => ({ isXeroConnected: h.isXeroConnected }));
vi.mock("@/lib/xero-organisation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/xero-organisation")>();
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
import { prepareGuestPlan } from "@/lib/booking-modify-plan";
import { resolveTargetDates } from "@/lib/booking-modify-validation";
import { buildModificationProposalParties } from "@/lib/booking-exception-request-service";
import { requiresAdultSupervisionReview } from "@/lib/booking-review";
import {
  eachDateOnlyInRange,
  formatDateOnly,
  parseDateOnly,
} from "@/lib/date-only";


const D = (s: string) => parseDateOnly(s);
const NOW = new Date("2026-08-10T06:00:00.000Z");
/** The calendar day {@link NOW} falls on at the club, as a date-only instant. */
const CLUB_TODAY = new Date("2026-08-10T00:00:00.000Z");
const params = Promise.resolve({ id: "b1" });

/** The flat season rate the deterministic pricer charges for an unlocked night. */
const NIGHT_CENTS = 5_000;
/**
 * The CHILD rate, deliberately different from the adult one. It is what makes a
 * party that resolves in the wrong ORDER cost a different amount: two added
 * guests with swapped ranges occupy the same total nights, so with one flat rate
 * the cents would agree even though the wrong guest was priced on the wrong
 * nights.
 */
const CHILD_NIGHT_CENTS = 3_000;
/** The stored per-night price on the fixture's booked nights (a #1036 lock). */
const BOOKED_NIGHT_CENTS = 4_200;

function req(body: unknown) {
  return new NextRequest("http://localhost/api/bookings/b1/modify-quote", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

function nightsBetween(start: Date, end: Date): string[] {
  return eachDateOnlyInRange(start, end).map(formatDateOnly);
}

/** A live `BookingGuest` row as the route, the planner and the freeze all read it. */
function liveGuest(
  id: string,
  firstName: string,
  start: string,
  end: string,
  nights?: string[],
) {
  return {
    id,
    firstName,
    lastName: "Guest",
    ageTier: "ADULT",
    isMember: false,
    memberId: null,
    consentStatus: null,
    stayStart: D(start),
    stayEnd: D(end),
    priceCents:
      (nights ?? nightsBetween(D(start), D(end))).length * BOOKED_NIGHT_CENTS,
    nights: (nights ?? nightsBetween(D(start), D(end))).map((night) => ({
      stayDate: D(night),
      priceCents: BOOKED_NIGHT_CENTS,
    })),
  };
}

const DEFAULT_GUESTS = [
  liveGuest("g1", "Ann", "2026-09-01", "2026-09-04"),
  liveGuest("g2", "Bob", "2026-09-01", "2026-09-04"),
  liveGuest("g3", "Cal", "2026-09-01", "2026-09-04"),
];

/**
 * The booking under test. `overrides` exists for the in-progress suite, which
 * needs a stay that NOW sits inside and a status the in-progress edit window
 * admits; everything else takes the future CONFIRMED default.
 */
function bookingWith(
  guests: ReturnType<typeof liveGuest>[],
  overrides: { status?: string; checkIn?: string; checkOut?: string } = {},
) {
  const totalPriceCents = guests.reduce((sum, g) => sum + g.priceCents, 0);
  return {
    id: "b1",
    status: overrides.status ?? "CONFIRMED",
    memberId: "m1",
    lodgeId: "lodge-1",
    checkIn: D(overrides.checkIn ?? "2026-09-01"),
    checkOut: D(overrides.checkOut ?? "2026-09-04"),
    wholeLodgeHold: false,
    requiresAdminReview: false,
    adminReviewStatus: null,
    memberReviewJustification: null,
    adminReviewNotes: null,
    adminReviewedById: null,
    adminReviewedAt: null,
    totalPriceCents,
    discountCents: 0,
    promoAdjustmentCents: 0,
    finalPriceCents: totalPriceCents,
    payment: null,
    promoRedemption: null,
    guests,
  };
}

/**
 * The one pricing function, applied to whichever party it is handed.
 *
 * Deliberately a pure function of the RESOLVED party: a guest's nights are their
 * explicit night set when they have one (#713) and their envelope otherwise, and
 * a night the guest already bought keeps its stored price (#1036). Two parties
 * that resolve identically therefore cost the same to the cent, and two that do
 * not cannot.
 */
type PricedGuest = {
  ageTier?: string;
  stayStart: Date;
  stayEnd: Date;
  nights?: ReadonlyArray<Date> | null;
  lockedNightPrices?: ReadonlyArray<{ stayDate: Date; priceCents: number }>;
};

function priceParty(guests: ReadonlyArray<PricedGuest>) {
  const perGuest = guests.map((guest) => {
    const nights =
      guest.nights && guest.nights.length > 0
        ? [...new Set(guest.nights.map(formatDateOnly))].sort()
        : nightsBetween(guest.stayStart, guest.stayEnd);
    const locked = new Map(
      (guest.lockedNightPrices ?? []).map((lock) => [
        formatDateOnly(lock.stayDate),
        lock.priceCents,
      ]),
    );
    const rate = guest.ageTier === "CHILD" ? CHILD_NIGHT_CENTS : NIGHT_CENTS;
    const perNightCents = nights.map((night) => locked.get(night) ?? rate);
    return {
      priceCents: perNightCents.reduce((sum, cents) => sum + cents, 0),
      perNightCents,
      nightDates: nights.map(D),
    };
  });
  return {
    totalPriceCents: perGuest.reduce((sum, g) => sum + g.priceCents, 0),
    guests: perGuest,
  };
}

/**
 * The comparable shape of a proposed party: who is on the booking, on exactly
 * which nights, at which identity. Every field the pricing, capacity, hosting
 * and policy passes read from a resolved guest.
 */
function partyShape(
  guests: ReadonlyArray<{
    bookingGuestId?: string | null;
    ageTier: string;
    isMember: boolean;
    memberId?: string | null;
    stayStart: Date;
    stayEnd: Date;
    nights?: ReadonlyArray<Date> | null;
  }>,
) {
  return guests.map((guest) => ({
    bookingGuestId: guest.bookingGuestId ?? null,
    ageTier: guest.ageTier,
    isMember: guest.isMember,
    memberId: guest.memberId ?? null,
    stayStart: formatDateOnly(guest.stayStart),
    stayEnd: formatDateOnly(guest.stayEnd),
    nights:
      guest.nights && guest.nights.length > 0
        ? [...new Set(guest.nights.map(formatDateOnly))].sort()
        : null,
  }));
}

/** The nights each guest occupies, by guest name — the officer-facing view. */
function nightsByName(
  guests: ReadonlyArray<{
    name: string;
    stayStart: Date;
    stayEnd: Date;
    nights?: ReadonlyArray<Date> | null;
  }>,
) {
  return Object.fromEntries(
    guests.map((guest) => [
      guest.name,
      guest.nights && guest.nights.length > 0
        ? [...new Set(guest.nights.map(formatDateOnly))].sort()
        : nightsBetween(guest.stayStart, guest.stayEnd),
    ]),
  );
}

// ---------------------------------------------------------------------------
// The three surfaces
// ---------------------------------------------------------------------------

type CapturedRouteRun = {
  status: number;
  body: Record<string, unknown>;
  envelope: [string, string] | null;
  party: ReturnType<typeof partyShape> | null;
  /**
   * The same party read off the rate-resolution pass instead of the pricing pass.
   * `party` is null on the in-progress branch (the main pricing pass is replaced
   * by `buildInProgressGuestRangePlan`); this one is populated on every branch.
   */
  ratedParty: ReturnType<typeof partyShape> | null;
  pricedParty: ReadonlyArray<PricedGuest> | null;
  capacityRange: [string, string] | null;
  minimumStayRange: [string, string] | null;
};

/** Drive the REAL preview route as the booking's own member. */
async function runRoute(
  delta: Record<string, unknown>,
  guests = DEFAULT_GUESTS,
  bookingOverrides: Parameters<typeof bookingWith>[1] = {},
): Promise<CapturedRouteRun> {
  h.bookingFindUnique.mockResolvedValue(bookingWith(guests, bookingOverrides));
  const res = await POST(req(delta), { params });
  const body = (await res.json()) as Record<string, unknown>;

  const priceCall = h.priceGuests.mock.calls.find((call) => {
    const arg = call[1] as { guests?: Array<{ bookingGuestId?: string | null }> };
    // The MAIN pricing pass is the one over the whole proposed party (it carries
    // `bookingGuestId`); the itemisation passes price sub-slices without it.
    return arg?.guests?.some((g) => g.bookingGuestId !== undefined) ?? false;
  });
  const capacityCall = h.checkCapacityForGuestRanges.mock.calls[0];
  const minStayCall = h.validateMinimumStay.mock.calls[0];
  // The route resolves rate membership types three times — the proposed party,
  // then the added guests, then the stored guests — so the FIRST call is the one
  // carrying `guestsForPricing`.
  const ratedCall = h.resolveGuestRates.mock.calls[0];

  return {
    status: res.status,
    body,
    envelope: priceCall
      ? [
          formatDateOnly((priceCall[1] as { checkIn: Date }).checkIn),
          formatDateOnly((priceCall[1] as { checkOut: Date }).checkOut),
        ]
      : null,
    party: priceCall
      ? partyShape((priceCall[1] as { guests: Parameters<typeof partyShape>[0] }).guests)
      : null,
    ratedParty: ratedCall
      ? partyShape((ratedCall[1] as { guests: Parameters<typeof partyShape>[0] }).guests)
      : null,
    pricedParty: priceCall
      ? (priceCall[1] as { guests: ReadonlyArray<PricedGuest> }).guests
      : null,
    capacityRange: capacityCall
      ? [
          formatDateOnly(capacityCall[1] as Date),
          formatDateOnly(capacityCall[2] as Date),
        ]
      : null,
    minimumStayRange: minStayCall
      ? [
          formatDateOnly(minStayCall[0] as Date),
          formatDateOnly(minStayCall[1] as Date),
        ]
      : null,
  };
}

/** Drive the REAL apply-path planner over the same delta, as the same member. */
async function runPlanner(
  delta: Record<string, unknown>,
  guests = DEFAULT_GUESTS,
  bookingOverrides: Parameters<typeof bookingWith>[1] = {},
) {
  const booking = bookingWith(guests, bookingOverrides) as never;
  const input = delta as never;
  const dates = resolveTargetDates({
    booking,
    role: "USER",
    input,
    // #3123 - the club's day is a required input now. Stated as the calendar
    // day this suite's pinned `NOW` falls on, so the future matrix stays
    // "future" and the in-progress fixture below (2026-08-08 -> 2026-08-12)
    // stays mid-stay, which is the branch it was added to exercise.
    today: CLUB_TODAY,
  });
  const plan = await prepareGuestPlan({} as never, {
    // #3123 - the SAME club day `resolveTargetDates` was handed above. The
    // planner's person-night guard reads it too, and two days in one plan would
    // be the straddle this issue exists to remove.
    today: CLUB_TODAY,
    booking,
    role: "USER",
    actorId: "m1",
    input,
    isInProgressEdit: dates.isInProgressEdit,
    editableFrom: dates.editableFrom,
    newCheckIn: dates.newCheckIn,
    newCheckOut: dates.newCheckOut,
    memberGuestPolicy: {
      wideningEnabled: false,
      approvalRequired: true,
      pendingHoldExpiryDays: 0,
    },
    // #2560: the mode the route resolves for this fixture (Xero module off).
    subscriptionLockoutMode: "NO_BLOCK",
  });
  return {
    envelope: [
      formatDateOnly(dates.newCheckIn),
      formatDateOnly(dates.newCheckOut),
    ] as [string, string],
    party: partyShape(plan.guestsForPricing),
    pricedParty: plan.guestsForPricing as unknown as ReadonlyArray<PricedGuest>,
    nightsByName: nightsByName([
      ...plan.proposedRemainingGuests.map((entry) => ({
        name: `${entry.guest.firstName} ${entry.guest.lastName}`,
        stayStart: entry.stayStart,
        stayEnd: entry.stayEnd,
        nights: entry.nights,
      })),
      // `normalizedAddGuests` carries the resolved range on a row whose declared
      // `stayStart`/`nights` are the intersection of the raw payload's strings and
      // the resolved dates (see the field-by-field assignment in
      // `prepareGuestPlan`), so the runtime Dates are narrowed here.
      ...(plan.normalizedAddGuests ?? []).map((guest) => ({
        name: `${guest.firstName} ${guest.lastName}`,
        stayStart: guest.stayStart as Date,
        stayEnd: guest.stayEnd as Date,
        nights: guest.nights as Date[] | undefined,
      })),
    ]),
  };
}

/** Freeze the same delta the way the officer's review card is built. */
function runFreeze(
  delta: Record<string, unknown>,
  guests = DEFAULT_GUESTS,
  bookingOverrides: Parameters<typeof bookingWith>[1] = {},
) {
  const { proposed } = buildModificationProposalParties({
    bookingCheckIn: D(bookingOverrides.checkIn ?? "2026-09-01"),
    bookingCheckOut: D(bookingOverrides.checkOut ?? "2026-09-04"),
    liveGuests: guests as never,
    delta: delta as never,
  });
  return {
    envelope: [proposed.checkIn, proposed.checkOut] as [string, string],
    nightsByName: Object.fromEntries(
      proposed.guests.map((guest) => [
        `${guest.firstName} ${guest.lastName}`,
        guest.nights,
      ]),
    ),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.clearAllMocks();
  h.auth.mockResolvedValue({ user: { id: "m1" } });
  h.requireActiveSessionUser.mockResolvedValue(null);
  h.authorizationRole.mockReturnValue("USER");
  h.bookingFindUnique.mockResolvedValue(bookingWith(DEFAULT_GUESTS));
  h.bookingFindMany.mockResolvedValue([]);
  h.seasonFindMany.mockResolvedValue([
    {
      id: "season-1",
      startDate: D("2026-06-01"),
      endDate: D("2026-12-31"),
      membershipTypeRates: [
        {
          membershipTypeId: "type-nonmember",
          ageTier: "ADULT",
          pricePerNightCents: NIGHT_CENTS,
        },
        {
          membershipTypeId: "type-nonmember",
          ageTier: "CHILD",
          pricePerNightCents: CHILD_NIGHT_CENTS,
        },
      ],
    },
  ]);
  h.groupDiscountFindUnique.mockResolvedValue(null);
  h.bookingRequestFindFirst.mockResolvedValue(null);
  h.getDefaultLodgeId.mockResolvedValue("lodge-1");
  h.getLodgeCapacity.mockResolvedValue(29);
  h.findConflicts.mockResolvedValue([]);
  h.assertNoConflicts.mockResolvedValue(undefined);
  h.checkCapacityForGuestRanges.mockResolvedValue({
    available: true,
    minAvailable: 10,
    nightDetails: [],
  });
  // Pass-through: whatever party the resolution produced reaches pricing and
  // capacity unchanged, only stamped with a rate identity.
  h.resolveGuestRates.mockImplementation(
    (_db: unknown, { guests }: { guests: Array<Record<string, unknown>> }) =>
      Promise.resolve(
        guests.map((g) => ({
          ...g,
          rateMembershipTypeId: "type-nonmember",
          rateSource: "NON_MEMBER_DEFAULT",
        })),
      ),
  );
  // The deterministic pricer: the same pure function both sides are compared with.
  h.priceGuests.mockImplementation(
    (_db: unknown, { guests }: { guests: ReadonlyArray<PricedGuest> }) =>
      Promise.resolve(priceParty(guests)),
  );
  h.calculateChangeFee.mockReturnValue({ feeCents: 0 });
  h.loadModuleFlags.mockResolvedValue({ xeroIntegration: false });
  h.isXeroConnected.mockResolvedValue(false);
  h.getXeroLockDates.mockResolvedValue({
    periodLockDate: null,
    endOfYearLockDate: null,
  });
  h.validateMinimumStay.mockResolvedValue({ valid: true, violations: [] });
  h.findUnpaidMemberGuestNames.mockResolvedValue([]);
  h.resolveLinkedBookingMembersWithBoundary.mockResolvedValue({
    members: new Map(),
    boundary: { scopeByMemberId: new Map(), beyondFamilyMemberIds: [] },
  });
  h.assertLinkedBookingMembersCanBeBooked.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// The matrix
// ---------------------------------------------------------------------------

const ADD_ADULT = {
  firstName: "Dee",
  lastName: "Newcomer",
  ageTier: "ADULT" as const,
  isMember: false,
};
/** A SECOND added guest, at a different age tier so mis-ordering moves money. */
const ADD_CHILD = {
  firstName: "Eve",
  lastName: "Latecomer",
  ageTier: "CHILD" as const,
  isMember: false,
};

/**
 * Every delta shape the owner's decision named, driven end to end through all
 * three surfaces. The name is the case; the delta is the whole input.
 */
const MATRIX: Array<[string, Record<string, unknown>]> = [
  ["changing only the overall booking dates (extend)", { checkOut: "2026-09-06" }],
  ["changing only the overall booking dates (shorten)", { checkOut: "2026-09-03" }],
  [
    "moving the whole booking (both bounds)",
    { checkIn: "2026-09-08", checkOut: "2026-09-11" },
  ],
  [
    "changing only individual guest ranges",
    {
      guestStayRanges: [
        { guestId: "g1", stayStart: "2026-09-01", stayEnd: "2026-09-03" },
      ],
    },
  ],
  [
    "full ranges for ALL guests",
    {
      guestStayRanges: [
        { guestId: "g1", stayStart: "2026-09-01", stayEnd: "2026-09-04" },
        { guestId: "g2", stayStart: "2026-09-02", stayEnd: "2026-09-04" },
        { guestId: "g3", stayStart: "2026-09-01", stayEnd: "2026-09-03" },
      ],
    },
  ],
  [
    "ranges for only SOME guests (unchanged guests mixed with changed ones)",
    {
      guestStayRanges: [
        { guestId: "g2", stayStart: "2026-09-02", stayEnd: "2026-09-03" },
      ],
    },
  ],
  [
    "overall dates AND a partial guestStayRanges — the #2526 divergence",
    {
      checkOut: "2026-09-05",
      guestStayRanges: [
        { guestId: "g1", stayStart: "2026-09-01", stayEnd: "2026-09-05" },
      ],
    },
  ],
  [
    "guests arriving and departing on different nights",
    {
      guestStayRanges: [
        { guestId: "g1", stayStart: "2026-09-01", stayEnd: "2026-09-02" },
        { guestId: "g2", stayStart: "2026-09-02", stayEnd: "2026-09-03" },
        { guestId: "g3", stayStart: "2026-09-03", stayEnd: "2026-09-04" },
      ],
    },
  ],
  [
    "an explicit non-contiguous night set (#713)",
    {
      guestStayRanges: [
        { guestId: "g1", nights: ["2026-09-01", "2026-09-03"] },
      ],
    },
  ],
  ["adding a guest with no range of their own", { addGuests: [ADD_ADULT] }],
  [
    "adding a guest WITH a range of their own",
    {
      addGuests: [
        { ...ADD_ADULT, stayStart: "2026-09-02", stayEnd: "2026-09-04" },
      ],
    },
  ],
  [
    "adding a guest whose range reaches PAST the booking envelope",
    {
      addGuests: [
        { ...ADD_ADULT, stayStart: "2026-09-01", stayEnd: "2026-09-07" },
      ],
    },
  ],
  [
    // The route joins its added-guest rows to the resolver's `added` array BY
    // INDEX. With one added guest that index is always 0, so a collapsed or
    // reversed join is invisible. Two added guests on DIFFERENT ranges at
    // DIFFERENT age tiers make it visible three ways at once: the party shape,
    // the officer's night list, and the cents.
    "adding TWO guests with different ranges — the positional join",
    {
      checkOut: "2026-09-06",
      addGuests: [
        { ...ADD_ADULT, stayStart: "2026-09-01", stayEnd: "2026-09-02" },
        { ...ADD_CHILD, stayStart: "2026-09-02", stayEnd: "2026-09-06" },
      ],
    },
  ],
  [
    // The #713 explicit night set, on an ADDED guest this time: the deliberate
    // gap must survive into the priced party, not collapse to the contiguous
    // envelope (which on this delta would charge five nights instead of two).
    "adding a guest with an explicit non-contiguous night set (#713)",
    {
      checkOut: "2026-09-06",
      addGuests: [{ ...ADD_ADULT, nights: ["2026-09-01", "2026-09-05"] }],
    },
  ],
  ["removing a guest", { removeGuestIds: ["g3"] }],
  [
    "removing a guest while another guest's range changes",
    {
      checkOut: "2026-09-05",
      removeGuestIds: ["g3"],
      guestStayRanges: [
        { guestId: "g1", stayStart: "2026-09-02", stayEnd: "2026-09-05" },
      ],
    },
  ],
  [
    "a guest range OUTSIDE the requested envelope widens it (#713 auto-expand)",
    {
      guestStayRanges: [
        { guestId: "g1", stayStart: "2026-09-01", stayEnd: "2026-09-09" },
      ],
    },
  ],
  [
    // SHORTENING in range-input mode. The member asks to drop the last night,
    // but two guests still hold stored ranges that span it, so the #713
    // auto-expand pins the envelope back open and they are quoted the original
    // four nights. Old and new route agree on this; nothing pinned it before.
    "shortening the booking while stored ranges pin the envelope open",
    {
      checkOut: "2026-09-03",
      guestStayRanges: [
        { guestId: "g2", stayStart: "2026-09-02", stayEnd: "2026-09-03" },
      ],
    },
  ],
  [
    "a range on a REMOVED guest switches the mode but never widens the envelope",
    {
      removeGuestIds: ["g3"],
      guestStayRanges: [
        { guestId: "g3", stayStart: "2026-08-25", stayEnd: "2026-09-20" },
      ],
    },
  ],
  [
    "duplicate/conflicting range entries for one guest",
    {
      guestStayRanges: [
        { guestId: "g1", stayStart: "2026-09-01", stayEnd: "2026-09-02" },
        { guestId: "g1", stayStart: "2026-09-02", stayEnd: "2026-09-04" },
      ],
    },
  ],
  [
    "a range entry carrying NO dates at all is not a range input",
    { checkOut: "2026-09-05", guestStayRanges: [{ guestId: "g1" }] },
  ],
  [
    "an unknown guestId in guestStayRanges is ignored by both",
    {
      guestStayRanges: [
        { guestId: "not-on-this-booking", stayStart: "2026-09-01", stayEnd: "2026-09-02" },
      ],
    },
  ],
  [
    "everything at once: dates, a partial range, an add and a remove",
    {
      checkOut: "2026-09-06",
      removeGuestIds: ["g3"],
      guestStayRanges: [
        { guestId: "g2", nights: ["2026-09-01", "2026-09-05"] },
      ],
      addGuests: [
        { ...ADD_ADULT, stayStart: "2026-09-02", stayEnd: "2026-09-06" },
      ],
    },
  ],
];

/**
 * THE GOLDEN ANSWER for every matrix case: the resolved envelope, every guest's
 * occupied nights by name, and the quoted total in cents.
 *
 * Why this exists alongside the three-way equality checks. All three compared
 * surfaces now call the ONE resolver, so an equality check between them is a
 * RELATIVE gate: it pins the route's plumbing (which envelope goes into which
 * pass, guest order, index numbering) but is blind by construction to a change in
 * the RULE, because both sides move together. Reversing the added-guest
 * resolution order inside the resolver, or restoring the pre-#2526 per-guest
 * reset, leaves every equality green.
 *
 * These values are absolute and were checked by hand against the fixture
 * (3 guests booked 2026-09-01..2026-09-04, three nights each locked at
 * `BOOKED_NIGHT_CENTS`, new adult nights at `NIGHT_CENTS`, new child nights at
 * `CHILD_NIGHT_CENTS`), not merely captured from a passing run. Changing one is a
 * deliberate statement that the club's answer to that delta has changed, and it
 * needs the same hand check — never a copy of whatever the new code printed.
 */
type Golden = {
  envelope: [string, string];
  nights: Record<string, string[]>;
  cents: number;
};

const GOLDEN: Record<string, Golden> = {
  "changing only the overall booking dates (extend)": {
    envelope: ["2026-09-01", "2026-09-06"],
    nights: {
      "Ann Guest": ["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04", "2026-09-05"],
      "Bob Guest": ["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04", "2026-09-05"],
      "Cal Guest": ["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04", "2026-09-05"],
    },
    cents: 67_800,
  },
  "changing only the overall booking dates (shorten)": {
    envelope: ["2026-09-01", "2026-09-03"],
    nights: {
      "Ann Guest": ["2026-09-01", "2026-09-02"],
      "Bob Guest": ["2026-09-01", "2026-09-02"],
      "Cal Guest": ["2026-09-01", "2026-09-02"],
    },
    cents: 25_200,
  },
  "moving the whole booking (both bounds)": {
    envelope: ["2026-09-08", "2026-09-11"],
    nights: {
      "Ann Guest": ["2026-09-08", "2026-09-09", "2026-09-10"],
      "Bob Guest": ["2026-09-08", "2026-09-09", "2026-09-10"],
      "Cal Guest": ["2026-09-08", "2026-09-09", "2026-09-10"],
    },
    cents: 45_000,
  },
  "changing only individual guest ranges": {
    envelope: ["2026-09-01", "2026-09-04"],
    nights: {
      "Ann Guest": ["2026-09-01", "2026-09-02"],
      "Bob Guest": ["2026-09-01", "2026-09-02", "2026-09-03"],
      "Cal Guest": ["2026-09-01", "2026-09-02", "2026-09-03"],
    },
    cents: 33_600,
  },
  "full ranges for ALL guests": {
    envelope: ["2026-09-01", "2026-09-04"],
    nights: {
      "Ann Guest": ["2026-09-01", "2026-09-02", "2026-09-03"],
      "Bob Guest": ["2026-09-02", "2026-09-03"],
      "Cal Guest": ["2026-09-01", "2026-09-02"],
    },
    cents: 29_400,
  },
  "ranges for only SOME guests (unchanged guests mixed with changed ones)": {
    envelope: ["2026-09-01", "2026-09-04"],
    nights: {
      "Ann Guest": ["2026-09-01", "2026-09-02", "2026-09-03"],
      "Bob Guest": ["2026-09-02"],
      "Cal Guest": ["2026-09-01", "2026-09-02", "2026-09-03"],
    },
    cents: 29_400,
  },
  "overall dates AND a partial guestStayRanges — the #2526 divergence": {
    envelope: ["2026-09-01", "2026-09-05"],
    nights: {
      "Ann Guest": ["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04"],
      "Bob Guest": ["2026-09-01", "2026-09-02", "2026-09-03"],
      "Cal Guest": ["2026-09-01", "2026-09-02", "2026-09-03"],
    },
    cents: 42_800,
  },
  "guests arriving and departing on different nights": {
    envelope: ["2026-09-01", "2026-09-04"],
    nights: {
      "Ann Guest": ["2026-09-01"],
      "Bob Guest": ["2026-09-02"],
      "Cal Guest": ["2026-09-03"],
    },
    cents: 12_600,
  },
  "an explicit non-contiguous night set (#713)": {
    envelope: ["2026-09-01", "2026-09-04"],
    nights: {
      "Ann Guest": ["2026-09-01", "2026-09-03"],
      "Bob Guest": ["2026-09-01", "2026-09-02", "2026-09-03"],
      "Cal Guest": ["2026-09-01", "2026-09-02", "2026-09-03"],
    },
    cents: 33_600,
  },
  "adding a guest with no range of their own": {
    envelope: ["2026-09-01", "2026-09-04"],
    nights: {
      "Ann Guest": ["2026-09-01", "2026-09-02", "2026-09-03"],
      "Bob Guest": ["2026-09-01", "2026-09-02", "2026-09-03"],
      "Cal Guest": ["2026-09-01", "2026-09-02", "2026-09-03"],
      "Dee Newcomer": ["2026-09-01", "2026-09-02", "2026-09-03"],
    },
    cents: 52_800,
  },
  "adding a guest WITH a range of their own": {
    envelope: ["2026-09-01", "2026-09-04"],
    nights: {
      "Ann Guest": ["2026-09-01", "2026-09-02", "2026-09-03"],
      "Bob Guest": ["2026-09-01", "2026-09-02", "2026-09-03"],
      "Cal Guest": ["2026-09-01", "2026-09-02", "2026-09-03"],
      "Dee Newcomer": ["2026-09-02", "2026-09-03"],
    },
    cents: 47_800,
  },
  "adding a guest whose range reaches PAST the booking envelope": {
    envelope: ["2026-09-01", "2026-09-07"],
    nights: {
      "Ann Guest": ["2026-09-01", "2026-09-02", "2026-09-03"],
      "Bob Guest": ["2026-09-01", "2026-09-02", "2026-09-03"],
      "Cal Guest": ["2026-09-01", "2026-09-02", "2026-09-03"],
      "Dee Newcomer": ["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04", "2026-09-05", "2026-09-06"],
    },
    cents: 67_800,
  },
  "adding TWO guests with different ranges — the positional join": {
    envelope: ["2026-09-01", "2026-09-06"],
    nights: {
      "Ann Guest": ["2026-09-01", "2026-09-02", "2026-09-03"],
      "Bob Guest": ["2026-09-01", "2026-09-02", "2026-09-03"],
      "Cal Guest": ["2026-09-01", "2026-09-02", "2026-09-03"],
      "Dee Newcomer": ["2026-09-01"],
      "Eve Latecomer": ["2026-09-02", "2026-09-03", "2026-09-04", "2026-09-05"],
    },
    cents: 54_800,
  },
  "adding a guest with an explicit non-contiguous night set (#713)": {
    envelope: ["2026-09-01", "2026-09-06"],
    nights: {
      "Ann Guest": ["2026-09-01", "2026-09-02", "2026-09-03"],
      "Bob Guest": ["2026-09-01", "2026-09-02", "2026-09-03"],
      "Cal Guest": ["2026-09-01", "2026-09-02", "2026-09-03"],
      "Dee Newcomer": ["2026-09-01", "2026-09-05"],
    },
    cents: 47_800,
  },
  "removing a guest": {
    envelope: ["2026-09-01", "2026-09-04"],
    nights: {
      "Ann Guest": ["2026-09-01", "2026-09-02", "2026-09-03"],
      "Bob Guest": ["2026-09-01", "2026-09-02", "2026-09-03"],
    },
    cents: 25_200,
  },
  "removing a guest while another guest's range changes": {
    envelope: ["2026-09-01", "2026-09-05"],
    nights: {
      "Ann Guest": ["2026-09-02", "2026-09-03", "2026-09-04"],
      "Bob Guest": ["2026-09-01", "2026-09-02", "2026-09-03"],
    },
    cents: 26_000,
  },
  "a guest range OUTSIDE the requested envelope widens it (#713 auto-expand)": {
    envelope: ["2026-09-01", "2026-09-09"],
    nights: {
      "Ann Guest": ["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04", "2026-09-05", "2026-09-06", "2026-09-07", "2026-09-08"],
      "Bob Guest": ["2026-09-01", "2026-09-02", "2026-09-03"],
      "Cal Guest": ["2026-09-01", "2026-09-02", "2026-09-03"],
    },
    cents: 62_800,
  },
  "shortening the booking while stored ranges pin the envelope open": {
    envelope: ["2026-09-01", "2026-09-04"],
    nights: {
      "Ann Guest": ["2026-09-01", "2026-09-02", "2026-09-03"],
      "Bob Guest": ["2026-09-02"],
      "Cal Guest": ["2026-09-01", "2026-09-02", "2026-09-03"],
    },
    cents: 29_400,
  },
  "a range on a REMOVED guest switches the mode but never widens the envelope": {
    envelope: ["2026-09-01", "2026-09-04"],
    nights: {
      "Ann Guest": ["2026-09-01", "2026-09-02", "2026-09-03"],
      "Bob Guest": ["2026-09-01", "2026-09-02", "2026-09-03"],
    },
    cents: 25_200,
  },
  "duplicate/conflicting range entries for one guest": {
    envelope: ["2026-09-01", "2026-09-04"],
    nights: {
      "Ann Guest": ["2026-09-02", "2026-09-03"],
      "Bob Guest": ["2026-09-01", "2026-09-02", "2026-09-03"],
      "Cal Guest": ["2026-09-01", "2026-09-02", "2026-09-03"],
    },
    cents: 33_600,
  },
  "a range entry carrying NO dates at all is not a range input": {
    envelope: ["2026-09-01", "2026-09-05"],
    nights: {
      "Ann Guest": ["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04"],
      "Bob Guest": ["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04"],
      "Cal Guest": ["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04"],
    },
    cents: 52_800,
  },
  "an unknown guestId in guestStayRanges is ignored by both": {
    envelope: ["2026-09-01", "2026-09-04"],
    nights: {
      "Ann Guest": ["2026-09-01", "2026-09-02", "2026-09-03"],
      "Bob Guest": ["2026-09-01", "2026-09-02", "2026-09-03"],
      "Cal Guest": ["2026-09-01", "2026-09-02", "2026-09-03"],
    },
    cents: 37_800,
  },
  "everything at once: dates, a partial range, an add and a remove": {
    envelope: ["2026-09-01", "2026-09-06"],
    nights: {
      "Ann Guest": ["2026-09-01", "2026-09-02", "2026-09-03"],
      "Bob Guest": ["2026-09-01", "2026-09-05"],
      "Dee Newcomer": ["2026-09-02", "2026-09-03", "2026-09-04", "2026-09-05"],
    },
    cents: 41_800,
  },
};

describe("#2563 the preview, the save and the freeze resolve one party", () => {
  for (const [name, delta] of MATRIX) {
    it(`agrees on envelope, guest nights and cents: ${name}`, async () => {
      const planner = await runPlanner(delta);
      const freeze = runFreeze(delta);
      const route = await runRoute(delta);

      expect(route.status).toBe(200);

      // 1. The same overall booking date range.
      expect(route.envelope).toEqual(planner.envelope);
      expect(freeze.envelope).toEqual(planner.envelope);

      // 2. The same party: every guest's arrival, departure, occupied nights and
      //    identity, in the same order.
      expect(route.party).toEqual(planner.party);
      // 3. ...and the same nights the officer's card shows (order-insensitive:
      //    the frozen party is canonicalised for hashing).
      expect(freeze.nightsByName).toEqual(planner.nightsByName);

      // 4. Identical guest-night allocations feed capacity, over the same range.
      expect(route.capacityRange).toEqual(planner.envelope);

      // 5. Identical pricing to the cent — the same pure pricer over each party.
      expect(priceParty(route.pricedParty!).totalPriceCents).toBe(
        priceParty(planner.pricedParty).totalPriceCents,
      );
      expect(route.body.newTotalPriceCents).toBe(
        priceParty(planner.pricedParty).totalPriceCents,
      );

      // 6. The adult-supervision (child-safety) rule judges the same party. The
      //    preview does not run the rule — the save does — so what has to match
      //    is its INPUT, checked by evaluating the pure predicate on both.
      expect(requiresAdultSupervisionReview(route.party!)).toBe(
        requiresAdultSupervisionReview(planner.party),
      );

      // 7. Minimum stay is judged over the resolved envelope, or not at all when
      //    the envelope did not move (#2363 — the apply path exempts it too).
      const envelopeMoved =
        planner.envelope[0] !== "2026-09-01" || planner.envelope[1] !== "2026-09-04";
      if (envelopeMoved) {
        expect(route.minimumStayRange).toEqual(planner.envelope);
      } else {
        expect(route.minimumStayRange).toBeNull();
      }

      // 8. And all of it against the ABSOLUTE expected answer, so that a change
      //    inside the shared resolver — which would move all three surfaces
      //    together and keep every equality above green — reddens here instead.
      const golden = GOLDEN[name];
      expect(planner.envelope).toEqual(golden.envelope);
      expect(planner.nightsByName).toEqual(golden.nights);
      expect(route.body.newTotalPriceCents).toBe(golden.cents);
    });
  }

  it("every matrix case has a golden, and no golden is orphaned", () => {
    // Belt and braces for the lookup above: a new matrix row without a golden
    // would otherwise throw on `golden.envelope` with an unhelpful message, and a
    // golden left behind by a deleted row would sit there asserting nothing.
    expect(Object.keys(GOLDEN).sort()).toEqual(MATRIX.map(([name]) => name).sort());
  });

  it("the comparison has teeth: the pre-#2526 per-guest rule prices differently", async () => {
    // The control. If the route ever drifted back to "no range entry + the dates
    // moved => reset this guest to the new envelope", the mixed case above would
    // resolve 3 + 4 + 4 guest-nights instead of 4 + 3 + 3, at a different price.
    // This asserts the two answers really are different, so the equalities above
    // are not two implementations agreeing on nothing.
    const delta = {
      checkOut: "2026-09-05",
      guestStayRanges: [
        { guestId: "g1", stayStart: "2026-09-01", stayEnd: "2026-09-05" },
      ],
    };
    const planner = await runPlanner(delta);

    // What the canonical (global-flag) rule produces: only Ann moved.
    expect(planner.nightsByName).toEqual({
      "Ann Guest": ["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04"],
      "Bob Guest": ["2026-09-01", "2026-09-02", "2026-09-03"],
      "Cal Guest": ["2026-09-01", "2026-09-02", "2026-09-03"],
    });

    // What the abandoned per-guest rule would have produced: everybody reset.
    const naiveParty = DEFAULT_GUESTS.map((guest) =>
      guest.id === "g1"
        ? {
            stayStart: D("2026-09-01"),
            stayEnd: D("2026-09-05"),
            lockedNightPrices: guest.nights,
          }
        : {
            stayStart: D("2026-09-01"),
            stayEnd: D("2026-09-05"),
            lockedNightPrices: guest.nights,
          },
    );
    expect(priceParty(naiveParty).totalPriceCents).not.toBe(
      priceParty(planner.pricedParty).totalPriceCents,
    );
  });
});

describe("#2563 a refused delta is refused identically, with the same guest number", () => {
  const REFUSALS: Array<[string, Record<string, unknown>, string]> = [
    [
      "a half-supplied range on the FIRST remaining guest",
      { guestStayRanges: [{ guestId: "g1", stayStart: "2026-09-02" }] },
      "Guest 1: Date In and Date Out are both required.",
    ],
    [
      "a half-supplied range on the SECOND remaining guest — member-facing numbering",
      { guestStayRanges: [{ guestId: "g2", stayEnd: "2026-09-03" }] },
      "Guest 2: Date In and Date Out are both required.",
    ],
    [
      "a half-supplied range on the THIRD remaining guest",
      { guestStayRanges: [{ guestId: "g3", stayStart: "2026-09-02" }] },
      "Guest 3: Date In and Date Out are both required.",
    ],
    [
      "an inverted range",
      {
        guestStayRanges: [
          { guestId: "g2", stayStart: "2026-09-03", stayEnd: "2026-09-02" },
        ],
      },
      "Guest 2: Date Out must be after Date In.",
    ],
    [
      "a zero-width range",
      {
        guestStayRanges: [
          { guestId: "g1", stayStart: "2026-09-02", stayEnd: "2026-09-02" },
        ],
      },
      "Guest 1: Date Out must be after Date In.",
    ],
    [
      "a malformed date",
      {
        guestStayRanges: [
          { guestId: "g1", stayStart: "01/09/2026", stayEnd: "2026-09-03" },
        ],
      },
      "Guest 1 Date In must use yyyy-mm-dd format.",
    ],
    [
      "a malformed night in an explicit night set",
      { guestStayRanges: [{ guestId: "g3", nights: ["not-a-date"] }] },
      "Guest 3 night 1 must use yyyy-mm-dd format.",
    ],
    [
      "an ADDED guest's own bad range — numbered AFTER the remaining guests",
      {
        addGuests: [{ ...ADD_ADULT, stayStart: "2026-09-02" }],
      },
      "Guest 4: Date In and Date Out are both required.",
    ],
    [
      "an added guest's bad range with a guest removed — the number follows who is left",
      {
        removeGuestIds: ["g2"],
        addGuests: [{ ...ADD_ADULT, stayEnd: "2026-09-02" }],
      },
      "Guest 3: Date In and Date Out are both required.",
    ],
    [
      // The SECOND added guest, i.e. index 4 of the one continuing sequence. The
      // number has to keep counting past the first added guest, which is only
      // observable with more than one add.
      "a bad range on the SECOND added guest — the number keeps counting",
      {
        addGuests: [
          { ...ADD_ADULT, stayStart: "2026-09-01", stayEnd: "2026-09-02" },
          { ...ADD_CHILD, stayEnd: "2026-09-03" },
        ],
      },
      "Guest 5: Date In and Date Out are both required.",
    ],
  ];

  for (const [name, delta, message] of REFUSALS) {
    it(`refuses with the same 400 and the same wording: ${name}`, async () => {
      const route = await runRoute(delta);
      expect(route.status).toBe(400);
      expect(route.body.error).toBe(message);

      // The apply path refuses the same delta with the same words, as an
      // `ApiError` 400 — the structured code stays on the error, the presentation
      // (a JSON body) is applied at the route boundary.
      await expect(runPlanner(delta)).rejects.toMatchObject({
        message,
        status: 400,
      });

      // And the freeze refuses it too, rather than freezing a proposal the
      // canonical service could never execute.
      expect(() => runFreeze(delta)).toThrow(message);
    });
  }

  it("prices nothing and checks no capacity once a range is refused", async () => {
    const route = await runRoute({
      guestStayRanges: [{ guestId: "g1", stayStart: "2026-09-02" }],
    });
    expect(route.status).toBe(400);
    expect(h.priceGuests).not.toHaveBeenCalled();
    expect(h.checkCapacityForGuestRanges).not.toHaveBeenCalled();
  });
});

/*
  THE IN-PROGRESS BRANCH — the one shape where the two resolver calls are handed
  DIFFERENT `requested` envelopes.

  Everywhere else, call 2's `requested` is simply call 1's answer, so the second
  call is trivially idempotent. On an in-progress edit the route clamps check-in
  back to the stored day between the two calls
  (`newCheckIn = isInProgressEdit ? booking.checkIn : finalRequestedCheckIn`), and
  the docblock in the route says in so many words that safety then rests on the
  in-progress check-in guard having already refused any delta whose RESOLVED
  check-in moved. That argument was prose only: the whole matrix above runs on a
  future booking, so `editPolicy.mode` was never "in-progress" anywhere in this
  file, and no suite in the repo compared the preview against the planner for a
  mid-stay edit.

  The cents cannot be compared here — an in-progress preview prices through
  `buildInProgressGuestRangePlan`, which charges only nights from `editableFrom`
  and is a structurally different surface from the planner's whole-stay pricing —
  so this suite compares the RESOLVED PARTY, which is what both sides share.
*/
const IN_PROGRESS_BOOKING = {
  status: "PAID",
  checkIn: "2026-08-08",
  checkOut: "2026-08-12",
} as const;

const IN_PROGRESS_GUESTS = [
  liveGuest("g1", "Ann", "2026-08-08", "2026-08-12"),
  liveGuest("g2", "Bob", "2026-08-08", "2026-08-12"),
  liveGuest("g3", "Cal", "2026-08-08", "2026-08-12"),
];

describe("#2563 an in-progress edit resolves one party too", () => {
  // NZ today is 2026-08-10 (NOW), so this stay is under way: check-in is behind
  // us, check-out ahead, and the status admits the in-progress edit window.
  const delta = {
    checkOut: "2026-08-14",
    guestStayRanges: [
      { guestId: "g2", stayStart: "2026-08-08", stayEnd: "2026-08-14" },
    ],
    // The range-LESS added guest is the only term in the envelope min/max that
    // depends on `requested`, so it is the one that moves if the clamp between
    // the two calls is ever wrong.
    addGuests: [ADD_ADULT],
  };

  it("resolves the same envelope and the same per-guest nights as the planner", async () => {
    const planner = await runPlanner(delta, IN_PROGRESS_GUESTS, IN_PROGRESS_BOOKING);
    const freeze = runFreeze(delta, IN_PROGRESS_GUESTS, IN_PROGRESS_BOOKING);
    const route = await runRoute(delta, IN_PROGRESS_GUESTS, IN_PROGRESS_BOOKING);

    expect(route.status).toBe(200);
    // The route really is on the in-progress branch: its main pricing pass never
    // runs (the in-progress plan replaces it), which is why the party is read off
    // the rate-resolution pass instead.
    expect(route.party).toBeNull();
    expect(route.ratedParty).not.toBeNull();

    // The envelope, via the minimum-stay pass — the one place the route hands the
    // resolved envelope to a collaborator on this branch.
    expect(route.minimumStayRange).toEqual(planner.envelope);
    expect(planner.envelope).toEqual(["2026-08-08", "2026-08-14"]);

    // The party: same guests, same arrival and departure, same nights, same order.
    expect(route.ratedParty).toEqual(planner.party);
    expect(freeze.nightsByName).toEqual(planner.nightsByName);

    // Golden. The clamp pinned check-in to the stored 8 Aug, so the added guest
    // with no range of their own lands on 8-14 Aug and not on some wider span
    // reaching before the stay. (The in-progress plan then charges only the
    // nights from `editableFrom` onwards — that is its job, not the resolver's.)
    expect(planner.nightsByName).toEqual({
      "Ann Guest": ["2026-08-08", "2026-08-09", "2026-08-10", "2026-08-11"],
      "Bob Guest": [
        "2026-08-08",
        "2026-08-09",
        "2026-08-10",
        "2026-08-11",
        "2026-08-12",
        "2026-08-13",
      ],
      "Cal Guest": ["2026-08-08", "2026-08-09", "2026-08-10", "2026-08-11"],
      "Dee Newcomer": [
        "2026-08-08",
        "2026-08-09",
        "2026-08-10",
        "2026-08-11",
        "2026-08-12",
        "2026-08-13",
      ],
    });
  });

  it("refuses a moved check-in with the same words the save uses", async () => {
    // The guard the envelope argument leans on. A guest range that drags the
    // RESOLVED check-in off the stored day is refused before pass 2 runs, which
    // is what keeps the clamp a no-op.
    const moved = {
      guestStayRanges: [
        { guestId: "g1", stayStart: "2026-08-06", stayEnd: "2026-08-12" },
      ],
    };
    const route = await runRoute(moved, IN_PROGRESS_GUESTS, IN_PROGRESS_BOOKING);
    expect(route.status).toBe(400);
    expect(route.body.error).toBe(
      "Check-in cannot be changed for an in-progress booking",
    );
    await expect(
      runPlanner(moved, IN_PROGRESS_GUESTS, IN_PROGRESS_BOOKING),
    ).rejects.toMatchObject({
      message: "Check-in cannot be changed for an in-progress booking",
      status: 400,
    });
  });
});

/*
  The behavioural matrix above passes against the PRE-#2563 route as well — which
  is exactly the point (the substitution is behaviour-preserving to the cent), and
  exactly why it cannot be the whole gate. "Exactly ONE implementation of the
  modification stay-range resolution remains in the repository" is a claim about a
  set of files, not about an output, so it is read off the source. The owner's
  decision refused the alternative outright: two implementations kept in step by
  parity tests is the arrangement that shipped the #2526 bug.
*/
const ROUTE_FILE = "src/app/api/bookings/[id]/modify-quote/route.ts";
const RESOLVER_FILE = "src/lib/booking-modification-stay-ranges.ts";

function readRepoFile(relativePath: string): string {
  return readFileSync(path.resolve(process.cwd(), relativePath), "utf8");
}

/** Every non-test source file under `src/` that names `identifier`. */
function sourceFilesNaming(identifier: string): string[] {
  const root = path.resolve(process.cwd(), "src");
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "__tests__") continue;
        walk(full);
        continue;
      }
      if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) continue;
      if (readFileSync(full, "utf8").includes(identifier)) {
        found.push(path.relative(process.cwd(), full).split(path.sep).join("/"));
      }
    }
  };
  walk(root);
  return found.sort();
}

describe("#2563 exactly one stay-range resolution exists, and the route calls it", () => {
  it("the quote route declares none of the private helpers it used to own", () => {
    const source = readRepoFile(ROUTE_FILE);
    // The four helpers named in the issue, as DECLARATIONS. Matching the bare
    // name would hit the docblock that explains why they are gone.
    for (const helper of [
      "hasStayRangeValue",
      "hasStayRangeInput",
      "minDate",
      "maxDate",
    ]) {
      expect(source, helper).not.toContain(`function ${helper}(`);
    }
    // ...and no local re-derivation of the envelope or of a guest's range. (The
    // `proposedRanges` NAME survives elsewhere on this route as the partner-shared
    // capacity argument — what must not survive is the loop that BUILT one.)
    expect(source).not.toContain("normalizeGuestStayRanges");
    expect(source).not.toContain("normalizeGuestStayRange(");
    expect(source).not.toContain("const proposedRanges");
  });

  it("the quote route resolves ranges by calling the shared resolver, twice", () => {
    const source = readRepoFile(ROUTE_FILE);
    expect(source).toContain(
      `from "@/lib/booking-modification-stay-ranges"`,
    );
    // The two passes the apply path makes: the envelope pass (mirroring
    // `resolveTargetDates`) and the per-guest pass (mirroring `prepareGuestPlan`).
    expect(source.match(/resolveStayRangesForPreview\(\{/g)).toHaveLength(2);
    // Reached through the route's single error-mapping adapter, nowhere else.
    expect(source.match(/resolveModificationStayRanges\(/g)).toHaveLength(1);
  });

  it("the resolver's rules live in one file, with only known callers", () => {
    // If a new surface starts resolving modification stay ranges, this list is
    // where it has to be declared — the point being that it is a decision, not a
    // copy that drifts.
    //
    // Matched on the CALL form, like `deltaHasStayRangeInputs(` below. Matching
    // the bare identifier instead made this assertion pass against the PRE-#2563
    // route, whose docblock NAMED the resolver in prose while the route went on
    // using its own local copy — and it would redden just as wrongly for a new
    // file that only points at the resolver in a comment. The defining module is
    // deliberately absent: its declaration reads
    // `resolveModificationStayRanges<Guest ...`, so only callers match.
    expect(sourceFilesNaming("resolveModificationStayRanges(")).toEqual([
      ROUTE_FILE,
      "src/lib/booking-exception-request-service.ts",
      "src/lib/booking-modify-validation.ts",
    ]);
    // ...and it is DECLARED exactly once, in the module that owns the rule.
    expect(sourceFilesNaming("export function resolveModificationStayRanges")).toEqual([
      RESOLVER_FILE,
    ]);
    // The GLOBAL range-input predicate is CALLED only by the resolution it
    // switches (other files name it in prose, which is the pointer working).
    expect(sourceFilesNaming("deltaHasStayRangeInputs(")).toEqual([RESOLVER_FILE]);
    // The modification envelope's own expansion — the union of the stored and
    // requested bounds — is built in exactly one place. (`minDate`/`maxDate` are
    // generic date helpers several unrelated modules declare for themselves; what
    // must not exist twice is THIS envelope.)
    expect(sourceFilesNaming("const unionEnvelope")).toEqual([RESOLVER_FILE]);
  });

  it("the route boundary maps the resolver's error without restating the rule", () => {
    const source = readRepoFile(ROUTE_FILE);
    // The adapter catches exactly the resolver's structured error type and turns
    // it into this route's presentation (a 400 JSON body), carrying the resolver's
    // own message so preview and save refuse in the same words.
    expect(source).toContain("error instanceof BookingGuestStayRangeValidationError");
    expect(source).toContain("{ error: error.message }");
  });
});

describe("#2563 the preview stays a preview", () => {
  it("writes nothing for any delta in the matrix", async () => {
    for (const [, delta] of MATRIX) {
      const route = await runRoute(delta);
      expect(route.status).toBe(200);
    }
    // Not one write, and not one transaction, across the whole matrix.
    expect(h.bookingUpdate).not.toHaveBeenCalled();
    expect(h.bookingGuestCreate).not.toHaveBeenCalled();
    expect(h.bookingGuestUpdate).not.toHaveBeenCalled();
    expect(h.bookingGuestDeleteMany).not.toHaveBeenCalled();
    expect(h.transaction).not.toHaveBeenCalled();
  });

  it("writes nothing for a refused delta either", async () => {
    const route = await runRoute({
      guestStayRanges: [
        { guestId: "g1", stayStart: "2026-09-05", stayEnd: "2026-09-02" },
      ],
    });
    expect(route.status).toBe(400);
    expect(h.bookingUpdate).not.toHaveBeenCalled();
    expect(h.bookingGuestUpdate).not.toHaveBeenCalled();
    expect(h.transaction).not.toHaveBeenCalled();
  });
});
