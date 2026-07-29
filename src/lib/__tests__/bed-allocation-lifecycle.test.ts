import { BookingStatus } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import {
  BED_ALLOCATABLE_BOOKING_STATUSES,
  partnerShareSweepCounterpartNames,
  partnerShareSweepNights,
  reconcileBedAllocationsForBooking,
  sweepFuturePartnerSharedAllocations,
} from "@/lib/bed-allocation-lifecycle";
import { parseDateOnly } from "@/lib/date-only";

function makeDb(overrides: Record<string, unknown> = {}) {
  const db: any = {
    clubModuleSettings: {
      findUnique: vi.fn().mockResolvedValue({ bedAllocation: true }),
    },
    booking: {
      findUnique: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
    },
    bedAllocation: {
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      findMany: vi.fn().mockResolvedValue([]),
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
      // #1387 displacement side effects: MOVE updates a provisional row's
      // bed/room; UNALLOCATE deletes it. updateMany/deleteMany are idempotent.
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      delete: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockResolvedValue({}),
      // #1750 prune orphan-promotion survivor lookup; null = no partner stranded,
      // so the default prune tests never promote.
      findFirst: vi.fn().mockResolvedValue(null),
    },
    bedAllocationSettings: {
      findUnique: vi.fn().mockResolvedValue({ autoAllocationEnabled: false }),
    },
    lodgeRoom: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    // #1387 displacement audit trail.
    auditLog: {
      create: vi.fn().mockResolvedValue({}),
    },
    ...overrides,
  };
  // #1387 atomic apply: the lifecycle opens a transaction when the client
  // exposes `$transaction`. Run the callback against this same mock so its
  // updateMany/deleteMany/createMany spies are exercised.
  db.$transaction = vi.fn((cb: (client: unknown) => unknown) => cb(db));
  // #1750: the prune orphan-promotion CAPTURE (findMany) runs on every reconcile;
  // the survivor lookup (findFirst) runs only when that capture found a doomed
  // primary. Guarantee the findFirst seam even when a test fully replaces the
  // bedAllocation object (the #1387 planner overrides); null = no partner
  // stranded, so it is inert.
  if (typeof db.bedAllocation?.findFirst !== "function") {
    db.bedAllocation.findFirst = vi.fn().mockResolvedValue(null);
  }
  return db;
}

// Two rooms of two beds each, in sort order Room A (A1, A2), Room B (B1, B2).
// Shared by the #1387 first-claim displacement tests.
const TWO_ROOMS_TWO_BEDS = [
  {
    id: "room-a",
    name: "Room A",
    sortOrder: 1,
    active: true,
    beds: [
      { id: "bed-a1", roomId: "room-a", name: "A1", sortOrder: 1, active: true },
      { id: "bed-a2", roomId: "room-a", name: "A2", sortOrder: 2, active: true },
    ],
  },
  {
    id: "room-b",
    name: "Room B",
    sortOrder: 2,
    active: true,
    beds: [
      { id: "bed-b1", roomId: "room-b", name: "B1", sortOrder: 1, active: true },
      { id: "bed-b2", roomId: "room-b", name: "B2", sortOrder: 2, active: true },
    ],
  },
];

const NIGHT = parseDateOnly("2026-08-01");
const NIGHT_END = parseDateOnly("2026-08-02");
const NIGHT_UTC = new Date("2026-08-01T00:00:00.000Z");

/** An existing BedAllocation row as returned by the lifecycle's findMany. */
function existingAllocation(opts: {
  bedId: string;
  roomId: string;
  bookingId: string;
  bookingGuestId: string;
  status: BookingStatus;
  isRequestConverted?: boolean;
  ageTier?: string;
  approvedAt?: Date | null;
  stayDate?: Date;
  // #1677 whole-stay displacement inputs: the occupying booking's created-at
  // (newest-first eviction) and stay window (extends-beyond-envelope pinning).
  bookingCreatedAt?: Date;
  bookingCheckIn?: Date;
  bookingCheckOut?: Date;
}) {
  return {
    bedId: opts.bedId,
    bookingId: opts.bookingId,
    bookingGuestId: opts.bookingGuestId,
    roomId: opts.roomId,
    stayDate: opts.stayDate ?? NIGHT,
    approvedAt: opts.approvedAt ?? null,
    booking: {
      status: opts.status,
      originBookingRequest: opts.isRequestConverted ? { id: "req-1" } : null,
      createdAt: opts.bookingCreatedAt,
      checkIn: opts.bookingCheckIn,
      checkOut: opts.bookingCheckOut,
    },
    bookingGuest: { ageTier: opts.ageTier ?? "ADULT" },
  };
}

