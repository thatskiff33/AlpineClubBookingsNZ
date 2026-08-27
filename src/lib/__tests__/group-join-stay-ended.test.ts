import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BookingStatus,
  GroupBookingPaymentMode,
  GroupBookingStatus,
} from "@prisma/client";

// #1723 path 3 (owner decision A): a group whose stay has fully ended — the
// organiser booking's check-out is on or before NZ today — is excluded from
// the joinable set. Every join write path must refuse before any booking or
// join-request row is created, because a join now could only ever produce a
// retroactive card obligation on a finished stay. These tests exercise the
// real service gates in joinGroupBookingAsMember, createNonMemberJoinRequest,
// and verifyAndCreateNonMemberJoin (the route tests mock the service, so the
// behaviour is pinned here). Mock rig mirrors group-join-lodge-capacity.test.ts.

const mocks = vi.hoisted(() => ({
  groupFindUnique: vi.fn(),
  joinFindUnique: vi.fn(),
  joinFindFirst: vi.fn(),
  joinCount: vi.fn(),
  memberFindUnique: vi.fn(),
  memberFindFirst: vi.fn(),
  getLodgeCapacity: vi.fn(),
  getDefaultLodgeId: vi.fn(),
  resolveLinkedBookingMembers: vi.fn(),
  assertLinkedBookingMembersCanBeBooked: vi.fn(),
  normalizeBookingGuestInputs: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    groupBooking: { findUnique: mocks.groupFindUnique },
    groupBookingJoin: {
      findUnique: mocks.joinFindUnique,
      findFirst: mocks.joinFindFirst,
      count: mocks.joinCount,
    },
    member: {
      findUnique: mocks.memberFindUnique,
      findFirst: mocks.memberFindFirst,
    },
  },
}));

vi.mock("@/lib/lodge-capacity", async () => {
  const actual = await vi.importActual<typeof import("@/lib/lodge-capacity")>(
    "@/lib/lodge-capacity"
  );
  return { ...actual, getLodgeCapacity: mocks.getLodgeCapacity };
});

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

import {
  createNonMemberJoinRequest,
  joinGroupBookingAsMember,
  verifyAndCreateNonMemberJoin,
} from "@/lib/group-booking";
import { addDaysDateOnly, getTodayDateOnly } from "@/lib/date-only";

/** A correctly-formatted (64 hex char) action token for the verify path. */
const VALID_TOKEN = "a".repeat(64);

/** The club's zone, named rather than taken from a helper default (#3123). */
const CLUB_ZONE = "Pacific/Auckland";

// The gate compares against the club's today at call time, so fixture stays
// are derived from it (fixed calendar dates would change meaning as time
// passes): an ended stay checked out yesterday; a live one ends tomorrow.
const endedStay = {
  checkIn: addDaysDateOnly(getTodayDateOnly(CLUB_ZONE), -3),
  checkOut: addDaysDateOnly(getTodayDateOnly(CLUB_ZONE), -1),
};
const liveStay = {
  checkIn: addDaysDateOnly(getTodayDateOnly(CLUB_ZONE), -1),
  checkOut: addDaysDateOnly(getTodayDateOnly(CLUB_ZONE), 1),
};

function openGroup(stay: { checkIn: Date; checkOut: Date }) {
  return {
    id: "group-1",
    status: GroupBookingStatus.OPEN,
    joinDeadline: null,
    paymentMode: GroupBookingPaymentMode.EACH_PAYS_OWN,
    maxJoiners: null,
    organiserMemberId: "organiser-1",
    organiserBooking: {
      id: "booking-1",
      lodgeId: "lodge-1",
      checkIn: stay.checkIn,
      checkOut: stay.checkOut,
      status: BookingStatus.CONFIRMED,
      deletedAt: null,
    },
  };
}

