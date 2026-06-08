import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  bookingFindUnique: vi.fn(),
  createDraftBooking: vi.fn(),
  logAudit: vi.fn(),
  resolveLinkedBookingMembers: vi.fn(),
  assertLinkedBookingMembersCanBeBooked: vi.fn(),
  normalizeBookingGuestInputs: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: { findUnique: mocks.bookingFindUnique },
    member: { findMany: vi.fn() },
    familyGroupMember: { findMany: vi.fn() },
  },
}));

vi.mock("@/lib/booking-create", () => ({
  createDraftBooking: mocks.createDraftBooking,
}));

vi.mock("@/lib/booking-guests", () => ({
  BookingGuestValidationError: class BookingGuestValidationError extends Error {
    constructor(
      message: string,
      public status: number,
    ) {
      super(message);
    }
  },
  resolveLinkedBookingMembers: mocks.resolveLinkedBookingMembers,
  assertLinkedBookingMembersCanBeBooked:
    mocks.assertLinkedBookingMembersCanBeBooked,
  normalizeBookingGuestInputs: mocks.normalizeBookingGuestInputs,
}));

vi.mock("@/lib/audit", () => ({
  logAudit: mocks.logAudit,
}));

import { copyBookingToDraft } from "@/lib/admin-booking-copy";

function makeSourceBooking(overrides: Record<string, unknown> = {}) {
  return {
    id: "source-booking",
    memberId: "member-1",
    checkIn: new Date("2026-08-01T00:00:00.000Z"),
    checkOut: new Date("2026-08-04T00:00:00.000Z"),
    deletedAt: null,
    notes: "Late arrival",
    expectedArrivalTime: "19:00",
    member: { id: "member-1", active: true },
    guests: [
      {
        id: "guest-1",
        firstName: "Nina",
        lastName: "Visitor",
        ageTier: "ADULT",
        isMember: false,
        memberId: null,
        stayStart: new Date("2026-08-01T00:00:00.000Z"),
        stayEnd: new Date("2026-08-03T00:00:00.000Z"),
      },
      {
        id: "guest-2",
        firstName: "Old",
        lastName: "Member",
        ageTier: "ADULT",
        isMember: true,
        memberId: "member-2",
        stayStart: new Date("2026-08-02T00:00:00.000Z"),
        stayEnd: new Date("2026-08-04T00:00:00.000Z"),
      },
    ],
    ...overrides,
  };
}

describe("copyBookingToDraft", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveLinkedBookingMembers.mockResolvedValue(
      new Map([
        [
          "member-2",
          {
            id: "member-2",
            firstName: "Current",
            lastName: "Member",
            ageTier: "YOUTH",
          },
        ],
      ]),
    );
    mocks.assertLinkedBookingMembersCanBeBooked.mockResolvedValue(undefined);
    mocks.normalizeBookingGuestInputs.mockImplementation((guests, linkedMembers) =>
      guests.map((guest: any) => {
        const linkedMember = guest.memberId
          ? linkedMembers.get(guest.memberId)
          : null;
        return linkedMember
          ? {
              ...guest,
              firstName: linkedMember.firstName,
              lastName: linkedMember.lastName,
              ageTier: linkedMember.ageTier,
              isMember: true,
            }
          : guest;
      }),
    );
    mocks.createDraftBooking.mockResolvedValue({
      id: "draft-copy",
      status: "DRAFT",
    });
  });

  it("creates a draft copy with shifted guest ranges and recalculated creation input", async () => {
    mocks.bookingFindUnique.mockResolvedValue(makeSourceBooking());

    const result = await copyBookingToDraft({
      sourceBookingId: "source-booking",
      targetCheckIn: "2026-09-10",
      adminMemberId: "admin-1",
    });

    expect(result).toEqual({
      bookingId: "draft-copy",
      sourceBookingId: "source-booking",
      checkIn: "2026-09-10",
      checkOut: "2026-09-13",
      status: "DRAFT",
    });
    expect(mocks.createDraftBooking).toHaveBeenCalledWith(
      expect.objectContaining({
        effectiveMemberId: "member-1",
        isOnBehalf: true,
        sessionUserId: "admin-1",
        checkIn: new Date("2026-09-10T00:00:00.000Z"),
        checkOut: new Date("2026-09-13T00:00:00.000Z"),
        notes: "Late arrival",
        expectedArrivalTime: "19:00",
      }),
    );
    const call = mocks.createDraftBooking.mock.calls[0][0];
    expect(call.guests).toEqual([
      expect.objectContaining({
        firstName: "Nina",
        lastName: "Visitor",
        ageTier: "ADULT",
        isMember: false,
        memberId: undefined,
        stayStart: new Date("2026-09-10T00:00:00.000Z"),
        stayEnd: new Date("2026-09-12T00:00:00.000Z"),
      }),
      expect.objectContaining({
        firstName: "Current",
        lastName: "Member",
        ageTier: "YOUTH",
        isMember: true,
        memberId: "member-2",
        stayStart: new Date("2026-09-11T00:00:00.000Z"),
        stayEnd: new Date("2026-09-13T00:00:00.000Z"),
      }),
    ]);
    expect(mocks.logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "booking.copy.created",
        memberId: "admin-1",
        targetId: "draft-copy",
        metadata: expect.objectContaining({
          sourceBookingId: "source-booking",
          copiedBookingId: "draft-copy",
        }),
      }),
    );
  });

  it("rejects deleted source bookings", async () => {
    mocks.bookingFindUnique.mockResolvedValue(
      makeSourceBooking({ deletedAt: new Date("2026-08-10T00:00:00.000Z") }),
    );

    await expect(
      copyBookingToDraft({
        sourceBookingId: "source-booking",
        targetCheckIn: "2026-09-10",
        adminMemberId: "admin-1",
      }),
    ).rejects.toMatchObject({
      message: "Deleted bookings cannot be copied",
      status: 400,
    });
    expect(mocks.createDraftBooking).not.toHaveBeenCalled();
  });
});
