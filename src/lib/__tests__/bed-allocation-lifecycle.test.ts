import { BookingStatus } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import {
  acquireFuturePartnerSharedAllocationLocks,
  acquireMemberMergePartnerSharedLodgeLocks,
  BED_ALLOCATABLE_BOOKING_STATUSES,
  describePartnerSharedSweepReason,
  partnerShareSweepCounterpartNames,
  partnerShareSweepNights,
  reconcileBedAllocationsForBookingWithLodgeLockHeld,
  sweepFuturePartnerSharedAllocationsWithLocksHeld,
  sweepUnbackedFutureSharedDoublesWithLocksHeld,
} from "@/lib/bed-allocation-lifecycle";
import { acquireMemberLifecycleLocks } from "@/lib/member-lifecycle-lock";
import { BED_ALLOCATION_PRIORITY_VOCABULARY } from "@/lib/bed-allocation-settings";
import { eachDateOnlyInRange, parseDateOnly } from "@/lib/date-only";


/**
 * #3123 — the club's day now arrives at these lock-bound entry points as a
 * REQUIRED argument, resolved by the caller outside its transaction
 * (`INV-LOCK-004`). This is the same day the frozen clock's default instant
 * produced before the migration, so every assertion below is unchanged.
 */
const CLUB_TODAY_DATE_ONLY = new Date("2026-07-01T00:00:00.000Z");
const NORMALIZED_GUEST_NIGHTS = Symbol("normalizedGuestNights");

describe("partner-share lock prefix", () => {
  it("deduplicates and sorts lodge then member locks behind the global lock", async () => {
    const events: unknown[] = [];
    const executeRaw = vi.fn(
      async (_strings: TemplateStringsArray, ...values: unknown[]) => {
        events.push(values[0] ?? "global");
        return 1;
      },
    );
    const findMany = vi.fn(async () => {
      events.push("discover-lodges");
      return [
        { room: { lodgeId: "lodge-z" } },
        { room: { lodgeId: "lodge-a" } },
        { room: { lodgeId: "lodge-z" } },
        { room: { lodgeId: null } },
      ];
    });
    const tx = {
      $executeRaw: executeRaw,
      bedAllocation: { findMany },
    } as any;

    await acquireFuturePartnerSharedAllocationLocks(tx, [
      "member-2",
      "member-1",
      "member-2",
    ], CLUB_TODAY_DATE_ONLY);
    await acquireMemberLifecycleLocks(tx, ["member-2", "member-1", "member-2"]);

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          bookingGuest: {
            memberId: { in: ["member-2", "member-1"] },
          },
        }),
      }),
    );
    expect(events).toEqual([
      "global",
      "discover-lodges",
      "lodge-a",
      "lodge-z",
      "member-lifecycle:member-1",
      "member-lifecycle:member-2",
    ]);
  });
});

/**
 * Member merge's own prefix (#2595). Two differences from the #1756 sibling
 * above, and each is load-bearing:
 *
 *  - it does NOT take the global cohort `lock(1)`, because a merge holds its
 *    locks for up to 120s and would reject every 5s-budget cohort writer in the
 *    club, and
 *  - it therefore derives the lodge set from the members' GUEST ROWS as well as
 *    their existing future allocations, so a lodge where a placement could still
 *    land — but no allocation exists yet — is covered. Since #2672 that read
 *    carries no date filter at all: the stay columns are mutable, so a lodge
 *    holding only past guest-nights today can hold future ones before the merge
 *    commits.
 *
 * Delete the guest-row half and this describe fails on both counts.
 */
describe("member-merge partner-share lodge prefix (#2595)", () => {
  function makeMergeLockTx(input: {
    allocationLodgeIds: (string | null)[];
    guestNightLodgeIds: (string | null)[];
  }) {
    const events: unknown[] = [];
    const executeRaw = vi.fn(
      async (_strings: TemplateStringsArray, ...values: unknown[]) => {
        events.push(values[0] ?? "global");
        return 1;
      },
    );
    const bedAllocationFindMany = vi.fn(async () => {
      events.push("discover-allocation-lodges");
      return input.allocationLodgeIds.map((lodgeId) => ({ room: { lodgeId } }));
    });
    const bookingGuestFindMany = vi.fn(async () => {
      events.push("discover-guest-night-lodges");
      return input.guestNightLodgeIds.map((lodgeId) => ({
        booking: { lodgeId },
      }));
    });
    const tx = {
      $executeRaw: executeRaw,
      bedAllocation: { findMany: bedAllocationFindMany },
      bookingGuest: { findMany: bookingGuestFindMany },
    } as any;
    return { tx, events, bedAllocationFindMany, bookingGuestFindMany };
  }

  it("takes only the sorted union of allocation and guest-night lodges, and no global key", async () => {
    const { tx, events, bookingGuestFindMany } = makeMergeLockTx({
      allocationLodgeIds: ["lodge-z", "lodge-a", "lodge-z", null],
      // `lodge-m` exists ONLY as a future guest-night: no bed is allocated
      // there yet, and a concurrent placement could still create one.
      guestNightLodgeIds: ["lodge-m", "lodge-a", null],
    });

    const locked = await acquireMemberMergePartnerSharedLodgeLocks(tx, [
      "member-2",
      "member-1",
      "member-2",
    ], CLUB_TODAY_DATE_ONLY);
    await acquireMemberLifecycleLocks(tx, ["member-2", "member-1"]);

    expect(locked).toEqual(["lodge-a", "lodge-m", "lodge-z"]);
    expect(events).toEqual([
      "discover-allocation-lodges",
      "discover-guest-night-lodges",
      "lodge-a",
      "lodge-m",
      "lodge-z",
      "member-lifecycle:member-1",
      "member-lifecycle:member-2",
    ]);
    // The global cohort key is what the owner decision removed; assert its
    // absence explicitly rather than relying on the array comparison above.
    expect(events).not.toContain("global");

    // Both members, and NOTHING ELSE in the filter — the immutable request ids
    // are the only input.
    //
    // STRICT on `where`, deliberately, and this is load-bearing rather than
    // fussy. `expect.objectContaining` ignores ADDED keys, so it would pass a
    // query narrowed by `booking: { status: … }`, or by the stay dates this
    // query used to filter on — and every such narrowing is on state a
    // concurrent writer can change while the merge runs, which is the whole
    // hole `partnerShareGuestRowLodgeIds` exists to close:
    //
    //  - booking-status transitions serialise on the global cohort key, which
    //    merge no longer holds, so a booking that is not allocatable when the
    //    set is derived can become allocatable while the merge runs; and
    //  - `stayStart`/`stayEnd`/`BookingGuestNight` are rewritten by the admin
    //    date override and by an in-progress check-out extension that needs no
    //    override and no admin role (#2672), so a lodge holding only PAST
    //    guest-nights at derivation time can hold future ones minutes later.
    //
    // With the global key gone, either narrowing would silently reopen the
    // coverage hole and every other test in the tree would stay green. Compare
    // the whole object so it cannot.
    expect(bookingGuestFindMany).toHaveBeenCalledWith({
      where: { memberId: { in: ["member-2", "member-1"] } },
      select: { booking: { select: { lodgeId: true } } },
    });
  });

  it("locks a guest-night-only lodge even when the members hold no allocation at all", async () => {
    const { tx, events } = makeMergeLockTx({
      allocationLodgeIds: [],
      guestNightLodgeIds: ["lodge-future-only"],
    });

    const locked = await acquireMemberMergePartnerSharedLodgeLocks(tx, [
      "member-1",
    ], CLUB_TODAY_DATE_ONLY);

    expect(locked).toEqual(["lodge-future-only"]);
    expect(events).toEqual([
      "discover-allocation-lodges",
      "discover-guest-night-lodges",
      "lodge-future-only",
    ]);
  });

  it("takes nothing at all for an empty member set", async () => {
    const { tx, events, bedAllocationFindMany, bookingGuestFindMany } =
      makeMergeLockTx({ allocationLodgeIds: [], guestNightLodgeIds: [] });

    expect(await acquireMemberMergePartnerSharedLodgeLocks(tx, [], CLUB_TODAY_DATE_ONLY)).toEqual([]);
    expect(events).toEqual([]);
    expect(bedAllocationFindMany).not.toHaveBeenCalled();
    expect(bookingGuestFindMany).not.toHaveBeenCalled();
  });
});