function verifyJoinRow(
  stay: { checkIn: Date; checkOut: Date },
  paymentMode: GroupBookingPaymentMode = GroupBookingPaymentMode.EACH_PAYS_OWN,
) {
  return {
    id: "join-1",
    isMember: false,
    bookingId: null,
    verifiedAt: null,
    verificationTokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
    contactFirstName: "Sam",
    contactLastName: "Guest",
    contactEmail: "sam@example.com",
    contactPhone: null,
    guestsSnapshot: [
      { firstName: "Sam", lastName: "Guest", ageTier: "ADULT" },
    ],
    groupBooking: {
      status: GroupBookingStatus.OPEN,
      joinDeadline: null,
      paymentMode,
      organiserBooking: {
        id: "booking-1",
        checkIn: stay.checkIn,
        checkOut: stay.checkOut,
        status: BookingStatus.CONFIRMED,
        deletedAt: null,
        lodgeId: "lodge-1",
      },
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getLodgeCapacity.mockResolvedValue(4);
  mocks.getDefaultLodgeId.mockResolvedValue("lodge-default");
  mocks.joinFindFirst.mockResolvedValue(null);
  mocks.memberFindFirst.mockResolvedValue(null);
  mocks.memberFindUnique.mockResolvedValue({ ageTier: "ADULT" });
  mocks.resolveLinkedBookingMembers.mockResolvedValue([]);
  mocks.assertLinkedBookingMembersCanBeBooked.mockResolvedValue(undefined);
  mocks.normalizeBookingGuestInputs.mockImplementation((guests: unknown[]) =>
    guests.map((g) => ({ ...(g as object), isMember: true }))
  );
});

describe("joinGroupBookingAsMember refuses a fully ended stay", () => {
  const guests = [
    { firstName: "Jo", lastName: "Member", ageTier: "ADULT" as const, isMember: true },
  ];

  it("throws 409 when the group's stay has ended", async () => {
    mocks.groupFindUnique.mockResolvedValue(openGroup(endedStay));

    await expect(
      joinGroupBookingAsMember({ code: "ABCD2345", guests }, "joiner-1", "MEMBER")
    ).rejects.toMatchObject({
      message: "This group's stay has ended",
      status: 409,
    });
    // Refused before any joiner/roster reads — the gate sits directly after
    // the isGroupJoinable check.
    expect(mocks.joinFindFirst).not.toHaveBeenCalled();
  });

  it("lets a still-running stay through the gate (fails later, at the guest cap)", async () => {
    mocks.groupFindUnique.mockResolvedValue(openGroup(liveStay));

    // Five guests against a capacity of four: reaching the cap error proves
    // the ended-stay gate passed a stay that checks out tomorrow.
    const tooMany = Array.from({ length: 5 }, (_, i) => ({
      firstName: `Guest${i}`,
      lastName: "Test",
      ageTier: "ADULT" as const,
      isMember: true,
    }));
    await expect(
      joinGroupBookingAsMember(
        { code: "ABCD2345", guests: tooMany },
        "joiner-1",
        "MEMBER"
      )
    ).rejects.toMatchObject({
      message: "A booking cannot exceed 4 guests",
    });
  });
});

describe("createNonMemberJoinRequest refuses a fully ended stay", () => {
  const input = {
    code: "ABCD2345",
    contactFirstName: "Sam",
    contactLastName: "Guest",
    contactEmail: "sam@example.com",
    guests: [{ firstName: "Sam", lastName: "Guest", ageTier: "ADULT" as const }],
  };

  it("throws 409 GROUP_STAY_ENDED when the group's stay has ended", async () => {
    mocks.groupFindUnique.mockResolvedValue(openGroup(endedStay));

    await expect(createNonMemberJoinRequest(input)).rejects.toMatchObject({
      message: "This group's stay has ended",
      status: 409,
      code: "GROUP_STAY_ENDED",
    });
    // No member-email lookup: the gate fires before contact processing.
    expect(mocks.memberFindFirst).not.toHaveBeenCalled();
  });

  it("lets a still-running stay through the gate (fails later, at the guest cap)", async () => {
    mocks.groupFindUnique.mockResolvedValue(openGroup(liveStay));

    await expect(
      createNonMemberJoinRequest({
        ...input,
        guests: Array.from({ length: 5 }, (_, i) => ({
          firstName: `Guest${i}`,
          lastName: "Test",
          ageTier: "ADULT" as const,
        })),
      })
    ).rejects.toMatchObject({
      message: "A booking cannot exceed 4 guests",
    });
  });
});

describe("verifyAndCreateNonMemberJoin refuses a fully ended stay", () => {
  it("returns not_joinable when the stay ended after the verification email went out", async () => {
    mocks.joinFindUnique.mockResolvedValue(verifyJoinRow(endedStay));

    await expect(verifyAndCreateNonMemberJoin(VALID_TOKEN)).resolves.toEqual({
      outcome: "not_joinable",
      message: "This group's stay has ended",
    });
  });

  it("keeps gate precedence: ended-stay beats the payment-mode gate", async () => {
    // An ended ORGANISER_PAYS group reports the ended stay, not the
    // individual-sign-ups message — the ended gate sits directly after
    // isGroupJoinable, ahead of the payment-mode/active-booking checks.
    mocks.joinFindUnique.mockResolvedValue(
      verifyJoinRow(endedStay, GroupBookingPaymentMode.ORGANISER_PAYS),
    );

    await expect(verifyAndCreateNonMemberJoin(VALID_TOKEN)).resolves.toEqual({
      outcome: "not_joinable",
      message: "This group's stay has ended",
    });
  });

  it("lets a still-running stay through to the next gate", async () => {
    // A live ORGANISER_PAYS group fails on payment mode, proving the
    // ended-stay gate passed a stay that checks out tomorrow.
    mocks.joinFindUnique.mockResolvedValue(
      verifyJoinRow(liveStay, GroupBookingPaymentMode.ORGANISER_PAYS),
    );

    await expect(verifyAndCreateNonMemberJoin(VALID_TOKEN)).resolves.toEqual({
      outcome: "not_joinable",
      message: "This group is not accepting individual sign-ups",
    });
  });
});
