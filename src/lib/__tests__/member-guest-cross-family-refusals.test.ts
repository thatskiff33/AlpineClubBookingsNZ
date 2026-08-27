// "+ Add Member Guest" (epic #2305) MG2 (#2307) — OWNER DECISION D-8.
//
// MG2 is the release in which a cross-family memberId first gets past
// authorization, which makes three previously-harmless refusals reachable by
// anybody who can call the booking API, against a member the caller may never have
// met. Each one described that member in detail. This file pins the collapse.
//
// WHAT "COLLAPSE" HAS TO MEAN TO BE WORTH ANYTHING. It is not enough that each
// refusal stops naming the member: the three must become INDISTINGUISHABLE from
// one another. If the unpaid-subscription case returned a different message, or a
// different status, from the person-night case, a caller could still read a
// stranger's financial state off the shape of the refusal. So the last test in
// this file asserts all three produce the same message and the same status, and
// each individual test asserts the detailed FAMILY-scope behaviour is untouched —
// a member adding their own child still gets told exactly which field is missing.
import { describe, expect, it, vi } from "vitest";

// Subscription enforcement is a club/Xero-state question that has nothing to do
// with D-8; forcing it ON is what makes the third refusal reachable in a unit test
// at all. Everything else in this file runs against the real implementations.
vi.mock("@/lib/member-subscription-eligibility", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/member-subscription-eligibility")>()),
  isSubscriptionEnforcementActive: vi.fn().mockResolvedValue(true),
}));
// The membership-type policy resolver needs far more of the schema than this
// unit test stubs; an empty map means "no type-level exemption", which is the
// case that reaches the refusal.
vi.mock("@/lib/membership-type-policy", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/membership-type-policy")>()),
  resolveMembershipTypePoliciesForMembers: vi.fn().mockResolvedValue(new Map()),
}));
vi.mock("@/lib/age-tier", () => ({
  getAgeTierSettings: vi.fn().mockResolvedValue([
    {
      tier: "ADULT",
      minAge: 18,
      maxAge: null,
      label: "Adult",
      subscriptionRequiredForBooking: true,
      sortOrder: 0,
    },
  ]),
}));

import {
  assertLinkedBookingMembersCanBeBooked,
  BookingGuestProfileRequiredError,
  BookingGuestValidationError,
  MEMBER_GUEST_NOT_ADDABLE_CODE,
  getBookingGuestValidationErrorResponse,
  resolveLinkedBookingMembersWithBoundary,
  type LinkedBookingMember,
} from "@/lib/booking-guests";
import { findUnpaidMemberGuests } from "@/lib/booking-member-guest-subscriptions";
import { markCrossFamilyGuestsOnBooking } from "@/lib/member-guest-add-policy";
import { findBookingMemberNightConflicts } from "@/lib/booking-member-night-conflicts";
import { MEMBER_GUEST_CROSS_FAMILY_REFUSAL_MESSAGE } from "@/lib/member-guest-refusal";
import { parseDateOnly } from "@/lib/date-only";
import { dateOnlyInstantOf, requireCalendarDate } from "@/lib/club-time";

// #3123 (`INV-LOCK-004`) — the CLUB's day, resolved by the caller BEFORE it opens
// its transaction and threaded in. Pinned to the frozen clock's club day, so
// these fixtures answer exactly as they did while the guard read the club's zone
// for itself.
const FIXTURE_CLUB_TODAY = dateOnlyInstantOf(requireCalendarDate("2026-07-01"));

const BOOKER = "m-booker";
const CHILD = "m-child";
const OUTSIDER = "m-outsider";

const CHECK_IN = parseDateOnly("2026-09-10");
const CHECK_OUT = parseDateOnly("2026-09-12");

// ---------------------------------------------------------------------------
// 1. The profile-completeness gate
// ---------------------------------------------------------------------------

/** A member who cannot be booked: no login of their own, nothing confirmed. */
function incompleteMember(id: string): LinkedBookingMember {
  return {
    id,
    ageTier: "ADULT",
    active: true,
    canLogin: false,
    firstName: "Dana",
    lastName: "Doe",
    profileCompletedAt: null,
    detailsConfirmedAt: null,
    detailsConfirmedByMemberId: null,
    onboardingConfirmedAt: null,
  };
}

