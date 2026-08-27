import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BookingStatus,
  GroupBookingPaymentMode,
  GroupBookingStatus,
} from "@prisma/client";

// Regression coverage for the production-readiness review §1.4: the group-join
// guest-cap checks in joinGroupBookingAsMember + createNonMemberJoinRequest now
// size the cap against the GROUP'S lodge capacity, not the club default lodge.
// The real availability check later is lodge-scoped either way (so there was
// never an overbooking risk), but the cap threshold and its error message were
// wrong for non-default lodges. These tests pin that getLodgeCapacity is called
// with the group's own lodgeId and that the default-lodge lookup is skipped
// when the group already carries a lodge.

const mocks = vi.hoisted(() => ({
  groupFindUnique: vi.fn(),
  memberFindUnique: vi.fn(),
  memberFindFirst: vi.fn(),
  joinFindFirst: vi.fn(),
  joinCount: vi.fn(),
  getLodgeCapacity: vi.fn(),
  getDefaultLodgeId: vi.fn(),
  resolveLinkedBookingMembers: vi.fn(),
  assertLinkedBookingMembersCanBeBooked: vi.fn(),
  normalizeBookingGuestInputs: vi.fn(),
  validateMinimumStay: vi.fn(),
  assertMembershipTypeBookingAllowed: vi.fn(),
  requiresPaidSubscriptionForMemberForBooking: vi.fn(),
  findUnpaidMemberGuests: vi.fn(),
  createConfirmedBooking: vi.fn(),
  evaluateProposedAdultMemberHosting: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    groupBooking: { findUnique: mocks.groupFindUnique },
    groupDiscountSetting: { findUnique: vi.fn().mockResolvedValue(null) },
    groupBookingJoin: {
      findFirst: mocks.joinFindFirst,
      count: mocks.joinCount,
    },
    member: {
      findUnique: mocks.memberFindUnique,
      findFirst: mocks.memberFindFirst,
    },
  },
}));

// Partial mock: only override getLodgeCapacity; keep FALLBACK_LODGE_CAPACITY
// et al so other importers (email registry) still resolve.
vi.mock("@/lib/lodge-capacity", async () => {
  const actual = await vi.importActual<typeof import("@/lib/lodge-capacity")>(
    "@/lib/lodge-capacity"
  );
  return { ...actual, getLodgeCapacity: mocks.getLodgeCapacity };
});

// Partial mock: keep lodgeNullTolerantScope et al intact; only spy on the
// default-lodge fallback so we can assert the group's lodge is used instead.
vi.mock("@/lib/lodges", async () => {
  const actual = await vi.importActual<typeof import("@/lib/lodges")>(
    "@/lib/lodges"
  );
  return { ...actual, getDefaultLodgeId: mocks.getDefaultLodgeId };
});

vi.mock("@/lib/booking-guests", async () => {
  const actual = await vi.importActual<typeof import("@/lib/booking-guests")>(
    "@/lib/booking-guests"
  );
  return {
    ...actual,
    resolveLinkedBookingMembers: mocks.resolveLinkedBookingMembers,
    assertLinkedBookingMembersCanBeBooked:
      mocks.assertLinkedBookingMembersCanBeBooked,
    normalizeBookingGuestInputs: mocks.normalizeBookingGuestInputs,
  };
});

vi.mock("@/lib/booking-policies", () => ({
  validateMinimumStay: mocks.validateMinimumStay,
  formatViolationsDetail: () => "Lodge B weekends: minimum 2 nights",
}));

vi.mock("@/lib/membership-type-policy", () => ({
  assertMembershipTypeBookingAllowed:
    mocks.assertMembershipTypeBookingAllowed,
  requiresPaidSubscriptionForMemberForBooking:
    mocks.requiresPaidSubscriptionForMemberForBooking,
  priceBookingGuestsWithMembershipTypePolicy: vi.fn(),
}));

vi.mock("@/lib/booking-member-guest-subscriptions", () => ({
  findUnpaidMemberGuests: mocks.findUnpaidMemberGuests,
}));

vi.mock("@/lib/booking-create", async () => {
  const actual = await vi.importActual<typeof import("@/lib/booking-create")>(
    "@/lib/booking-create",
  );
  return { ...actual, createConfirmedBooking: mocks.createConfirmedBooking };
});
vi.mock("@/lib/adult-member-hosting-review", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/adult-member-hosting-review")>();
  return {
    ...actual,
    evaluateProposedAdultMemberHosting:
      mocks.evaluateProposedAdultMemberHosting,
  };
});

