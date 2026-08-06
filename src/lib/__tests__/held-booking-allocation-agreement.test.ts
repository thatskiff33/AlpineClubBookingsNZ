import { BookingStatus } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Two-paths agreement: whole-lodge-held bookings get NO bed allocations
// (ADR-001 bed-allocation short-circuit, issue #2285).
//
// ADR-001 says a held booking implicitly occupies every bed, so BOTH surfaces
// that write/plan BedAllocation rows must skip it:
//   1. the admin board planner (getBedAllocationDashboard, #120), and
//   2. the lifecycle auto-allocator (reconcileBedAllocationsForBooking).
// Issue #2285 was exactly a divergence here — the board excluded held bookings
// while the lifecycle silently created rows for them. This file is the guard
// the issue demanded: it runs ONE shared held-booking scenario through both
// paths and fails if either ever starts allocating a held booking again. The
// non-held control proves the fixture is potent (both paths DO allocate the
// identical ordinary booking), so the held assertions cannot pass vacuously.
// ---------------------------------------------------------------------------

const prismaState = vi.hoisted(() => ({
  db: undefined as any,
  transaction: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: new Proxy(
    {},
    {
      get: (_target, property) =>
        property === "$transaction"
          ? prismaState.transaction
          : prismaState.db?.[property as keyof typeof prismaState.db],
    },
  ),
}));

vi.mock("@/lib/lodge-capacity", () => ({
  getLodgeCapacityStatus: vi.fn().mockResolvedValue({
    capacity: 29,
    source: "capacity_override",
    bedAllocationEnabled: false,
    activeBedCount: 0,
    fallbackCapacity: 29,
  }),
  getLodgePartnerSharedCapacityStatus: vi.fn().mockResolvedValue({
    capacity: 29,
    source: "capacity_override",
    bedAllocationEnabled: false,
    activeBedCount: 0,
    fallbackCapacity: 29,
    activeDoubleBedCount: 0,
    partnerSharedHeadroom: 0,
  }),
}));

import {
  getBedAllocationDashboard,
  isBookingBedAllocationLocked,
  parseBedAllocationDateRange,
  runAutoBedAllocation,
} from "@/lib/admin-bed-allocation";
import { BED_ALLOCATION_PRIORITY_VOCABULARY } from "@/lib/bed-allocation-settings";
import { reconcileBedAllocationsForBookingWithLodgeLockHeld as reconcileBedAllocationsForBooking } from "@/lib/bed-allocation-lifecycle";
import { parseDateOnly } from "@/lib/date-only";

// --- Shared scenario: one booking, two guests, one night, a room with two ---
// --- free beds, auto-allocation enabled. Held vs ordinary is the only knob. --

const CHECK_IN = parseDateOnly("2026-07-01");
const CHECK_OUT = parseDateOnly("2026-07-02");
const BOOKING_ID = "booking-scenario";

const ROOM = {
  id: "room-a",
  name: "Room A",
  sortOrder: 1,
  active: true,
  notes: null,
  lodgeId: "lodge-1",
  beds: [1, 2].map((n) => ({
    id: `bed-a-${n}`,
    roomId: "room-a",
    name: `A${n}`,
    sortOrder: n,
    active: true,
    bedType: "SINGLE",
    bunkGroup: null,
  })),
};

function scenarioGuest(id: string) {
  return {
    id,
    bookingId: BOOKING_ID,
    firstName: id,
    lastName: "Test",
    ageTier: "ADULT",
    stayStart: CHECK_IN,
    stayEnd: CHECK_OUT,
    nights: [{ stayDate: CHECK_IN }],
  };
}

// Board-shaped booking row (loadBookingRecords select).
function boardBooking(wholeLodgeHold: boolean) {
  return {
    id: BOOKING_ID,
    status: "CONFIRMED",
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
    checkIn: CHECK_IN,
    checkOut: CHECK_OUT,
    lodgeId: "lodge-1",
    requestedRoomId: null,
    parentBookingId: null,
    originBookingRequest: null,
    heldForBookingRequest: null,
    requestedRoom: null,
    adminCapacityHoldAt: null,
    wholeLodgeHold,
    member: { firstName: "Org", lastName: "Contact", email: "org@example.nz" },
    guests: [scenarioGuest("guest-1"), scenarioGuest("guest-2")],
  };
}