function profileGateDb() {
  return {
    familyGroupMember: { findMany: async () => [] },
    member: { findMany: async () => [] },
  } as unknown as Parameters<typeof assertLinkedBookingMembersCanBeBooked>[0];
}

describe("D-8 leak 1 — the profile-completeness gate", () => {
  it("collapses to the neutral refusal for a cross-family target, disclosing nothing about them", async () => {
    const error = await assertLinkedBookingMembersCanBeBooked(
      profileGateDb(),
      new Map([[OUTSIDER, incompleteMember(OUTSIDER)]]),
      BOOKER,
      { crossFamilyMemberIds: [OUTSIDER] },
    ).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(BookingGuestValidationError);
    // Not the detailed body: that shape carries name, missingFields and canLogin.
    expect(error).not.toBeInstanceOf(BookingGuestProfileRequiredError);
    const refusal = error as BookingGuestValidationError;
    expect(refusal.message).toBe(MEMBER_GUEST_CROSS_FAMILY_REFUSAL_MESSAGE);
    expect(refusal.status).toBe(403);
    // Nothing about the member survives anywhere in the error.
    const serialised = JSON.stringify({
      message: refusal.message,
      ...(refusal as unknown as Record<string, unknown>),
    });
    expect(serialised).not.toContain("Dana");
    expect(serialised).not.toContain("Doe");
    expect(serialised).not.toContain("canLogin");
  });

  it("keeps the detailed, actionable error for a family-scope target", async () => {
    const error = await assertLinkedBookingMembersCanBeBooked(
      profileGateDb(),
      new Map([[CHILD, incompleteMember(CHILD)]]),
      BOOKER,
      // No cross-family ids: everybody requested is inside the booker's family.
      { crossFamilyMemberIds: [] },
    ).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(BookingGuestProfileRequiredError);
    const detailed = error as BookingGuestProfileRequiredError;
    expect(detailed.members[0].name).toBe("Dana Doe");
    expect(detailed.members[0].missingFields.length).toBeGreaterThan(0);
  });

  it("a cross-family target wins over a family one blocked in the same request", async () => {
    // Reporting the family member in full while staying silent about the stranger
    // would leak by omission, and a caller could read the same oracle one id at a
    // time.
    const error = await assertLinkedBookingMembersCanBeBooked(
      profileGateDb(),
      new Map([
        [CHILD, incompleteMember(CHILD)],
        [OUTSIDER, incompleteMember(OUTSIDER)],
      ]),
      BOOKER,
      { crossFamilyMemberIds: [OUTSIDER] },
    ).catch((err: unknown) => err);

    expect(error).not.toBeInstanceOf(BookingGuestProfileRequiredError);
    expect((error as BookingGuestValidationError).message).toBe(
      MEMBER_GUEST_CROSS_FAMILY_REFUSAL_MESSAGE,
    );
  });

  it("is unreachable when nothing is blocked, cross-family or not", async () => {
    await expect(
      assertLinkedBookingMembersCanBeBooked(
        profileGateDb(),
        new Map(),
        BOOKER,
        { crossFamilyMemberIds: [OUTSIDER] },
      ),
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 2. The person-night conflict
// ---------------------------------------------------------------------------

/**
 * The two `FamilyGroupMember` reads `computeMemberGuestBoundary` makes, stubbed:
 * everyone in `householdMemberIds` shares one group with the booker.
 */
function familyBoundaryDb(householdMemberIds: readonly string[]) {
  return {
    familyGroupMember: {
      findMany: async ({ where }: { where: { memberId?: unknown; familyGroupId?: unknown } }) =>
        where.familyGroupId
          ? householdMemberIds.map((memberId) => ({ memberId, familyGroupId: "fg-1" }))
          : [{ memberId: BOOKER, familyGroupId: "fg-1" }],
    },
  } as unknown as Parameters<typeof markCrossFamilyGuestsOnBooking>[0];
}

function conflictDb(conflictMemberId: string) {
  return {
    bookingGuest: {
      findMany: async () => [
        {
          id: "bg-other",
          memberId: conflictMemberId,
          firstName: "Dana",
          lastName: "Doe",
          stayStart: CHECK_IN,
          stayEnd: CHECK_OUT,
          nights: [{ stayDate: CHECK_IN }],
          member: { firstName: "Dana", lastName: "Doe" },
          booking: {
            id: "bk-other",
            memberId: "m-stranger",
            status: "CONFIRMED",
            checkIn: CHECK_IN,
            checkOut: CHECK_OUT,
            member: { firstName: "Sam", lastName: "Stranger" },
            guests: [{ id: "bg-other", memberId: conflictMemberId }, { id: "bg-2", memberId: null }],
          },
        },
      ],
    },
  } as unknown as Parameters<typeof findBookingMemberNightConflicts>[0];
}

describe("D-8 leak 2 — the person-night conflict", () => {
  it("refuses neutrally instead of returning a cross-family member's booked nights", async () => {
    const error = await findBookingMemberNightConflicts(conflictDb(OUTSIDER), {
      today: FIXTURE_CLUB_TODAY,
      actorMemberId: BOOKER,
      actorRole: "USER",
      checkIn: CHECK_IN,
      checkOut: CHECK_OUT,
      guests: [
        {
          memberId: OUTSIDER,
          stayStart: CHECK_IN,
          stayEnd: CHECK_OUT,
          crossFamilyMemberGuest: true,
        },
      ],
    }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(BookingGuestValidationError);
    const refusal = error as BookingGuestValidationError;
    expect(refusal.message).toBe(MEMBER_GUEST_CROSS_FAMILY_REFUSAL_MESSAGE);
    expect(refusal.status).toBe(403);
    // The message the ordinary conflict would have produced names the member and
    // the nights; this one names neither.
    expect(refusal.message).not.toContain("Dana");
    expect(refusal.message).not.toContain("2026-09-10");
  });

  // REWRITTEN by the privacy review of MG3 (#2308), finding C1, and the rewrite
  // is the point rather than a tidy-up. This test used to be called "returns the
  // ordinary detailed conflict for an unmarked (family-scope) guest" and its body
  // asserted that an UNMARKED guest gets the detailed answer — treating "unmarked"
  // and "family-scope" as the same thing.
  //
  // They are not, and MG3 is exactly where they come apart: the marker is set
  // only on guests a request is ADDING, so a cross-family member guest ALREADY on
  // the booking is unmarked forever. Equating the two is what made the CRITICAL
  // read-out look correct, and it is why nothing caught it. The two cases are now
  // separate tests: this one is genuinely family-scope (the guard is given the
  // booker's own household), and the one below is the unmarked stranger.
  it("returns the ordinary detailed conflict for a guest inside the booker's family", async () => {
    const conflicts = await findBookingMemberNightConflicts(conflictDb(CHILD), {
      today: FIXTURE_CLUB_TODAY,
      actorMemberId: BOOKER,
      actorRole: "USER",
      checkIn: CHECK_IN,
      checkOut: CHECK_OUT,
      guests: await markCrossFamilyGuestsOnBooking(
        familyBoundaryDb([BOOKER, CHILD]),
        BOOKER,
        [{ memberId: CHILD, stayStart: CHECK_IN, stayEnd: CHECK_OUT }],
      ),
    });

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].memberName).toBe("Dana Doe");
    expect(conflicts[0].conflictingNights.length).toBeGreaterThan(0);
    // #2250's disclosure gate is untouched: this viewer is not entitled to the
    // other booking, so none of its fields are attached.
    expect(conflicts[0].bookingId).toBeUndefined();
  });

  it("refuses neutrally for a cross-family member guest ALREADY on the booking (C1)", async () => {
    // The case with no coverage anywhere before this: nobody is being added, so
    // nothing carries the request-scoped marker, and the guard used to answer in
    // full — name and exact booked nights — on every date change, through a
    // side-effect-free preview that spent no throttle and wrote no audit row.
    const guests = await markCrossFamilyGuestsOnBooking(
      familyBoundaryDb([BOOKER, CHILD]),
      BOOKER,
      [
        // No `crossFamilyMemberGuest` anywhere in the input: it is DERIVED.
        { memberId: OUTSIDER, stayStart: CHECK_IN, stayEnd: CHECK_OUT },
      ],
    );
    expect(guests[0]).toMatchObject({ crossFamilyMemberGuest: true });

    const error = await findBookingMemberNightConflicts(conflictDb(OUTSIDER), {
      today: FIXTURE_CLUB_TODAY,
      actorMemberId: BOOKER,
      actorRole: "USER",
      checkIn: CHECK_IN,
      checkOut: CHECK_OUT,
      guests,
    }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(BookingGuestValidationError);
    const refusal = error as BookingGuestValidationError;
    expect(refusal.message).toBe(MEMBER_GUEST_CROSS_FAMILY_REFUSAL_MESSAGE);
    expect(refusal.status).toBe(403);
    expect(refusal.message).not.toContain("Dana");
    expect(refusal.message).not.toContain("2026-09-10");
  });

  it("leaves an ADMIN path's detailed conflict alone", async () => {
    // An officer is entitled to the detail, exactly as `collapseForMemberIds`
    // exempts them; withholding it would buy nothing and cost support tickets.
    const guests = await markCrossFamilyGuestsOnBooking(
      familyBoundaryDb([BOOKER, CHILD]),
      BOOKER,
      [{ memberId: OUTSIDER, stayStart: CHECK_IN, stayEnd: CHECK_OUT }],
      { skipAuthorization: true },
    );
    expect(guests[0]).not.toHaveProperty("crossFamilyMemberGuest");

    const conflicts = await findBookingMemberNightConflicts(conflictDb(OUTSIDER), {
      today: FIXTURE_CLUB_TODAY,
      actorMemberId: "m-admin",
      actorRole: "ADMIN",
      checkIn: CHECK_IN,
      checkOut: CHECK_OUT,
      guests,
    });
    expect(conflicts[0].memberName).toBe("Dana Doe");
  });

  it("says nothing when a marked cross-family guest has no clash at all", async () => {
    // The marker must not turn into a refusal on its own — only a real conflict
    // refuses.
    const conflicts = await findBookingMemberNightConflicts(
      { bookingGuest: { findMany: async () => [] } } as unknown as Parameters<
        typeof findBookingMemberNightConflicts
      >[0],
      {
        today: FIXTURE_CLUB_TODAY,
        actorMemberId: BOOKER,
        actorRole: "USER",
        checkIn: CHECK_IN,
        checkOut: CHECK_OUT,
        guests: [
          {
            memberId: OUTSIDER,
            stayStart: CHECK_IN,
            stayEnd: CHECK_OUT,
            crossFamilyMemberGuest: true,
          },
        ],
      },
    );

    expect(conflicts).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 3. The unpaid-subscription refusal
// ---------------------------------------------------------------------------

function subscriptionDb(memberId: string) {
  return {
    memberSubscription: {
      findMany: async () => [
        {
          memberId,
          status: "AWAITING_PAYMENT",
          xeroOnlineInvoiceUrl: "https://invoice.example/secret",
          xeroInvoiceNumber: "INV-4242",
        },
      ],
    },
    member: {
      findMany: async () => [
        { id: memberId, firstName: "Dana", lastName: "Doe", ageTier: "ADULT" },
      ],
    },
    membershipType: { findMany: async () => [] },
    memberSubscriptionYear: { findMany: async () => [] },
  } as unknown as Parameters<typeof findUnpaidMemberGuests>[0];
}

describe("D-8 leak 3 — the unpaid-subscription refusal", () => {
  it("refuses neutrally instead of returning a cross-family member's name, status and invoice", async () => {
    const error = await findUnpaidMemberGuests(subscriptionDb(OUTSIDER), {
      bookingMemberId: BOOKER,
      checkIn: CHECK_IN,
      guests: [
        { isMember: true, memberId: OUTSIDER, crossFamilyMemberGuest: true },
      ],
    }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(BookingGuestValidationError);
    const refusal = error as BookingGuestValidationError;
    expect(refusal.message).toBe(MEMBER_GUEST_CROSS_FAMILY_REFUSAL_MESSAGE);
    expect(refusal.status).toBe(403);
    expect(refusal.message).not.toContain("Dana");
    expect(refusal.message).not.toContain("INV-4242");
  });

  it("returns the detailed rows for a family-scope member guest", async () => {
    const result = await findUnpaidMemberGuests(subscriptionDb(CHILD), {
      bookingMemberId: BOOKER,
      checkIn: CHECK_IN,
      guests: [{ isMember: true, memberId: CHILD }],
    }).catch((err: unknown) => err);

    expect(Array.isArray(result)).toBe(true);
    const rows = result as Awaited<ReturnType<typeof findUnpaidMemberGuests>>;
    expect(rows[0].name).toBe("Dana Doe");
    expect(rows[0].invoiceNumber).toBe("INV-4242");
  });
});

// ---------------------------------------------------------------------------
// The property that makes the collapse worth doing
// ---------------------------------------------------------------------------

describe("the three refusals are indistinguishable", () => {
  it("share one message and one status", async () => {
    const fromProfileGate = await assertLinkedBookingMembersCanBeBooked(
      profileGateDb(),
      new Map([[OUTSIDER, incompleteMember(OUTSIDER)]]),
      BOOKER,
      { crossFamilyMemberIds: [OUTSIDER] },
    ).catch((err: unknown) => err);

    const fromNightConflict = await findBookingMemberNightConflicts(
      conflictDb(OUTSIDER),
      {
        today: FIXTURE_CLUB_TODAY,
        actorMemberId: BOOKER,
        actorRole: "USER",
        checkIn: CHECK_IN,
        checkOut: CHECK_OUT,
        guests: [
          {
            memberId: OUTSIDER,
            stayStart: CHECK_IN,
            stayEnd: CHECK_OUT,
            crossFamilyMemberGuest: true,
          },
        ],
      },
    ).catch((err: unknown) => err);

    expect(fromProfileGate).toBeInstanceOf(BookingGuestValidationError);
    expect(fromNightConflict).toBeInstanceOf(BookingGuestValidationError);
    const profileRefusal = fromProfileGate as BookingGuestValidationError;
    const conflictRefusal = fromNightConflict as BookingGuestValidationError;
    expect(profileRefusal.message).toBe(conflictRefusal.message);
    expect(profileRefusal.status).toBe(conflictRefusal.status);
    // And the message says nothing at all about which invariant refused.
    expect(profileRefusal.message).toBe(MEMBER_GUEST_CROSS_FAMILY_REFUSAL_MESSAGE);
  });
});

// ---------------------------------------------------------------------------
// 4. The two refusals that used to ESCAPE the collapse entirely (#2388, MG3 #2308)
// ---------------------------------------------------------------------------
//
// D-8's collapse was applied to the three refusals MG2 knew about. Two more
// answered a cross-family probe in their own words, with their own status, and
// needed no stopwatch at all to tell apart from the neutral one:
//
//   * "Linked member is inactive or not found" (400) — a straight existence
//     oracle. Try an id; the status alone said whether an active member was
//     behind it.
//   * "This account is age-exempt (N/A)…" (400) — said the target is an
//     organisation or school account rather than a person.
//
// Equalising response TIMING would have been pointless while either of these
// stood, because the body already gave the answer away. Both now collapse for a
// beyond-family id on a member-initiated path, and both keep their detailed,
// actionable form for a family-scope target and for an admin on-behalf path.
describe("D-8 leak 4 — resolution refusals no longer escape the collapse", () => {
  const OUTSIDER_2 = "m-outsider-2";

  function resolveDb(rows: Array<{ id: string; ageTier: string }>) {
    return {
      familyGroupMember: {
        findMany: async ({ where }: { where: Record<string, unknown> }) => {
          // The booker's own family group contains the booker and CHILD.
          if ((where as { memberId?: string }).memberId === BOOKER) {
            return [{ familyGroupId: "fg-1" }];
          }
          if ((where as { familyGroupId?: { in: string[] } }).familyGroupId) {
            return [{ memberId: BOOKER }, { memberId: CHILD }];
          }
          return [];
        },
      },
      member: {
        findMany: async () =>
          rows.map((row) => ({
            id: row.id,
            ageTier: row.ageTier,
            active: true,
            canLogin: true,
            firstName: "Dana",
            lastName: "Doe",
            profileCompletedAt: CHECK_IN,
            detailsConfirmedAt: CHECK_IN,
            detailsConfirmedByMemberId: null,
            onboardingConfirmedAt: CHECK_IN,
          })),
      },
    } as unknown as Parameters<typeof resolveLinkedBookingMembersWithBoundary>[0];
  }

  it("collapses 'inactive or not found' to the neutral refusal for a beyond-family id", async () => {
    const error = await resolveLinkedBookingMembersWithBoundary(
      // The member query returns nothing: the id names nobody active.
      resolveDb([]),
      BOOKER,
      [OUTSIDER],
      { memberGuestWideningEnabled: true },
    ).catch((err: unknown) => err);

    const refusal = error as BookingGuestValidationError;
    expect(refusal).toBeInstanceOf(BookingGuestValidationError);
    expect(refusal.message).toBe(MEMBER_GUEST_CROSS_FAMILY_REFUSAL_MESSAGE);
    expect(refusal.status).toBe(403);
    // The old body and the old status are both gone.
    expect(refusal.message).not.toContain("inactive or not found");
    expect(refusal.status).not.toBe(400);
  });

  it("collapses the age-exempt refusal for a beyond-family id", async () => {
    const error = await resolveLinkedBookingMembersWithBoundary(
      resolveDb([{ id: OUTSIDER, ageTier: "NOT_APPLICABLE" }]),
      BOOKER,
      [OUTSIDER],
      { memberGuestWideningEnabled: true },
    ).catch((err: unknown) => err);

    const refusal = error as BookingGuestValidationError;
    expect(refusal.message).toBe(MEMBER_GUEST_CROSS_FAMILY_REFUSAL_MESSAGE);
    expect(refusal.status).toBe(403);
    expect(refusal.message).not.toMatch(/age-exempt/i);
  });

  it("makes the two indistinguishable from each other AND from the profile-gate refusal", async () => {
    // The whole point of a collapse: not that each refusal stops naming the
    // member, but that a caller holding one cannot tell WHICH refusal it was.
    const notFound = (await resolveLinkedBookingMembersWithBoundary(
      resolveDb([]),
      BOOKER,
      [OUTSIDER],
      { memberGuestWideningEnabled: true },
    ).catch((err: unknown) => err)) as BookingGuestValidationError;

    const ageExempt = (await resolveLinkedBookingMembersWithBoundary(
      resolveDb([{ id: OUTSIDER, ageTier: "NOT_APPLICABLE" }]),
      BOOKER,
      [OUTSIDER],
      { memberGuestWideningEnabled: true },
    ).catch((err: unknown) => err)) as BookingGuestValidationError;

    const profileGate = (await assertLinkedBookingMembersCanBeBooked(
      profileGateDb(),
      new Map([[OUTSIDER, incompleteMember(OUTSIDER)]]),
      BOOKER,
      { crossFamilyMemberIds: [OUTSIDER] },
    ).catch((err: unknown) => err)) as BookingGuestValidationError;

    for (const refusal of [ageExempt, profileGate]) {
      expect(refusal.message).toBe(notFound.message);
      expect(refusal.status).toBe(notFound.status);
    }
  });

  it("keeps the detailed refusal for a FAMILY-scope id — a booker adding their own child is told why", async () => {
    const error = await resolveLinkedBookingMembersWithBoundary(
      resolveDb([]),
      BOOKER,
      [CHILD],
      { memberGuestWideningEnabled: true },
    ).catch((err: unknown) => err);

    const refusal = error as BookingGuestValidationError;
    expect(refusal.message).toBe("Linked member is inactive or not found");
    expect(refusal.status).toBe(400);
    expect(refusal.crossFamilyMemberIds).toBeUndefined();
  });

  it("keeps the detailed refusal on an admin on-behalf path", async () => {
    // An officer is entitled to know the id is wrong, and hiding it from them
    // would only produce support tickets.
    const error = await resolveLinkedBookingMembersWithBoundary(
      resolveDb([]),
      BOOKER,
      [OUTSIDER],
      { skipAuthorization: true, memberGuestWideningEnabled: true },
    ).catch((err: unknown) => err);

    expect((error as BookingGuestValidationError).message).toBe(
      "Linked member is inactive or not found",
    );
  });

  it("tags every collapsed refusal with the targets it was about, for the audit trail", async () => {
    // #2388: the route writes one audit row per refused target and must not have
    // to recompute the family boundary to find out who they were.
    const notFound = (await resolveLinkedBookingMembersWithBoundary(
      resolveDb([]),
      BOOKER,
      [OUTSIDER],
      { memberGuestWideningEnabled: true },
    ).catch((err: unknown) => err)) as BookingGuestValidationError;
    expect(notFound.crossFamilyMemberIds).toEqual([OUTSIDER]);

    const profileGate = (await assertLinkedBookingMembersCanBeBooked(
      profileGateDb(),
      new Map([
        [OUTSIDER, incompleteMember(OUTSIDER)],
        [OUTSIDER_2, incompleteMember(OUTSIDER_2)],
      ]),
      BOOKER,
      { crossFamilyMemberIds: [OUTSIDER, OUTSIDER_2] },
    ).catch((err: unknown) => err)) as BookingGuestValidationError;
    expect(profileGate.crossFamilyMemberIds).toEqual([OUTSIDER, OUTSIDER_2]);
  });

  it("still resolves a beyond-family member normally when nothing is wrong with them", async () => {
    const { members, boundary } = await resolveLinkedBookingMembersWithBoundary(
      resolveDb([{ id: OUTSIDER, ageTier: "ADULT" }]),
      BOOKER,
      [OUTSIDER],
      { memberGuestWideningEnabled: true },
    );
    expect(members.has(OUTSIDER)).toBe(true);
    expect(boundary.beyondFamilyMemberIds).toEqual([OUTSIDER]);
  });
});

describe("the response body a collapsed refusal produces (#2308 plan §5.4)", () => {
  it("carries the neutral code so the wizard can place it, and never the target ids", async () => {
    const refusal = (await assertLinkedBookingMembersCanBeBooked(
      profileGateDb(),
      new Map([[OUTSIDER, incompleteMember(OUTSIDER)]]),
      BOOKER,
      { crossFamilyMemberIds: [OUTSIDER] },
    ).catch((err: unknown) => err)) as BookingGuestValidationError;

    const body = getBookingGuestValidationErrorResponse(refusal);
    expect(body).toEqual({
      code: MEMBER_GUEST_NOT_ADDABLE_CODE,
      error: MEMBER_GUEST_CROSS_FAMILY_REFUSAL_MESSAGE,
    });
    // Echoing the ids back would confirm WHICH of several requested members the
    // club refused to discuss — the leak-by-omission the collapse exists to stop.
    expect(JSON.stringify(body)).not.toContain(OUTSIDER);
  });

  it("gives an ordinary validation error no code at all", () => {
    const body = getBookingGuestValidationErrorResponse(
      new BookingGuestValidationError("Linked member is inactive or not found", 400),
    );
    expect(body).toEqual({ error: "Linked member is inactive or not found" });
  });

  it("never marks the DETAILED family-scope refusal with the neutral code", async () => {
    const detailed = (await assertLinkedBookingMembersCanBeBooked(
      profileGateDb(),
      new Map([[CHILD, incompleteMember(CHILD)]]),
      BOOKER,
      { crossFamilyMemberIds: [] },
    ).catch((err: unknown) => err)) as BookingGuestValidationError;
    const body = getBookingGuestValidationErrorResponse(detailed) as {
      code?: string;
    };
    expect(body.code).toBe("GUEST_PROFILE_REQUIRED");
  });
});
