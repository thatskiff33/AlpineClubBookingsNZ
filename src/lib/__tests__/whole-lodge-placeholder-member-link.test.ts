import { beforeEach, describe, expect, it, vi } from "vitest";

/*
  #2337 — the placeholder→member link, at the pricing-plan level.

  These tests pin the ONE load-bearing correctness point of the whole feature:
  when a placeholder is linked to a member, the linked row must enter pricing with
  the MEMBER identity AND its booked non-member `lockedNightPrices` CLEARED. If the
  linked row kept its stored non-member locks, `priceBookingGuestsWithMembership-
  TypePolicy` would hold every night at the booked non-member price and the
  re-rate would silently do nothing — the member would never get the member rate.

  Revert the `link ? [] : lockedNightPricesForGuest(...)` carve-out in
  `prepareGuestPlan` and the first test fails: the linked row keeps a length-1 lock
  set. A non-linked placeholder KEEPS its locks (the #1036 behaviour), which the
  same test pins so the carve-out cannot be widened into "clear everyone".
*/

const h = vi.hoisted(() => ({
  resolveLinkedBookingMembersWithBoundary: vi.fn(),
  assertLinkedBookingMembersCanBeBooked: vi.fn(),
  getLodgeCapacity: vi.fn(),
  assertNoBookingMemberNightConflicts: vi.fn(),
}));

vi.mock("@/lib/booking-guests", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/booking-guests")>();
  return {
    ...actual,
    resolveLinkedBookingMembersWithBoundary:
      h.resolveLinkedBookingMembersWithBoundary,
    assertLinkedBookingMembersCanBeBooked:
      h.assertLinkedBookingMembersCanBeBooked,
  };
});

vi.mock("@/lib/lodge-capacity", () => ({
  getLodgeCapacity: h.getLodgeCapacity,
}));

vi.mock("@/lib/booking-member-night-conflicts", () => ({
  assertNoBookingMemberNightConflicts: h.assertNoBookingMemberNightConflicts,
}));

import { dateOnlyInstantOf, requireCalendarDate, requireClubTimeZone } from "@/lib/club-time";
import { prepareGuestPlan } from "@/lib/booking-modify-plan";

// #3123 (`INV-LOCK-004`) — the CLUB's day, resolved by the caller BEFORE it opens
// its transaction and threaded in. Pinned to the frozen clock's club day, so
// these fixtures answer exactly as they did while the guard read the club's zone
// for itself.
const FIXTURE_CLUB_TODAY = dateOnlyInstantOf(requireCalendarDate("2026-07-01"));

const NIGHT_1 = new Date("2026-08-10T00:00:00.000Z");
const CHECK_IN = new Date("2026-08-10T00:00:00.000Z");
const CHECK_OUT = new Date("2026-08-11T00:00:00.000Z");

function placeholder(id: string) {
  return {
    id,
    firstName: "Guest",
    lastName: id.slice(-1),
    ageTier: "ADULT",
    isMember: false,
    memberId: null,
    stayStart: CHECK_IN,
    stayEnd: CHECK_OUT,
    // A booked non-member night price — this is what the re-rate must displace
    // for the linked row and keep for the non-linked one.
    nights: [{ stayDate: NIGHT_1, priceCents: 5000 }],
  };
}

function wholeLodgeBooking() {
  return {
    id: "booking-1",
    memberId: "owner-1",
    lodgeId: "lodge-1",
    checkIn: CHECK_IN,
    checkOut: CHECK_OUT,
    wholeLodgeHold: true,
    status: "CONFIRMED",
    requiresAdminReview: false,
    adminReviewStatus: null,
    memberReviewJustification: null,
    adminReviewNotes: null,
    adminReviewedById: null,
    adminReviewedAt: null,
    guests: [placeholder("g1"), placeholder("g2")],
  };
}

const tx = {} as never;

function familyBoundary(memberId: string) {
  return {
    members: new Map([
      [
        memberId,
        { id: memberId, ageTier: "ADULT", firstName: "Ada", lastName: "Lovelace" },
      ],
    ]),
    boundary: {
      scopeByMemberId: new Map([[memberId, "FAMILY"]]),
      beyondFamilyMemberIds: [],
    },
  };
}