describe("bed allocation lifecycle", () => {
  it("does not touch allocations when the bed allocation module is disabled", async () => {
    const db = makeDb({
      clubModuleSettings: {
        findUnique: vi.fn().mockResolvedValue({ bedAllocation: false }),
      },
    });

    const result = await reconcileBedAllocationsForBooking({
      bookingId: "booking-1",
      db: db as any,
    });

    expect(result).toEqual({
      enabled: false,
      deletedCount: 0,
      createdCount: 0,
      promotedCount: 0,
    });
    expect(db.booking.findUnique).not.toHaveBeenCalled();
    expect(db.bedAllocation.deleteMany).not.toHaveBeenCalled();
  });

  it("treats completed bookings as allocatable operational stays", () => {
    expect(BED_ALLOCATABLE_BOOKING_STATUSES).toContain(BookingStatus.COMPLETED);
  });

  it("releases all allocations when a booking is no longer allocatable", async () => {
    const db = makeDb();
    db.booking.findUnique.mockResolvedValue({
      id: "booking-1",
      status: BookingStatus.CANCELLED,
      deletedAt: null,
      checkIn: parseDateOnly("2026-07-01"),
      checkOut: parseDateOnly("2026-07-03"),
      guests: [
        {
          id: "guest-1",
          bookingId: "booking-1",
          ageTier: "ADULT",
          stayStart: parseDateOnly("2026-07-01"),
          stayEnd: parseDateOnly("2026-07-03"),
        },
      ],
    });
    db.bedAllocation.deleteMany.mockResolvedValue({ count: 2 });

    const result = await reconcileBedAllocationsForBooking({
      bookingId: "booking-1",
      db: db as any,
    });

    expect(db.bedAllocation.deleteMany).toHaveBeenCalledWith({
      where: { bookingId: "booking-1" },
    });
    expect(result).toEqual({
      enabled: true,
      deletedCount: 2,
      createdCount: 0,
      promotedCount: 0,
    });
  });

  it("prunes stale guest-night allocations and auto-allocates missing valid nights", async () => {
    const db = makeDb({
      bedAllocationSettings: {
        findUnique: vi.fn().mockResolvedValue({ autoAllocationEnabled: true }),
      },
      lodgeRoom: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "room-a",
            name: "Room A",
            sortOrder: 1,
            active: true,
            beds: [
              {
                id: "bed-a1",
                roomId: "room-a",
                name: "A1",
                sortOrder: 1,
                active: true,
              },
            ],
          },
        ]),
      },
    });
    db.booking.findUnique.mockResolvedValue({
      id: "booking-1",
      status: BookingStatus.PAID,
      deletedAt: null,
      checkIn: parseDateOnly("2026-07-01"),
      checkOut: parseDateOnly("2026-07-03"),
      guests: [
        {
          id: "guest-1",
          bookingId: "booking-1",
          ageTier: "ADULT",
          stayStart: parseDateOnly("2026-07-02"),
          stayEnd: parseDateOnly("2026-07-03"),
        },
      ],
    });
    db.booking.findMany.mockResolvedValue([
      {
        id: "booking-1",
        createdAt: new Date("2026-06-01T00:00:00.000Z"),
        // The same spy answers the planner load AND the write-time re-check
        // (#2285 review), so the row must carry the re-check's fields too.
        status: BookingStatus.PAID,
        deletedAt: null,
        wholeLodgeHold: false,
        guests: [
          {
            id: "guest-1",
            bookingId: "booking-1",
            ageTier: "ADULT",
            stayStart: parseDateOnly("2026-07-02"),
            stayEnd: parseDateOnly("2026-07-03"),
          },
        ],
      },
    ]);
    db.bedAllocation.deleteMany.mockResolvedValue({ count: 1 });
    db.bedAllocation.createMany.mockResolvedValue({ count: 1 });

    const result = await reconcileBedAllocationsForBooking({
      bookingId: "booking-1",
      db: db as any,
      previousRange: {
        checkIn: parseDateOnly("2026-07-01"),
        checkOut: parseDateOnly("2026-07-03"),
      },
    });

    expect(db.bedAllocation.deleteMany).toHaveBeenCalledWith({
      where: {
        bookingId: "booking-1",
        OR: [
          { bookingGuestId: { notIn: ["guest-1"] } },
          {
            bookingGuestId: "guest-1",
            stayDate: { lt: parseDateOnly("2026-07-02") },
          },
          {
            bookingGuestId: "guest-1",
            stayDate: { gte: parseDateOnly("2026-07-03") },
          },
        ],
      },
    });
    expect(db.bedAllocation.createMany).toHaveBeenCalledWith({
      data: [
        {
          bookingId: "booking-1",
          bookingGuestId: "guest-1",
          roomId: "room-a",
          bedId: "bed-a1",
          stayDate: parseDateOnly("2026-07-02"),
          source: "AUTO",
        },
      ],
      skipDuplicates: true,
    });
    expect(result).toEqual({
      enabled: true,
      deletedCount: 1,
      createdCount: 1,
      promotedCount: 0,
    });
  });

  it("uses existing adult allocations when auto-filling a missing family minor", async () => {
    const db = makeDb({
      bedAllocationSettings: {
        findUnique: vi.fn().mockResolvedValue({ autoAllocationEnabled: true }),
      },
      lodgeRoom: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "room-a",
            name: "Room A",
            sortOrder: 1,
            active: true,
            beds: [
              {
                id: "bed-a1",
                roomId: "room-a",
                name: "A1",
                sortOrder: 1,
                active: true,
              },
              {
                id: "bed-a2",
                roomId: "room-a",
                name: "A2",
                sortOrder: 2,
                active: true,
              },
            ],
          },
        ]),
      },
    });
    const bookingRecord = {
      id: "booking-family",
      status: BookingStatus.PAID,
      deletedAt: null,
      checkIn: parseDateOnly("2026-07-01"),
      checkOut: parseDateOnly("2026-07-02"),
      guests: [
        {
          id: "adult-1",
          bookingId: "booking-family",
          ageTier: "ADULT",
          stayStart: parseDateOnly("2026-07-01"),
          stayEnd: parseDateOnly("2026-07-02"),
        },
        {
          id: "child-1",
          bookingId: "booking-family",
          ageTier: "CHILD",
          stayStart: parseDateOnly("2026-07-01"),
          stayEnd: parseDateOnly("2026-07-02"),
        },
      ],
    };
    db.booking.findUnique.mockResolvedValue(bookingRecord);
    db.booking.findMany.mockResolvedValue([
      {
        id: bookingRecord.id,
        createdAt: new Date("2026-06-01T00:00:00.000Z"),
        // Also answers the write-time re-check (#2285 review).
        status: bookingRecord.status,
        deletedAt: null,
        wholeLodgeHold: false,
        guests: bookingRecord.guests,
      },
    ]);
    db.bedAllocation.findMany.mockResolvedValue([
      {
        bedId: "bed-a1",
        bookingId: "booking-family",
        bookingGuestId: "adult-1",
        roomId: "room-a",
        stayDate: parseDateOnly("2026-07-01"),
        bookingGuest: { ageTier: "ADULT" },
      },
    ]);
    db.bedAllocation.createMany.mockResolvedValue({ count: 1 });

    const result = await reconcileBedAllocationsForBooking({
      bookingId: "booking-family",
      db: db as any,
    });

    expect(db.bedAllocation.createMany).toHaveBeenCalledWith({
      data: [
        {
          bookingId: "booking-family",
          bookingGuestId: "child-1",
          roomId: "room-a",
          bedId: "bed-a2",
          stayDate: parseDateOnly("2026-07-01"),
          source: "AUTO",
        },
      ],
      skipDuplicates: true,
    });
    expect(result).toEqual({
      enabled: true,
      deletedCount: 0,
      createdCount: 1,
      promotedCount: 0,
    });
  });

  it("threads the SCHOOL request marker: teachers auto-fill together, students separately (#1768)", async () => {
    const roomOf = (id: string, sortOrder: number) => ({
      id,
      name: `Room ${id}`,
      sortOrder,
      active: true,
      beds: [1, 2, 3, 4].map((n) => ({
        id: `bed-${id}-${n}`,
        roomId: id,
        name: `${id}${n}`,
        sortOrder: n,
        active: true,
      })),
    });
    const db = makeDb({
      bedAllocationSettings: {
        findUnique: vi.fn().mockResolvedValue({ autoAllocationEnabled: true }),
      },
      lodgeRoom: {
        findMany: vi
          .fn()
          .mockResolvedValue([roomOf("room-a", 1), roomOf("room-b", 2)]),
      },
    });
    const guest = (id: string, ageTier: string) => ({
      id,
      bookingId: "booking-school",
      ageTier,
      stayStart: parseDateOnly("2026-07-01"),
      stayEnd: parseDateOnly("2026-07-02"),
    });
    const guests = [
      guest("teacher-1", "ADULT"),
      guest("teacher-2", "ADULT"),
      guest("student-1", "YOUTH"),
      guest("student-2", "CHILD"),
      guest("student-3", "YOUTH"),
    ];
    db.booking.findUnique.mockResolvedValue({
      id: "booking-school",
      status: BookingStatus.PAID,
      deletedAt: null,
      checkIn: parseDateOnly("2026-07-01"),
      checkOut: parseDateOnly("2026-07-02"),
      guests,
    });
    db.booking.findMany.mockResolvedValue([
      {
        id: "booking-school",
        createdAt: new Date("2026-06-01T00:00:00.000Z"),
        status: BookingStatus.PAID,
        checkIn: parseDateOnly("2026-07-01"),
        checkOut: parseDateOnly("2026-07-02"),
        requestedRoomId: null,
        originBookingRequest: { id: "req-1", type: "SCHOOL" },
        heldForBookingRequest: null,
        guests,
      },
    ]);
    db.bedAllocation.createMany.mockResolvedValue({ count: 5 });

    await reconcileBedAllocationsForBooking({
      bookingId: "booking-school",
      db: db as any,
    });

    const created = db.bedAllocation.createMany.mock.calls[0][0].data as Array<{
      bookingGuestId: string;
      roomId: string;
    }>;
    expect(created).toHaveLength(5);
    const teacherRooms = new Set(
      created
        .filter((row) => row.bookingGuestId.startsWith("teacher-"))
        .map((row) => row.roomId),
    );
    const studentRooms = new Set(
      created
        .filter((row) => row.bookingGuestId.startsWith("student-"))
        .map((row) => row.roomId),
    );
    expect(teacherRooms.size).toBe(1);
    for (const roomId of studentRooms) {
      expect(teacherRooms.has(roomId)).toBe(false);
    }
  });

  it("prunes nights dropped by a booking date change without re-allocating when auto-allocation is off (issue #816)", async () => {
    // Booking moved from 07-01..07-06 to 07-03..07-06: the first two nights are
    // no longer part of the stay and their allocations must be pruned. Auto
    // allocation is off (default), so the reconcile is prune-only.
    const db = makeDb();
    db.booking.findUnique.mockResolvedValue({
      id: "booking-1",
      status: BookingStatus.PAID,
      deletedAt: null,
      checkIn: parseDateOnly("2026-07-03"),
      checkOut: parseDateOnly("2026-07-06"),
      guests: [
        {
          id: "guest-1",
          bookingId: "booking-1",
          ageTier: "ADULT",
          stayStart: parseDateOnly("2026-07-03"),
          stayEnd: parseDateOnly("2026-07-06"),
        },
      ],
    });
    db.bedAllocation.deleteMany.mockResolvedValue({ count: 2 });

    const result = await reconcileBedAllocationsForBooking({
      bookingId: "booking-1",
      db: db as any,
      previousRange: {
        checkIn: parseDateOnly("2026-07-01"),
        checkOut: parseDateOnly("2026-07-06"),
      },
    });

    expect(db.bedAllocation.deleteMany).toHaveBeenCalledWith({
      where: {
        bookingId: "booking-1",
        OR: [
          { bookingGuestId: { notIn: ["guest-1"] } },
          {
            bookingGuestId: "guest-1",
            stayDate: { lt: parseDateOnly("2026-07-03") },
          },
          {
            bookingGuestId: "guest-1",
            stayDate: { gte: parseDateOnly("2026-07-06") },
          },
        ],
      },
    });
    expect(db.bedAllocation.createMany).not.toHaveBeenCalled();
    expect(result).toEqual({
      enabled: true,
      deletedCount: 2,
      createdCount: 0,
      promotedCount: 0,
    });
  });

  it("prunes a removed guest's allocations via the notIn clause (issue #816)", async () => {
    // guest-2 was removed from the booking; only guest-1 remains. The notIn
    // clause must drop every allocation that no longer belongs to a current
    // guest of the booking.
    const db = makeDb();
    db.booking.findUnique.mockResolvedValue({
      id: "booking-1",
      status: BookingStatus.PAID,
      deletedAt: null,
      checkIn: parseDateOnly("2026-07-01"),
      checkOut: parseDateOnly("2026-07-03"),
      guests: [
        {
          id: "guest-1",
          bookingId: "booking-1",
          ageTier: "ADULT",
          stayStart: parseDateOnly("2026-07-01"),
          stayEnd: parseDateOnly("2026-07-03"),
        },
      ],
    });
    db.bedAllocation.deleteMany.mockResolvedValue({ count: 1 });

    const result = await reconcileBedAllocationsForBooking({
      bookingId: "booking-1",
      db: db as any,
      previousRange: {
        checkIn: parseDateOnly("2026-07-01"),
        checkOut: parseDateOnly("2026-07-03"),
      },
    });

    const pruneCall = db.bedAllocation.deleteMany.mock.calls[0][0];
    expect(pruneCall.where.bookingId).toBe("booking-1");
    expect(pruneCall.where.OR).toContainEqual({
      bookingGuestId: { notIn: ["guest-1"] },
    });
    expect(db.bedAllocation.createMany).not.toHaveBeenCalled();
    expect(result.deletedCount).toBe(1);
    expect(result.createdCount).toBe(0);
  });

  it("scans only the booking's current range after a date shrink, never the old wider range (issue #1686)", async () => {
    // Booking shrank from 07-01..07-05 to 07-01..07-03. Since #1686 the
    // reconcile no longer re-plans the union of the old and new ranges to
    // opportunistically re-fill freed beds for OTHER bookings — pruning drops
    // the stale nights and the planner scan is the CURRENT range only. So the
    // occupancy and overlapping-booking scans cover 07-01..07-03, never the
    // dropped 07-03..07-05 tail. previousRange is retained on the call for API
    // stability but no longer widens the scan.
    const db = makeDb({
      bedAllocationSettings: {
        findUnique: vi.fn().mockResolvedValue({ autoAllocationEnabled: true }),
      },
    });
    db.booking.findUnique.mockResolvedValue({
      id: "booking-1",
      status: BookingStatus.PAID,
      deletedAt: null,
      checkIn: parseDateOnly("2026-07-01"),
      checkOut: parseDateOnly("2026-07-03"),
      guests: [
        {
          id: "guest-1",
          bookingId: "booking-1",
          ageTier: "ADULT",
          stayStart: parseDateOnly("2026-07-01"),
          stayEnd: parseDateOnly("2026-07-03"),
        },
      ],
    });
    db.bedAllocation.deleteMany.mockResolvedValue({ count: 2 });

    const result = await reconcileBedAllocationsForBooking({
      bookingId: "booking-1",
      db: db as any,
      previousRange: {
        checkIn: parseDateOnly("2026-07-01"),
        checkOut: parseDateOnly("2026-07-05"),
      },
    });

    // The existing-allocation scan and the overlapping-booking scan use only the
    // new range 07-01..07-03, not the pre-#1686 union 07-01..07-05. (With no
    // overlapping booking loaded, the #1677 load envelope equals this range.)
    expect(db.bedAllocation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          stayDate: {
            gte: parseDateOnly("2026-07-01"),
            lt: parseDateOnly("2026-07-03"),
          },
        }),
      }),
    );
    expect(db.booking.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          checkIn: { lt: parseDateOnly("2026-07-03") },
          checkOut: { gt: parseDateOnly("2026-07-01") },
        }),
      }),
    );
    expect(result).toEqual({
      enabled: true,
      deletedCount: 2,
      createdCount: 0,
      promotedCount: 0,
    });
  });

  it("auto-places only the reconciled booking's guests, not another overlapping booking's unallocated guest (issue #1686)", async () => {
    // Two unallocated bookings overlap the same night in a two-bed lodge:
    // booking-a (reconciled) and booking-b (an unrelated overlapping booking).
    // Reconciling booking-a auto-places ONLY guest-a; booking-b's guest-b is
    // loaded into the lodge-wide occupancy/envelope scan but is NEVER drafted —
    // that opportunistic lodge-wide fill was the #1686 bug. (On pre-#1686 code
    // this reconcile would draft BOTH guests.)
    const db = makeDb({
      bedAllocationSettings: {
        findUnique: vi.fn().mockResolvedValue({ autoAllocationEnabled: true }),
      },
      lodgeRoom: {
        findMany: vi.fn().mockResolvedValue(TWO_ROOMS_TWO_BEDS),
      },
    });
    db.booking.findUnique.mockResolvedValue({
      id: "booking-a",
      status: BookingStatus.PAID,
      deletedAt: null,
      checkIn: NIGHT,
      checkOut: NIGHT_END,
      guests: [
        {
          id: "guest-a",
          bookingId: "booking-a",
          ageTier: "ADULT",
          stayStart: NIGHT,
          stayEnd: NIGHT_END,
          nights: [],
        },
      ],
    });
    // Both bookings are returned by the lodge-wide overlap scan; only the
    // reconciled one may be placed.
    db.booking.findMany.mockResolvedValue([
      {
        id: "booking-a",
        createdAt: new Date("2026-07-01T00:00:00.000Z"),
        requestedRoomId: null,
        status: BookingStatus.PAID,
        originBookingRequest: null,
        checkIn: NIGHT,
        checkOut: NIGHT_END,
        guests: [
          {
            id: "guest-a",
            bookingId: "booking-a",
            ageTier: "ADULT",
            stayStart: NIGHT,
            stayEnd: NIGHT_END,
            nights: [],
          },
        ],
      },
      {
        id: "booking-b",
        createdAt: new Date("2026-06-01T00:00:00.000Z"),
        requestedRoomId: null,
        status: BookingStatus.PAID,
        originBookingRequest: null,
        checkIn: NIGHT,
        checkOut: NIGHT_END,
        guests: [
          {
            id: "guest-b",
            bookingId: "booking-b",
            ageTier: "ADULT",
            stayStart: NIGHT,
            stayEnd: NIGHT_END,
            nights: [],
          },
        ],
      },
    ]);
    db.bedAllocation.createMany.mockResolvedValue({ count: 1 });

    const result = await reconcileBedAllocationsForBooking({
      bookingId: "booking-a",
      db: db as any,
    });

    const created = db.bedAllocation.createMany.mock.calls[0][0].data;
    expect(created).toEqual([
      {
        bookingId: "booking-a",
        bookingGuestId: "guest-a",
        roomId: "room-a",
        bedId: "bed-a1",
        stayDate: NIGHT_UTC,
        source: "AUTO",
      },
    ]);
    // booking-b's guest is never drafted.
    expect(
      created.some((row: { bookingId: string }) => row.bookingId === "booking-b"),
    ).toBe(false);
    expect(result.createdCount).toBe(1);
  });

  it("prunes and skips the planner entirely when reconciling a cancelled booking (issue #1686)", async () => {
    // A cancelled booking cannot receive allocations, so reconcile takes the
    // fast path: pruning releases its beds, NOTHING is re-planned into them,
    // and no planner queries run at all — cancel flows call this inside their
    // transactions. Freed beds after a cancellation are not auto-refilled
    // (that is the explicit board action).
    const db = makeDb({
      bedAllocationSettings: {
        findUnique: vi.fn().mockResolvedValue({ autoAllocationEnabled: true }),
      },
      lodgeRoom: {
        findMany: vi.fn().mockResolvedValue(TWO_ROOMS_TWO_BEDS),
      },
    });
    db.booking.findUnique.mockResolvedValue({
      id: "booking-1",
      status: BookingStatus.CANCELLED,
      deletedAt: null,
      checkIn: parseDateOnly("2026-07-01"),
      checkOut: parseDateOnly("2026-07-03"),
      guests: [
        {
          id: "guest-1",
          bookingId: "booking-1",
          ageTier: "ADULT",
          stayStart: parseDateOnly("2026-07-01"),
          stayEnd: parseDateOnly("2026-07-03"),
        },
      ],
    });
    db.bedAllocation.deleteMany.mockResolvedValue({ count: 2 });

    const result = await reconcileBedAllocationsForBooking({
      bookingId: "booking-1",
      db: db as any,
    });

    expect(db.bedAllocation.deleteMany).toHaveBeenCalledWith({
      where: { bookingId: "booking-1" },
    });
    // Fast path: no PLANNER queries and nothing re-planned into the freed beds.
    expect(db.lodgeRoom.findMany).not.toHaveBeenCalled();
    expect(db.booking.findMany).not.toHaveBeenCalled();
    expect(db.bedAllocation.createMany).not.toHaveBeenCalled();
    // The only bedAllocation.findMany is the #1750 orphan-capture (doomed
    // primaries) that runs before every prune sweep, not a planner load.
    expect(db.bedAllocation.findMany).toHaveBeenCalledWith({
      where: { bookingId: "booking-1", isSecondOccupant: false },
      select: { bedId: true, stayDate: true },
    });
    expect(result).toEqual({
      enabled: true,
      deletedCount: 2,
      createdCount: 0,
      promotedCount: 0,
    });
  });

  it("takes the fast path for a soft-deleted booking too (issue #1686)", async () => {
    const db = makeDb({
      bedAllocationSettings: {
        findUnique: vi.fn().mockResolvedValue({ autoAllocationEnabled: true }),
      },
    });
    db.booking.findUnique.mockResolvedValue({
      id: "booking-1",
      status: BookingStatus.PAID,
      deletedAt: parseDateOnly("2026-07-02"),
      checkIn: parseDateOnly("2026-07-01"),
      checkOut: parseDateOnly("2026-07-03"),
      guests: [],
    });
    db.bedAllocation.deleteMany.mockResolvedValue({ count: 1 });

    const result = await reconcileBedAllocationsForBooking({
      bookingId: "booking-1",
      db: db as any,
    });

    expect(db.booking.findMany).not.toHaveBeenCalled();
    expect(db.bedAllocation.createMany).not.toHaveBeenCalled();
    expect(result.createdCount).toBe(0);
  });

  it("takes the fast path for a deleted booking: prunes and runs no planner queries (issue #1686)", async () => {
    // The booking row is gone (findUnique → null), so currentRange is null and
    // the planner is skipped entirely: no rooms/bookings/occupancy queries run.
    const db = makeDb({
      bedAllocationSettings: {
        findUnique: vi.fn().mockResolvedValue({ autoAllocationEnabled: true }),
      },
      lodgeRoom: {
        findMany: vi.fn().mockResolvedValue(TWO_ROOMS_TWO_BEDS),
      },
    });
    db.booking.findUnique.mockResolvedValue(null);
    db.bedAllocation.deleteMany.mockResolvedValue({ count: 3 });

    const result = await reconcileBedAllocationsForBooking({
      bookingId: "gone",
      db: db as any,
    });

    expect(db.bedAllocation.deleteMany).toHaveBeenCalledWith({
      where: { bookingId: "gone" },
    });
    expect(db.lodgeRoom.findMany).not.toHaveBeenCalled();
    expect(db.booking.findMany).not.toHaveBeenCalled();
    expect(db.bedAllocation.createMany).not.toHaveBeenCalled();
    // The only bedAllocation.findMany is the #1750 orphan-capture before the
    // sweep, not a planner load.
    expect(db.bedAllocation.findMany).toHaveBeenCalledWith({
      where: { bookingId: "gone", isSecondOccupant: false },
      select: { bedId: true, stayDate: true },
    });
    expect(result).toEqual({
      enabled: true,
      deletedCount: 3,
      createdCount: 0,
      promotedCount: 0,
    });
  });
});

