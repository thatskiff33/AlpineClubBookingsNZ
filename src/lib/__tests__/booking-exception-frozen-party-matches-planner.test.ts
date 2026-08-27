import { beforeEach, describe, expect, it, vi } from "vitest";

/*
  #2526 review, the HIGH finding — driven against the REAL planner.

  The whole integrity story of the booking-policy exception workflow is that an
  officer approves a FROZEN party, and the approval then drives the canonical
  modification service with the stored DELTA. That is sound only while "the party
  this delta produces" is one answer computed once. It was not: the freeze decided
  per guest ("no range entry + the dates moved => reset to the new envelope")
  while `prepareGuestPlan` decides on a GLOBAL flag ("any range input anywhere =>
  every guest without their own entry keeps their STORED range and night set, and
  the dates-moved reset never runs"). A member sending a date change plus a
  partial `guestStayRanges` had a proposal frozen, hashed, reviewed and
  capacity-checked for a party the execution never created.

  `src/lib/__tests__/booking-modification-stay-ranges.test.ts` pins the shared
  resolver's own semantics. THIS suite is the cross-check that matters: it runs
  the real `resolveTargetDates` -> `prepareGuestPlan` pair — no planner mock, no
  stubbed resolver — over the same delta the member sent, and asserts the
  guest-night set the planner will WRITE equals the guest-night set the officer
  was SHOWN. Only the planner's true database edges are mocked (member/boundary
  resolution, lodge capacity, member-night conflicts, the unpaid-subscription
  read), because a stay range depends on none of them.

  Revert the freeze to a per-guest rule, or the planner to a private copy of the
  resolution, and the mixed dates + partial-range case below reddens.
*/

const h = vi.hoisted(() => ({
  resolveLinkedBookingMembersWithBoundary: vi.fn(),
  assertLinkedBookingMembersCanBeBooked: vi.fn(),
  getLodgeCapacity: vi.fn(),
  assertNoBookingMemberNightConflicts: vi.fn(),
  findUnpaidMemberGuestNames: vi.fn(),
}));

vi.mock("@/lib/booking-guests", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/booking-guests")>();
  return {
    ...actual,
    resolveLinkedBookingMembersWithBoundary:
      h.resolveLinkedBookingMembersWithBoundary,
    assertLinkedBookingMembersCanBeBooked: h.assertLinkedBookingMembersCanBeBooked,
  };
});

vi.mock("@/lib/lodge-capacity", () => ({
  getLodgeCapacity: h.getLodgeCapacity,
}));

vi.mock("@/lib/booking-member-night-conflicts", () => ({
  assertNoBookingMemberNightConflicts: h.assertNoBookingMemberNightConflicts,
}));

vi.mock("@/lib/booking-member-guest-subscriptions", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@/lib/booking-member-guest-subscriptions")
  >();
  return { ...actual, findUnpaidMemberGuestNames: h.findUnpaidMemberGuestNames };
});

import { prepareGuestPlan } from "@/lib/booking-modify-plan";
import { resolveTargetDates } from "@/lib/booking-modify-validation";
import { buildModificationProposalParties } from "@/lib/booking-exception-request-service";
import { formatDateOnly, parseDateOnly } from "@/lib/date-only";
import { eachDateOnlyInRange } from "@/lib/date-only";
import { dateOnlyInstantOf, requireCalendarDate } from "@/lib/club-time";

// #3123 (`INV-LOCK-004`) — the CLUB's day, resolved by the caller BEFORE it opens
// its transaction and threaded in. Pinned to the frozen clock's club day, so
// these fixtures answer exactly as they did while the guard read the club's zone
// for itself.
const FIXTURE_CLUB_TODAY = dateOnlyInstantOf(requireCalendarDate("2026-07-01"));

const CHECK_IN = parseDateOnly("2026-08-01");
const CHECK_OUT = parseDateOnly("2026-08-03");
const tx = {} as never;

/** A live `BookingGuest` row as both the planner and the freeze read it. */
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
    stayStart: parseDateOnly(start),
    stayEnd: parseDateOnly(end),
    nights: (nights ?? nightsBetween(start, end)).map((night) => ({
      stayDate: parseDateOnly(night),
      priceCents: 5000,
    })),
  };
}

function nightsBetween(start: string, end: string): string[] {
  return eachDateOnlyInRange(parseDateOnly(start), parseDateOnly(end)).map(
    formatDateOnly,
  );
}