function boardDb(wholeLodgeHold: boolean) {
  return {
    bedAllocationSettings: {
      findUnique: vi.fn().mockResolvedValue({
        autoAllocationEnabled: true,
        allocationPriorityOrder: [...BED_ALLOCATION_PRIORITY_VOCABULARY],
        updatedByMemberId: null,
        updatedAt: parseDateOnly("2026-06-30"),
      }),
    },
    lodgeRoom: { findMany: vi.fn().mockResolvedValue([ROOM]) },
    booking: {
      findMany: vi.fn().mockResolvedValue([boardBooking(wholeLodgeHold)]),
    },
    bedAllocation: { findMany: vi.fn().mockResolvedValue([]) },
    // #2286: custodian bed holds. None here — this file is about the
    // whole-lodge-hold short-circuit, which the custodian never contends with.
    hutLeaderAssignment: { findMany: vi.fn().mockResolvedValue([]) },
    // #2286: runAutoBedAllocation now writes inside a locked transaction.
    $executeRaw: vi.fn().mockResolvedValue(1),
  };
}

async function runAutoWithDb(db: any) {
  prismaState.db = db;
  prismaState.transaction.mockImplementation(
    async (callback: (tx: typeof db) => unknown) => callback(db),
  );
  return runAutoBedAllocation({ range: RANGE, lodgeId: "lodge-1" });
}