describe("lifecycle auto-allocation lodge scope", () => {
  it("scopes the reconcile auto-fill strictly to the booking's lodge", async () => {
    const db = makeDb({
      bedAllocationSettings: {
        findUnique: vi.fn().mockResolvedValue({ autoAllocationEnabled: true }),
      },
    });
    db.booking.findUnique.mockResolvedValue({
      id: "booking-1",
      status: BookingStatus.PAID,
      deletedAt: null,
      lodgeId: "lodge-2",
      checkIn: parseDateOnly("2026-07-01"),
      checkOut: parseDateOnly("2026-07-03"),
      guests: [
        {
          id: "guest-1",
          bookingId: "booking-1",
          ageTier: "ADULT",
          stayStart: parseDateOnly("2026-07-01"),
          stayEnd: parseDateOnly("2026-07-03"),
          nights: [],
        },
      ],
    });

    await reconcileBedAllocationsForBooking({
      bookingId: "booking-1",
      db: db as any,
    });

    // The auto-fill planner must only see the booking's lodge: its rooms,
    // its bookings, and its beds' existing allocations. A cross-lodge fill
    // would violate the lodge-scoping contract.
    expect(db.lodgeRoom.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { lodgeId: "lodge-2" },
      }),
    );
    expect(db.booking.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          lodgeId: "lodge-2",
        }),
      }),
    );
    expect(db.bedAllocation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          room: { lodgeId: "lodge-2" },
        }),
      }),
    );
  });

  it("stays club-wide when the booking has no lodge (expand tolerance)", async () => {
    const db = makeDb({
      bedAllocationSettings: {
        findUnique: vi.fn().mockResolvedValue({ autoAllocationEnabled: true }),
      },
    });
    db.booking.findUnique.mockResolvedValue({
      id: "booking-1",
      status: BookingStatus.PAID,
      deletedAt: null,
      lodgeId: null,
      checkIn: parseDateOnly("2026-07-01"),
      checkOut: parseDateOnly("2026-07-03"),
      guests: [
        {
          id: "guest-1",
          bookingId: "booking-1",
          ageTier: "ADULT",
          stayStart: parseDateOnly("2026-07-01"),
          stayEnd: parseDateOnly("2026-07-03"),
          nights: [],
        },
      ],
    });

    await reconcileBedAllocationsForBooking({
      bookingId: "booking-1",
      db: db as any,
    });

    expect(db.lodgeRoom.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: undefined }),
    );
    expect(db.booking.findMany.mock.calls[0][0].where.OR).toBeUndefined();
  });
});

