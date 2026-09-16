import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseDateOnly } from "@/lib/date-only";

/**
 * Custodian bed hold — write-side validation (#2286).
 *
 * The hut-leaders form is where a hold is created, so this is where a bad hold
 * has to be stopped: an inactive or other-lodge bed, a bed another custodian
 * already holds on a covered night, and a bed with guests already allocated on
 * it. The last one is a HARD refusal rather than an eviction — displacing a
 * guest a human placed is not a form's decision to make.
 *
 * The over-capacity case is deliberately warn-and-confirm rather than a
 * refusal (#1668 precedent): a custodian genuinely does sleep in the lodge, so
 * a full night is legitimate — the admin just has to see it first.
 */

const mocks = vi.hoisted(() => ({
  hutLeaderAssignmentFindMany: vi.fn(),
  lodgeBedFindUnique: vi.fn(),
  bedAllocationFindMany: vi.fn(),
  bookingFindMany: vi.fn(),
  // #2286 review M5: the over-capacity confirmation ALSO reads the live
  // bookings its per-night figures cannot count (the #177 override-settle blind
  // spot). Its own spy, dispatched on the `capacityOverriddenAt` filter, so the
  // capacity-holding population stays exactly what each case sets.
  overriddenBookingFindMany: vi.fn(),
  // #2698: the whole-lodge hold read behind `findWholeLodgeHoldAmendments`,
  // dispatched on its own `wholeLodgeHold` filter so the occupancy population
  // each case sets stays exactly what it was.
  holdBookingFindMany: vi.fn(),
  getLodgeCapacity: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/lodge-capacity", () => ({
  getLodgeCapacity: mocks.getLodgeCapacity,
}));

import {
  custodianAssignmentNights,
  CustodianBedHoldError,
  CustodianOverCapacityConfirmationRequiredError,
  findWholeLodgeHoldAmendments,
  validateCustodianBedHold,
  wholeLodgeHoldAmendmentNights,
} from "@/lib/custodian-assignment";

const LODGE = "lodge-a";
const OTHER_LODGE = "lodge-b";

function db() {
  return {
    hutLeaderAssignment: { findMany: mocks.hutLeaderAssignmentFindMany },
    lodgeBed: { findUnique: mocks.lodgeBedFindUnique },
    bedAllocation: { findMany: mocks.bedAllocationFindMany },
    booking: {
      findMany: (args: { where?: Record<string, unknown> }) => {
        if (args?.where && "capacityOverriddenAt" in args.where) {
          return mocks.overriddenBookingFindMany(args);
        }
        if (args?.where && "wholeLodgeHold" in args.where) {
          return mocks.holdBookingFindMany(args);
        }
        return mocks.bookingFindMany(args);
      },
    },
  } as never;
}

function bed(overrides: Partial<{ active: boolean; roomActive: boolean; lodgeId: string }> = {}) {
  return {
    id: "bed-1",
    name: "A1",
    active: overrides.active ?? true,
    room: {
      id: "room-1",
      name: "Kea",
      active: overrides.roomActive ?? true,
      lodgeId: overrides.lodgeId ?? LODGE,
    },
  };
}