function addSelectedNights<T>(value: T): T {
  const rows = Array.isArray(value) ? value : [value];
  for (const row of rows as any[]) {
    if (!row?.guests) continue;
    for (const guest of row.guests) {
      if (guest.nights?.length) continue;
      guest.nights = eachDateOnlyInRange(guest.stayStart, guest.stayEnd).map(
        (stayDate) => ({ stayDate }),
      );
    }
  }
  return value;
}

async function reconcileBedAllocationsForBooking(input: {
  bookingId: string;
  db: any;
  previousRange?: { checkIn: Date; checkOut: Date };
}) {
  const db = input.db;
  if (!db[NORMALIZED_GUEST_NIGHTS]) {
    db[NORMALIZED_GUEST_NIGHTS] = true;
    for (const method of ["findUnique", "findMany"] as const) {
      const original = db.booking[method];
      db.booking[method] = vi.fn(async (...args: any[]) =>
        addSelectedNights(await original(...args)),
      );
    }
  }
  return reconcileBedAllocationsForBookingWithLodgeLockHeld(input);
}

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
    // #2286: the auto-fill planner is fed custodian bed holds as blocking,
    // never-evictable unknown occupants. None in these cases, so every
    // assertion below reads exactly as it did before that feature.
    hutLeaderAssignment: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    // #1387 displacement audit trail.
    auditLog: {
      create: vi.fn().mockResolvedValue({}),
    },
    // #2286: the displacement apply now takes the per-lodge advisory lock as
    // the first statement of its own transaction, so the custodian re-read and
    // the write sit inside the same lock the hold writer takes.
    $executeRaw: vi.fn().mockResolvedValue(1),
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
  // #2286: guarantee the custodian-hold seam even when a test replaces the
  // delegate map wholesale via `overrides`.
  if (typeof db.hutLeaderAssignment?.findMany !== "function") {
    db.hutLeaderAssignment = { findMany: vi.fn().mockResolvedValue([]) };
  }
  if (typeof db.$executeRaw !== "function") {
    db.$executeRaw = vi.fn().mockResolvedValue(1);
  }
  const findSettings = db.bedAllocationSettings?.findUnique;
  if (typeof findSettings === "function") {
    db.bedAllocationSettings.findUnique = vi.fn(async (...args: any[]) => {
      const row = await findSettings(...args);
      return row
        ? {
            allocationPriorityOrder: [...BED_ALLOCATION_PRIORITY_VOCABULARY],
            ...row,
          }
        : row;
    });
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
            stayDate: { notIn: [parseDateOnly("2026-07-02")] },
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
            stayDate: {
              notIn: [
                parseDateOnly("2026-07-03"),
                parseDateOnly("2026-07-04"),
                parseDateOnly("2026-07-05"),
              ],
            },
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

/**
 * Custodian bed holds and the reconcile planner (#2286, review finding M1).
 *
 * There are TWO distinct protections and both are behavioural here:
 *
 *  1. the plan itself avoids a held bed (the holds are fed to the planner as
 *     #1768 unknown occupants, blocking and never evictable), and
 *  2. the WRITE re-reads the live holds on the same client immediately before
 *     `createMany` and drops anything that would land on one.
 *
 * (2) is not redundant. This reconcile is routinely called post-commit and
 * unlocked, so a hold committed between the plan and the write would otherwise
 * be silently written over — nothing in the database stops it (owner decision:
 * application-code exclusion, no constraint).
 */
describe("custodian bed holds block the reconcile planner (#2286)", () => {
  const TWO_BED_ROOM = [
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
  ];

  function custodianHoldRow(bedId: string) {
    return {
      id: "assignment-1",
      memberId: "member-1",
      lodgeId: "lodge-1",
      bedId,
      startDate: parseDateOnly("2026-07-01"),
      endDate: parseDateOnly("2026-07-05"),
      member: { firstName: "Sam", lastName: "Ranger", ageTier: "ADULT" },
      bed: {
        id: bedId,
        name: bedId.toUpperCase(),
        roomId: "room-a",
        room: { id: "room-a", name: "Room A" },
      },
    };
  }

  function oneGuestOneNightDb() {
    const db = makeDb({
      bedAllocationSettings: {
        findUnique: vi.fn().mockResolvedValue({ autoAllocationEnabled: true }),
      },
      lodgeRoom: {
        findMany: vi.fn().mockResolvedValue(TWO_BED_ROOM),
      },
    });
    db.booking.findUnique.mockResolvedValue({
      id: "booking-1",
      status: BookingStatus.PAID,
      deletedAt: null,
      lodgeId: "lodge-1",
      checkIn: parseDateOnly("2026-07-02"),
      checkOut: parseDateOnly("2026-07-03"),
      guests: [
        {
          id: "guest-1",
          bookingId: "booking-1",
          ageTier: "ADULT",
          stayStart: parseDateOnly("2026-07-02"),
          stayEnd: parseDateOnly("2026-07-03"),
          nights: [],
        },
      ],
    });
    db.booking.findMany.mockResolvedValue([
      {
        id: "booking-1",
        createdAt: new Date("2026-06-01T00:00:00.000Z"),
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
    db.bedAllocation.createMany.mockResolvedValue({ count: 1 });
    return db;
  }

  it("leaves a held bed empty: the guest goes to the free bed instead", async () => {
    const db = oneGuestOneNightDb();
    // A1 is the planner's first choice by sort order — and it is held.
    db.hutLeaderAssignment.findMany.mockResolvedValue([
      custodianHoldRow("bed-a1"),
    ]);

    await reconcileBedAllocationsForBooking({
      bookingId: "booking-1",
      db: db as any,
    });

    const rows = db.bedAllocation.createMany.mock.calls[0][0].data;
    expect(rows).toHaveLength(1);
    expect(rows[0].bedId).toBe("bed-a2");
    // Nothing anywhere in the payload targets the held bed-night.
    expect(
      rows.some(
        (row: { bedId: string }) => row.bedId === "bed-a1",
      ),
    ).toBe(false);
    // The holds are read with the bedId gate — a role-only assignment is not an
    // occupancy and must never reach the planner.
    expect(db.hutLeaderAssignment.findMany.mock.calls[0][0].where.bedId).toEqual(
      { not: null },
    );
  });

  it("DRIFT: a hold created between the plan and the write still leaves no row", async () => {
    const db = oneGuestOneNightDb();
    // The planner's read sees nothing (so it happily plans A1); the write-time
    // re-read — the second call, on the same client, immediately before
    // createMany — sees the hold that landed in between.
    db.hutLeaderAssignment.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValue([custodianHoldRow("bed-a1")]);

    const result = await reconcileBedAllocationsForBooking({
      bookingId: "booking-1",
      db: db as any,
    });

    // The whole payload was a single row on the now-held bed, so nothing is
    // written at all rather than a row landing on a custodian's bed.
    expect(db.bedAllocation.createMany).not.toHaveBeenCalled();
    expect(result.createdCount).toBe(0);
    // Two reads: the planner feed and the write-time re-check. The second is
    // what makes the exclusion true at the moment of the write.
    expect(db.hutLeaderAssignment.findMany.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("writes normally when nothing is held, so the pre-#2286 behaviour is untouched", async () => {
    const db = oneGuestOneNightDb();

    await reconcileBedAllocationsForBooking({
      bookingId: "booking-1",
      db: db as any,
    });

    const rows = db.bedAllocation.createMany.mock.calls[0][0].data;
    expect(rows).toHaveLength(1);
    expect(rows[0].bedId).toBe("bed-a1");
  });

  it("locks EVERY lodge it touches, in sorted order, when the reconcile is unscoped", async () => {
    // An unscoped (pre-backfill) reconcile can span lodges, so the displacement
    // transaction takes each lodge's key sorted — the codebase's multi-lodge
    // pattern, and the only thing that stops it deadlocking against per-lodge
    // writers taking the same keys one at a time.
    const db = makeDb({
      bedAllocationSettings: {
        findUnique: vi.fn().mockResolvedValue({ autoAllocationEnabled: true }),
      },
      lodgeRoom: {
        findMany: vi
          .fn()
          // 1st: the planner's room load. 2nd: the lock-key resolution.
          .mockResolvedValueOnce([
            {
              id: "room-z",
              name: "Room Z",
              sortOrder: 1,
              active: true,
              // ONE bed, so the held guest can only be placed by displacing the
              // provisional occupant — the branch that opens its own
              // transaction and takes the locks.
              beds: [
                {
                  id: "bed-z1",
                  roomId: "room-z",
                  name: "Z1",
                  sortOrder: 1,
                  active: true,
                },
              ],
            },
          ])
          .mockResolvedValue([
            { lodgeId: "lodge-zulu" },
            { lodgeId: "lodge-alpha" },
          ]),
      },
    });
    db.booking.findUnique.mockResolvedValue({
      id: "held-new",
      status: BookingStatus.PAID,
      deletedAt: null,
      lodgeId: null,
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
    });
    db.booking.findMany.mockResolvedValue([
      {
        id: "held-new",
        createdAt: new Date("2026-07-01T00:00:00.000Z"),
        requestedRoomId: null,
        status: BookingStatus.PAID,
        deletedAt: null,
        wholeLodgeHold: false,
        originBookingRequest: null,
        guests: [
          {
            id: "hn-adult",
            bookingId: "held-new",
            ageTier: "ADULT",
            stayStart: NIGHT,
            stayEnd: NIGHT_END,
          },
        ],
      },
      {
        id: "prov-booking",
        createdAt: new Date("2026-07-02T00:00:00.000Z"),
        requestedRoomId: null,
        status: BookingStatus.PENDING,
        deletedAt: null,
        wholeLodgeHold: false,
        originBookingRequest: null,
        guests: [],
      },
    ]);
    // Z1 is occupied by a PROVISIONAL row, so the held booking's guest triggers
    // a displacement — the branch that opens its own transaction.
    db.bedAllocation.findMany.mockResolvedValue([
      existingAllocation({
        bedId: "bed-z1",
        roomId: "room-z",
        bookingId: "prov-booking",
        bookingGuestId: "prov-g1",
        status: BookingStatus.PENDING,
      }),
    ]);

    await reconcileBedAllocationsForBooking({
      bookingId: "held-new",
      db: db as any,
    });

    const lockedKeys = db.$executeRaw.mock.calls.flatMap((call: any[]) =>
      call.slice(1),
    );
    expect(lockedKeys).toEqual(["lodge-alpha", "lodge-zulu"]);
  });

  it("DRIFT on the DISPLACEMENT path: a hold created between the plan and the write writes no row, applies no displacement and audits nothing", async () => {
    // Same one-bed displacement scenario as the sorted-lock test above: Z1 is
    // provisionally occupied, so the held booking's guest can only be placed by
    // displacing the provisional occupant — the branch that opens its own
    // transaction and runs the IN-LOCK re-check (`recheckPayload(client)`)
    // rather than the common-path one. The common-path drift test above cannot
    // catch a bypass of this branch, so this test pins it separately: with the
    // filter mutated out, createMany runs on the held bed AND the innocent
    // provisional row is displaced for nothing.
    const db = makeDb({
      bedAllocationSettings: {
        findUnique: vi.fn().mockResolvedValue({ autoAllocationEnabled: true }),
      },
      lodgeRoom: {
        findMany: vi
          .fn()
          // 1st: the planner's room load. 2nd: the lock-key resolution.
          .mockResolvedValueOnce([
            {
              id: "room-z",
              name: "Room Z",
              sortOrder: 1,
              active: true,
              beds: [
                {
                  id: "bed-z1",
                  roomId: "room-z",
                  name: "Z1",
                  sortOrder: 1,
                  active: true,
                },
              ],
            },
          ])
          .mockResolvedValue([{ lodgeId: "lodge-zulu" }]),
      },
    });
    db.booking.findUnique.mockResolvedValue({
      id: "held-new",
      status: BookingStatus.PAID,
      deletedAt: null,
      lodgeId: null,
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
    });
    db.booking.findMany.mockResolvedValue([
      {
        id: "held-new",
        createdAt: new Date("2026-07-01T00:00:00.000Z"),
        requestedRoomId: null,
        status: BookingStatus.PAID,
        deletedAt: null,
        wholeLodgeHold: false,
        originBookingRequest: null,
        guests: [
          {
            id: "hn-adult",
            bookingId: "held-new",
            ageTier: "ADULT",
            stayStart: NIGHT,
            stayEnd: NIGHT_END,
          },
        ],
      },
      {
        id: "prov-booking",
        createdAt: new Date("2026-07-02T00:00:00.000Z"),
        requestedRoomId: null,
        status: BookingStatus.PENDING,
        deletedAt: null,
        wholeLodgeHold: false,
        originBookingRequest: null,
        guests: [],
      },
    ]);
    db.bedAllocation.findMany.mockResolvedValue([
      existingAllocation({
        bedId: "bed-z1",
        roomId: "room-z",
        bookingId: "prov-booking",
        bookingGuestId: "prov-g1",
        status: BookingStatus.PENDING,
        stayDate: NIGHT_UTC,
      }),
    ]);
    // The planner feed sees no hold (so it plans the displacement onto Z1); the
    // write-time re-read, inside the displacement transaction, sees the hold on
    // Z1 that landed in between.
    db.hutLeaderAssignment.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValue([
        {
          id: "assignment-z",
          memberId: "member-1",
          lodgeId: "lodge-zulu",
          bedId: "bed-z1",
          startDate: NIGHT,
          endDate: NIGHT,
          member: { firstName: "Sam", lastName: "Ranger", ageTier: "ADULT" },
          bed: {
            id: "bed-z1",
            name: "Z1",
            roomId: "room-z",
            room: { id: "room-z", name: "Room Z" },
          },
        },
      ]);

    await reconcileBedAllocationsForBooking({
      bookingId: "held-new",
      db: db as any,
    });

    // The emptied payload abandons the whole apply: no row lands on the held
    // bed-night...
    expect(db.bedAllocation.createMany).not.toHaveBeenCalled();
    // ...the innocent provisional occupant is NOT displaced for a write that
    // never happened (no displacement-shaped updateMany/deleteMany — the
    // prune's deleteMany is keyed by bookingId, never bookingGuestId)...
    expect(db.bedAllocation.updateMany).not.toHaveBeenCalled();
    for (const call of db.bedAllocation.deleteMany.mock.calls) {
      expect(call[0]?.where?.bookingGuestId).toBeUndefined();
    }
    // ...and nothing is audited as displaced, because nothing was.
    for (const call of db.auditLog.create.mock.calls) {
      expect(call[0]?.data?.action).not.toBe(
        "bed_allocation.provisional_displaced",
      );
    }
    // The re-check ran on the transaction client: planner feed + write-time
    // re-read.
    expect(
      db.hutLeaderAssignment.findMany.mock.calls.length,
    ).toBeGreaterThanOrEqual(2);
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
      data: {
        bedId: "bed-b2",
        roomId: "room-b",
        // #2656: a relocated row lands alone on a bed free at plan start, so it
        // is always the primary there — never a fresh orphaned second occupant.
        isSecondOccupant: false,
      },
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
      data: {
        bedId: "bed-b2",
        roomId: "room-b",
        // #2656: a relocated row lands alone on a bed free at plan start, so it
        // is always the primary there — never a fresh orphaned second occupant.
        isSecondOccupant: false,
      },
    });
    expect(db.bedAllocation.updateMany).toHaveBeenCalledWith({
      where: { bookingGuestId: "prov-g1", stayDate: night2Utc },
      data: {
        bedId: "bed-b2",
        roomId: "room-b",
        // #2656: a relocated row lands alone on a bed free at plan start, so it
        // is always the primary there — never a fresh orphaned second occupant.
        isSecondOccupant: false,
      },
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

describe("sweepFuturePartnerSharedAllocationsWithLocksHeld (#1756)", () => {
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

    const swept = await sweepFuturePartnerSharedAllocationsWithLocksHeld({
      today: CLUB_TODAY_DATE_ONLY,
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

    const swept = await sweepFuturePartnerSharedAllocationsWithLocksHeld({
      today: CLUB_TODAY_DATE_ONLY,
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

    const first = await sweepFuturePartnerSharedAllocationsWithLocksHeld({
      today: CLUB_TODAY_DATE_ONLY,
      memberId: "member-a",
      partnerMemberId: "member-b",
      reason: "partner_link_dissolved",
      db: db as any,
    });
    const second = await sweepFuturePartnerSharedAllocationsWithLocksHeld({
      today: CLUB_TODAY_DATE_ONLY,
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

    const swept = await sweepFuturePartnerSharedAllocationsWithLocksHeld({
      today: CLUB_TODAY_DATE_ONLY,
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
// Unbacked shared-double reconciliation (#2595)
//
// The validity-driven sibling of the #1756 sweep, for member merge: it judges
// each candidate bed-night's ACTUAL pair against the single source of truth
// (`mayShareDoubleBedWith`) instead of trusting a named event, so a merge that
// drops one CONFIRMED link removes exactly the share that link backed and leaves
// the surviving member's own still-CONFIRMED share alone.
// ---------------------------------------------------------------------------
describe("sweepUnbackedFutureSharedDoublesWithLocksHeld (#2595)", () => {
  const AUG1 = parseDateOnly("2026-08-01");
  const AUG2 = parseDateOnly("2026-08-02");
  // The lodge every fixture row sits in, and the one the caller says it locked.
  // Merge holds no global cohort key, so the sweep refuses any candidate row
  // outside this set rather than write bed inventory it has not serialised.
  const SWEEP_LODGE_ID = "lodge-1";

  /**
   * `mayShareDoubleBedWith` reads `member` and `memberPartnerLink` off the same
   * client, so the sweep's mock db has to answer those too. Members default to
   * active adults; only the CONFIRMED link rows decide who may share.
   *
   * `bookingGuest.findMany` answers the #2672 coverage re-derivation. It
   * defaults to a guest row in the ONE locked lodge — i.e. the ordinary case
   * where the prefix is still complete — so every case below runs that check
   * for real rather than past a stub that can never fail.
   */
  function makeSweepDb(
    confirmedPairs: [string, string][] = [],
    guestRowLodgeIds: (string | null)[] = [SWEEP_LODGE_ID],
  ) {
    return {
      bedAllocation: {
        findMany: vi.fn().mockResolvedValue([]),
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      bookingGuest: {
        findMany: vi.fn(async () =>
          guestRowLodgeIds.map((lodgeId) => ({ booking: { lodgeId } })),
        ),
      },
      member: {
        findMany: vi.fn(async (args: any) => {
          const ids: string[] = args?.where?.id?.in ?? [];
          return ids.map((id) => ({ id, ageTier: "ADULT", active: true }));
        }),
      },
      memberPartnerLink: {
        findMany: vi.fn(async () =>
          confirmedPairs.map(([a, b]) =>
            a < b
              ? { memberAId: a, memberBId: b }
              : { memberAId: b, memberBId: a },
          ),
        ),
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
    lodgeId?: string;
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
      room: { lodgeId: opts.lodgeId ?? SWEEP_LODGE_ID },
    };
  }

  it("sweeps the bed-night the merge unbacked and keeps the master's still-confirmed share", async () => {
    // The #2595 scenario: the master (member-m, absorbed the duplicate's guest
    // rows) is the PRIMARY on bed-d1 with the duplicate's ex-partner (member-p)
    // beside them and no link, and the PRIMARY on bed-d2 with its own CONFIRMED
    // partner (member-q).
    const db = makeSweepDb([["member-m", "member-q"]]);
    const unbackedSecond = allocationRow({
      id: "alloc-unbacked",
      bookingId: "booking-p",
      bookingGuestId: "guest-p",
      bedId: "bed-d1",
      stayDate: AUG1,
      memberId: "member-p",
      name: ["Pat", "Pine"],
    });
    const backedSecond = allocationRow({
      id: "alloc-backed",
      bookingId: "booking-q",
      bookingGuestId: "guest-q",
      bedId: "bed-d2",
      stayDate: AUG1,
      memberId: "member-q",
      name: ["Quin", "Quay"],
    });
    db.bedAllocation.findMany
      // 1: second-occupant rows whose guest is in scope — none, the master holds
      //    both primaries.
      .mockResolvedValueOnce([])
      // 2: the scope's own PRIMARY bed-nights.
      .mockResolvedValueOnce([
        { bedId: "bed-d1", stayDate: AUG1 },
        { bedId: "bed-d2", stayDate: AUG1 },
      ])
      // 3: second occupants sitting on those bed-nights.
      .mockResolvedValueOnce([unbackedSecond, backedSecond])
      // 4: primaries on all candidate bed-nights.
      .mockResolvedValueOnce([
        allocationRow({
          id: "alloc-primary-d1",
          bookingId: "booking-loser",
          bookingGuestId: "guest-loser",
          bedId: "bed-d1",
          stayDate: AUG1,
          memberId: "member-m",
          name: ["Mo", "Mane"],
        }),
        allocationRow({
          id: "alloc-primary-d2",
          bookingId: "booking-m",
          bookingGuestId: "guest-m",
          bedId: "bed-d2",
          stayDate: AUG1,
          memberId: "member-m",
          name: ["Mo", "Mane"],
        }),
      ]);
    db.bedAllocation.deleteMany.mockResolvedValue({ count: 1 });

    const swept = await sweepUnbackedFutureSharedDoublesWithLocksHeld({
      today: CLUB_TODAY_DATE_ONLY,
      memberIds: ["member-m", "member-loser"],
      lockedLodgeIds: [SWEEP_LODGE_ID],
      reason: "members_merged",
      db: db as any,
    });

    // Future-only, second-occupant-only candidate query on the scope.
    expect(db.bedAllocation.findMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: expect.objectContaining({
          isSecondOccupant: true,
          stayDate: { gte: expect.any(Date) },
          bookingGuest: { memberId: { in: ["member-m", "member-loser"] } },
        }),
      }),
    );
    // The PRIMARY-side candidate query is future-only too, and this pin is the
    // one that stops a whole class of damage. Query 3 derives its `(bedId,
    // stayDate)` tuples from THIS query's rows and carries no date filter of its
    // own, so dropping `stayDate: { gte: today }` here would pull historic
    // bed-nights into the candidate set and the sweep would start DELETING past
    // lodge occupancy — against "past lodge nights are history and stay
    // untouched" (docs/DOMAIN_INVARIANTS.md). Every real-DB fixture in this
    // area deliberately uses far-future 2099 nights so the frozen clock cannot
    // make the window vacuous, which means only this assertion can catch it.
    expect(db.bedAllocation.findMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: expect.objectContaining({
          isSecondOccupant: false,
          stayDate: { gte: expect.any(Date) },
          bookingGuest: { memberId: { in: ["member-m", "member-loser"] } },
        }),
      }),
    );
    // Query 3 reaches the counterparts ONLY through those bed-night tuples, so
    // it inherits the future-only window rather than restating it. Pinned so a
    // widening from tuples to, say, a bare `bookingGuest` filter cannot slip in.
    expect(db.bedAllocation.findMany).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        where: expect.objectContaining({
          isSecondOccupant: true,
          OR: [
            { bedId: "bed-d1", stayDate: AUG1 },
            { bedId: "bed-d2", stayDate: AUG1 },
          ],
        }),
      }),
    );
    // One batched eligibility question per distinct primary member.
    expect(db.memberPartnerLink.findMany).toHaveBeenCalledTimes(1);
    // Only the unbacked bed-night is removed, and only its second-occupant row.
    expect(db.bedAllocation.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["alloc-unbacked"] }, isSecondOccupant: true },
    });
    expect(swept).toEqual([
      expect.objectContaining({
        allocationId: "alloc-unbacked",
        bookingId: "booking-p",
        bedId: "bed-d1",
        secondOccupantMemberId: "member-p",
        secondOccupantName: "Pat Pine",
        primaryBookingId: "booking-loser",
        primaryMemberId: "member-m",
        primaryName: "Mo Mane",
      }),
    ]);

    // Audited against BOTH bookings, under the merge issue.
    const auditedData = db.auditLog.create.mock.calls.map(
      (call: any[]) => call[0].data,
    );
    expect(auditedData.map((data: any) => data.entityId).sort()).toEqual([
      "booking-loser",
      "booking-p",
    ]);
    for (const data of auditedData) {
      expect(data.action).toBe("BED_ALLOCATION_PARTNER_SHARE_SWEPT");
      expect(data.metadata).toMatchObject({
        issue: 2595,
        reason: "members_merged",
        stayDates: ["2026-08-01"],
      });
    }
    expect(partnerShareSweepNights(swept)).toEqual([AUG1]);
    expect(partnerShareSweepCounterpartNames(swept, "member-m")).toBe("Pat Pine");
  });

  it("judges the scoped member on the SECOND-occupant side too", async () => {
    const db = makeSweepDb([]);
    db.bedAllocation.findMany
      // 1: the scoped member IS the second occupant, with no confirmed link to
      //    the primary sitting there.
      .mockResolvedValueOnce([
        allocationRow({
          id: "alloc-own-2nd",
          bookingId: "booking-m",
          bookingGuestId: "guest-m",
          bedId: "bed-d1",
          stayDate: AUG2,
          memberId: "member-m",
          name: ["Mo", "Mane"],
        }),
      ])
      // 2: no primary bed-nights in scope, so query 3 is skipped entirely.
      .mockResolvedValueOnce([])
      // 3 (as issued): primaries on the candidate bed-night.
      .mockResolvedValueOnce([
        allocationRow({
          id: "alloc-primary",
          bookingId: "booking-x",
          bookingGuestId: "guest-x",
          bedId: "bed-d1",
          stayDate: AUG2,
          memberId: "member-x",
          name: ["Xena", "Xu"],
        }),
      ]);
    db.bedAllocation.deleteMany.mockResolvedValue({ count: 1 });

    const swept = await sweepUnbackedFutureSharedDoublesWithLocksHeld({
      today: CLUB_TODAY_DATE_ONLY,
      memberIds: ["member-m"],
      lockedLodgeIds: [SWEEP_LODGE_ID],
      reason: "members_merged",
      db: db as any,
    });

    expect(db.bedAllocation.findMany).toHaveBeenCalledTimes(3);
    expect(db.bedAllocation.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["alloc-own-2nd"] }, isSecondOccupant: true },
    });
    expect(swept).toHaveLength(1);
    expect(swept[0]).toMatchObject({
      allocationId: "alloc-own-2nd",
      secondOccupantMemberId: "member-m",
      primaryMemberId: "member-x",
    });
  });

  it("treats a guest with no member on either side as unbacked without asking eligibility", async () => {
    const db = makeSweepDb([]);
    db.bedAllocation.findMany
      .mockResolvedValueOnce([
        allocationRow({
          id: "alloc-nonmember-2nd",
          bookingId: "booking-guest",
          bookingGuestId: "guest-nonmember",
          bedId: "bed-d1",
          stayDate: AUG1,
          memberId: null,
          name: ["Non", "Member"],
        }),
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        allocationRow({
          id: "alloc-primary",
          bookingId: "booking-m",
          bookingGuestId: "guest-m",
          bedId: "bed-d1",
          stayDate: AUG1,
          memberId: "member-m",
          name: ["Mo", "Mane"],
        }),
      ]);
    db.bedAllocation.deleteMany.mockResolvedValue({ count: 1 });

    const swept = await sweepUnbackedFutureSharedDoublesWithLocksHeld({
      today: CLUB_TODAY_DATE_ONLY,
      memberIds: ["member-m"],
      lockedLodgeIds: [SWEEP_LODGE_ID],
      reason: "members_merged",
      db: db as any,
    });

    // No pair to ask about, so no eligibility round-trip is made at all.
    expect(db.memberPartnerLink.findMany).not.toHaveBeenCalled();
    expect(swept.map((row) => row.allocationId)).toEqual(["alloc-nonmember-2nd"]);
  });

  it("skips a candidate whose primary is missing (orphan) rather than guessing the pair", async () => {
    const db = makeSweepDb([]);
    db.bedAllocation.findMany
      .mockResolvedValueOnce([
        allocationRow({
          id: "alloc-orphan",
          bookingId: "booking-p",
          bookingGuestId: "guest-p",
          bedId: "bed-d1",
          stayDate: AUG1,
          memberId: "member-p",
        }),
      ])
      .mockResolvedValueOnce([])
      // No primary row on that bed-night: the #1743/#1750 promotion pass owns it.
      .mockResolvedValueOnce([]);

    const swept = await sweepUnbackedFutureSharedDoublesWithLocksHeld({
      today: CLUB_TODAY_DATE_ONLY,
      memberIds: ["member-m"],
      lockedLodgeIds: [SWEEP_LODGE_ID],
      reason: "members_merged",
      db: db as any,
    });

    expect(swept).toEqual([]);
    expect(db.bedAllocation.deleteMany).not.toHaveBeenCalled();
    expect(db.auditLog.create).not.toHaveBeenCalled();
  });

  it("is a safe no-op on an empty scope and idempotent on a second pass", async () => {
    const db = makeSweepDb([]);

    const emptyScope = await sweepUnbackedFutureSharedDoublesWithLocksHeld({
      today: CLUB_TODAY_DATE_ONLY,
      memberIds: [],
      lockedLodgeIds: [SWEEP_LODGE_ID],
      reason: "members_merged",
      db: db as any,
    });
    expect(emptyScope).toEqual([]);
    expect(db.bedAllocation.findMany).not.toHaveBeenCalled();

    const first = await sweepUnbackedFutureSharedDoublesWithLocksHeld({
      today: CLUB_TODAY_DATE_ONLY,
      memberIds: ["member-m"],
      lockedLodgeIds: [SWEEP_LODGE_ID],
      reason: "members_merged",
      db: db as any,
    });
    const second = await sweepUnbackedFutureSharedDoublesWithLocksHeld({
      today: CLUB_TODAY_DATE_ONLY,
      memberIds: ["member-m"],
      lockedLodgeIds: [SWEEP_LODGE_ID],
      reason: "members_merged",
      db: db as any,
    });

    expect(first).toEqual([]);
    expect(second).toEqual([]);
    expect(db.bedAllocation.deleteMany).not.toHaveBeenCalled();
    expect(db.auditLog.create).not.toHaveBeenCalled();
  });

  it("keeps the #1756 reasons on their own audit issue number", async () => {
    expect(describePartnerSharedSweepReason("members_merged")).toBe(
      "Members merged with no confirmed partnership",
    );
    expect(describePartnerSharedSweepReason("partner_link_dissolved")).toBe(
      "Partner link dissolved",
    );
  });

  /**
   * The safety net for dropping merge's global cohort key: the sweep serialises
   * against the bed-allocation writers ONLY through the per-lodge capacity keys
   * the caller holds, so a candidate row outside that set must roll the merge
   * back — never be deleted under no lock. Reachable only if a lodge appeared
   * for one of these members after the prefix derived its set.
   */
  it("refuses without writing when a candidate sits in an unlocked lodge", async () => {
    const db = makeSweepDb([]);
    db.bedAllocation.findMany
      .mockResolvedValueOnce([
        allocationRow({
          id: "alloc-elsewhere",
          bookingId: "booking-p",
          bookingGuestId: "guest-p",
          bedId: "bed-far",
          stayDate: AUG1,
          memberId: "member-p",
          lodgeId: "lodge-appeared-late",
        }),
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    await expect(
      sweepUnbackedFutureSharedDoublesWithLocksHeld({
        today: CLUB_TODAY_DATE_ONLY,
        memberIds: ["member-m"],
        lockedLodgeIds: [SWEEP_LODGE_ID],
        reason: "members_merged",
        db: db as any,
      }),
    ).rejects.toThrow(/unlocked lodge\(s\): lodge-appeared-late/);

    // Refused BEFORE any eligibility read, delete or audit.
    expect(db.memberPartnerLink.findMany).not.toHaveBeenCalled();
    expect(db.bedAllocation.deleteMany).not.toHaveBeenCalled();
    expect(db.auditLog.create).not.toHaveBeenCalled();
  });

  /**
   * The #2672 coverage proof, and the reason it is a SEPARATE check from the
   * one above rather than a stricter version of it.
   *
   * The candidate check can only fire on a row that already exists. The hazard
   * this closes is a lodge that holds no shared double YET: one of these members
   * merely has a guest row there, so a placement could still land in a lodge the
   * merge holds no capacity key for, between this sweep and the merge's commit.
   * There is deliberately nothing for the sweep to remove in this case — no
   * candidate row at all — and it must still refuse.
   *
   * Merge calls this after its sorted `Member … FOR UPDATE`, which is what makes
   * passing the check a statement about the rest of the transaction: no INSERT
   * of a `BookingGuest` naming these members, and no UPDATE re-pointing one onto
   * them, can commit while that row lock is held, because the foreign key needs
   * `FOR KEY SHARE` on the member row.
   */
  it("refuses when a member holds a guest row in a lodge the prefix did not lock, with nothing to sweep", async () => {
    const db = makeSweepDb(
      [],
      // The locked lodge, PLUS one that appeared after the prefix derived its
      // set. No allocation exists there — that is the whole point.
      [SWEEP_LODGE_ID, "lodge-appeared-after-derivation"],
    );

    await expect(
      sweepUnbackedFutureSharedDoublesWithLocksHeld({
        today: CLUB_TODAY_DATE_ONLY,
        memberIds: ["member-m", "member-loser"],
        lockedLodgeIds: [SWEEP_LODGE_ID],
        reason: "members_merged",
        db: db as any,
      }),
    ).rejects.toThrow(/unlocked lodge\(s\): lodge-appeared-after-derivation/);

    // Re-derived from the members alone — no date filter and no status filter,
    // because both would be filters on state a racing writer can change.
    expect(db.bookingGuest.findMany).toHaveBeenCalledWith({
      where: { memberId: { in: ["member-m", "member-loser"] } },
      select: { booking: { select: { lodgeId: true } } },
    });
    // Refused BEFORE the sweep read a single candidate.
    expect(db.bedAllocation.findMany).not.toHaveBeenCalled();
    expect(db.bedAllocation.deleteMany).not.toHaveBeenCalled();
    expect(db.auditLog.create).not.toHaveBeenCalled();
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
// the same exclusion (bed-allocation-board heldSpans); the two-paths agreement
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
   * Answer the FOUR booking reads independently.
   *
   * Told apart by their `select`: the planner load is the only one selecting
   * `guests`; the #2317 blocking-hold load selects the stay window but no
   * guests; the write-time re-check selects the flag trio and nothing else.
   * Testing `guests` alone stopped being enough when #2317 added its own query
   * — a `guests`-only test hands the hold load the narrow re-check rows, whose
   * missing `checkIn`/`checkOut` then make it return nothing for an incidental
   * reason (`toWholeLodgeHoldSpans` skips a row with no stay window) rather
   * than a chosen one.
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
    db.booking.findMany.mockImplementation(async ({ select }: any) => {
      if (select?.guests) return plannerRows;
      // The #2317 blocking-hold load. Explicitly EMPTY: these scenarios are
      // about the reconciled booking's own hold flag, and a booking never
      // blocks its own placement — so the emptiness is the fixture's decision,
      // not a side effect of the row shape it happened to be handed.
      if (select?.checkIn) return [];
      return writeTimeRows;
    });
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

    // The plan WAS built (the planner ran its loads) but not written. Three
    // booking reads now: the planner's own load, the blocking whole-lodge-hold
    // load it feeds to the planner as occupancy (#2317), and the write-time
    // re-check — which is the one that stops this write.
    expect(db.lodgeRoom.findMany).toHaveBeenCalled();
    expect(db.booking.findMany).toHaveBeenCalledTimes(3);
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

// --- D-12 (#2307): bed allocation places only operationally present guests ---
//
// Owner decision D-12: a member guest whose consent is still PENDING holds a bed
// against capacity (D-4) but is not somebody the club places in a specific bunk.
// Two guest SELECTS in this module decide who gets placed — the per-booking load
// and the auto-allocation planner's load — and both now carry the shared
// predicate.
//
// The third guest read in this module, the BedAllocation occupancy query, is
// deliberately NOT filtered, and the last test here says why in the only way
// that survives a refactor.
describe("bed allocation member-guest consent exclusion (D-12, #2307)", () => {
  const AWAITING = {
    consentStatus: "PENDING",
    consentRequestedAt: new Date("2026-06-25T00:00:00.000Z"),
    consentExpiresAt: new Date("2026-06-30T12:00:00.000Z"),
  };

  function guestRow(id: string, consent: Record<string, unknown> = {}) {
    return {
      id,
      bookingId: "booking-1",
      ageTier: "ADULT",
      stayStart: parseDateOnly("2026-07-01"),
      stayEnd: parseDateOnly("2026-07-03"),
      nights: [],
      // Null for every ordinary guest; that is the value the `not:` trap drops.
      consentStatus: null,
      ...consent,
    };
  }

  /** Filters a guest list the way Prisma would, from the `where` production sent. */
  function applyWhere(
    where: { OR?: Array<{ consentStatus: string | null }> } | undefined,
    guests: Array<{ consentStatus?: string | null }>,
  ) {
    if (!where?.OR) return guests;
    return guests.filter((guest) =>
      where.OR!.some(
        (branch) => branch.consentStatus === (guest.consentStatus ?? null),
      ),
    );
  }

  it("sends the predicate on the per-booking guest load", async () => {
    const db = makeDb();
    db.booking.findUnique.mockResolvedValue({
      id: "booking-1",
      status: BookingStatus.PAID,
      deletedAt: null,
      checkIn: parseDateOnly("2026-07-01"),
      checkOut: parseDateOnly("2026-07-03"),
      guests: [guestRow("guest-1")],
    });

    await reconcileBedAllocationsForBooking({
      bookingId: "booking-1",
      db: db as any,
    });

    const args = db.booking.findUnique.mock.calls[0][0];
    expect(args.select.guests.where.OR).toEqual([
      { consentStatus: null },
      { consentStatus: "CONFIRMED" },
    ]);
  });

  it("prunes an unconsented guest out of the placement set entirely", async () => {
    // Not merely "skips placing them": this list is what the prune diffs
    // against, so any BedAllocation row an earlier release wrote for a guest who
    // is no longer operationally present is swept on the next reconcile. That is
    // the intended coherence — they must not be occupying a bunk on the board
    // either — and it is asserted here so it cannot be mistaken for a bug later.
    const db = makeDb();
    db.booking.findUnique.mockImplementation(async (args: any) => ({
      id: "booking-1",
      status: BookingStatus.PAID,
      deletedAt: null,
      checkIn: parseDateOnly("2026-07-01"),
      checkOut: parseDateOnly("2026-07-03"),
      guests: applyWhere(args.select.guests.where, [
        guestRow("guest-ordinary"),
        guestRow("guest-agreed", { consentStatus: "CONFIRMED" }),
        guestRow("guest-awaiting", AWAITING),
      ]),
    }));
    db.bedAllocation.deleteMany.mockResolvedValue({ count: 1 });

    await reconcileBedAllocationsForBooking({
      bookingId: "booking-1",
      db: db as any,
    });

    const where = db.bedAllocation.deleteMany.mock.calls[0][0].where;
    // The keep-list is the two consented guests. The pending guest's id is
    // absent, so `notIn` sweeps any row it holds.
    expect(where.OR[0]).toEqual({
      bookingGuestId: { notIn: ["guest-ordinary", "guest-agreed"] },
    });
  });

  it("sends the predicate on the auto-allocation planner's guest load", async () => {
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
      guests: [guestRow("guest-1")],
    });
    db.booking.findMany.mockResolvedValue([]);

    await reconcileBedAllocationsForBooking({
      bookingId: "booking-1",
      db: db as any,
    });

    const args = db.booking.findMany.mock.calls[0][0];
    expect(args.select.guests.where.OR).toEqual([
      { consentStatus: null },
      { consentStatus: "CONFIRMED" },
    ]);
  });

  it("leaves the BedAllocation occupancy read UNFILTERED, on purpose", async () => {
    // This query reads the beds as WRITTEN, to learn what is occupied and which
    // guest-nights are already placed. Filter it and two things break at once: a
    // bed still holding an unconsented guest's row looks free and the planner
    // double-books it, and the already-placed guest-night is forgotten so the
    // planner drafts a duplicate. The exclusion belongs on the two guest selects
    // above; the sweep is what removes a stale row.
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
      guests: [guestRow("guest-1")],
    });
    db.booking.findMany.mockResolvedValue([]);

    await reconcileBedAllocationsForBooking({
      bookingId: "booking-1",
      db: db as any,
    });

    const occupancyCall = db.bedAllocation.findMany.mock.calls.find(
      (call: any[]) => call[0]?.select?.bedId !== undefined,
    );
    expect(occupancyCall, "the planner's occupancy read should have run").toBeTruthy();
    expect(JSON.stringify(occupancyCall![0])).not.toContain("consentStatus");
  });
});

/**
 * Shared-double invariants on the LIFECYCLE APPLY path (#2656).
 *
 * The planner no longer drafts a plan that displaces one occupant of a shared
 * double while the other stays. The apply path must still hold the invariants
 * on its own, because it runs some way after the plan was read and, on the
 * "already inside the caller's transaction" branch, takes no lock of its own —
 * so an admin can add a second occupant to a bed-night between the read and the
 * write. Every other removal path in the codebase promotes the survivor; this
 * one did not.
 */
describe("shared double invariants on the apply path (#2656)", () => {
  const HELD_GUEST = {
    id: "hn-adult",
    bookingId: "held-new",
    ageTier: "ADULT",
    stayStart: NIGHT,
    stayEnd: NIGHT_END,
    nights: [] as { stayDate: Date }[],
  };

  /**
   * A reconcile in which the plan UNALLOCATEs `prov-g1` off bed-a2 so the held
   * adult can claim it. `partner` is what the database reports as sitting on a
   * bed-night as a SECOND occupant when the apply path looks — the state a
   * concurrent admin partner placement leaves behind.
   */
  function displacementDb(options: {
    displacedIsSecondOccupant?: boolean;
    partner?: {
      id: string;
      bedId: string;
      bookingId: string;
      bookingGuestId: string;
    } | null;
    occupiedTargets?: Array<{ bedId: string; bookingGuestId: string }>;
  }) {
    const planned = [
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
    ];

    const findMany = vi.fn(async (args: any) => {
      // promoteOrphanedSecondOccupantsBatch's lookup.
      if (args?.where?.isSecondOccupant === true) {
        return options.partner
          ? [
              {
                ...options.partner,
                roomId: "room-a",
                stayDate: NIGHT_UTC,
                isSecondOccupant: true,
              },
            ]
          : [];
      }
      // sweepAllocationsWithPromotion's "doomed primaries" capture, from the
      // reconcile's own prune of the held booking's rows — a different
      // mechanism, kept out of this fixture so the assertions below are about
      // the displacement apply path alone.
      if (args?.where?.isSecondOccupant === false) {
        return [];
      }
      // The pre-write read of the rows the displacements are about to remove.
      if (args?.select?.isSecondOccupant === true) {
        return [
          {
            bookingGuestId: "prov-g1",
            stayDate: NIGHT_UTC,
            bedId: "bed-a2",
            isSecondOccupant: options.displacedIsSecondOccupant === true,
          },
        ];
      }
      // The occupancy re-check immediately before the write: bed-night +
      // occupant identity only, with none of the planner load's relations.
      if (
        args?.select?.bookingGuestId === true &&
        args?.select?.bedId === true &&
        args?.select?.booking === undefined
      ) {
        return (options.occupiedTargets ?? []).map((row) => ({
          bedId: row.bedId,
          stayDate: NIGHT_UTC,
          bookingGuestId: row.bookingGuestId,
        }));
      }
      // The planner's occupancy load.
      return planned;
    });

    return makeDb({
      bedAllocationSettings: {
        findUnique: vi.fn().mockResolvedValue({ autoAllocationEnabled: true }),
      },
      lodgeRoom: {
        findMany: vi.fn().mockResolvedValue([TWO_ROOMS_TWO_BEDS[0]]),
      },
      booking: {
        findUnique: vi.fn().mockResolvedValue({
          id: "held-new",
          status: BookingStatus.PAID,
          deletedAt: null,
          checkIn: NIGHT,
          checkOut: NIGHT_END,
          guests: [HELD_GUEST],
        }),
        findMany: vi.fn().mockResolvedValue([
          {
            id: "held-new",
            createdAt: new Date("2026-07-01T00:00:00.000Z"),
            requestedRoomId: null,
            status: BookingStatus.PAID,
            originBookingRequest: null,
            guests: [HELD_GUEST],
          },
        ]),
      },
      bedAllocation: {
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
        findMany,
        createMany: vi.fn().mockResolvedValue({ count: 1 }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        update: vi.fn().mockResolvedValue({}),
        delete: vi.fn().mockResolvedValue({}),
      },
    });
  }

  it("promotes the surviving second occupant when a displacement removes a shared double's primary", async () => {
    const db = displacementDb({
      partner: {
        id: "alloc-partner",
        bedId: "bed-a2",
        bookingId: "partner-booking",
        bookingGuestId: "partner-g1",
      },
    });

    await reconcileBedAllocationsForBooking({
      bookingId: "held-new",
      db: db as any,
    });

    // The primary is gone...
    expect(db.bedAllocation.deleteMany).toHaveBeenCalledWith({
      where: { bookingGuestId: "prov-g1", stayDate: NIGHT_UTC },
    });
    // ...and the partner it would have stranded is promoted, on the same
    // client, after the removal — never left as a dead-ended orphan.
    expect(db.bedAllocation.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["alloc-partner"] }, isSecondOccupant: true },
      data: { isSecondOccupant: false },
    });
    const promotionAudits = db.auditLog.create.mock.calls.filter(
      (call: any[]) => call[0]?.data?.action === "BED_ALLOCATION_PARTNER_PROMOTED",
    );
    expect(promotionAudits).toHaveLength(1);
    // The promotion is audited against the PARTNER's own booking, which is not
    // the booking whose displacement triggered it.
    expect(promotionAudits[0][0].data.targetId).toBe("partner-booking");
  });

  it("promotes nothing when the displaced row was itself the SECOND occupant", async () => {
    // Removing a second occupant leaves the primary in place: there is no
    // orphan, and flipping anything here would collide with
    // @@unique([bedId, stayDate, isSecondOccupant]).
    const db = displacementDb({
      displacedIsSecondOccupant: true,
      partner: {
        id: "alloc-partner",
        bedId: "bed-a2",
        bookingId: "partner-booking",
        bookingGuestId: "partner-g1",
      },
    });

    await reconcileBedAllocationsForBooking({
      bookingId: "held-new",
      db: db as any,
    });

    expect(db.bedAllocation.updateMany).not.toHaveBeenCalled();
    for (const call of db.auditLog.create.mock.calls) {
      expect(call[0]?.data?.action).not.toBe("BED_ALLOCATION_PARTNER_PROMOTED");
    }
  });

  it("refuses to write a row onto a bed-night the database still shows as occupied", async () => {
    // `createMany({ skipDuplicates: true })` is not a safety mechanism: against
    // a surviving SECOND occupant there is no duplicate to skip, and the row
    // would be created — an unrelated person in a double beside someone else's
    // partner. The payload is filtered instead, on the writing client.
    const db = displacementDb({
      occupiedTargets: [{ bedId: "bed-a2", bookingGuestId: "stranger-g1" }],
    });

    const result = await reconcileBedAllocationsForBooking({
      bookingId: "held-new",
      db: db as any,
    });

    expect(db.bedAllocation.createMany).not.toHaveBeenCalled();
    expect(result.createdCount).toBe(0);

    // ...and NOTHING was displaced for that write (#2669 review F1). The filter
    // runs BEFORE the displacements, so an emptied payload takes its
    // displacements down with it. Applying them first would evict a real
    // provisional booking, and audit it as displaced "so a capacity-holding
    // booking could claim it", for a claim that then never happened — the exact
    // state `justifiedDisplacements` exists to prevent.
    for (const call of db.bedAllocation.deleteMany.mock.calls) {
      expect(call[0]?.where?.bookingGuestId).toBeUndefined();
    }
    expect(db.bedAllocation.updateMany).not.toHaveBeenCalled();
    for (const call of db.auditLog.create.mock.calls) {
      expect(call[0]?.data?.action).not.toBe(
        "bed_allocation.provisional_displaced",
      );
    }
  });

  it("still writes when the only occupant of the target bed-night is the row this apply just displaced", async () => {
    // The paired control: the guard must not refuse the bed the plan itself
    // freed, whatever read-your-own-writes semantics the caller's client has.
    const db = displacementDb({
      occupiedTargets: [{ bedId: "bed-a2", bookingGuestId: "prov-g1" }],
    });

    const result = await reconcileBedAllocationsForBooking({
      bookingId: "held-new",
      db: db as any,
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
    expect(result.createdCount).toBe(1);
  });
});

/**
 * #3123 — the partner-share writers judge "future" on the day the CALLER
 * resolved, and resolve nothing themselves.
 *
 * All three sites run on a transaction client with locks already held: the two
 * lock-prefix helpers take `pg_advisory_xact_lock(1)` and every affected lodge
 * capacity key on their way in, and both sweeps are called after them (merge's
 * after a `Member … FOR UPDATE` as well). `INV-LOCK-004` forbids resolving the
 * club's timezone there — it is a `clubTimeSettings.findUnique`, so it would
 * take a second pooled connection and hold it under those keys for the length
 * of the query, which on the merge path is a 120-second window. So `today` is a
 * REQUIRED parameter and the caller resolves it before opening its transaction.
 *
 * DISCRIMINATION. Every assertion below supplies 30 June and rejects 1 July.
 * 1 July is what `getTodayDateOnly()` answers at the frozen instant under this
 * file's unmocked environment (`APP_TIME_ZONE` falls back to
 * `Pacific/Auckland`), so it is exactly the value the pre-migration code
 * produced — a site that ignored its parameter and read the container's zone
 * would pass a test that supplied 1 July, and fails these.
 *
 * Where the read HAPPENS, as opposed to which day it gives, is covered by
 * `lock-bound-club-zone-outside-transaction.test.ts`, which fails if any
 * club-zone reader reappears in this module or inside any caller's
 * `$transaction` callback.
 */
describe("the partner-share writers take the day they are given (#3123)", () => {
  /** Deliberately NOT the day the container's zone produces. */
  const SUPPLIED_CLUB_DAY = new Date("2026-06-30T00:00:00.000Z");
  const ENVIRONMENT_DAY = new Date("2026-07-01T00:00:00.000Z");
  const LODGE = "lodge-locked";

  function stayDateBound(findMany: ReturnType<typeof vi.fn>, nth = 0): Date {
    const args = findMany.mock.calls[nth]?.[0] as {
      where: { stayDate: { gte: Date } };
    };
    return args.where.stayDate.gte;
  }

  it("PREMISE: 30 June is not what the container's zone would have said", () => {
    // Without this the suite would still pass if the supplied day happened to
    // equal the environment's, which is the false green #3123 names by hand.
    expect(SUPPLIED_CLUB_DAY.toISOString()).not.toBe(
      ENVIRONMENT_DAY.toISOString(),
    );
    expect(ENVIRONMENT_DAY.toISOString()).toBe(
      CLUB_TODAY_DATE_ONLY.toISOString(),
    );
  });

  it("bounds the lock-prefix lodge derivation on the supplied day", async () => {
    const findMany = vi.fn().mockResolvedValue([{ room: { lodgeId: LODGE } }]);
    const tx = {
      $executeRaw: vi.fn().mockResolvedValue(1),
      bedAllocation: { findMany },
    } as any;

    await acquireFuturePartnerSharedAllocationLocks(
      tx,
      ["member-a"],
      SUPPLIED_CLUB_DAY,
    );

    // A day out here locks the WRONG set of lodges, which is worse than a
    // wrong date in a query: the sweep that follows then judges bed inventory
    // in a lodge nothing is serialising.
    expect(stayDateBound(findMany).toISOString()).toBe(
      SUPPLIED_CLUB_DAY.toISOString(),
    );
  });

  it("bounds the #1756 sweep's candidate reads on the supplied day", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const db = {
      bedAllocation: { findMany, deleteMany: vi.fn() },
      memberPartnerLink: { findMany: vi.fn().mockResolvedValue([]) },
      member: { findMany: vi.fn().mockResolvedValue([]) },
      auditLog: { create: vi.fn() },
    } as any;

    await sweepFuturePartnerSharedAllocationsWithLocksHeld({
      memberId: "member-a",
      reason: "member_deactivated",
      db,
      today: SUPPLIED_CLUB_DAY,
    });

    // Both candidate reads — the second-occupant scan and the primary-side
    // scan — share the one day, so the sweep cannot judge two halves of the
    // same share against two different days.
    expect(findMany.mock.calls.length).toBeGreaterThanOrEqual(2);
    for (let call = 0; call < findMany.mock.calls.length; call += 1) {
      expect(stayDateBound(findMany, call).toISOString()).toBe(
        SUPPLIED_CLUB_DAY.toISOString(),
      );
    }
  });

  it("bounds the merge sweep's candidate reads on the supplied day", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const db = {
      bedAllocation: { findMany, deleteMany: vi.fn() },
      bookingGuest: {
        findMany: vi.fn().mockResolvedValue([{ booking: { lodgeId: LODGE } }]),
      },
      memberPartnerLink: { findMany: vi.fn().mockResolvedValue([]) },
      member: { findMany: vi.fn().mockResolvedValue([]) },
      auditLog: { create: vi.fn() },
    } as any;

    await sweepUnbackedFutureSharedDoublesWithLocksHeld({
      memberIds: ["member-a", "member-b"],
      lockedLodgeIds: [LODGE],
      reason: "members_merged",
      db,
      today: SUPPLIED_CLUB_DAY,
    });

    expect(findMany.mock.calls.length).toBeGreaterThanOrEqual(1);
    for (let call = 0; call < findMany.mock.calls.length; call += 1) {
      expect(stayDateBound(findMany, call).toISOString()).toBe(
        SUPPLIED_CLUB_DAY.toISOString(),
      );
    }
  });
});