// Issue #1387: capacity-holding bookings get first claim on beds. When only a
// PROVISIONAL allocation blocks a held booking's guest-night, auto-allocation
// moves the provisional aside (to a free bed) or unallocates it, then places the
// held guest. A held allocation is NEVER displaced.
describe("bed allocation first-claim displacement (issue #1387)", () => {
  function heldFamilyDb(
    existing: ReturnType<typeof existingAllocation>[],
    plannerGuests: Array<{ id: string; ageTier: string }>,
  ) {
    const guests = plannerGuests.map((guest) => ({
      id: guest.id,
      bookingId: "held-new",
      ageTier: guest.ageTier,
      stayStart: NIGHT,
      stayEnd: NIGHT_END,
      nights: [] as { stayDate: Date }[],
    }));

    return makeDb({
      bedAllocationSettings: {
        findUnique: vi.fn().mockResolvedValue({ autoAllocationEnabled: true }),
      },
      lodgeRoom: {
        findMany: vi.fn().mockResolvedValue(TWO_ROOMS_TWO_BEDS),
      },
      booking: {
        findUnique: vi.fn().mockResolvedValue({
          id: "held-new",
          status: BookingStatus.PAID,
          deletedAt: null,
          checkIn: NIGHT,
          checkOut: NIGHT_END,
          guests,
        }),
        findMany: vi.fn().mockResolvedValue([
          {
            id: "held-new",
            createdAt: new Date("2026-07-01T00:00:00.000Z"),
            requestedRoomId: null,
            status: BookingStatus.PAID,
            originBookingRequest: null,
            guests,
          },
        ]),
      },
      bedAllocation: {
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        findMany: vi.fn().mockResolvedValue(existing),
        createMany: vi.fn().mockResolvedValue({ count: plannerGuests.length }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        delete: vi.fn().mockResolvedValue({}),
        update: vi.fn().mockResolvedValue({}),
      },
    });
  }

  it("case 1 — relocates a blocking provisional to a free bed (MOVE) so a held booking gets its bed", async () => {
    // Rooms A(A1,A2) B(B1,B2). Existing: A2 provisional, B1 held. Free: A1, B2.
    // New HELD family (adult + child): the adult takes the free A1; the child
    // must share the adult's room A, whose only other bed A2 is provisional.
    // A free bed (B2) exists, so the provisional is MOVED to B2 and the child
    // takes A2 — no held allocation is displaced.
    const db = heldFamilyDb(
      [
        existingAllocation({
          bedId: "bed-a2",
          roomId: "room-a",
          bookingId: "prov-booking",
          bookingGuestId: "prov-g1",
          status: BookingStatus.PENDING,
        }),
        existingAllocation({
          bedId: "bed-b1",
          roomId: "room-b",
          bookingId: "held-existing",
          bookingGuestId: "he-g1",
          status: BookingStatus.PAID,
        }),
      ],
      [
        { id: "hn-adult", ageTier: "ADULT" },
        { id: "hn-child", ageTier: "CHILD" },
      ],
    );

    const result = await reconcileBedAllocationsForBooking({
      bookingId: "held-new",
      db: db as any,
    });

    // Provisional MOVED to the free bed B2 (not deleted).
    expect(db.bedAllocation.updateMany).toHaveBeenCalledTimes(1);
    expect(db.bedAllocation.updateMany).toHaveBeenCalledWith({
      where: { bookingGuestId: "prov-g1", stayDate: NIGHT_UTC },
      data: { bedId: "bed-b2", roomId: "room-b" },
    });
    // No UNALLOCATE: no displacement-shaped deleteMany (prune's is by bookingId).
    const unallocateCalls = db.bedAllocation.deleteMany.mock.calls.filter(
      (call: any[]) => "bookingGuestId" in call[0].where,
    );
    expect(unallocateCalls).toHaveLength(0);

    // Held guests placed: adult on A1, child on the vacated A2.
    expect(db.bedAllocation.createMany).toHaveBeenCalledTimes(1);
    const created = db.bedAllocation.createMany.mock.calls[0][0].data;
    expect(created).toEqual([
      {
        bookingId: "held-new",
        bookingGuestId: "hn-adult",
        roomId: "room-a",
        bedId: "bed-a1",
        stayDate: NIGHT_UTC,
        source: "AUTO",
      },
      {
        bookingId: "held-new",
        bookingGuestId: "hn-child",
        roomId: "room-a",
        bedId: "bed-a2",
        stayDate: NIGHT_UTC,
        source: "AUTO",
      },
    ]);

    // Audit row on the displaced provisional booking.
    expect(db.auditLog.create).toHaveBeenCalledTimes(1);
    const audit = db.auditLog.create.mock.calls[0][0].data;
    expect(audit.action).toBe("bed_allocation.provisional_displaced");
    expect(audit.entityId).toBe("prov-booking");
    expect(audit.metadata.displacementType).toBe("MOVE");
    expect(audit.metadata.stayDate).toBe("2026-08-01");
    expect(audit.metadata.toBedId).toBe("bed-b2");
    expect(audit.metadata.displacedByBookingId).toBe("held-new");

    expect(result.createdCount).toBe(2);
  });

  it("case 2 — unallocates a blocking provisional (UNALLOCATE) when no free bed exists, returning it to the awaiting queue", async () => {
    // Room A(A1,A2) only. Existing: A1 held, A2 provisional. No free bed
    // anywhere. A new HELD adult must claim A2: the provisional is UNALLOCATED
    // (row deleted) and returns to the awaiting queue.
    const db = makeDb({
      bedAllocationSettings: {
        findUnique: vi.fn().mockResolvedValue({ autoAllocationEnabled: true }),
      },
      lodgeRoom: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "room-a",
            name: "Room A",
            sortOrder: 1,
            active: true,
            beds: [
              { id: "bed-a1", roomId: "room-a", name: "A1", sortOrder: 1, active: true },
              { id: "bed-a2", roomId: "room-a", name: "A2", sortOrder: 2, active: true },
            ],
          },
        ]),
      },
      booking: {
        findUnique: vi.fn().mockResolvedValue({
          id: "held-new",
          status: BookingStatus.PAID,
          deletedAt: null,
          checkIn: NIGHT,
          checkOut: NIGHT_END,
          guests: [
            {
              id: "hn-adult",
              bookingId: "held-new",
              ageTier: "ADULT",
              stayStart: NIGHT,
              stayEnd: NIGHT_END,
              nights: [],
            },
          ],
        }),
        findMany: vi.fn().mockResolvedValue([
          {
            id: "held-new",
            createdAt: new Date("2026-07-01T00:00:00.000Z"),
            requestedRoomId: null,
            status: BookingStatus.PAID,
            originBookingRequest: null,
            guests: [
              {
                id: "hn-adult",
                bookingId: "held-new",
                ageTier: "ADULT",
                stayStart: NIGHT,
                stayEnd: NIGHT_END,
                nights: [],
              },
            ],
          },
        ]),
      },
      bedAllocation: {
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        findMany: vi.fn().mockResolvedValue([
          existingAllocation({
            bedId: "bed-a1",
            roomId: "room-a",
            bookingId: "held-existing",
            bookingGuestId: "he-g1",
            status: BookingStatus.PAID,
          }),
          existingAllocation({
            bedId: "bed-a2",
            roomId: "room-a",
            bookingId: "prov-booking",
            bookingGuestId: "prov-g1",
            status: BookingStatus.PENDING,
          }),
        ]),
        createMany: vi.fn().mockResolvedValue({ count: 1 }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        update: vi.fn().mockResolvedValue({}),
        delete: vi.fn().mockResolvedValue({}),
      },
    });

    const result = await reconcileBedAllocationsForBooking({
      bookingId: "held-new",
      db: db as any,
    });

    // Provisional row DELETED (unallocated), not moved.
    expect(db.bedAllocation.deleteMany).toHaveBeenCalledWith({
      where: { bookingGuestId: "prov-g1", stayDate: NIGHT_UTC },
    });
    expect(db.bedAllocation.updateMany).not.toHaveBeenCalled();

    // Held adult claims the freed A2.
    const created = db.bedAllocation.createMany.mock.calls[0][0].data;
    expect(created).toEqual([
      {
        bookingId: "held-new",
        bookingGuestId: "hn-adult",
        roomId: "room-a",
        bedId: "bed-a2",
        stayDate: NIGHT_UTC,
        source: "AUTO",
      },
    ]);

    // Audit row records the unallocation.
    expect(db.auditLog.create).toHaveBeenCalledTimes(1);
    const audit = db.auditLog.create.mock.calls[0][0].data;
    expect(audit.entityId).toBe("prov-booking");
    expect(audit.metadata.displacementType).toBe("UNALLOCATE");
    expect(audit.metadata.toBedId).toBeNull();

    expect(result.createdCount).toBe(1);
  });

  it("case 3 — never displaces a held allocation: a new held booking stays awaiting when the lodge is full of held bookings", async () => {
    // Room A(A1) only, occupied by a HELD booking. A new HELD adult finds no
    // free bed and no PROVISIONAL to displace, so it stays unallocated —
    // nothing is moved or deleted.
    const db = makeDb({
      bedAllocationSettings: {
        findUnique: vi.fn().mockResolvedValue({ autoAllocationEnabled: true }),
      },
      lodgeRoom: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "room-a",
            name: "Room A",
            sortOrder: 1,
            active: true,
            beds: [
              { id: "bed-a1", roomId: "room-a", name: "A1", sortOrder: 1, active: true },
            ],
          },
        ]),
      },
      booking: {
        findUnique: vi.fn().mockResolvedValue({
          id: "held-new",
          status: BookingStatus.PAID,
          deletedAt: null,
          checkIn: NIGHT,
          checkOut: NIGHT_END,
          guests: [
            {
              id: "hn-adult",
              bookingId: "held-new",
              ageTier: "ADULT",
              stayStart: NIGHT,
              stayEnd: NIGHT_END,
              nights: [],
            },
          ],
        }),
        findMany: vi.fn().mockResolvedValue([
          {
            id: "held-new",
            createdAt: new Date("2026-07-01T00:00:00.000Z"),
            requestedRoomId: null,
            status: BookingStatus.PAID,
            originBookingRequest: null,
            guests: [
              {
                id: "hn-adult",
                bookingId: "held-new",
                ageTier: "ADULT",
                stayStart: NIGHT,
                stayEnd: NIGHT_END,
                nights: [],
              },
            ],
          },
        ]),
      },
      bedAllocation: {
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        findMany: vi.fn().mockResolvedValue([
          existingAllocation({
            bedId: "bed-a1",
            roomId: "room-a",
            bookingId: "held-existing",
            bookingGuestId: "he-g1",
            status: BookingStatus.PAID,
          }),
        ]),
        createMany: vi.fn().mockResolvedValue({ count: 0 }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        update: vi.fn().mockResolvedValue({}),
        delete: vi.fn().mockResolvedValue({}),
      },
    });

    const result = await reconcileBedAllocationsForBooking({
      bookingId: "held-new",
      db: db as any,
    });

    expect(db.bedAllocation.updateMany).not.toHaveBeenCalled();
    const unallocateCalls = db.bedAllocation.deleteMany.mock.calls.filter(
      (call: any[]) => "bookingGuestId" in call[0].where,
    );
    expect(unallocateCalls).toHaveLength(0);
    expect(db.bedAllocation.createMany).not.toHaveBeenCalled();
    expect(db.auditLog.create).not.toHaveBeenCalled();
    expect(result.createdCount).toBe(0);
  });

  it("case 4 — idempotent: re-running after a MOVE is a no-op (held stays put, provisional stays at its moved bed)", async () => {
    // Post-case-1 state: A1 held-new adult, A2 held-new child, B1 held-existing,
    // B2 the relocated provisional. Every guest-night is allocated, so a second
    // reconcile plans nothing: no moves, deletes, creates, or audit rows.
    const db = heldFamilyDb(
      [
        existingAllocation({
          bedId: "bed-a1",
          roomId: "room-a",
          bookingId: "held-new",
          bookingGuestId: "hn-adult",
          status: BookingStatus.PAID,
        }),
        existingAllocation({
          bedId: "bed-a2",
          roomId: "room-a",
          bookingId: "held-new",
          bookingGuestId: "hn-child",
          status: BookingStatus.PAID,
          ageTier: "CHILD",
        }),
        existingAllocation({
          bedId: "bed-b1",
          roomId: "room-b",
          bookingId: "held-existing",
          bookingGuestId: "he-g1",
          status: BookingStatus.PAID,
        }),
        existingAllocation({
          bedId: "bed-b2",
          roomId: "room-b",
          bookingId: "prov-booking",
          bookingGuestId: "prov-g1",
          status: BookingStatus.PENDING,
        }),
      ],
      [
        { id: "hn-adult", ageTier: "ADULT" },
        { id: "hn-child", ageTier: "CHILD" },
      ],
    );

    const result = await reconcileBedAllocationsForBooking({
      bookingId: "held-new",
      db: db as any,
    });

    expect(db.bedAllocation.updateMany).not.toHaveBeenCalled();
    const unallocateCalls = db.bedAllocation.deleteMany.mock.calls.filter(
      (call: any[]) => "bookingGuestId" in call[0].where,
    );
    expect(unallocateCalls).toHaveLength(0);
    expect(db.bedAllocation.createMany).not.toHaveBeenCalled();
    expect(db.auditLog.create).not.toHaveBeenCalled();
    expect(result.createdCount).toBe(0);
  });

  it("case 5 — held-first ordering: a held and a provisional booking compete for the last free bed and the held booking wins it", async () => {
    // Room A(A1) only, empty. A PROVISIONAL booking (created EARLIER) and a
    // HELD booking (created LATER) both want the single free bed. Held-first
    // ordering gives A1 to the held booking; the provisional stays awaiting and
    // nothing is displaced.
    const heldGuest = {
      id: "hn-adult",
      bookingId: "held-new",
      ageTier: "ADULT",
      stayStart: NIGHT,
      stayEnd: NIGHT_END,
      nights: [] as { stayDate: Date }[],
    };
    const provGuest = {
      id: "pn-adult",
      bookingId: "prov-new",
      ageTier: "ADULT",
      stayStart: NIGHT,
      stayEnd: NIGHT_END,
      nights: [] as { stayDate: Date }[],
    };

    const db = makeDb({
      bedAllocationSettings: {
        findUnique: vi.fn().mockResolvedValue({ autoAllocationEnabled: true }),
      },
      lodgeRoom: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "room-a",
            name: "Room A",
            sortOrder: 1,
            active: true,
            beds: [
              { id: "bed-a1", roomId: "room-a", name: "A1", sortOrder: 1, active: true },
            ],
          },
        ]),
      },
      booking: {
        findUnique: vi.fn().mockResolvedValue({
          id: "held-new",
          status: BookingStatus.PAID,
          deletedAt: null,
          checkIn: NIGHT,
          checkOut: NIGHT_END,
          guests: [heldGuest],
        }),
        findMany: vi.fn().mockResolvedValue([
          {
            // Provisional created EARLIER — would win under pure FIFO.
            id: "prov-new",
            createdAt: new Date("2026-06-01T00:00:00.000Z"),
            requestedRoomId: null,
            status: BookingStatus.PENDING,
            originBookingRequest: null,
            guests: [provGuest],
          },
          {
            id: "held-new",
            createdAt: new Date("2026-07-01T00:00:00.000Z"),
            requestedRoomId: null,
            status: BookingStatus.PAID,
            originBookingRequest: null,
            guests: [heldGuest],
          },
        ]),
      },
      bedAllocation: {
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        findMany: vi.fn().mockResolvedValue([]),
        createMany: vi.fn().mockResolvedValue({ count: 1 }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        update: vi.fn().mockResolvedValue({}),
        delete: vi.fn().mockResolvedValue({}),
      },
    });

    const result = await reconcileBedAllocationsForBooking({
      bookingId: "held-new",
      db: db as any,
    });

    // The HELD booking gets the only bed; the provisional does not, and nothing
    // is displaced (no existing allocations to displace).
    const created = db.bedAllocation.createMany.mock.calls[0][0].data;
    expect(created).toEqual([
      {
        bookingId: "held-new",
        bookingGuestId: "hn-adult",
        roomId: "room-a",
        bedId: "bed-a1",
        stayDate: NIGHT_UTC,
        source: "AUTO",
      },
    ]);
    expect(created).toHaveLength(1);
    expect(db.bedAllocation.updateMany).not.toHaveBeenCalled();
    const unallocateCalls = db.bedAllocation.deleteMany.mock.calls.filter(
      (call: any[]) => "bookingGuestId" in call[0].where,
    );
    expect(unallocateCalls).toHaveLength(0);
    expect(db.auditLog.create).not.toHaveBeenCalled();
    expect(result.createdCount).toBe(1);
  });

  it("never displaces an admin-APPROVED provisional allocation (the #776 lock stays intact)", async () => {
    // Room A(A1,A2). A1 Held, A2 Provisional but ADMIN-APPROVED. A new Held
    // adult finds no free bed and the only provisional is approved (locked), so
    // it stays awaiting — the approved row is neither moved nor deleted.
    const db = makeDb({
      bedAllocationSettings: {
        findUnique: vi.fn().mockResolvedValue({ autoAllocationEnabled: true }),
      },
      lodgeRoom: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "room-a",
            name: "Room A",
            sortOrder: 1,
            active: true,
            beds: [
              { id: "bed-a1", roomId: "room-a", name: "A1", sortOrder: 1, active: true },
              { id: "bed-a2", roomId: "room-a", name: "A2", sortOrder: 2, active: true },
            ],
          },
        ]),
      },
      booking: {
        findUnique: vi.fn().mockResolvedValue({
          id: "held-new",
          status: BookingStatus.PAID,
          deletedAt: null,
          checkIn: NIGHT,
          checkOut: NIGHT_END,
          guests: [
            {
              id: "hn-adult",
              bookingId: "held-new",
              ageTier: "ADULT",
              stayStart: NIGHT,
              stayEnd: NIGHT_END,
              nights: [],
            },
          ],
        }),
        findMany: vi.fn().mockResolvedValue([
          {
            id: "held-new",
            createdAt: new Date("2026-07-01T00:00:00.000Z"),
            requestedRoomId: null,
            status: BookingStatus.PAID,
            originBookingRequest: null,
            guests: [
              {
                id: "hn-adult",
                bookingId: "held-new",
                ageTier: "ADULT",
                stayStart: NIGHT,
                stayEnd: NIGHT_END,
                nights: [],
              },
            ],
          },
        ]),
      },
      bedAllocation: {
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        findMany: vi.fn().mockResolvedValue([
          existingAllocation({
            bedId: "bed-a1",
            roomId: "room-a",
            bookingId: "held-existing",
            bookingGuestId: "he-g1",
            status: BookingStatus.PAID,
          }),
          existingAllocation({
            bedId: "bed-a2",
            roomId: "room-a",
            bookingId: "prov-booking",
            bookingGuestId: "prov-g1",
            status: BookingStatus.PENDING,
            approvedAt: new Date("2026-07-05T00:00:00.000Z"),
          }),
        ]),
        createMany: vi.fn().mockResolvedValue({ count: 0 }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        update: vi.fn().mockResolvedValue({}),
        delete: vi.fn().mockResolvedValue({}),
      },
    });

    const result = await reconcileBedAllocationsForBooking({
      bookingId: "held-new",
      db: db as any,
    });

    // The approved provisional is untouched; the held booking stays awaiting.
    expect(db.bedAllocation.updateMany).not.toHaveBeenCalled();
    const unallocateCalls = db.bedAllocation.deleteMany.mock.calls.filter(
      (call: any[]) => "bookingGuestId" in call[0].where,
    );
    expect(unallocateCalls).toHaveLength(0);
    expect(db.bedAllocation.createMany).not.toHaveBeenCalled();
    expect(db.auditLog.create).not.toHaveBeenCalled();
    expect(result.createdCount).toBe(0);
  });

  it("displaces a provisional family as ONE unit: whole-stay unallocation, never a stranded minor (#1677)", async () => {
    // Rooms A(A1,A2) B(B1,B2), all occupied (no free bed). Room A holds a
    // Provisional family — adult A1, child A2. A new Held adult needs a bed.
    // Whole-booking displacement (#1677) evicts the provisional FAMILY as one
    // unit; with no other room able to host both, the whole family is
    // UNALLOCATED (both rows deleted) — the child is never left in a room
    // without its adult, and the family is never night- or guest-split.
    const db = makeDb({
      bedAllocationSettings: {
        findUnique: vi.fn().mockResolvedValue({ autoAllocationEnabled: true }),
      },
      lodgeRoom: {
        findMany: vi.fn().mockResolvedValue(TWO_ROOMS_TWO_BEDS),
      },
      booking: {
        findUnique: vi.fn().mockResolvedValue({
          id: "held-new",
          status: BookingStatus.PAID,
          deletedAt: null,
          checkIn: NIGHT,
          checkOut: NIGHT_END,
          guests: [
            {
              id: "hn-adult",
              bookingId: "held-new",
              ageTier: "ADULT",
              stayStart: NIGHT,
              stayEnd: NIGHT_END,
              nights: [],
            },
          ],
        }),
        findMany: vi.fn().mockResolvedValue([
          {
            id: "held-new",
            createdAt: new Date("2026-07-01T00:00:00.000Z"),
            requestedRoomId: null,
            status: BookingStatus.PAID,
            originBookingRequest: null,
            guests: [
              {
                id: "hn-adult",
                bookingId: "held-new",
                ageTier: "ADULT",
                stayStart: NIGHT,
                stayEnd: NIGHT_END,
                nights: [],
              },
            ],
          },
        ]),
      },
      bedAllocation: {
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        findMany: vi.fn().mockResolvedValue([
          existingAllocation({
            bedId: "bed-a1",
            roomId: "room-a",
            bookingId: "prov-booking",
            bookingGuestId: "prov-adult",
            status: BookingStatus.PENDING,
            ageTier: "ADULT",
          }),
          existingAllocation({
            bedId: "bed-a2",
            roomId: "room-a",
            bookingId: "prov-booking",
            bookingGuestId: "prov-child",
            status: BookingStatus.PENDING,
            ageTier: "CHILD",
          }),
          existingAllocation({
            bedId: "bed-b1",
            roomId: "room-b",
            bookingId: "held-existing",
            bookingGuestId: "he-g1",
            status: BookingStatus.PAID,
          }),
          existingAllocation({
            bedId: "bed-b2",
            roomId: "room-b",
            bookingId: "held-existing",
            bookingGuestId: "he-g2",
            status: BookingStatus.PAID,
          }),
        ]),
        createMany: vi.fn().mockResolvedValue({ count: 1 }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        update: vi.fn().mockResolvedValue({}),
        delete: vi.fn().mockResolvedValue({}),
      },
    });

    const result = await reconcileBedAllocationsForBooking({
      bookingId: "held-new",
      db: db as any,
    });

    // BOTH provisional rows are unallocated — the family leaves as one unit
    // and returns to the awaiting queue together. Nothing is MOVEd (no room
    // can host both), so MOVE/UNALLOCATE are never mixed for one booking.
    expect(db.bedAllocation.deleteMany).toHaveBeenCalledWith({
      where: { bookingGuestId: "prov-adult", stayDate: NIGHT_UTC },
    });
    expect(db.bedAllocation.deleteMany).toHaveBeenCalledWith({
      where: { bookingGuestId: "prov-child", stayDate: NIGHT_UTC },
    });
    expect(db.bedAllocation.updateMany).not.toHaveBeenCalled();

    // The held adult claims the first freed room-A bed.
    const created = db.bedAllocation.createMany.mock.calls[0][0].data;
    expect(created).toEqual([
      {
        bookingId: "held-new",
        bookingGuestId: "hn-adult",
        roomId: "room-a",
        bedId: "bed-a1",
        stayDate: NIGHT_UTC,
        source: "AUTO",
      },
    ]);
    // One audit row per displaced guest-night, both on the provisional booking.
    expect(db.auditLog.create).toHaveBeenCalledTimes(2);
    for (const call of db.auditLog.create.mock.calls) {
      expect(call[0].data.entityId).toBe("prov-booking");
      expect(call[0].data.metadata.displacementType).toBe("UNALLOCATE");
    }
    expect(
      db.auditLog.create.mock.calls.map(
        (call: any[]) => call[0].data.metadata.displacedBookingGuestId,
      ),
    ).toEqual(["prov-adult", "prov-child"]);
    expect(result.createdCount).toBe(1);
  });

  it("applies displacement inline when the caller already provides a transaction (no nested $transaction)", async () => {
    // Same UNALLOCATE setup as case 2, but the client exposes no `$transaction`
    // (it is already a TransactionClient): the lifecycle must apply the
    // deleteMany + createMany inline on that client, not open a nested one.
    const db = heldFamilyDb(
      [
        existingAllocation({
          bedId: "bed-a1",
          roomId: "room-a",
          bookingId: "held-existing",
          bookingGuestId: "he-g1",
          status: BookingStatus.PAID,
        }),
        existingAllocation({
          bedId: "bed-a2",
          roomId: "room-a",
          bookingId: "prov-booking",
          bookingGuestId: "prov-g1",
          status: BookingStatus.PENDING,
        }),
        existingAllocation({
          bedId: "bed-b1",
          roomId: "room-b",
          bookingId: "held-existing",
          bookingGuestId: "he-g2",
          status: BookingStatus.PAID,
        }),
        existingAllocation({
          bedId: "bed-b2",
          roomId: "room-b",
          bookingId: "held-existing",
          bookingGuestId: "he-g3",
          status: BookingStatus.PAID,
        }),
      ],
      [{ id: "hn-adult", ageTier: "ADULT" }],
    );
    // Simulate an already-open caller transaction: no `$transaction` method.
    db.$transaction = undefined;

    const result = await reconcileBedAllocationsForBooking({
      bookingId: "held-new",
      db: db as any,
    });

    // Provisional at A2 unallocated; held adult takes the freed A2 — applied
    // inline on the same client.
    expect(db.bedAllocation.deleteMany).toHaveBeenCalledWith({
      where: { bookingGuestId: "prov-g1", stayDate: NIGHT_UTC },
    });
    const created = db.bedAllocation.createMany.mock.calls[0][0].data;
    expect(created).toEqual([
      {
        bookingId: "held-new",
        bookingGuestId: "hn-adult",
        roomId: "room-a",
        bedId: "bed-a2",
        stayDate: NIGHT_UTC,
        source: "AUTO",
      },
    ]);
    expect(db.auditLog.create).toHaveBeenCalledTimes(1);
    expect(result.createdCount).toBe(1);
  });

  it("case 1 (multi-night) — moves a blocking multi-night provisional WHOLE to one room so a held family keeps one room for its stay (#1677)", async () => {
    // Rooms A(A1,A2) B(B1,B2), two nights. Existing: A2 provisional BOTH
    // nights, B1 held BOTH nights. A new HELD family (adult+child, two nights)
    // claims room A whole: the provisional's ENTIRE stay is MOVEd to B2 (one
    // updateMany per night, same destination), and the family never changes
    // rooms mid-stay.
    const night2 = parseDateOnly("2026-08-02");
    const night2Utc = new Date("2026-08-02T00:00:00.000Z");
    const stayEnd = parseDateOnly("2026-08-03");
    const guests = [
      {
        id: "hn-adult",
        bookingId: "held-new",
        ageTier: "ADULT",
        stayStart: NIGHT,
        stayEnd,
        nights: [] as { stayDate: Date }[],
      },
      {
        id: "hn-child",
        bookingId: "held-new",
        ageTier: "CHILD",
        stayStart: NIGHT,
        stayEnd,
        nights: [] as { stayDate: Date }[],
      },
    ];
    const db = makeDb({
      bedAllocationSettings: {
        findUnique: vi.fn().mockResolvedValue({ autoAllocationEnabled: true }),
      },
      lodgeRoom: {
        findMany: vi.fn().mockResolvedValue(TWO_ROOMS_TWO_BEDS),
      },
      booking: {
        findUnique: vi.fn().mockResolvedValue({
          id: "held-new",
          status: BookingStatus.PAID,
          deletedAt: null,
          checkIn: NIGHT,
          checkOut: stayEnd,
          guests,
        }),
        findMany: vi.fn().mockResolvedValue([
          {
            id: "held-new",
            createdAt: new Date("2026-07-01T00:00:00.000Z"),
            requestedRoomId: null,
            status: BookingStatus.PAID,
            originBookingRequest: null,
            checkIn: NIGHT,
            checkOut: stayEnd,
            guests,
          },
        ]),
      },
      bedAllocation: {
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        findMany: vi.fn().mockResolvedValue([
          existingAllocation({
            bedId: "bed-a2",
            roomId: "room-a",
            bookingId: "prov-booking",
            bookingGuestId: "prov-g1",
            status: BookingStatus.PENDING,
            bookingCheckIn: NIGHT,
            bookingCheckOut: stayEnd,
          }),
          existingAllocation({
            bedId: "bed-a2",
            roomId: "room-a",
            bookingId: "prov-booking",
            bookingGuestId: "prov-g1",
            status: BookingStatus.PENDING,
            stayDate: night2,
            bookingCheckIn: NIGHT,
            bookingCheckOut: stayEnd,
          }),
          existingAllocation({
            bedId: "bed-b1",
            roomId: "room-b",
            bookingId: "held-existing",
            bookingGuestId: "he-g1",
            status: BookingStatus.PAID,
          }),
          existingAllocation({
            bedId: "bed-b1",
            roomId: "room-b",
            bookingId: "held-existing",
            bookingGuestId: "he-g1",
            status: BookingStatus.PAID,
            stayDate: night2,
          }),
        ]),
        createMany: vi.fn().mockResolvedValue({ count: 4 }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        update: vi.fn().mockResolvedValue({}),
        delete: vi.fn().mockResolvedValue({}),
      },
    });

    const result = await reconcileBedAllocationsForBooking({
      bookingId: "held-new",
      db: db as any,
    });

    // The provisional's WHOLE stay moves to B2 — one updateMany per night,
    // both to the same destination room and bed.
    expect(db.bedAllocation.updateMany).toHaveBeenCalledTimes(2);
    expect(db.bedAllocation.updateMany).toHaveBeenCalledWith({
      where: { bookingGuestId: "prov-g1", stayDate: NIGHT_UTC },
      data: { bedId: "bed-b2", roomId: "room-b" },
    });
    expect(db.bedAllocation.updateMany).toHaveBeenCalledWith({
      where: { bookingGuestId: "prov-g1", stayDate: night2Utc },
      data: { bedId: "bed-b2", roomId: "room-b" },
    });
    const unallocateCalls = db.bedAllocation.deleteMany.mock.calls.filter(
      (call: any[]) => "bookingGuestId" in call[0].where,
    );
    expect(unallocateCalls).toHaveLength(0);

    // The held family keeps room A (same beds) for BOTH nights.
    const created = db.bedAllocation.createMany.mock.calls[0][0].data;
    expect(created).toEqual([
      {
        bookingId: "held-new",
        bookingGuestId: "hn-adult",
        roomId: "room-a",
        bedId: "bed-a1",
        stayDate: NIGHT_UTC,
        source: "AUTO",
      },
      {
        bookingId: "held-new",
        bookingGuestId: "hn-child",
        roomId: "room-a",
        bedId: "bed-a2",
        stayDate: NIGHT_UTC,
        source: "AUTO",
      },
      {
        bookingId: "held-new",
        bookingGuestId: "hn-adult",
        roomId: "room-a",
        bedId: "bed-a1",
        stayDate: night2Utc,
        source: "AUTO",
      },
      {
        bookingId: "held-new",
        bookingGuestId: "hn-child",
        roomId: "room-a",
        bedId: "bed-a2",
        stayDate: night2Utc,
        source: "AUTO",
      },
    ]);
    expect(db.auditLog.create).toHaveBeenCalledTimes(2);
    expect(result.createdCount).toBe(4);
  });
});

