import { CLUB_FORMAT_TEST } from "@/lib/__tests__/support/club-format-fixture";
import { beforeEach, describe, expect, it, vi } from "vitest";

/*
  #3451 — own-dependant identity on the SAVE half of the edit panel's add-guest
  flow (`INV-GUEST-019`; owner decision 1 Oct 2026, option C).

  `PUT /api/bookings/[id]/modify` resolves its members inside the guest planner,
  so the guard lives there and this suite drives the planner directly. It pins:
  an added free-text guest named as one of the booking OWNER's recorded
  dependants is refused unless a live declaration covers them; a declaration that
  describes no collision is refused as tampering; the guard runs BEFORE the member
  lookup, so its answer never depends on whether another claimed id is a real
  member (#3451 review, B1); the dependants read are the OWNER's on an officer's
  edit, never the officer's; untouched rows are not re-asked about; and an
  approved policy-exception replay is checked against its frozen answers.
*/

const h = vi.hoisted(() => ({
  resolveLinkedBookingMembersWithBoundary: vi.fn(),
  assertLinkedBookingMembersCanBeBooked: vi.fn(),
  getLodgeCapacity: vi.fn(),
  assertNoBookingMemberNightConflicts: vi.fn(),
  memberFindMany: vi.fn(),
}));

vi.mock("@/lib/booking-guests", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("@/lib/booking-guests");
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

import {
  DEPENDANT_IDENTITY_DECLARATION_INVALID_CODE,
  DEPENDANT_IDENTITY_UNRESOLVED_CODE,
  DIFFERENT_PERSON_SAME_NAME,
  OwnDependantIdentityRefusedError,
} from "@/lib/booking-dependant-identity";
import { prepareGuestPlan } from "@/lib/booking-modify-plan";
import { dateOnlyInstantOf, requireCalendarDate } from "@/lib/club-time";

const FIXTURE_CLUB_TODAY = dateOnlyInstantOf(requireCalendarDate("2026-07-01"));
const CHECK_IN = new Date("2026-08-10T00:00:00.000Z");
const CHECK_OUT = new Date("2026-08-12T00:00:00.000Z");

const OWNER = "owner-1";
const DEPENDANT = { id: "dep-sam", firstName: "Sam", lastName: "Smith" };

function existingGuest(id: string, firstName: string, lastName: string) {
  return {
    id,
    firstName,
    lastName,
    ageTier: "ADULT",
    isMember: false,
    memberId: null,
    stayStart: CHECK_IN,
    stayEnd: CHECK_OUT,
    nights: [
      { stayDate: CHECK_IN, priceCents: 5000, priceSource: "SOLD" },
      {
        stayDate: new Date("2026-08-11T00:00:00.000Z"),
        priceCents: 5000,
        priceSource: "SOLD",
      },
    ],
  };
}

function booking(guests = [existingGuest("g1", "Pat", "Owner")]) {
  return {
    id: "booking-1",
    memberId: OWNER,
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

// The transaction client the planner is handed. `member.findMany` is THE seam:
// it is what `loadBookerDependants` reads, on `tx`, never on a second client.
// The family-group read is downstream of the guard (the cross-family marker on a
// member-linked row) and answers "no groups" here.
const tx = {
  member: { findMany: h.memberFindMany },
  familyGroupMember: { findMany: vi.fn().mockResolvedValue([]) },
} as never;

function resolved(memberIds: string[]) {
  return {
    members: new Map(
      memberIds.map((id) => [
        id,
        { id, ageTier: "CHILD", firstName: "Sam", lastName: "Smith" },
      ]),
    ),
    boundary: { scopeByMemberId: new Map(), beyondFamilyMemberIds: [] },
  };
}

function addGuest(
  firstName: string,
  lastName: string,
  extra: Record<string, unknown> = {},
) {
  return {
    firstName,
    lastName,
    ageTier: "CHILD" as const,
    isMember: false,
    ...extra,
  };
}

async function plan(
  input: Record<string, unknown>,
  actor: { role: "ADMIN" | "MEMBER"; id: string } = { role: "MEMBER", id: OWNER },
  bookingFixture = booking(),
) {
  return prepareGuestPlan(tx, {
    today: FIXTURE_CLUB_TODAY,
    format: CLUB_FORMAT_TEST,
    booking: bookingFixture as never,
    role: actor.role as never,
    actorId: actor.id,
    input: input as never,
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
}

async function refusalOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (error instanceof OwnDependantIdentityRefusedError) return error;
    throw error;
  }
  return null;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.resolveLinkedBookingMembersWithBoundary.mockResolvedValue(resolved([]));
  h.assertLinkedBookingMembersCanBeBooked.mockResolvedValue(undefined);
  h.getLodgeCapacity.mockResolvedValue(20);
  h.assertNoBookingMemberNightConflicts.mockResolvedValue(undefined);
  h.memberFindMany.mockResolvedValue([DEPENDANT]);
});

describe("#3451: the modify save refuses an added guest named as the owner's dependant", () => {
  it("refuses an unanswered collision, reading the OWNER's dependants on tx", async () => {
    const refusal = await refusalOf(
      plan({ addGuests: [addGuest("  sam ", "SMITH")] }),
    );

    expect(refusal).not.toBeNull();
    expect(refusal?.refusal.code).toBe(DEPENDANT_IDENTITY_UNRESOLVED_CODE);
    expect(refusal?.refusal.status).toBe(409);
    expect(refusal?.ownerMemberId).toBe(OWNER);
    // The candidate set is the owner's own parent links, nothing wider.
    expect(h.memberFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [{ parentMemberId: OWNER }, { secondaryParentId: OWNER }],
        }),
      }),
    );
    // Stopped before the person-night guard, so nothing downstream ran.
    expect(h.assertNoBookingMemberNightConflicts).not.toHaveBeenCalled();
  });

  it("accepts the edit once the member says it is a different person", async () => {
    const refusal = await refusalOf(
      plan({
        addGuests: [addGuest("Sam", "Smith")],
        dependantIdentityDeclarations: [
          {
            kind: DIFFERENT_PERSON_SAME_NAME,
            dependantMemberId: DEPENDANT.id,
            normalizedName: "sam smith",
          },
        ],
      }),
    );
    expect(refusal).toBeNull();
  });

  it("accepts the edit once the row is moved onto the member path (it resolved)", async () => {
    h.resolveLinkedBookingMembersWithBoundary.mockResolvedValue(
      resolved([DEPENDANT.id]),
    );
    const refusal = await refusalOf(
      plan({
        addGuests: [
          addGuest("Sam", "Smith", { isMember: true, memberId: DEPENDANT.id }),
        ],
      }),
    );
    expect(refusal).toBeNull();
  });

  it("leaves a CLAIMED member id to the member lookup, which refuses one that does not resolve", async () => {
    h.resolveLinkedBookingMembersWithBoundary.mockRejectedValue(
      new Error("Linked member is inactive or not found"),
    );
    await expect(
      plan({
        addGuests: [
          addGuest("Sam", "Smith", { isMember: true, memberId: "made-up" }),
        ],
      }),
    ).rejects.toThrow("Linked member is inactive or not found");
  });

  // B1: the membership-existence oracle. Same answer whether X resolves or not,
  // because the guard answers before the lookup runs at all.
  it.each([
    ["X is a real member", () =>
      h.resolveLinkedBookingMembersWithBoundary.mockResolvedValue(resolved(["member-x"]))],
    ["X is nobody", () =>
      h.resolveLinkedBookingMembersWithBoundary.mockRejectedValue(new Error("not found"))],
  ])("answers identically whether another claimed id resolves (%s)", async (_label, arrange) => {
    arrange();
    const refusal = await refusalOf(
      plan({
        addGuests: [
          addGuest("Grace", "Hopper", { isMember: true, memberId: "member-x" }),
          addGuest("Sam", "Smith"),
        ],
      }),
    );
    expect(refusal?.refusal.code).toBe(DEPENDANT_IDENTITY_UNRESOLVED_CODE);
    expect(h.resolveLinkedBookingMembersWithBoundary).not.toHaveBeenCalled();
  });

  it("refuses a declaration about a dependant the owner does not have", async () => {
    const refusal = await refusalOf(
      plan({
        addGuests: [addGuest("Sam", "Smith")],
        dependantIdentityDeclarations: [
          {
            kind: DIFFERENT_PERSON_SAME_NAME,
            dependantMemberId: "somebody-else",
            normalizedName: "sam smith",
          },
        ],
      }),
    );
    expect(refusal?.refusal.code).toBe(
      DEPENDANT_IDENTITY_DECLARATION_INVALID_CODE,
    );
    expect(refusal?.refusal.status).toBe(400);
  });

  it("refuses a declaration parked on an edit with no colliding guest", async () => {
    const refusal = await refusalOf(
      plan({
        addGuests: [addGuest("Alex", "Brown")],
        dependantIdentityDeclarations: [
          {
            kind: DIFFERENT_PERSON_SAME_NAME,
            dependantMemberId: DEPENDANT.id,
            normalizedName: "sam smith",
          },
        ],
      }),
    );
    expect(refusal?.refusal.code).toBe(
      DEPENDANT_IDENTITY_DECLARATION_INVALID_CODE,
    );
  });

  it("leaves a name that is nobody's dependant alone", async () => {
    const refusal = await refusalOf(
      plan({ addGuests: [addGuest("Alex", "Brown")] }),
    );
    expect(refusal).toBeNull();
  });

  it("does not re-ask about a guest already on the booking", async () => {
    const refusal = await refusalOf(
      plan(
        { addGuests: [addGuest("Alex", "Brown")] },
        { role: "MEMBER", id: OWNER },
        booking([existingGuest("g1", "Sam", "Smith")]),
      ),
    );
    expect(refusal).toBeNull();
  });

  it("guards an officer's edit too, against the OWNER's dependants, and says so", async () => {
    const refusal = await refusalOf(
      plan({ addGuests: [addGuest("Sam", "Smith")] }, { role: "ADMIN", id: "admin-1" }),
    );
    expect(refusal?.refusal.code).toBe(DEPENDANT_IDENTITY_UNRESOLVED_CODE);
    expect(refusal?.ownerMemberId).toBe(OWNER);
    const where = h.memberFindMany.mock.calls[0]?.[0]?.where;
    expect(where.OR).toEqual([
      { parentMemberId: OWNER },
      { secondaryParentId: OWNER },
    ]);
    expect(JSON.stringify(where)).not.toContain("admin-1");
  });

  it("guards an approved policy exception's replay, against its frozen answers", async () => {
    // No answer frozen: the replay is refused, as the save would be.
    const unanswered = await refusalOf(
      plan(
        { addGuests: [addGuest("Sam", "Smith")], reviewedMemberProposal: true },
        { role: "ADMIN", id: "admin-1" },
      ),
    );
    expect(unanswered?.refusal.code).toBe(DEPENDANT_IDENTITY_UNRESOLVED_CODE);

    // The member's answer, frozen on the request and passed back in, holds.
    const answered = await refusalOf(
      plan(
        {
          addGuests: [addGuest("Sam", "Smith")],
          reviewedMemberProposal: true,
          dependantIdentityDeclarations: [
            {
              kind: DIFFERENT_PERSON_SAME_NAME,
              dependantMemberId: DEPENDANT.id,
              normalizedName: "sam smith",
            },
          ],
        },
        { role: "ADMIN", id: "admin-1" },
      ),
    );
    expect(answered).toBeNull();
  });

  it("asks about an existing guest RENAMED onto the dependant's name", async () => {
    const refusal = await refusalOf(
      plan({
        guestUpdates: [{ guestId: "g1", firstName: "Sam", lastName: "Smith" }],
      }),
    );
    expect(refusal?.refusal.code).toBe(DEPENDANT_IDENTITY_UNRESOLVED_CODE);

    const answered = await refusalOf(
      plan({
        guestUpdates: [{ guestId: "g1", firstName: "Sam", lastName: "Smith" }],
        dependantIdentityDeclarations: [
          {
            kind: DIFFERENT_PERSON_SAME_NAME,
            dependantMemberId: DEPENDANT.id,
            normalizedName: "sam smith",
          },
        ],
      }),
    );
    expect(answered).toBeNull();
  });

  it("does not re-ask about a casing fix to a guest already carrying the name", async () => {
    const refusal = await refusalOf(
      plan(
        { guestUpdates: [{ guestId: "g1", firstName: "Sam", lastName: "SMITH" }] },
        { role: "MEMBER", id: OWNER },
        booking([existingGuest("g1", "sam", "smith")]),
      ),
    );
    expect(refusal).toBeNull();
  });

  it("pays nothing on an all-member edit with no declaration", async () => {
    h.resolveLinkedBookingMembersWithBoundary.mockResolvedValue(
      resolved([DEPENDANT.id]),
    );
    await refusalOf(
      plan({
        addGuests: [
          addGuest("Sam", "Smith", { isMember: true, memberId: DEPENDANT.id }),
        ],
      }),
    );
    expect(h.memberFindMany).not.toHaveBeenCalled();
  });
});