function bookingWith(guests: ReturnType<typeof liveGuest>[]) {
  return {
    id: "booking-1",
    memberId: "owner-1",
    lodgeId: "lodge-1",
    checkIn: CHECK_IN,
    checkOut: CHECK_OUT,
    wholeLodgeHold: false,
    status: "CONFIRMED",
    requiresAdminReview: false,
    adminReviewStatus: null,
    memberReviewJustification: null,
    adminReviewNotes: null,
    adminReviewedById: null,
    adminReviewedAt: null,
    guests,
  };
}

/**
 * The guest-night set the EXECUTION will write, derived from the planner's own
 * output. Deliberately re-derived here rather than reusing the freeze's helper:
 * the point of the comparison is that two independently-written derivations of
 * the same plan agree.
 */
function plannedNightsByGuest(
  proposedRemainingGuests: Array<{
    guest: { firstName: string };
    stayStart: Date;
    stayEnd: Date;
    nights?: Date[];
  }>,
) {
  return Object.fromEntries(
    proposedRemainingGuests.map((entry) => [
      entry.guest.firstName,
      (entry.nights && entry.nights.length > 0
        ? [...new Set(entry.nights.map(formatDateOnly))].sort()
        : nightsBetween(
            formatDateOnly(entry.stayStart),
            formatDateOnly(entry.stayEnd),
          )),
    ]),
  );
}

/** The guest-night set the OFFICER was shown, from the frozen proposal. */
function frozenNightsByGuest(
  guests: ReturnType<typeof liveGuest>[],
  delta: Parameters<typeof buildModificationProposalParties>[0]["delta"],
) {
  const { proposed } = buildModificationProposalParties({
    bookingCheckIn: CHECK_IN,
    bookingCheckOut: CHECK_OUT,
    liveGuests: guests,
    delta,
  });
  return {
    envelope: [proposed.checkIn, proposed.checkOut] as [string, string],
    byGuest: Object.fromEntries(
      proposed.guests.map((guest) => [guest.firstName, guest.nights]),
    ),
  };
}

/**
 * Run the real planner over the same delta the member sent, exactly as the
 * approval does: `role: "ADMIN"` (the mechanism that applies the reviewed
 * minimum-stay override) plus `reviewedMemberProposal: true` (which hands the
 * guest-authorisation rules back to member semantics).
 */
async function runRealPlanner(
  guests: ReturnType<typeof liveGuest>[],
  delta: Record<string, unknown>,
) {
  const booking = bookingWith(guests) as never;
  const input = { ...delta, reviewedMemberProposal: true } as never;
  const dates = resolveTargetDates({
    booking,
    role: "ADMIN",
    input,
    // #3123 - the club's day is now a required input. Every fixture here is
    // future-dated against the frozen clock, so the frozen day keeps the
    // planner on exactly the branch these cases were written for.
    today: new Date("2026-07-01T00:00:00.000Z"),
  });
  const plan = await prepareGuestPlan(tx, {
    today: FIXTURE_CLUB_TODAY,
    booking,
    role: "ADMIN",
    actorId: "officer-1",
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
  });
  return {
    envelope: [
      formatDateOnly(dates.newCheckIn),
      formatDateOnly(dates.newCheckOut),
    ] as [string, string],
    byGuest: plannedNightsByGuest(plan.proposedRemainingGuests),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.resolveLinkedBookingMembersWithBoundary.mockResolvedValue({
    members: new Map(),
    boundary: { scopeByMemberId: new Map(), beyondFamilyMemberIds: [] },
  });
  h.assertLinkedBookingMembersCanBeBooked.mockResolvedValue(undefined);
  h.getLodgeCapacity.mockResolvedValue(20);
  h.assertNoBookingMemberNightConflicts.mockResolvedValue(undefined);
  h.findUnpaidMemberGuestNames.mockResolvedValue([]);
});