// Issue #1677: whole-stay planning needs to SEE whole stays. The lifecycle
// widens its loads to the envelope of every booking overlapping the reconcile
// range, while the planner bookings set stays restricted to the original
// range (no cascade).
describe("bed allocation envelope widening (issue #1677)", () => {
  it("loads allocations across the overlapping bookings' full stay envelope while keeping the booking scan on the original range", async () => {
    const db = makeDb({
      bedAllocationSettings: {
        findUnique: vi.fn().mockResolvedValue({ autoAllocationEnabled: true }),
      },
    });
    db.booking.findUnique.mockResolvedValue({
      id: "booking-a",
      status: BookingStatus.PAID,
      deletedAt: null,
      checkIn: parseDateOnly("2026-08-01"),
      checkOut: parseDateOnly("2026-08-02"),
      guests: [
        {
          id: "ga-1",
          bookingId: "booking-a",
          ageTier: "ADULT",
          stayStart: parseDateOnly("2026-08-01"),
          stayEnd: parseDateOnly("2026-08-02"),
          nights: [],
        },
      ],
    });
    // A neighbouring booking straddles the range: 07-30 .. 08-03.
    db.booking.findMany.mockResolvedValue([
      {
        id: "booking-b",
        createdAt: new Date("2026-06-01T00:00:00.000Z"),
        requestedRoomId: null,
        status: BookingStatus.PENDING,
        originBookingRequest: null,
        checkIn: parseDateOnly("2026-07-30"),
        checkOut: parseDateOnly("2026-08-03"),
        guests: [],
      },
    ]);

    await reconcileBedAllocationsForBooking({
      bookingId: "booking-a",
      db: db as any,
    });

    // Booking scan: original reconcile range only (no cascade).
    expect(db.booking.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          checkIn: { lt: parseDateOnly("2026-08-02") },
          checkOut: { gt: parseDateOnly("2026-08-01") },
        }),
      }),
    );
    // Allocation scan: widened to the overlapping booking's full envelope, so
    // out-of-range allocations of straddling stays are visible to the planner.
    expect(db.bedAllocation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          stayDate: {
            gte: parseDateOnly("2026-07-30"),
            lt: parseDateOnly("2026-08-03"),
          },
        }),
      }),
    );
  });

  it("never night-splits a neighbouring provisional stay straddling the reconcile range: the whole stay is displaced", async () => {
    // Room A has ONE bed. Provisional booking B holds it for 07-31..08-03
    // (three nights). Reconciling held booking A for its 08-01..08-02 night
    // displaces B's ENTIRE stay — all three rows are unallocated, including
    // the two nights OUTSIDE A's range — never just the contested night.
    const bNights = [
      parseDateOnly("2026-07-31"),
      parseDateOnly("2026-08-01"),
      parseDateOnly("2026-08-02"),
    ];
    const db = makeDb({
      bedAllocationSettings: {
        findUnique: vi.fn().mockResolvedValue({ autoAllocationEnabled: true }),
      },
      lodgeRoom: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "room-a",
            name: "Room A",
            sortOrder: 1,
            active: true,
            beds: [
              { id: "bed-a1", roomId: "room-a", name: "A1", sortOrder: 1, active: true },
            ],
          },
        ]),
      },
    });
    db.booking.findUnique.mockResolvedValue({
      id: "held-a",
      status: BookingStatus.PAID,
      deletedAt: null,
      checkIn: parseDateOnly("2026-08-01"),
      checkOut: parseDateOnly("2026-08-02"),
      guests: [
        {
          id: "ha-g1",
          bookingId: "held-a",
          ageTier: "ADULT",
          stayStart: parseDateOnly("2026-08-01"),
          stayEnd: parseDateOnly("2026-08-02"),
          nights: [],
        },
      ],
    });
    db.booking.findMany.mockResolvedValue([
      {
        id: "prov-b",
        createdAt: new Date("2026-06-01T00:00:00.000Z"),
        requestedRoomId: null,
        status: BookingStatus.PENDING,
        originBookingRequest: null,
        checkIn: parseDateOnly("2026-07-31"),
        checkOut: parseDateOnly("2026-08-03"),
        guests: [
          {
            id: "pb-g1",
            bookingId: "prov-b",
            ageTier: "ADULT",
            stayStart: parseDateOnly("2026-07-31"),
            stayEnd: parseDateOnly("2026-08-03"),
            nights: [],
          },
        ],
      },
      {
        id: "held-a",
        createdAt: new Date("2026-07-01T00:00:00.000Z"),
        requestedRoomId: null,
        status: BookingStatus.PAID,
        originBookingRequest: null,
        checkIn: parseDateOnly("2026-08-01"),
        checkOut: parseDateOnly("2026-08-02"),
        guests: [
          {
            id: "ha-g1",
            bookingId: "held-a",
            ageTier: "ADULT",
            stayStart: parseDateOnly("2026-08-01"),
            stayEnd: parseDateOnly("2026-08-02"),
            nights: [],
          },
        ],
      },
    ]);
    db.bedAllocation.findMany.mockResolvedValue(
      bNights.map((stayDate) =>
        existingAllocation({
          bedId: "bed-a1",
          roomId: "room-a",
          bookingId: "prov-b",
          bookingGuestId: "pb-g1",
          status: BookingStatus.PENDING,
          stayDate,
          bookingCheckIn: parseDateOnly("2026-07-31"),
          bookingCheckOut: parseDateOnly("2026-08-03"),
        }),
      ),
    );
    db.bedAllocation.createMany.mockResolvedValue({ count: 1 });

    const result = await reconcileBedAllocationsForBooking({
      bookingId: "held-a",
      db: db as any,
    });

    // ALL of B's nights are unallocated — the stay leaves as one unit.
    const unallocateCalls = db.bedAllocation.deleteMany.mock.calls.filter(
      (call: any[]) => "bookingGuestId" in call[0].where,
    );
    expect(unallocateCalls.map((call: any[]) => call[0].where)).toEqual([
      {
        bookingGuestId: "pb-g1",
        stayDate: new Date("2026-07-31T00:00:00.000Z"),
      },
      {
        bookingGuestId: "pb-g1",
        stayDate: new Date("2026-08-01T00:00:00.000Z"),
      },
      {
        bookingGuestId: "pb-g1",
        stayDate: new Date("2026-08-02T00:00:00.000Z"),
      },
    ]);
    const created = db.bedAllocation.createMany.mock.calls[0][0].data;
    expect(created).toEqual([
      {
        bookingId: "held-a",
        bookingGuestId: "ha-g1",
        roomId: "room-a",
        bedId: "bed-a1",
        stayDate: new Date("2026-08-01T00:00:00.000Z"),
        source: "AUTO",
      },
    ]);
    expect(db.auditLog.create).toHaveBeenCalledTimes(3);
    expect(result.createdCount).toBe(1);
  });

  it("treats a stay extending beyond the load envelope as non-displaceable (only partially visible)", async () => {
    // The blocking occupant's booking runs past the envelope (checkOut
    // 08-05 > envelope end 08-02) — e.g. a booking visible only through the
    // widened envelope of ANOTHER overlapping stay. Moving it whole is
    // impossible when part of its stay is invisible, so it is pinned and the
    // held booking stays awaiting.
    const db = makeDb({
      bedAllocationSettings: {
        findUnique: vi.fn().mockResolvedValue({ autoAllocationEnabled: true }),
      },
      lodgeRoom: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "room-a",
            name: "Room A",
            sortOrder: 1,
            active: true,
            beds: [
              { id: "bed-a1", roomId: "room-a", name: "A1", sortOrder: 1, active: true },
            ],
          },
        ]),
      },
    });
    db.booking.findUnique.mockResolvedValue({
      id: "held-a",
      status: BookingStatus.PAID,
      deletedAt: null,
      checkIn: parseDateOnly("2026-08-01"),
      checkOut: parseDateOnly("2026-08-02"),
      guests: [
        {
          id: "ha-g1",
          bookingId: "held-a",
          ageTier: "ADULT",
          stayStart: parseDateOnly("2026-08-01"),
          stayEnd: parseDateOnly("2026-08-02"),
          nights: [],
        },
      ],
    });
    db.booking.findMany.mockResolvedValue([
      {
        id: "held-a",
        createdAt: new Date("2026-07-01T00:00:00.000Z"),
        requestedRoomId: null,
        status: BookingStatus.PAID,
        originBookingRequest: null,
        checkIn: parseDateOnly("2026-08-01"),
        checkOut: parseDateOnly("2026-08-02"),
        guests: [
          {
            id: "ha-g1",
            bookingId: "held-a",
            ageTier: "ADULT",
            stayStart: parseDateOnly("2026-08-01"),
            stayEnd: parseDateOnly("2026-08-02"),
            nights: [],
          },
        ],
      },
    ]);
    db.bedAllocation.findMany.mockResolvedValue([
      existingAllocation({
        bedId: "bed-a1",
        roomId: "room-a",
        bookingId: "prov-x",
        bookingGuestId: "px-g1",
        status: BookingStatus.PENDING,
        bookingCheckIn: parseDateOnly("2026-08-01"),
        bookingCheckOut: parseDateOnly("2026-08-05"),
      }),
    ]);

    const result = await reconcileBedAllocationsForBooking({
      bookingId: "held-a",
      db: db as any,
    });

    expect(db.bedAllocation.updateMany).not.toHaveBeenCalled();
    const unallocateCalls = db.bedAllocation.deleteMany.mock.calls.filter(
      (call: any[]) => "bookingGuestId" in call[0].where,
    );
    expect(unallocateCalls).toHaveLength(0);
    expect(db.bedAllocation.createMany).not.toHaveBeenCalled();
    expect(db.auditLog.create).not.toHaveBeenCalled();
    expect(result.createdCount).toBe(0);
  });
});