/*
  #3770 — owner decision "only agreed adults count", on the modify plan. A
  booking whose only adult is a member guest from beyond the family who has NOT
  agreed yet is minors-only for the adult-supervision rule, as children alone
  would be; the same plan with that adult agreed is not. Read through the plan's
  own stored/planned consent facts, the ones its paid-up-adult check uses.
*/
describe("#3770: the modify plan does not count a pending outsider adult", () => {
  function outsiderAdult(consentStatus: "PENDING" | "CONFIRMED") {
    return {
      ...existingGuest("g2", "Grace", "Hopper"),
      isMember: true,
      memberId: "member-x",
      consentStatus,
    };
  }
  function minorsPlusOutsider(consentStatus: "PENDING" | "CONFIRMED") {
    return booking([
      { ...existingGuest("g1", "Kid", "Owner"), ageTier: "CHILD", consentStatus: null },
      outsiderAdult(consentStatus),
    ] as never);
  }

  it("flags the booking for review when the only adult has not agreed yet", async () => {
    const result = await plan(
      { memberReviewJustification: "Grandad is coming" },
      { role: "MEMBER", id: OWNER },
      minorsPlusOutsider("PENDING"),
    );
    expect((result as { requiresAdminReview: boolean }).requiresAdminReview).toBe(true);
  });

  it("CONTROL: an outsider adult who has agreed still counts", async () => {
    const result = await plan(
      { memberReviewJustification: "Grandad is coming" },
      { role: "MEMBER", id: OWNER },
      minorsPlusOutsider("CONFIRMED"),
    );
    expect((result as { requiresAdminReview: boolean }).requiresAdminReview).toBe(false);
  });
});