import {
  createNonMemberJoinRequest,
  joinGroupBookingAsMember,
  GroupBookingError,
} from "@/lib/group-booking";
import {
  addDaysDateOnly,
  formatDateOnly,
  getTodayDateOnly,
} from "@/lib/date-only";
import {
  HOSTING_COVERAGE_RETRY_CODE,
  HOSTING_COVERAGE_RETRY_MESSAGE,
  HostingCoverageParticipantRetryError,
} from "@/lib/adult-member-hosting-queue-participants";

/**
 * The club's zone, named rather than left to `getTodayDateOnly`'s `APP_TIME_ZONE`
 * default, which #3123 deletes. `group-booking` resolves its own "today" through
 * `readClubTimeZoneOutsideRequest()`; prisma is mocked here with no
 * `clubTimeSettings` delegate, so that read fails soft to the environment seed
 * and then to `Pacific/Auckland` — the same day the ended-stay gate measures
 * from.
 */
const CLUB_ZONE = "Pacific/Auckland";

// Kept relative to the real clock: the ended-stay gate (#1723 path 3) rejects
// joins once the organiser booking's check-out reaches NZ today, so a
// hardcoded calendar date would rot into "This group's stay has ended"
// failures before these tests ever reach the capacity cap they pin.
const checkIn = addDaysDateOnly(getTodayDateOnly(CLUB_ZONE), 30);
const checkOut = addDaysDateOnly(getTodayDateOnly(CLUB_ZONE), 32);

// The group's booking belongs to lodge-b, whose capacity (4) is smaller than
// the default lodge's, so a 5-guest join must fail against 4 — not against the
// default lodge's number.
const LODGE_B = "lodge-b";
const LODGE_B_CAPACITY = 4;

function activeGroup(lodgeId: string | null) {
  return {
    id: "group-1",
    status: GroupBookingStatus.OPEN,
    joinDeadline: null,
    paymentMode: GroupBookingPaymentMode.EACH_PAYS_OWN,
    maxJoiners: null,
    organiserMemberId: "organiser-1",
    organiserBooking: {
      id: "booking-1",
      lodgeId,
      checkIn,
      checkOut,
      status: BookingStatus.CONFIRMED,
      deletedAt: null,
    },
  };
}

function makeGuests(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    firstName: `Guest${i}`,
    lastName: "Test",
    ageTier: "ADULT" as const,
  }));
}

describe("createNonMemberJoinRequest caps against the group's lodge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getLodgeCapacity.mockResolvedValue(LODGE_B_CAPACITY);
    mocks.getDefaultLodgeId.mockResolvedValue("lodge-default");
  });

  it("sizes the cap with the group's lodge, not the default lodge", async () => {
    mocks.groupFindUnique.mockResolvedValue(activeGroup(LODGE_B));

    await expect(
      createNonMemberJoinRequest({
        code: "ABCD2345",
        contactFirstName: "Non",
        contactLastName: "Member",
        contactEmail: "non@example.com",
        guests: makeGuests(LODGE_B_CAPACITY + 1),
      })
    ).rejects.toMatchObject({
      message: `A booking cannot exceed ${LODGE_B_CAPACITY} guests`,
    });

    expect(mocks.getLodgeCapacity).toHaveBeenCalledWith(LODGE_B);
    // Group carries its own lodge, so the default-lodge fallback is not used.
    expect(mocks.getDefaultLodgeId).not.toHaveBeenCalled();
  });

  it("falls back to the default lodge only when the group has no lodge", async () => {
    mocks.groupFindUnique.mockResolvedValue(activeGroup(null));

    await expect(
      createNonMemberJoinRequest({
        code: "ABCD2345",
        contactFirstName: "Non",
        contactLastName: "Member",
        contactEmail: "non@example.com",
        guests: makeGuests(LODGE_B_CAPACITY + 1),
      })
    ).rejects.toBeInstanceOf(GroupBookingError);

    expect(mocks.getDefaultLodgeId).toHaveBeenCalled();
    expect(mocks.getLodgeCapacity).toHaveBeenCalledWith("lodge-default");
  });
});