describe("prune orphan auto-promote (#1750)", () => {
  const survivingPartner = {
    id: "alloc-partner",
    bookingId: "booking-2",
    bedId: "bed-1",
    stayDate: parseDateOnly("2026-07-02"),
    isSecondOccupant: true,
    bedType: "DOUBLE",
  };

  /**
   * The sweep's promotion is BATCHED since the #2285 review: one `findMany`
   * over every vacated bed-night plus one `updateMany`, instead of a
   * findFirst/update round-trip per night (the sweep runs under the caller's
   * capacity lock on the hold-toggle and school-approval paths). The mock
   * `bedAllocation.findMany` therefore has to answer TWO different queries —
   * the doomed-primary capture (`isSecondOccupant: false`) and the survivor
   * lookup (`isSecondOccupant: true`) — so route by the WHERE the real client
   * would honour.
   */
  function routeSweepFindMany(
    db: any,
    opts: { doomed: Array<{ bedId: string; stayDate: Date }>; survivors: unknown[] },
  ) {
    db.bedAllocation.findMany.mockImplementation(async ({ where }: any) =>
      where?.isSecondOccupant === true ? opts.survivors : opts.doomed,
    );
  }

  function cancelledPrimaryBooking() {
    return {
      id: "booking-1",
      status: BookingStatus.CANCELLED,
      deletedAt: null,
      checkIn: parseDateOnly("2026-07-01"),
      checkOut: parseDateOnly("2026-07-03"),
      guests: [
        {
          id: "guest-1",
          bookingId: "booking-1",
          ageTier: "ADULT",
          stayStart: parseDateOnly("2026-07-01"),
          stayEnd: parseDateOnly("2026-07-03"),
        },
      ],
    };
  }

  it("promotes a partner from another booking when the primary's booking is cancelled", async () => {
    const db = makeDb();
    db.booking.findUnique.mockResolvedValue(cancelledPrimaryBooking());
    // Capture-before: the cancelled booking's primary sat on bed-1 on 07-02.
    // The surviving partner (booking-2) still holds the second-occupant slot.
    routeSweepFindMany(db, {
      doomed: [{ bedId: "bed-1", stayDate: parseDateOnly("2026-07-02") }],
      survivors: [survivingPartner],
    });
    db.bedAllocation.deleteMany.mockResolvedValue({ count: 2 });

    const result = await reconcileBedAllocationsForBooking({
      bookingId: "booking-1",
      db: db as any,
    });

    // Doomed primaries captured BEFORE the delete, scoped to primaries only and
    // NOT to bedType — a stale-SINGLE AUTO primary on a real DOUBLE must still be
    // captured (#1749).
    expect(db.bedAllocation.findMany).toHaveBeenCalledWith({
      where: { bookingId: "booking-1", isSecondOccupant: false },
      select: { bedId: true, stayDate: true },
    });
    // Survivor lookup: ONE batched query over every vacated bed-night, gated on
    // isSecondOccupant alone (never bedType, #1749).
    expect(db.bedAllocation.findMany).toHaveBeenCalledWith({
      where: {
        isSecondOccupant: true,
        OR: [{ bedId: "bed-1", stayDate: parseDateOnly("2026-07-02") }],
      },
    });
    // ONE batched flip, id-scoped and re-asserting isSecondOccupant so a row
    // concurrently removed or already promoted is an idempotent no-op.
    expect(db.bedAllocation.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["alloc-partner"] }, isSecondOccupant: true },
      data: { isSecondOccupant: false },
    });
    // The per-night findFirst/update round-trip is gone.
    expect(db.bedAllocation.findFirst).not.toHaveBeenCalled();
    expect(db.bedAllocation.update).not.toHaveBeenCalled();
    // The capture MUST run BEFORE the delete — a deleteMany returns only a count,
    // so capturing after it would find nothing and silently disable the whole
    // prune promotion against a real DB (branch A).
    expect(
      db.bedAllocation.findMany.mock.invocationCallOrder[0],
    ).toBeLessThan(db.bedAllocation.deleteMany.mock.invocationCallOrder[0]);
    // Audited against the PROMOTED partner's own (different) booking.
    expect(db.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "BED_ALLOCATION_PARTNER_PROMOTED",
        entityId: "alloc-partner",
        targetId: "booking-2",
      }),
    });
    expect(result.promotedCount).toBe(1);
    expect(result.deletedCount).toBe(2);
  });

  it("leaves the primary untouched when the partner's own booking is cancelled", async () => {
    // booking-2 owns only the SECOND occupant, so its sweep captures no doomed
    // primary and never touches the surviving primary on booking-1.
    const db = makeDb();
    db.booking.findUnique.mockResolvedValue({
      ...cancelledPrimaryBooking(),
      id: "booking-2",
    });
    db.bedAllocation.findMany.mockResolvedValue([]);
    db.bedAllocation.deleteMany.mockResolvedValue({ count: 1 });

    const result = await reconcileBedAllocationsForBooking({
      bookingId: "booking-2",
      db: db as any,
    });

    // No doomed primary captured, so the batched survivor lookup never runs and
    // nothing is flipped.
    expect(db.bedAllocation.findMany).toHaveBeenCalledTimes(1);
    expect(db.bedAllocation.updateMany).not.toHaveBeenCalled();
    expect(db.bedAllocation.findFirst).not.toHaveBeenCalled();
    expect(db.bedAllocation.update).not.toHaveBeenCalled();
    expect(db.auditLog.create).not.toHaveBeenCalled();
    expect(result.promotedCount).toBe(0);
  });

  it("promotes an orphaned partner on the stale-guest-night prune path too", async () => {
    // A date change drops a night on which guest-1 was a shared double's primary;
    // the partner (booking-2) on that bed-night is promoted. Auto-allocation is
    // off (makeDb default), so the only bedAllocation.findMany is the capture.
    const db = makeDb();
    db.booking.findUnique.mockResolvedValue({
      id: "booking-1",
      status: BookingStatus.PAID,
      deletedAt: null,
      checkIn: parseDateOnly("2026-07-01"),
      checkOut: parseDateOnly("2026-07-02"),
      guests: [
        {
          id: "guest-1",
          bookingId: "booking-1",
          ageTier: "ADULT",
          stayStart: parseDateOnly("2026-07-01"),
          stayEnd: parseDateOnly("2026-07-02"),
        },
      ],
    });
    routeSweepFindMany(db, {
      doomed: [{ bedId: "bed-1", stayDate: parseDateOnly("2026-07-02") }],
      survivors: [survivingPartner],
    });
    db.bedAllocation.deleteMany.mockResolvedValue({ count: 1 });

    const result = await reconcileBedAllocationsForBooking({
      bookingId: "booking-1",
      db: db as any,
    });

    // Branch B capture: still scoped to primaries, layered over the stale-night
    // OR clause.
    expect(db.bedAllocation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          bookingId: "booking-1",
          isSecondOccupant: false,
        }),
        select: { bedId: true, stayDate: true },
      }),
    );
    expect(db.bedAllocation.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["alloc-partner"] }, isSecondOccupant: true },
      data: { isSecondOccupant: false },
    });
    // Capture-before-delete ordering holds on the stale-guest-night path too
    // (branch B). Auto-allocation is off, so findMany[0] is the capture.
    expect(
      db.bedAllocation.findMany.mock.invocationCallOrder[0],
    ).toBeLessThan(db.bedAllocation.deleteMany.mock.invocationCallOrder[0]);
    expect(result.promotedCount).toBe(1);
  });

  it("promotes a found survivor even when its own denormalized bedType reads stale non-DOUBLE (#1749 repair path)", async () => {
    // The survivor lookup is gated by WHERE isSecondOccupant=true alone; a second
    // occupant only ever exists on a real DOUBLE, so a stale SINGLE bedType on
    // that row must NOT make the repair decline — declining would permanently
    // dead-end the bed-night behind the orphan guard, the exact #1749 failure.
    const db = makeDb();
    db.booking.findUnique.mockResolvedValue(cancelledPrimaryBooking());
    routeSweepFindMany(db, {
      doomed: [{ bedId: "bed-1", stayDate: parseDateOnly("2026-07-02") }],
      survivors: [{ ...survivingPartner, bedType: "SINGLE" }],
    });
    db.bedAllocation.deleteMany.mockResolvedValue({ count: 2 });

    const result = await reconcileBedAllocationsForBooking({
      bookingId: "booking-1",
      db: db as any,
    });

    expect(db.bedAllocation.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["alloc-partner"] }, isSecondOccupant: true },
      data: { isSecondOccupant: false },
    });
    expect(result.promotedCount).toBe(1);
  });

  it("runs the prune promotion on the caller's client without opening a nested transaction", async () => {
    const db = makeDb();
    db.booking.findUnique.mockResolvedValue(cancelledPrimaryBooking());
    routeSweepFindMany(db, {
      doomed: [{ bedId: "bed-1", stayDate: parseDateOnly("2026-07-02") }],
      survivors: [survivingPartner],
    });
    db.bedAllocation.deleteMany.mockResolvedValue({ count: 2 });

    const result = await reconcileBedAllocationsForBooking({
      bookingId: "booking-1",
      db: db as any,
    });

    // The capture/delete/flip all ran on the injected client; the prune never
    // opens its own transaction (reconcile is already inside the caller's).
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(db.bedAllocation.updateMany).toHaveBeenCalledTimes(1);
    expect(result.promotedCount).toBe(1);
  });

  it("batches the survivor lookup and the flip across many vacated bed-nights (#2285 review)", async () => {
    // A whole-booking sweep vacates guests × nights bed-nights and runs under
    // the caller's capacity lock on the hold-toggle path, so the promotion must
    // cost ONE findMany + ONE updateMany — not two round-trips per night. The
    // duplicate bed-night proves the dedup still holds, and the non-partner row
    // proves the JS re-check still refuses to fabricate a promotion from a mock
    // whose findMany ignores the WHERE.
    const db = makeDb();
    db.booking.findUnique.mockResolvedValue(cancelledPrimaryBooking());
    const nights = [
      { bedId: "bed-1", stayDate: parseDateOnly("2026-07-01") },
      { bedId: "bed-2", stayDate: parseDateOnly("2026-07-01") },
      { bedId: "bed-1", stayDate: parseDateOnly("2026-07-02") },
      // Duplicate of the first: must not be looked up or flipped twice.
      { bedId: "bed-1", stayDate: parseDateOnly("2026-07-01") },
    ];
    routeSweepFindMany(db, {
      doomed: nights,
      survivors: [
        {
          ...survivingPartner,
          id: "alloc-partner-a",
          bedId: "bed-1",
          stayDate: parseDateOnly("2026-07-01"),
        },
        {
          ...survivingPartner,
          id: "alloc-partner-b",
          bedId: "bed-2",
          stayDate: parseDateOnly("2026-07-01"),
        },
        // A row the WHERE would never have returned (already primary): the JS
        // re-check drops it rather than "promoting" an existing primary.
        {
          ...survivingPartner,
          id: "alloc-primary",
          bedId: "bed-1",
          stayDate: parseDateOnly("2026-07-02"),
          isSecondOccupant: false,
        },
      ],
    });
    db.bedAllocation.deleteMany.mockResolvedValue({ count: 4 });

    const result = await reconcileBedAllocationsForBooking({
      bookingId: "booking-1",
      db: db as any,
    });

    // Exactly two findMany calls: the doomed-primary capture and ONE batched
    // survivor lookup carrying every deduped bed-night.
    expect(db.bedAllocation.findMany).toHaveBeenCalledTimes(2);
    expect(db.bedAllocation.findMany).toHaveBeenCalledWith({
      where: {
        isSecondOccupant: true,
        OR: [
          { bedId: "bed-1", stayDate: parseDateOnly("2026-07-01") },
          { bedId: "bed-2", stayDate: parseDateOnly("2026-07-01") },
          { bedId: "bed-1", stayDate: parseDateOnly("2026-07-02") },
        ],
      },
    });
    // ONE flip covering both genuine partners; the already-primary row is not in it.
    expect(db.bedAllocation.updateMany).toHaveBeenCalledTimes(1);
    expect(db.bedAllocation.updateMany).toHaveBeenCalledWith({
      where: {
        id: { in: ["alloc-partner-a", "alloc-partner-b"] },
        isSecondOccupant: true,
      },
      data: { isSecondOccupant: false },
    });
    expect(result.promotedCount).toBe(2);
    // Both promotions are still audited individually against their own booking.
    expect(db.auditLog.create).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// #1756: stale partner-share sweep
// ---------------------------------------------------------------------------

describe("sweepFuturePartnerSharedAllocations (#1756)", () => {
  const AUG1 = parseDateOnly("2026-08-01");
  const AUG2 = parseDateOnly("2026-08-02");

  function makeSweepDb() {
    return {
      bedAllocation: {
        findMany: vi.fn().mockResolvedValue([]),
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
    };
  }

  function allocationRow(opts: {
    id: string;
    bookingId: string;
    bookingGuestId: string;
    bedId: string;
    stayDate: Date;
    memberId: string | null;
    name?: [string, string];
  }) {
    const [firstName, lastName] = opts.name ?? ["Guest", opts.id];
    return {
      id: opts.id,
      bookingId: opts.bookingId,
      bookingGuestId: opts.bookingGuestId,
      bedId: opts.bedId,
      roomId: "room-1",
      stayDate: opts.stayDate,
      bookingGuest: { memberId: opts.memberId, firstName, lastName },
    };
  }

  it("pair scope: sweeps only the exact pair's future second-occupant rows and audits both bookings", async () => {
    const db = makeSweepDb();
    // Ben (member-b) is Alice's (member-a) second occupant on two nights, and
    // ALSO holds a stale pre-#1756 share with member-x on another bed — that
    // bed-night belongs to the b↔x pair's own event, not this dissolve.
    const pairNight1 = allocationRow({
      id: "alloc-1",
      bookingId: "booking-b",
      bookingGuestId: "guest-b",
      bedId: "bed-d1",
      stayDate: AUG1,
      memberId: "member-b",
      name: ["Ben", "Birch"],
    });
    const pairNight2 = allocationRow({
      id: "alloc-2",
      bookingId: "booking-b",
      bookingGuestId: "guest-b",
      bedId: "bed-d1",
      stayDate: AUG2,
      memberId: "member-b",
      name: ["Ben", "Birch"],
    });
    const stalePairRow = allocationRow({
      id: "alloc-stale",
      bookingId: "booking-b",
      bookingGuestId: "guest-b2",
      bedId: "bed-d2",
      stayDate: AUG1,
      memberId: "member-b",
      name: ["Ben", "Birch"],
    });
    db.bedAllocation.findMany
      // 1: second-occupant rows whose guest is member-a or member-b
      .mockResolvedValueOnce([pairNight1, pairNight2, stalePairRow])
      // 2: primaries on the candidate bed-nights
      .mockResolvedValueOnce([
        allocationRow({
          id: "alloc-primary-1",
          bookingId: "booking-a",
          bookingGuestId: "guest-a",
          bedId: "bed-d1",
          stayDate: AUG1,
          memberId: "member-a",
          name: ["Alice", "Ash"],
        }),
        allocationRow({
          id: "alloc-primary-2",
          bookingId: "booking-a",
          bookingGuestId: "guest-a",
          bedId: "bed-d1",
          stayDate: AUG2,
          memberId: "member-a",
          name: ["Alice", "Ash"],
        }),
        allocationRow({
          id: "alloc-primary-x",
          bookingId: "booking-x",
          bookingGuestId: "guest-x",
          bedId: "bed-d2",
          stayDate: AUG1,
          memberId: "member-x",
          name: ["Xena", "Xu"],
        }),
      ]);
    db.bedAllocation.deleteMany.mockResolvedValue({ count: 2 });

    const swept = await sweepFuturePartnerSharedAllocations({
      memberId: "member-a",
      partnerMemberId: "member-b",
      reason: "partner_link_dissolved",
      db: db as any,
    });

    // Future-only, second-occupant-only candidate query (past nights are
    // filtered in SQL, so they can never be swept).
    expect(db.bedAllocation.findMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: expect.objectContaining({
          isSecondOccupant: true,
          stayDate: { gte: expect.any(Date) },
          bookingGuest: { memberId: { in: ["member-a", "member-b"] } },
        }),
      }),
    );
    // Only the exact pair's rows are deleted — never the b↔x bed-night, and
    // never a primary (isSecondOccupant re-checked in the delete WHERE).
    expect(db.bedAllocation.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["alloc-1", "alloc-2"] }, isSecondOccupant: true },
    });
    expect(swept).toHaveLength(2);
    expect(swept[0]).toMatchObject({
      allocationId: "alloc-1",
      bookingId: "booking-b",
      primaryBookingId: "booking-a",
      secondOccupantMemberId: "member-b",
      primaryMemberId: "member-a",
    });

    // Audit rows on BOTH bookings (grouped, one per side, nights listed).
    expect(db.auditLog.create).toHaveBeenCalledTimes(2);
    const auditedData = db.auditLog.create.mock.calls.map(
      (call: any[]) => call[0].data,
    );
    const auditedTargets = auditedData.map((data: any) => data.entityId).sort();
    expect(auditedTargets).toEqual(["booking-a", "booking-b"]);
    for (const data of auditedData) {
      expect(data.action).toBe("BED_ALLOCATION_PARTNER_SHARE_SWEPT");
      expect(data.metadata).toMatchObject({
        issue: 1756,
        reason: "partner_link_dissolved",
        stayDates: ["2026-08-01", "2026-08-02"],
      });
    }

    // The alert helpers summarise the swept rows.
    expect(partnerShareSweepNights(swept)).toEqual([AUG1, AUG2]);
    expect(partnerShareSweepCounterpartNames(swept, "member-a")).toBe("Ben Birch");
    expect(partnerShareSweepCounterpartNames(swept, "member-b")).toBe("Alice Ash");
  });

  it("member scope: sweeps the member's own second-occupant rows AND the partner sitting on their primary bed", async () => {
    const db = makeSweepDb();
    const ownSecondRow = allocationRow({
      id: "alloc-own-2nd",
      bookingId: "booking-m",
      bookingGuestId: "guest-m",
      bedId: "bed-d1",
      stayDate: AUG1,
      memberId: "member-m",
      name: ["Mo", "Mane"],
    });
    const partnerOnOwnBed = allocationRow({
      id: "alloc-partner-2nd",
      bookingId: "booking-p",
      bookingGuestId: "guest-p",
      bedId: "bed-d2",
      stayDate: AUG2,
      memberId: "member-p",
      name: ["Pat", "Pine"],
    });
    db.bedAllocation.findMany
      // 1: rows where member-m IS the second occupant
      .mockResolvedValueOnce([ownSecondRow])
      // 2: member-m's own PRIMARY bed-nights
      .mockResolvedValueOnce([{ bedId: "bed-d2", stayDate: AUG2 }])
      // 3: second occupants on those primary bed-nights
      .mockResolvedValueOnce([partnerOnOwnBed])
      // 4: primaries on all candidate bed-nights
      .mockResolvedValueOnce([
        allocationRow({
          id: "alloc-primary-q",
          bookingId: "booking-q",
          bookingGuestId: "guest-q",
          bedId: "bed-d1",
          stayDate: AUG1,
          memberId: "member-q",
          name: ["Quin", "Quay"],
        }),
        allocationRow({
          id: "alloc-primary-m",
          bookingId: "booking-m2",
          bookingGuestId: "guest-m2",
          bedId: "bed-d2",
          stayDate: AUG2,
          memberId: "member-m",
          name: ["Mo", "Mane"],
        }),
      ]);
    db.bedAllocation.deleteMany.mockResolvedValue({ count: 2 });

    const swept = await sweepFuturePartnerSharedAllocations({
      memberId: "member-m",
      reason: "member_deactivated",
      db: db as any,
    });

    // Both directions swept: member-m removed as a second occupant, and
    // member-m's partner removed from member-m's own primary bed — the
    // primaries themselves are never deleted.
    expect(db.bedAllocation.deleteMany).toHaveBeenCalledWith({
      where: {
        id: { in: ["alloc-own-2nd", "alloc-partner-2nd"] },
        isSecondOccupant: true,
      },
    });
    expect(swept).toHaveLength(2);
    expect(partnerShareSweepCounterpartNames(swept, "member-m")).toBe(
      "Quin Quay, Pat Pine",
    );
  });

  it("is a safe no-op on an empty candidate set and therefore idempotent on a second run", async () => {
    const db = makeSweepDb();

    const first = await sweepFuturePartnerSharedAllocations({
      memberId: "member-a",
      partnerMemberId: "member-b",
      reason: "partner_link_dissolved",
      db: db as any,
    });
    const second = await sweepFuturePartnerSharedAllocations({
      memberId: "member-a",
      partnerMemberId: "member-b",
      reason: "partner_link_dissolved",
      db: db as any,
    });

    expect(first).toEqual([]);
    expect(second).toEqual([]);
    expect(db.bedAllocation.deleteMany).not.toHaveBeenCalled();
    expect(db.auditLog.create).not.toHaveBeenCalled();
  });

  it("pair scope: skips a candidate whose primary is missing (orphan) rather than guessing the pair", async () => {
    const db = makeSweepDb();
    db.bedAllocation.findMany
      .mockResolvedValueOnce([
        allocationRow({
          id: "alloc-orphan",
          bookingId: "booking-b",
          bookingGuestId: "guest-b",
          bedId: "bed-d1",
          stayDate: AUG1,
          memberId: "member-b",
        }),
      ])
      // No primary row on that bed-night (transient #1743 orphan).
      .mockResolvedValueOnce([]);

    const swept = await sweepFuturePartnerSharedAllocations({
      memberId: "member-a",
      partnerMemberId: "member-b",
      reason: "partner_link_dissolved",
      db: db as any,
    });

    expect(swept).toEqual([]);
    expect(db.bedAllocation.deleteMany).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Exclusive whole-lodge hold (ADR-001, #2285)
//
// A booking with `wholeLodgeHold: true` implicitly occupies EVERY bed, so the
// lifecycle must own ZERO BedAllocation rows for it: reconcile prunes any
// existing rows (whole-booking sweep — this is what self-heals legacy rows an
// older lifecycle wrongly created, with no data migration) and never feeds the
// booking to the planner. Keyed on the flag, NOT the status: a held booking
// sits in an ordinary BED_ALLOCATABLE status (PAID here). The board applies
// the same exclusion (admin-bed-allocation heldSpans); the two-paths agreement
// is locked down in held-booking-allocation-agreement.test.ts.
// ---------------------------------------------------------------------------
describe("exclusive whole-lodge hold (ADR-001, #2285)", () => {
  const HOLD_CHECK_IN = parseDateOnly("2026-07-01");
  const HOLD_CHECK_OUT = parseDateOnly("2026-07-02");

  function holdGuest(id: string) {
    return {
      id,
      bookingId: "booking-held",
      ageTier: "ADULT",
      stayStart: HOLD_CHECK_IN,
      stayEnd: HOLD_CHECK_OUT,
    };
  }

  // A fixture that WOULD auto-place both guests if the booking were ordinary:
  // auto-allocation on, a room with two free beds, no existing allocations.
  // The control test below proves that potency, so the held test's "nothing
  // created" cannot pass vacuously.
  function holdScenarioDb(wholeLodgeHold: boolean) {
    const db = makeDb({
      bedAllocationSettings: {
        findUnique: vi.fn().mockResolvedValue({ autoAllocationEnabled: true }),
      },
      lodgeRoom: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "room-a",
            name: "Room A",
            sortOrder: 1,
            active: true,
            beds: [
              { id: "bed-a1", roomId: "room-a", name: "A1", sortOrder: 1, active: true },
              { id: "bed-a2", roomId: "room-a", name: "A2", sortOrder: 2, active: true },
            ],
          },
        ]),
      },
    });
    db.booking.findUnique.mockResolvedValue({
      id: "booking-held",
      status: BookingStatus.PAID,
      deletedAt: null,
      checkIn: HOLD_CHECK_IN,
      checkOut: HOLD_CHECK_OUT,
      lodgeId: null,
      wholeLodgeHold,
      guests: [holdGuest("guest-1"), holdGuest("guest-2")],
    });
    db.booking.findMany.mockResolvedValue([
      {
        id: "booking-held",
        createdAt: new Date("2026-06-01T00:00:00.000Z"),
        requestedRoomId: null,
        checkIn: HOLD_CHECK_IN,
        checkOut: HOLD_CHECK_OUT,
        status: BookingStatus.PAID,
        originBookingRequest: null,
        heldForBookingRequest: null,
        adminCapacityHoldAt: null,
        wholeLodgeHold,
        guests: [holdGuest("guest-1"), holdGuest("guest-2")],
      },
    ]);
    return db;
  }

  it("prunes EVERY allocation row (whole-booking sweep) and never reaches the planner for a held booking", async () => {
    const db = holdScenarioDb(true);
    db.bedAllocation.deleteMany.mockResolvedValue({ count: 3 });

    const result = await reconcileBedAllocationsForBooking({
      bookingId: "booking-held",
      db: db as any,
    });

    // Whole-booking sweep, not the stale-guest-night scoped prune: a held
    // booking owns no rows at all, so legacy rows self-heal here (#2285).
    expect(db.bedAllocation.deleteMany).toHaveBeenCalledWith({
      where: { bookingId: "booking-held" },
    });
    // The planner is skipped entirely — its room/occupancy loads never run and
    // nothing is created, even though auto-allocation is enabled and beds are
    // free (the control below proves this fixture would otherwise place).
    expect(db.lodgeRoom.findMany).not.toHaveBeenCalled();
    expect(db.bedAllocation.createMany).not.toHaveBeenCalled();
    expect(result).toEqual({
      enabled: true,
      deletedCount: 3,
      createdCount: 0,
      promotedCount: 0,
    });
  });

  it("control: the identical booking WITHOUT the hold is scope-pruned and auto-placed (fixture potency)", async () => {
    const db = holdScenarioDb(false);
    db.bedAllocation.createMany.mockResolvedValue({ count: 2 });

    const result = await reconcileBedAllocationsForBooking({
      bookingId: "booking-held",
      db: db as any,
    });

    // Ordinary path: the prune is the guest-night-scoped sweep...
    expect(db.bedAllocation.deleteMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        bookingId: "booking-held",
        OR: expect.any(Array),
      }),
    });
    // ...and the planner places both guests in the free room.
    expect(db.bedAllocation.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          bookingId: "booking-held",
          bookingGuestId: "guest-1",
          stayDate: HOLD_CHECK_IN,
          source: "AUTO",
        }),
        expect.objectContaining({
          bookingId: "booking-held",
          bookingGuestId: "guest-2",
          stayDate: HOLD_CHECK_IN,
          source: "AUTO",
        }),
      ],
      skipDuplicates: true,
    });
    expect(result.createdCount).toBe(2);
  });

  // -------------------------------------------------------------------------
  // Drift and races (#2285 review). Three reads see the booking's held/status
  // state at three different moments — `findUnique` at the top of reconcile,
  // the planner's `findMany` load, and the write-time re-check — and a hold
  // SET or a cancel can commit between any two of them (reconcile is called
  // post-commit and unlocked from several lifecycle callers). Each guard is
  // pinned separately, because each is individually revertible while the
  // others keep the suite green.
  // -------------------------------------------------------------------------

  /**
   * Answer the three booking reads independently. The planner load is the only
   * one selecting `guests`; the write-time re-check selects the flag trio and
   * nothing else, so the two are told apart by their `select`.
   */
  function driftScenarioDb(states: {
    reconcileRead: boolean;
    plannerRead: boolean;
    writeTimeRead: { wholeLodgeHold?: boolean; status?: BookingStatus; deletedAt?: Date | null };
  }) {
    const db = holdScenarioDb(states.reconcileRead);
    const plannerRows = [
      {
        id: "booking-held",
        createdAt: new Date("2026-06-01T00:00:00.000Z"),
        requestedRoomId: null,
        checkIn: HOLD_CHECK_IN,
        checkOut: HOLD_CHECK_OUT,
        status: BookingStatus.PAID,
        originBookingRequest: null,
        heldForBookingRequest: null,
        adminCapacityHoldAt: null,
        wholeLodgeHold: states.plannerRead,
        guests: [holdGuest("guest-1"), holdGuest("guest-2")],
      },
    ];
    const writeTimeRows = [
      {
        id: "booking-held",
        status: states.writeTimeRead.status ?? BookingStatus.PAID,
        deletedAt: states.writeTimeRead.deletedAt ?? null,
        wholeLodgeHold: states.writeTimeRead.wholeLodgeHold ?? false,
      },
    ];
    db.booking.findMany.mockImplementation(async ({ select }: any) =>
      select?.guests ? plannerRows : writeTimeRows,
    );
    return db;
  }

  it("deep guard: the planner load reporting the booking HELD stops the write even when the reconcile read said otherwise", async () => {
    // Reverting `&& !booking.wholeLodgeHold` in the planner-bookings filter
    // leaves the rest of the suite green, because reconcile's own short-circuit
    // normally means the planner never sees a held booking. This is the case
    // that only the deep guard catches: the hold committed between the two
    // reads, so the planner's load is the first to see it.
    const db = driftScenarioDb({
      reconcileRead: false,
      plannerRead: true,
      writeTimeRead: { wholeLodgeHold: false },
    });

    const result = await reconcileBedAllocationsForBooking({
      bookingId: "booking-held",
      db: db as any,
    });

    expect(db.bedAllocation.createMany).not.toHaveBeenCalled();
    expect(result.createdCount).toBe(0);
    // It really is the deep guard: the planner ran its loads and then dropped
    // the booking, so the write-time re-check was never even reached.
    expect(db.lodgeRoom.findMany).toHaveBeenCalled();
    expect(db.booking.findMany).toHaveBeenCalledTimes(1);
  });

  it("write-time re-check: a hold SET landing after the plan is built writes nothing", async () => {
    // The exact F1 race: both earlier reads saw an ordinary booking, the
    // planner produced a full plan, and the exclusive-hold toggle committed
    // (pruning the rows and freeing the unique keys, so `skipDuplicates` cannot
    // help) before the createMany.
    const db = driftScenarioDb({
      reconcileRead: false,
      plannerRead: false,
      writeTimeRead: { wholeLodgeHold: true },
    });

    const result = await reconcileBedAllocationsForBooking({
      bookingId: "booking-held",
      db: db as any,
    });

    // The plan WAS built (the planner ran its loads) but not written.
    expect(db.lodgeRoom.findMany).toHaveBeenCalled();
    expect(db.booking.findMany).toHaveBeenCalledTimes(2);
    expect(db.bedAllocation.createMany).not.toHaveBeenCalled();
    expect(result.createdCount).toBe(0);
  });

  it("write-time re-check: a concurrent cancel landing after the plan is built writes nothing (CLEAR-vs-cancel)", async () => {
    // F3: the clear-direction re-plan races a cancel, which serialises on the
    // DISJOINT club-wide key and so is not excluded by the hold toggle's
    // per-lodge lock. The re-check covers status and deletedAt as well as the
    // hold flag, so the re-plan cannot resurrect rows for a cancelled booking.
    const db = driftScenarioDb({
      reconcileRead: false,
      plannerRead: false,
      writeTimeRead: { status: BookingStatus.CANCELLED },
    });

    const result = await reconcileBedAllocationsForBooking({
      bookingId: "booking-held",
      db: db as any,
    });

    expect(db.bedAllocation.createMany).not.toHaveBeenCalled();
    expect(result.createdCount).toBe(0);
  });

  it("write-time re-check: a concurrent soft delete landing after the plan is built writes nothing", async () => {
    const db = driftScenarioDb({
      reconcileRead: false,
      plannerRead: false,
      writeTimeRead: { deletedAt: new Date("2026-06-30T00:00:00.000Z") },
    });

    const result = await reconcileBedAllocationsForBooking({
      bookingId: "booking-held",
      db: db as any,
    });

    expect(db.bedAllocation.createMany).not.toHaveBeenCalled();
    expect(result.createdCount).toBe(0);
  });

  it("write-time re-check: an unchanged booking still writes the whole plan (the guard is not a blanket refusal)", async () => {
    const db = driftScenarioDb({
      reconcileRead: false,
      plannerRead: false,
      writeTimeRead: { wholeLodgeHold: false },
    });
    db.bedAllocation.createMany.mockResolvedValue({ count: 2 });

    const result = await reconcileBedAllocationsForBooking({
      bookingId: "booking-held",
      db: db as any,
    });

    expect(db.bedAllocation.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({ bookingGuestId: "guest-1" }),
        expect.objectContaining({ bookingGuestId: "guest-2" }),
      ],
      skipDuplicates: true,
    });
    expect(result.createdCount).toBe(2);
  });
});