function beyondFamilyBoundary(memberId: string) {
  return {
    members: new Map([
      [
        memberId,
        { id: memberId, ageTier: "ADULT", firstName: "Grace", lastName: "Hopper" },
      ],
    ]),
    boundary: {
      scopeByMemberId: new Map([[memberId, "BEYOND_FAMILY"]]),
      beyondFamilyMemberIds: [memberId],
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.assertLinkedBookingMembersCanBeBooked.mockResolvedValue(undefined);
  h.getLodgeCapacity.mockResolvedValue(20);
  h.assertNoBookingMemberNightConflicts.mockResolvedValue(undefined);
});

describe("#2337: prepareGuestPlan threads a placeholder→member link into pricing", () => {
  it("CLEARS the linked row's locked non-member night prices and stamps the member identity, while a non-linked placeholder keeps its locks", async () => {
    h.resolveLinkedBookingMembersWithBoundary.mockResolvedValue(
      familyBoundary("member-9"),
    );

    const plan = await prepareGuestPlan(tx, {
      today: FIXTURE_CLUB_TODAY,
      booking: wholeLodgeBooking() as never,
      role: "ADMIN",
      actorId: "admin-1",
      input: { linkGuestToMember: [{ guestId: "g1", memberId: "member-9" }] },
      isInProgressEdit: false,
      editableFrom: null,
      newCheckIn: CHECK_IN,
      newCheckOut: CHECK_OUT,
      memberGuestPolicy: {
        wideningEnabled: false,
        approvalRequired: true,
        pendingHoldExpiryDays: 0,
      },
    });

    expect(plan.guestMemberLinks).toEqual([
      {
        guestId: "g1",
        memberId: "member-9",
        previousFirstName: "Guest",
        previousLastName: "1",
      },
    ]);

    // Capacity is invariant: a link is a pure re-rate, no headcount change.
    expect(plan.guestsForPricing).toHaveLength(2);
    expect(plan.totalGuestCount).toBe(2);

    const linked = plan.guestsForPricing.find((g) => g.bookingGuestId === "g1");
    const untouched = plan.guestsForPricing.find(
      (g) => g.bookingGuestId === "g2",
    );

    // The linked row: member identity, and NO locked night prices — the whole
    // point. This is the mutation-verify anchor.
    expect(linked?.isMember).toBe(true);
    expect(linked?.memberId).toBe("member-9");
    expect(linked?.lockedNightPrices).toEqual([]);

    // The non-linked placeholder is completely unchanged: still a non-member, and
    // still holding its booked night price (#1036).
    expect(untouched?.isMember).toBe(false);
    expect(untouched?.memberId).toBeNull();
    expect(untouched?.lockedNightPrices).toEqual([
      { stayDate: NIGHT_1, priceCents: 5000 },
    ]);

    // A family-scope link writes no consent columns and asks nobody.
    expect(plan.guestMemberLinkColumns.get("g1")).toBeUndefined();
    expect(plan.memberGuestEntries.size).toBe(0);

    // The linked row displays the member's name, not the "Guest 1" placeholder.
    expect(plan.guestMemberLinkNames.get("g1")).toEqual({
      firstName: "Ada",
      lastName: "Lovelace",
    });
  });

  it("resolves the linked member THROUGH the boundary machinery, so an ineligible member is refused by the same path an added member guest is", async () => {
    h.resolveLinkedBookingMembersWithBoundary.mockResolvedValue(
      familyBoundary("member-9"),
    );

    await prepareGuestPlan(tx, {
      today: FIXTURE_CLUB_TODAY,
      booking: wholeLodgeBooking() as never,
      role: "ADMIN",
      actorId: "admin-1",
      input: { linkGuestToMember: [{ guestId: "g1", memberId: "member-9" }] },
      isInProgressEdit: false,
      editableFrom: null,
      newCheckIn: CHECK_IN,
      newCheckOut: CHECK_OUT,
      memberGuestPolicy: {
        wideningEnabled: false,
        approvalRequired: true,
        pendingHoldExpiryDays: 0,
      },
    });

    // The link's member id joined the SAME resolve as any added member guest.
    const [, , memberIds] =
      h.resolveLinkedBookingMembersWithBoundary.mock.calls[0] ?? [];
    expect(memberIds).toContain("member-9");
    // Its eligibility ran through the shared assertion.
    expect(h.assertLinkedBookingMembersCanBeBooked).toHaveBeenCalledTimes(1);
  });

  it("plans consent columns for a BEYOND-FAMILY link, so it fires the same notification an added cross-family member guest does (option a)", async () => {
    h.resolveLinkedBookingMembersWithBoundary.mockResolvedValue(
      beyondFamilyBoundary("member-9"),
    );

    const plan = await prepareGuestPlan(tx, {
      today: FIXTURE_CLUB_TODAY,
      booking: wholeLodgeBooking() as never,
      role: "ADMIN",
      actorId: "admin-1",
      input: { linkGuestToMember: [{ guestId: "g1", memberId: "member-9" }] },
      isInProgressEdit: false,
      editableFrom: null,
      newCheckIn: CHECK_IN,
      newCheckOut: CHECK_OUT,
      memberGuestPolicy: {
        wideningEnabled: true,
        approvalRequired: true,
        pendingHoldExpiryDays: 7,
        // #3123 — the consent expiry clamp takes the club's persisted zone as a
        // required value, threaded on the policy the caller already resolved.
        timeZone: requireClubTimeZone("America/Denver"),
      },
    });

    const columns = plan.guestMemberLinkColumns.get("g1");
    expect(columns).toBeDefined();
    // Some consent state was written (the exact sub-state is the consent module's
    // to decide); the row is no longer an all-null family-scope row.
    expect(columns?.consentStatus).not.toBeNull();
    // And an entry exists so the post-commit dispatch tells the linked member.
    expect(plan.memberGuestEntries.has("member-9")).toBe(true);
  });
});