// Lifecycle-shaped mock client (mirrors bed-allocation-lifecycle.test.ts).
function lifecycleDb(wholeLodgeHold: boolean) {
  const db: any = {
    clubModuleSettings: {
      findUnique: vi.fn().mockResolvedValue({ bedAllocation: true }),
    },
    // #2286: custodian bed holds. None here.
    hutLeaderAssignment: { findMany: vi.fn().mockResolvedValue([]) },
    booking: {
      findUnique: vi.fn().mockResolvedValue({
        id: BOOKING_ID,
        status: BookingStatus.CONFIRMED,
        deletedAt: null,
        checkIn: CHECK_IN,
        checkOut: CHECK_OUT,
        lodgeId: null,
        wholeLodgeHold,
        guests: [scenarioGuest("guest-1"), scenarioGuest("guest-2")],
      }),
      findMany: vi.fn().mockResolvedValue([
        {
          id: BOOKING_ID,
          createdAt: new Date("2026-06-01T00:00:00.000Z"),
          requestedRoomId: null,
          checkIn: CHECK_IN,
          checkOut: CHECK_OUT,
          status: BookingStatus.CONFIRMED,
          originBookingRequest: null,
          heldForBookingRequest: null,
          adminCapacityHoldAt: null,
          wholeLodgeHold,
          guests: [scenarioGuest("guest-1"), scenarioGuest("guest-2")],
        },
      ]),
    },
    bedAllocation: {
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      findMany: vi.fn().mockResolvedValue([]),
      createMany: vi.fn().mockResolvedValue({ count: 2 }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findFirst: vi.fn().mockResolvedValue(null),
    },
    bedAllocationSettings: {
      findUnique: vi.fn().mockResolvedValue({
        autoAllocationEnabled: true,
        allocationPriorityOrder: [...BED_ALLOCATION_PRIORITY_VOCABULARY],
      }),
    },
    lodgeRoom: { findMany: vi.fn().mockResolvedValue([ROOM]) },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  };
  db.$transaction = vi.fn((cb: (client: unknown) => unknown) => cb(db));
  return db;
}

const RANGE = parseBedAllocationDateRange({ from: "2026-07-01", to: "2026-07-03" });

describe("held bookings get no allocations — board and lifecycle agree (ADR-001, #2285)", () => {
  it("HELD: the board plans nothing for it AND the lifecycle creates nothing for it", async () => {
    // Path 1 — admin board planner (#120): the held booking's guest-nights are
    // excluded from awaiting-allocation and from the plan, and it is
    // represented via the exclusiveHolds banner instead.
    const dashboard = await getBedAllocationDashboard({
      range: RANGE,
      db: boardDb(true) as never,
    });
    expect(
      dashboard.unallocatedGuestNights.every((g) => g.bookingId !== BOOKING_ID),
    ).toBe(true);
    expect(
      dashboard.suggestedAllocations.every((a) => a.bookingId !== BOOKING_ID),
    ).toBe(true);
    expect(dashboard.exclusiveHolds.map((h) => h.bookingId)).toEqual([
      BOOKING_ID,
    ]);

    // Path 2 — lifecycle (#2285): reconcile prunes every row the booking owns
    // (whole-booking sweep — the legacy-row self-heal) and creates none.
    const db = lifecycleDb(true);
    const result = await reconcileBedAllocationsForBooking({
      bookingId: BOOKING_ID,
      db,
    });
    expect(db.bedAllocation.deleteMany).toHaveBeenCalledWith({
      where: { bookingId: BOOKING_ID },
    });
    expect(db.bedAllocation.createMany).not.toHaveBeenCalled();
    expect(result.createdCount).toBe(0);
  });

  it("CONTROL (not held): BOTH paths allocate the identical ordinary booking — the fixture is potent", async () => {
    // Board: both guests await allocation and the planner suggests beds.
    const dashboard = await getBedAllocationDashboard({
      range: RANGE,
      db: boardDb(false) as never,
    });
    expect(
      dashboard.unallocatedGuestNights.some((g) => g.bookingId === BOOKING_ID),
    ).toBe(true);
    expect(
      dashboard.suggestedAllocations.some((a) => a.bookingId === BOOKING_ID),
    ).toBe(true);
    expect(dashboard.exclusiveHolds).toEqual([]);

    // Lifecycle: reconcile auto-places both guests in the free room.
    const db = lifecycleDb(false);
    const result = await reconcileBedAllocationsForBooking({
      bookingId: BOOKING_ID,
      db,
    });
    expect(db.bedAllocation.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [
          expect.objectContaining({ bookingGuestId: "guest-1", source: "AUTO" }),
          expect.objectContaining({ bookingGuestId: "guest-2", source: "AUTO" }),
        ],
      }),
    );
    expect(result.createdCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Write-time re-check on the BOARD planner (#2285 review).
//
// `runAutoBedAllocation` reads the dashboard and then `createMany`s under NO
// lock at all, so an exclusive hold set in between would be silently undone:
// the hold's prune frees the unique keys, so `skipDuplicates` cannot stop the
// re-insert. Both planners now re-read the payload's bookings immediately
// before the write and drop rows for any booking that has become
// unallocatable.
// ---------------------------------------------------------------------------
describe("Run Auto Allocation re-checks the bookings it is about to write (#2285 review)", () => {
  /**
   * Board db whose booking reads drift: the dashboard load (the only read
   * selecting `guests`) sees an ordinary booking, while the write-time re-check
   * sees whatever `writeTime` says.
   */
  function driftingBoardDb(writeTime: {
    status?: string;
    deletedAt?: Date | null;
    wholeLodgeHold?: boolean;
  }) {
    const db: any = boardDb(false);
    const dashboardRows = [boardBooking(false)];
    const writeTimeRows = [
      {
        id: BOOKING_ID,
        status: writeTime.status ?? "CONFIRMED",
        deletedAt: writeTime.deletedAt ?? null,
        wholeLodgeHold: writeTime.wholeLodgeHold ?? false,
      },
    ];
    db.booking.findMany = vi.fn(async ({ select }: any) =>
      select?.guests ? dashboardRows : writeTimeRows,
    );
    db.bedAllocation.createMany = vi.fn().mockResolvedValue({ count: 2 });
    return db;
  }

  it("writes nothing when an exclusive hold lands between the dashboard read and the write", async () => {
    const db = driftingBoardDb({ wholeLodgeHold: true });

    const result = await runAutoWithDb(db);

    expect(db.bedAllocation.createMany).not.toHaveBeenCalled();
    expect(result.count).toBe(0);
  });

  it("writes nothing when a cancel lands between the dashboard read and the write", async () => {
    const db = driftingBoardDb({ status: "CANCELLED" });

    const result = await runAutoWithDb(db);

    expect(db.bedAllocation.createMany).not.toHaveBeenCalled();
    expect(result.count).toBe(0);
  });

  it("control: an unchanged booking is still written in full", async () => {
    const db = driftingBoardDb({});

    const result = await runAutoWithDb(db);

    expect(db.bedAllocation.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({ bookingId: BOOKING_ID, source: "AUTO" }),
        expect.objectContaining({ bookingId: BOOKING_ID, source: "AUTO" }),
      ],
      skipDuplicates: true,
    });
    expect(result.count).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Requested-room lock semantics across the hold toggle (#2285 review, F6).
//
// A member may set/clear their requested room until the lodge confirms beds;
// the lock signal (#776) is "this booking has at least one APPROVED
// BedAllocation row" (`isBookingBedAllocationLocked`). Setting an exclusive
// hold prunes every row the booking owns, approved ones included, so the lock
// falls OFF and the member's room editor re-opens — and after the hold is
// cleared, the AUTO re-plan creates unapproved rows, so it STAYS off until an
// admin approves again.
//
// That is the intended, coherent state and is deliberately NOT changed: with no
// allocated beds there is nothing for the lock to protect, and a lock left on
// over zero rows would strand the member's requested room behind a confirmation
// that no longer exists. This test pins the semantics so a future change has to
// be a deliberate decision rather than an accident; the audit list the prune
// records (`booking.exclusiveHold.set` metadata) is the recovery path for the
// approvals it destroys.
// ---------------------------------------------------------------------------
describe("requested-room lock is OFF after a hold set and after a hold clear (#2285 review)", () => {
  /** A tiny BedAllocation store shared by the reconcile mock and the lock read. */
  function lockScenarioDb(rows: Array<{ id: string; approvedAt: Date | null }>) {
    let store = [...rows];
    const db: any = {
      clubModuleSettings: {
        findUnique: vi.fn().mockResolvedValue({ bedAllocation: true }),
      },
      booking: {
        findUnique: vi.fn(),
        findMany: vi.fn().mockResolvedValue([]),
      },
      bedAllocation: {
        deleteMany: vi.fn(async () => {
          const count = store.length;
          store = [];
          return { count };
        }),
        findMany: vi.fn().mockResolvedValue([]),
        createMany: vi.fn(async ({ data }: any) => {
          // The planner never stamps approvedAt — AUTO rows are drafts.
          for (const row of data) {
            store.push({ id: `auto-${store.length}`, approvedAt: row.approvedAt ?? null });
          }
          return { count: data.length };
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        // The #776 lock read: "any approved row for this booking?"
        findFirst: vi.fn(async () => store.find((row) => row.approvedAt !== null) ?? null),
      },
      bedAllocationSettings: {
        findUnique: vi.fn().mockResolvedValue({
          autoAllocationEnabled: true,
          allocationPriorityOrder: [...BED_ALLOCATION_PRIORITY_VOCABULARY],
        }),
      },
      lodgeRoom: { findMany: vi.fn().mockResolvedValue([ROOM]) },
      // #2286: custodian bed holds. None here.
      hutLeaderAssignment: { findMany: vi.fn().mockResolvedValue([]) },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
    };
    db.$transaction = vi.fn((cb: (client: unknown) => unknown) => cb(db));
    return db;
  }

  const heldBooking = {
    id: BOOKING_ID,
    status: BookingStatus.CONFIRMED,
    deletedAt: null,
    checkIn: CHECK_IN,
    checkOut: CHECK_OUT,
    lodgeId: null,
    wholeLodgeHold: true,
    guests: [scenarioGuest("guest-1"), scenarioGuest("guest-2")],
  };

  it("SET: the prune removes the approved rows, so the lock falls off", async () => {
    // The booking has an APPROVED row, so the member's room editor is locked.
    const db = lockScenarioDb([
      { id: "approved-1", approvedAt: new Date("2026-06-15T00:00:00.000Z") },
    ]);
    expect(await isBookingBedAllocationLocked({ bookingId: BOOKING_ID, db })).toBe(
      true,
    );

    db.booking.findUnique.mockResolvedValue(heldBooking);
    await reconcileBedAllocationsForBooking({ bookingId: BOOKING_ID, db });

    expect(await isBookingBedAllocationLocked({ bookingId: BOOKING_ID, db })).toBe(
      false,
    );
  });

  it("CLEAR: the AUTO re-plan creates only unapproved rows, so the lock stays off until re-approval", async () => {
    const db = lockScenarioDb([]);
    db.booking.findUnique.mockResolvedValue({
      ...heldBooking,
      wholeLodgeHold: false,
    });
    db.booking.findMany.mockImplementation(async ({ select }: any) =>
      select?.guests
        ? [
            {
              id: BOOKING_ID,
              createdAt: new Date("2026-06-01T00:00:00.000Z"),
              requestedRoomId: null,
              checkIn: CHECK_IN,
              checkOut: CHECK_OUT,
              status: BookingStatus.CONFIRMED,
              originBookingRequest: null,
              heldForBookingRequest: null,
              adminCapacityHoldAt: null,
              wholeLodgeHold: false,
              guests: [scenarioGuest("guest-1"), scenarioGuest("guest-2")],
            },
          ]
        : [
            {
              id: BOOKING_ID,
              status: BookingStatus.CONFIRMED,
              deletedAt: null,
              wholeLodgeHold: false,
            },
          ],
    );

    const result = await reconcileBedAllocationsForBooking({
      bookingId: BOOKING_ID,
      db,
    });

    expect(result.createdCount).toBe(2);
    expect(await isBookingBedAllocationLocked({ bookingId: BOOKING_ID, db })).toBe(
      false,
    );
  });
});