describe("joinGroupBookingAsMember caps against the group's lodge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getLodgeCapacity.mockResolvedValue(LODGE_B_CAPACITY);
    mocks.getDefaultLodgeId.mockResolvedValue("lodge-default");
    mocks.joinFindFirst.mockResolvedValue(null); // no existing join
    mocks.memberFindUnique.mockResolvedValue({ ageTier: "ADULT" });
    // The booking-guests collaborators are exercised only to reach the cap; the
    // cap runs on the normalised guests, so echo them straight through.
    mocks.resolveLinkedBookingMembers.mockResolvedValue([]);
    mocks.assertLinkedBookingMembersCanBeBooked.mockResolvedValue(undefined);
    mocks.normalizeBookingGuestInputs.mockImplementation((guests: unknown[]) =>
      guests.map((g) => ({ ...(g as object), isMember: true }))
    );
    mocks.assertMembershipTypeBookingAllowed.mockResolvedValue(undefined);
    mocks.requiresPaidSubscriptionForMemberForBooking.mockResolvedValue(false);
    mocks.findUnpaidMemberGuests.mockResolvedValue([]);
    mocks.validateMinimumStay.mockResolvedValue({ valid: true, violations: [] });
    mocks.evaluateProposedAdultMemberHosting.mockResolvedValue(null);
  });

  it("sizes the member-join cap with the group's lodge, not the default lodge", async () => {
    mocks.groupFindUnique.mockResolvedValue(activeGroup(LODGE_B));

    await expect(
      joinGroupBookingAsMember(
        {
          code: "ABCD2345",
          guests: makeGuests(LODGE_B_CAPACITY + 1).map((g) => ({
            ...g,
            memberId: "m-x",
            isMember: true,
          })),
        },
        "joiner-1",
        "MEMBER"
      )
    ).rejects.toMatchObject({
      message: `A booking cannot exceed ${LODGE_B_CAPACITY} guests`,
    });

    expect(mocks.getLodgeCapacity).toHaveBeenCalledWith(LODGE_B);
    expect(mocks.getDefaultLodgeId).not.toHaveBeenCalled();
  });

  it("returns a frozen non-default-lodge policy review before any booking write", async () => {
    const violation = {
      reasonCode: "MINIMUM_STAY",
      policyId: "policy-lodge-b",
      policyVersion: 5,
      policyName: "Lodge B weekends",
      resolvedScope: {
        kind: "LODGE",
        lodgeId: LODGE_B,
        effectiveLodgeId: LODGE_B,
      },
      affectedNights: [formatDateOnly(checkIn)],
      exceptionEligible: true,
      capacityMode: "HOLD",
      message: "Lodge B requires two nights.",
      triggerDay: "Friday",
      minimumNights: 2,
      actualNights: 1,
      requirements: {
        kind: "MINIMUM_STAY",
        minimumNights: 2,
        actualNights: 1,
        triggerDays: [5],
      },
    } as const;
    mocks.groupFindUnique.mockResolvedValue(activeGroup(LODGE_B));
    mocks.validateMinimumStay.mockResolvedValue({
      valid: false,
      violations: [violation],
    });

    await expect(
      joinGroupBookingAsMember(
        {
          code: "ABCD2345",
          guests: [
            {
              firstName: "Jo",
              lastName: "Member",
              ageTier: "ADULT",
              memberId: "joiner-1",
              isMember: true,
            },
          ],
        },
        "joiner-1",
        "MEMBER",
      ),
    ).rejects.toMatchObject({
      status: 400,
      code: "MINIMUM_STAY_VIOLATION",
      details: "Lodge B weekends: minimum 2 nights",
      violations: [violation],
      exceptionReview: { violations: [violation], capacityMode: "HOLD" },
    });

    expect(mocks.validateMinimumStay).toHaveBeenCalledWith(
      checkIn,
      checkOut,
      LODGE_B,
    );
    expect(mocks.evaluateProposedAdultMemberHosting).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        bookingOwnerMemberId: "joiner-1",
        lodgeId: LODGE_B,
      }),
    );
    expect(mocks.createConfirmedBooking).not.toHaveBeenCalled();
  });

  it("translates participant contention from booking creation into the stable group 409", async () => {
    mocks.groupFindUnique.mockResolvedValue(activeGroup(LODGE_B));
    mocks.createConfirmedBooking.mockRejectedValue(
      new HostingCoverageParticipantRetryError(),
    );

    await expect(
      joinGroupBookingAsMember(
        {
          code: "ABCD2345",
          guests: [
            {
              firstName: "Jo",
              lastName: "Member",
              ageTier: "ADULT",
              memberId: "joiner-1",
              isMember: true,
            },
          ],
        },
        "joiner-1",
        "MEMBER",
      ),
    ).rejects.toMatchObject({
      status: 409,
      message: HOSTING_COVERAGE_RETRY_MESSAGE,
      code: HOSTING_COVERAGE_RETRY_CODE,
    });

    // The same authoritative lodge used by the checks above must reach the
    // writer. Without this property a lodge-B group child silently defaults to
    // lodge A even though its policy and capacity were evaluated at B.
    expect(mocks.createConfirmedBooking).toHaveBeenCalledWith(
      expect.objectContaining({ lodgeId: LODGE_B }),
    );
  });
});