describe("the frozen party equals what the REAL planner produces", () => {
  it("a dates change PLUS a partial guestStayRanges — the divergence that shipped", async () => {
    // THE FAILURE CASE. 3 guests on 2 nights; the member moves check-out out by a
    // night (tripping minimum stay on the new shape) and supplies a stay range for
    // guest A only. The old freeze reset B and C to the new 3-night envelope and
    // showed the officer 9 guest-nights; the planner keeps them on their stored 2,
    // so the execution committed 7 — a different party, a different price, and a
    // minimum-stay judgement made on a party that never existed.
    const guests = [
      liveGuest("a", "Ann", "2026-08-01", "2026-08-03"),
      liveGuest("b", "Bob", "2026-08-01", "2026-08-03"),
      liveGuest("c", "Cal", "2026-08-01", "2026-08-03"),
    ];
    const delta = {
      checkOut: "2026-08-04",
      guestStayRanges: [
        { guestId: "a", stayStart: "2026-08-01", stayEnd: "2026-08-04" },
      ],
    };

    const planned = await runRealPlanner(guests, delta);
    const frozen = frozenNightsByGuest(guests, delta);

    expect(planned.byGuest).toEqual(frozen.byGuest);
    expect(planned.envelope).toEqual(frozen.envelope);
    // And the party really is the asymmetric one, so the equality above is not
    // two implementations agreeing on the wrong answer.
    expect(frozen.byGuest.Ann).toEqual([
      "2026-08-01",
      "2026-08-02",
      "2026-08-03",
    ]);
    expect(frozen.byGuest.Bob).toEqual(["2026-08-01", "2026-08-02"]);
    expect(frozen.byGuest.Cal).toEqual(["2026-08-01", "2026-08-02"]);
    expect(
      Object.values(frozen.byGuest).reduce((sum, n) => sum + n.length, 0),
    ).toBe(7);
  });

  it("a bare dates change with NO range input resets every guest, in both", async () => {
    const guests = [
      liveGuest("a", "Ann", "2026-08-01", "2026-08-03"),
      liveGuest("b", "Bob", "2026-08-01", "2026-08-03"),
    ];
    const delta = { checkOut: "2026-08-04" };

    const planned = await runRealPlanner(guests, delta);
    const frozen = frozenNightsByGuest(guests, delta);

    expect(planned.byGuest).toEqual(frozen.byGuest);
    expect(planned.envelope).toEqual(frozen.envelope);
    expect(frozen.byGuest.Bob).toEqual([
      "2026-08-01",
      "2026-08-02",
      "2026-08-03",
    ]);
  });

  it("a stored SPARSE night set survives in both, instead of being flattened", async () => {
    // The other half of the same finding: the old freeze expanded
    // stayStart..stayEnd, so a guest booked for the 1st and the 3rd was frozen as
    // holding the 2nd as well — a bed claimed, and priced, on a night the
    // execution never books.
    const guests = [
      liveGuest("a", "Ann", "2026-08-01", "2026-08-04", [
        "2026-08-01",
        "2026-08-03",
      ]),
      liveGuest("b", "Bob", "2026-08-01", "2026-08-03"),
    ];
    const delta = {
      guestStayRanges: [
        { guestId: "b", stayStart: "2026-08-01", stayEnd: "2026-08-02" },
      ],
    };

    const planned = await runRealPlanner(guests, delta);
    const frozen = frozenNightsByGuest(guests, delta);

    expect(planned.byGuest).toEqual(frozen.byGuest);
    expect(frozen.byGuest.Ann).toEqual(["2026-08-01", "2026-08-03"]);
    expect(frozen.byGuest.Bob).toEqual(["2026-08-01"]);
  });

  it("a range that reaches past the requested envelope widens both the same way", async () => {
    const guests = [liveGuest("a", "Ann", "2026-08-01", "2026-08-03")];
    const delta = {
      guestStayRanges: [
        { guestId: "a", stayStart: "2026-08-01", stayEnd: "2026-08-06" },
      ],
    };

    const planned = await runRealPlanner(guests, delta);
    const frozen = frozenNightsByGuest(guests, delta);

    expect(planned.envelope).toEqual(frozen.envelope);
    expect(planned.envelope).toEqual(["2026-08-01", "2026-08-06"]);
    expect(planned.byGuest).toEqual(frozen.byGuest);
  });

  it("a removal plus a partial range agrees on who is left and on what nights", async () => {
    const guests = [
      liveGuest("a", "Ann", "2026-08-01", "2026-08-03"),
      liveGuest("b", "Bob", "2026-08-01", "2026-08-03"),
      liveGuest("c", "Cal", "2026-08-01", "2026-08-03"),
    ];
    const delta = {
      checkOut: "2026-08-04",
      removeGuestIds: ["c"],
      guestStayRanges: [
        { guestId: "a", stayStart: "2026-08-02", stayEnd: "2026-08-04" },
      ],
    };

    const planned = await runRealPlanner(guests, delta);
    const frozen = frozenNightsByGuest(guests, delta);

    expect(Object.keys(planned.byGuest).sort()).toEqual(["Ann", "Bob"]);
    expect(planned.byGuest).toEqual(frozen.byGuest);
    expect(planned.envelope).toEqual(frozen.envelope);
  });
});