function validate(overrides: Record<string, unknown> = {}) {
  return validateCustodianBedHold({
    bedId: "bed-1",
    lodgeId: LODGE,
    startDate: parseDateOnly("2026-07-02"),
    endDate: parseDateOnly("2026-07-04"),
    db: db(),
    ...overrides,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.lodgeBedFindUnique.mockResolvedValue(bed());
  mocks.hutLeaderAssignmentFindMany.mockResolvedValue([]);
  mocks.bedAllocationFindMany.mockResolvedValue([]);
  mocks.bookingFindMany.mockResolvedValue([]);
  mocks.overriddenBookingFindMany.mockResolvedValue([]);
  mocks.getLodgeCapacity.mockResolvedValue(10);
});

describe("custodianAssignmentNights", () => {
  it("includes the endDate night itself", () => {
    const nights = custodianAssignmentNights(
      parseDateOnly("2026-07-02"),
      parseDateOnly("2026-07-04"),
    );
    expect(nights).toHaveLength(3);
  });
});

describe("validateCustodianBedHold", () => {
  it("does nothing at all for a role-only assignment — the pre-#2286 path", async () => {
    await expect(validate({ bedId: null })).resolves.toBeUndefined();
    expect(mocks.lodgeBedFindUnique).not.toHaveBeenCalled();
  });

  it("refuses an inactive bed", async () => {
    mocks.lodgeBedFindUnique.mockResolvedValue(bed({ active: false }));
    await expect(validate()).rejects.toMatchObject({
      name: "CustodianBedHoldError",
      code: "BED_NOT_FOUND",
      status: 404,
    });
  });

  it("refuses a bed in an inactive room", async () => {
    mocks.lodgeBedFindUnique.mockResolvedValue(bed({ roomActive: false }));
    await expect(validate()).rejects.toBeInstanceOf(CustodianBedHoldError);
  });

  it("refuses a bed at another lodge, and says to clear the bed before changing lodges", async () => {
    mocks.lodgeBedFindUnique.mockResolvedValue(bed({ lodgeId: OTHER_LODGE }));
    await expect(validate()).rejects.toMatchObject({
      code: "BED_WRONG_LODGE",
      message: expect.stringContaining("Clear the bed"),
    });
  });

  it("refuses a bed another custodian already holds on a covered night — a handover overlap is allowed only on DIFFERENT beds", async () => {
    mocks.hutLeaderAssignmentFindMany.mockResolvedValue([
      {
        id: "other-assignment",
        memberId: "m2",
        lodgeId: LODGE,
        bedId: "bed-1",
        startDate: parseDateOnly("2026-07-04"),
        endDate: parseDateOnly("2026-07-09"),
        member: { firstName: "Other", lastName: "Custodian", ageTier: "ADULT" },
        bed: {
          id: "bed-1",
          name: "A1",
          roomId: "room-1",
          room: { id: "room-1", name: "Kea" },
        },
      },
    ]);

    await expect(validate()).rejects.toMatchObject({
      code: "BED_HELD_BY_ANOTHER_CUSTODIAN",
      nights: ["2026-07-04"],
    });
  });

  it("does not conflict with its OWN hold when the assignment is being edited", async () => {
    mocks.hutLeaderAssignmentFindMany.mockResolvedValue([
      {
        id: "being-edited",
        memberId: "m1",
        lodgeId: LODGE,
        bedId: "bed-1",
        startDate: parseDateOnly("2026-07-02"),
        endDate: parseDateOnly("2026-07-04"),
        member: { firstName: "Sam", lastName: "Ranger", ageTier: "ADULT" },
        bed: {
          id: "bed-1",
          name: "A1",
          roomId: "room-1",
          room: { id: "room-1", name: "Kea" },
        },
      },
    ]);

    await expect(
      validate({ assignmentId: "being-edited" }),
    ).resolves.toBeUndefined();
  });

  it("HARD refuses a bed with guests already allocated, listing the dates rather than evicting anyone", async () => {
    mocks.bedAllocationFindMany.mockResolvedValue([
      { stayDate: parseDateOnly("2026-07-03") },
    ]);

    await expect(validate()).rejects.toMatchObject({
      code: "BED_HAS_ALLOCATIONS",
      nights: ["2026-07-03"],
      message: expect.stringContaining("bed allocation page"),
    });
  });

  it("warns and asks for confirmation when the hold tips a night past capacity", async () => {
    mocks.getLodgeCapacity.mockResolvedValue(1);
    mocks.bookingFindMany.mockResolvedValue([
      {
        checkIn: parseDateOnly("2026-07-02"),
        checkOut: parseDateOnly("2026-07-03"),
        guests: [
          {
            stayStart: parseDateOnly("2026-07-02"),
            stayEnd: parseDateOnly("2026-07-03"),
            nights: [],
          },
        ],
      },
    ]);

    await expect(validate()).rejects.toBeInstanceOf(
      CustodianOverCapacityConfirmationRequiredError,
    );
  });

  it("names the live bookings its own figures cannot count (#177 blind spot)", async () => {
    // The per-night arithmetic uses capacityHoldingBookingFilter(), so an
    // overridden PAYMENT_PENDING booking contributes NOTHING to the number the
    // admin is asked to accept — yet the settlement carve-out will admit it onto
    // exactly these nights. A confirmation that hides it understates what is
    // being accepted.
    mocks.getLodgeCapacity.mockResolvedValue(1);
    mocks.bookingFindMany.mockResolvedValue([
      {
        checkIn: parseDateOnly("2026-07-02"),
        checkOut: parseDateOnly("2026-07-03"),
        guests: [
          {
            stayStart: parseDateOnly("2026-07-02"),
            stayEnd: parseDateOnly("2026-07-03"),
            nights: [],
          },
        ],
      },
    ]);
    mocks.overriddenBookingFindMany.mockResolvedValue([
      {
        id: "booking-override",
        checkIn: parseDateOnly("2026-07-03"),
        checkOut: parseDateOnly("2026-07-05"),
        status: "PAYMENT_PENDING",
        member: { firstName: "Pat", lastName: "Payer", email: "pat@x.nz" },
        _count: { guests: 3 },
      },
    ]);

    await expect(validate()).rejects.toMatchObject({
      code: "CUSTODIAN_OVER_CAPACITY_CONFIRM_REQUIRED",
      nonHoldingBookings: [
        {
          id: "booking-override",
          memberName: "Pat Payer",
          checkIn: "2026-07-03",
          checkOut: "2026-07-05",
          guestCount: 3,
          status: "PAYMENT_PENDING",
        },
      ],
    });
  });

  it("does not pay for that extra read when the hold fits inside capacity", async () => {
    // It only matters when we are ABOUT to ask, so an ordinary within-capacity
    // hold must not run the query at all.
    await expect(validate()).resolves.toBeUndefined();
    expect(mocks.overriddenBookingFindMany).not.toHaveBeenCalled();
  });

  it("proceeds once the admin confirms the override", async () => {
    mocks.getLodgeCapacity.mockResolvedValue(1);
    mocks.bookingFindMany.mockResolvedValue([
      {
        checkIn: parseDateOnly("2026-07-02"),
        checkOut: parseDateOnly("2026-07-03"),
        guests: [
          {
            stayStart: parseDateOnly("2026-07-02"),
            stayEnd: parseDateOnly("2026-07-03"),
            nights: [],
          },
        ],
      },
    ]);

    await expect(
      validate({ confirmOverCapacity: true }),
    ).resolves.toBeUndefined();
  });

  it("counts OTHER custodians toward the ceiling too — three custodians is three beds", async () => {
    mocks.getLodgeCapacity.mockResolvedValue(2);
    const otherHold = [
      {
        id: "other-assignment",
        memberId: "m2",
        lodgeId: LODGE,
        // A DIFFERENT bed, so it is not a same-bed clash — but it is still an
        // occupant on those nights.
        bedId: "bed-2",
        startDate: parseDateOnly("2026-07-02"),
        endDate: parseDateOnly("2026-07-04"),
        member: { firstName: "Other", lastName: "Custodian", ageTier: "ADULT" },
        bed: {
          id: "bed-2",
          name: "A2",
          roomId: "room-1",
          room: { id: "room-1", name: "Kea" },
        },
      },
    ];
    // The same-bed clash query filters to bed-1, so it must see nothing; the
    // lodge-wide occupancy query must see the other custodian.
    mocks.hutLeaderAssignmentFindMany.mockImplementation(
      async (args: { where: { bedId?: { in?: string[] } } }) =>
        args.where.bedId?.in ? [] : otherHold,
    );
    mocks.bookingFindMany.mockResolvedValue([
      {
        checkIn: parseDateOnly("2026-07-02"),
        checkOut: parseDateOnly("2026-07-05"),
        guests: [
          {
            stayStart: parseDateOnly("2026-07-02"),
            stayEnd: parseDateOnly("2026-07-05"),
            nights: [],
          },
        ],
      },
    ]);

    // 1 guest + 1 other custodian + this hold = 3 for 2 beds.
    await expect(validate()).rejects.toBeInstanceOf(
      CustodianOverCapacityConfirmationRequiredError,
    );
  });
});

/**
 * #2698 — which existing whole-lodge holds a custodian bed hold would narrow.
 *
 * Two date conventions meet here and neither is converted by hand: a custodian
 * assignment bands inclusive-inclusive covered DAYS, a whole-lodge hold spans
 * the half-open booking envelope `[checkIn, checkOut)` because a `checkOut` is
 * a departure morning. Each side's own predicate applies its own convention,
 * so the boundary cases below are the real test of that rather than of
 * arithmetic written twice.
 */
describe("findWholeLodgeHoldAmendments (#2698)", () => {
  /** A capacity-holding whole-lodge hold, as `booking.findMany` returns it. */
  function holdRow(overrides: Record<string, unknown> = {}) {
    return {
      id: "booking-hold",
      status: "PAID",
      checkIn: parseDateOnly("2026-07-01"),
      checkOut: parseDateOnly("2026-07-06"),
      lodgeId: LODGE,
      wholeLodgeHold: true,
      originBookingRequest: null,
      adminCapacityHoldAt: null,
      ...overrides,
    };
  }

  /** This assignment's OWN custodian hold, as `findCustodianBedHolds` reads it. */
  function ownHoldRow(startDate: string, endDate: string) {
    return {
      id: "assignment-1",
      memberId: "member-1",
      lodgeId: LODGE,
      bedId: "bed-1",
      startDate: parseDateOnly(startDate),
      endDate: parseDateOnly(endDate),
      member: { firstName: "Sam", lastName: "Leader", ageTier: "ADULT" },
      bed: {
        id: "bed-1",
        name: "A1",
        roomId: "room-1",
        room: { id: "room-1", name: "Kea" },
      },
    };
  }

  function findAmendments(overrides: Record<string, unknown> = {}) {
    return findWholeLodgeHoldAmendments({
      bedId: "bed-1",
      lodgeId: LODGE,
      startDate: parseDateOnly("2026-07-02"),
      endDate: parseDateOnly("2026-07-04"),
      db: db(),
      ...overrides,
    });
  }

  beforeEach(() => {
    mocks.hutLeaderAssignmentFindMany.mockResolvedValue([]);
    mocks.holdBookingFindMany.mockResolvedValue([]);
  });

  it("returns nothing when no whole-lodge hold overlaps", async () => {
    await expect(findAmendments()).resolves.toEqual([]);
  });

  it("names every night the bed would leave the hold's represented set", async () => {
    mocks.holdBookingFindMany.mockResolvedValue([holdRow()]);
    await expect(findAmendments()).resolves.toEqual([
      {
        bookingId: "booking-hold",
        nights: ["2026-07-02", "2026-07-03", "2026-07-04"],
      },
    ]);
  });

  it("stops at the hold's departure morning, which is not a held night", async () => {
    // checkOut 07-03 means the group's last NIGHT is 07-02. A custodian taking
    // the bed on 07-03 and 07-04 narrows nothing.
    mocks.holdBookingFindMany.mockResolvedValue([
      holdRow({ checkOut: parseDateOnly("2026-07-03") }),
    ]);
    await expect(findAmendments()).resolves.toEqual([
      { bookingId: "booking-hold", nights: ["2026-07-02"] },
    ]);
  });

  it("reports each overlapping hold separately, with only its own nights", async () => {
    mocks.holdBookingFindMany.mockResolvedValue([
      holdRow({
        id: "booking-early",
        checkIn: parseDateOnly("2026-07-01"),
        checkOut: parseDateOnly("2026-07-03"),
      }),
      holdRow({
        id: "booking-late",
        checkIn: parseDateOnly("2026-07-04"),
        checkOut: parseDateOnly("2026-07-08"),
      }),
    ]);
    await expect(findAmendments()).resolves.toEqual([
      { bookingId: "booking-early", nights: ["2026-07-02"] },
      { bookingId: "booking-late", nights: ["2026-07-04"] },
    ]);
  });

  it("ignores a hold on a booking that no longer holds capacity", async () => {
    // The blocking predicate is the capacity engine's own, so a hold flag on a
    // cancelled booking narrows nothing — it was blocking nothing either.
    mocks.holdBookingFindMany.mockResolvedValue([
      holdRow({ status: "CANCELLED" }),
    ]);
    await expect(findAmendments()).resolves.toEqual([]);
  });

  it("does not re-ask about nights this assignment already holds", async () => {
    // "New and amended holds only" (owner, 9 Aug 2026). 07-02 and 07-03 left
    // the hold's set when this assignment was created and accepted; only the
    // NEW night 07-04 is a fresh amendment.
    mocks.holdBookingFindMany.mockResolvedValue([holdRow()]);
    mocks.hutLeaderAssignmentFindMany.mockResolvedValue([
      ownHoldRow("2026-07-02", "2026-07-03"),
    ]);
    await expect(
      findAmendments({ assignmentId: "assignment-1" }),
    ).resolves.toEqual([
      { bookingId: "booking-hold", nights: ["2026-07-04"] },
    ]);
  });

  it("asks nothing at all when the edit adds no new custodian night", async () => {
    mocks.holdBookingFindMany.mockResolvedValue([holdRow()]);
    mocks.hutLeaderAssignmentFindMany.mockResolvedValue([
      ownHoldRow("2026-07-01", "2026-07-31"),
    ]);
    await expect(
      findAmendments({ assignmentId: "assignment-1" }),
    ).resolves.toEqual([]);
  });

  it("counts ANOTHER assignment's hold on the same bed as a fresh amendment", async () => {
    // Only this assignment's own coverage is already outside the hold's set.
    // A different assignment's row is not this write, so it is not subtracted —
    // and `validateCustodianBedHold` refuses that overlap before this is ever
    // reached, so it is a belt-and-braces direction, not a live case.
    mocks.holdBookingFindMany.mockResolvedValue([holdRow()]);
    mocks.hutLeaderAssignmentFindMany.mockResolvedValue([
      { ...ownHoldRow("2026-07-02", "2026-07-04"), id: "assignment-other" },
    ]);
    await expect(
      findAmendments({ assignmentId: "assignment-1" }),
    ).resolves.toEqual([
      {
        bookingId: "booking-hold",
        nights: ["2026-07-02", "2026-07-03", "2026-07-04"],
      },
    ]);
  });
});

/** The one-line night list the 409 and the audit row both carry. */
describe("wholeLodgeHoldAmendmentNights", () => {
  it("de-duplicates and sorts across every affected hold", () => {
    expect(
      wholeLodgeHoldAmendmentNights([
        { bookingId: "b1", nights: ["2026-07-03", "2026-07-02"] },
        { bookingId: "b2", nights: ["2026-07-03", "2026-07-05"] },
      ]),
    ).toEqual(["2026-07-02", "2026-07-03", "2026-07-05"]);
  });
});
