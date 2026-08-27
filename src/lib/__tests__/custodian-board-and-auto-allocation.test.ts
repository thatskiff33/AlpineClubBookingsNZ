import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseDateOnly } from "@/lib/date-only";

/**
 * Custodian occupancy — the board payload, the planner feed, and the
 * auto-allocation re-filter (#2286, chokepoints 2 and 4).
 *
 * The planner is where a custodian bed-night has to become invisible-but-taken:
 * it is fed as a #1768 unknown-occupant row (null booking, null guest), which
 * the planner treats as blocking and never evictable. `runAutoBedAllocation`
 * then re-reads the holds under its own lock before writing — defence in
 * depth, because the dashboard read that produced the suggestions was unlocked.
 */

const mocks = vi.hoisted(() => ({
  hutLeaderAssignmentFindMany: vi.fn(),
  transaction: vi.fn(),
  executeRaw: vi.fn(),
  createMany: vi.fn(),
  lodgeRoomFindManyForLocks: vi.fn(),
  dropAllocationRows: vi.fn(),
  db: undefined as any,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: new Proxy(
    {},
    {
      get: (_target, property) =>
        property === "$transaction"
          ? mocks.transaction
          : mocks.db?.[property as keyof typeof mocks.db],
    },
  ),
}));

vi.mock("@/lib/lodge-capacity", () => ({
  getLodgeCapacityStatus: vi.fn(),
  getLodgePartnerSharedCapacityStatus: vi.fn(),
}));

vi.mock("@/lib/bed-allocation-lifecycle", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/bed-allocation-lifecycle")>();
  return {
    ...actual,
    // The write-time re-check (#2285) has its own coverage; here it passes
    // everything through so the CUSTODIAN filter is the only thing acting.
    dropAllocationRowsForUnallocatableBookings: mocks.dropAllocationRows,
  };
});

import {
  BedAllocationAdminError,
} from "@/lib/bed-allocation-admin-contract";
import {
  runAutoBedAllocation,
} from "@/lib/bed-allocation-auto-allocate";
import {
  getBedAllocationDashboard,
} from "@/lib/bed-allocation-board";
import {
  parseBedAllocationDateRange,
} from "@/lib/bed-allocation-date-range";
import { requireCalendarDate } from "@/lib/club-time";
import { BED_ALLOCATION_PRIORITY_VOCABULARY } from "@/lib/bed-allocation-settings";

const LODGE = "lodge-1";

const room = {
  id: "room-a",
  name: "Kea",
  sortOrder: 1,
  active: true,
  notes: null,
  lodgeId: LODGE,
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

function bookingRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "booking-1",
    status: "CONFIRMED",
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
    checkIn: parseDateOnly("2026-07-01"),
    checkOut: parseDateOnly("2026-07-02"),
    lodgeId: LODGE,
    requestedRoomId: null,
    parentBookingId: null,
    originBookingRequest: null,
    heldForBookingRequest: null,
    requestedRoom: null,
    adminCapacityHoldAt: null,
    wholeLodgeHold: false,
    member: { firstName: "Org", lastName: "Contact", email: "s@x.nz" },
    guests: [
      {
        id: "guest-1",
        bookingId: "booking-1",
        firstName: "Ada",
        lastName: "Guest",
        ageTier: "ADULT",
        stayStart: parseDateOnly("2026-07-01"),
        stayEnd: parseDateOnly("2026-07-02"),
        nights: [{ stayDate: parseDateOnly("2026-07-01") }],
      },
    ],
    ...overrides,
  };
}

function holdRow(bedId = "bed-a-1") {
  return {
    id: "assignment-1",
    memberId: "member-1",
    lodgeId: LODGE,
    bedId,
    startDate: parseDateOnly("2026-07-01"),
    endDate: parseDateOnly("2026-07-01"),
    member: { firstName: "Sam", lastName: "Ranger", ageTier: "ADULT" },
    bed: {
      id: bedId,
      name: bedId.toUpperCase(),
      roomId: "room-a",
      room: { id: "room-a", name: "Kea" },
    },
  };
}

function buildDb(overrides: Record<string, unknown> = {}) {
  return {
    $executeRaw: mocks.executeRaw,
    lodge: {
      findUnique: vi.fn().mockResolvedValue({ id: LODGE, active: true }),
    },
    bedAllocationSettings: {
      findUnique: vi.fn().mockResolvedValue({
        autoAllocationEnabled: true,
        allocationPriorityOrder: [...BED_ALLOCATION_PRIORITY_VOCABULARY],
        updatedByMemberId: null,
        updatedAt: parseDateOnly("2026-06-30"),
      }),
    },
    lodgeRoom: { findMany: vi.fn().mockResolvedValue([room]) },
    booking: { findMany: vi.fn().mockResolvedValue([bookingRow()]) },
    bedAllocation: {
      findMany: vi.fn().mockResolvedValue([]),
      createMany: mocks.createMany,
    },
    hutLeaderAssignment: { findMany: mocks.hutLeaderAssignmentFindMany },
    ...overrides,
  } as never;
}

async function runAutoWithDb(
  db: ReturnType<typeof buildDb>,
  input: Parameters<typeof runAutoBedAllocation>[0],
) {
  mocks.db = db;
  mocks.transaction.mockImplementation(
    async (callback: (tx: typeof db) => unknown) => callback(db),
  );
  return runAutoBedAllocation(input);
}

// The board range is half-open: nights are [fromDate, toDate), so this window
// is the single night of 2026-07-01.
/**
 * #3123 — the club's day is now a required argument of
 * `parseBedAllocationDateRange`, resolved by the caller (`INV-LOCK-004`). Every
 * call in this file names its own `from`, so nothing below depends on the value.
 */
const CLUB_DAY = requireCalendarDate("2026-07-01");

const range = parseBedAllocationDateRange({
  from: "2026-07-01",
  to: "2026-07-02",
}, CLUB_DAY);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.hutLeaderAssignmentFindMany.mockResolvedValue([]);
  mocks.executeRaw.mockResolvedValue(1);
  mocks.createMany.mockResolvedValue({ count: 0 });
  mocks.dropAllocationRows.mockImplementation(async (_db, rows) => ({
    rows,
    droppedBookingIds: [],
  }));
});

describe("board payload (chokepoint 2)", () => {
  it("emits the custodian holds overlapping the range, clamped to the board's nights", async () => {
    mocks.hutLeaderAssignmentFindMany.mockResolvedValue([holdRow()]);

    const dashboard = await getBedAllocationDashboard({
      range,
      lodgeId: LODGE,
      db: buildDb(),
    });

    expect(dashboard.custodianHolds).toEqual([
      {
        assignmentId: "assignment-1",
        memberName: "Sam Ranger",
        bedId: "bed-a-1",
        bedName: "BED-A-1",
        roomId: "room-a",
        roomName: "Kea",
        startDate: "2026-07-01",
        endDate: "2026-07-01",
        nights: ["2026-07-01"],
      },
    ]);
  });

  it("is an empty list when nothing is held, so the board renders exactly as before", async () => {
    const dashboard = await getBedAllocationDashboard({
      range,
      lodgeId: LODGE,
      db: buildDb(),
    });
    expect(dashboard.custodianHolds).toEqual([]);
  });

  it("keeps the planner off a held bed: the suggestion moves to the free bed instead", async () => {
    // Without a hold the first-fit planner takes bed-a-1.
    const free = await getBedAllocationDashboard({
      range,
      lodgeId: LODGE,
      db: buildDb(),
    });
    expect(free.suggestedAllocations[0]).toMatchObject({ bedId: "bed-a-1" });

    mocks.hutLeaderAssignmentFindMany.mockResolvedValue([holdRow("bed-a-1")]);
    const held = await getBedAllocationDashboard({
      range,
      lodgeId: LODGE,
      db: buildDb(),
    });
    expect(held.suggestedAllocations[0]).toMatchObject({ bedId: "bed-a-2" });
  });

  it("leaves the guest unallocated rather than placing them when EVERY bed is held", async () => {
    mocks.hutLeaderAssignmentFindMany.mockResolvedValue([
      { ...holdRow("bed-a-1"), id: "assignment-1" },
      { ...holdRow("bed-a-2"), id: "assignment-2" },
    ]);

    const dashboard = await getBedAllocationDashboard({
      range,
      lodgeId: LODGE,
      db: buildDb(),
    });
    expect(dashboard.suggestedAllocations).toEqual([]);
    expect(dashboard.suggestedUnallocatedGuestNights.length).toBeGreaterThan(0);
  });
});

describe("runAutoBedAllocation (chokepoint 4)", () => {
  it.each([null, { id: LODGE, active: false }])(
    "rejects an unknown or inactive lodge under the locks before planning or writing",
    async (lodge) => {
      const lodgeFindUnique = vi.fn().mockResolvedValue(lodge);
      const roomFindMany = vi.fn();
      const db = buildDb({
        lodge: { findUnique: lodgeFindUnique },
        lodgeRoom: { findMany: roomFindMany },
      });

      await expect(
        runAutoWithDb(db, { range, lodgeId: LODGE }),
      ).rejects.toEqual(
        expect.objectContaining<Partial<BedAllocationAdminError>>({
          message: "Lodge not found or not active",
          status: 400,
        }),
      );

      expect(mocks.transaction).toHaveBeenCalledOnce();
      expect(mocks.executeRaw).toHaveBeenCalled();
      expect(lodgeFindUnique).toHaveBeenCalledWith({
        where: { id: LODGE },
        select: { id: true, active: true },
      });
      expect(roomFindMany).not.toHaveBeenCalled();
      expect(mocks.createMany).not.toHaveBeenCalled();
    },
  );

  it("rebuilds after the locks and never writes the bed deactivated/retyped after preview", async () => {
    let inventory = room;
    const roomFindMany = vi.fn(async () => [inventory]);
    const db = buildDb({ lodgeRoom: { findMany: roomFindMany } });

    const preview = await getBedAllocationDashboard({
      range,
      lodgeId: LODGE,
      db,
    });
    expect(preview.suggestedAllocations).toEqual([
      expect.objectContaining({ bedId: "bed-a-1" }),
    ]);

    // The transaction callback is the interleaving seam: the inventory writer
    // wins after the action starts but before global -> lodge is acquired. The
    // pre-fix implementation planned before opening this transaction and wrote
    // bed-a-1 from that stale snapshot. Retyping is included in the same edit.
    roomFindMany.mockClear();
    mocks.db = db;
    mocks.transaction.mockImplementation(
      async (callback: (tx: typeof db) => unknown) => {
        inventory = {
          ...room,
          beds: room.beds.map((bed) =>
            bed.id === "bed-a-1"
              ? { ...bed, active: false, bedType: "DOUBLE" }
              : bed,
          ),
        };
        return callback(db);
      },
    );
    mocks.createMany.mockResolvedValue({ count: 1 });

    const result = await runAutoBedAllocation({ range, lodgeId: LODGE });

    expect(result).toEqual({ count: 1 });
    expect(roomFindMany).toHaveBeenCalledOnce();
    expect(mocks.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ bedId: "bed-a-2" })],
      skipDuplicates: true,
    });
    expect(
      mocks.createMany.mock.calls[0][0].data.some(
        (row: { bedId: string }) => row.bedId === "bed-a-1",
      ),
    ).toBe(false);
  });

  it("rebuilds after the locks and writes nothing into a room deactivated after preview", async () => {
    let inventory = room;
    const roomFindMany = vi.fn(async () => [inventory]);
    const db = buildDb({ lodgeRoom: { findMany: roomFindMany } });

    const preview = await getBedAllocationDashboard({
      range,
      lodgeId: LODGE,
      db,
    });
    expect(preview.suggestedAllocations).toHaveLength(1);

    roomFindMany.mockClear();
    mocks.db = db;
    mocks.transaction.mockImplementation(
      async (callback: (tx: typeof db) => unknown) => {
        inventory = { ...room, active: false };
        return callback(db);
      },
    );
    const result = await runAutoBedAllocation({ range, lodgeId: LODGE });

    expect(result).toEqual({ count: 0 });
    expect(roomFindMany).toHaveBeenCalledOnce();
    expect(mocks.createMany).not.toHaveBeenCalled();
  });

  it("re-filters suggestions against custodian holds read inside its own locked transaction", async () => {
    // The dashboard read sees no hold; the in-transaction read does. That is
    // exactly the race the re-filter exists for.
    let call = 0;
    mocks.hutLeaderAssignmentFindMany.mockImplementation(async () => {
      call += 1;
      return call === 1 ? [] : [holdRow("bed-a-1")];
    });

    const db = buildDb();
    const result = await runAutoWithDb(db, { range, lodgeId: LODGE });

    expect(result).toEqual({ count: 0 });
    expect(mocks.createMany).not.toHaveBeenCalled();
  });

  it("writes the suggestions that do not touch a held bed-night", async () => {
    mocks.createMany.mockResolvedValue({ count: 1 });
    const db = buildDb();
    const result = await runAutoWithDb(db, { range, lodgeId: LODGE });

    expect(result).toMatchObject({ count: 1 });
    expect(mocks.createMany).toHaveBeenCalledOnce();
  });

  it("takes the per-lodge advisory lock before writing — it took none at all before #2286", async () => {
    const db = buildDb();
    await runAutoWithDb(db, { range, lodgeId: LODGE });
    expect(mocks.executeRaw).toHaveBeenCalled();
  });

  it("locks exactly the board's required lodge scope", async () => {
    const db = buildDb();

    await runAutoWithDb(db, { range, lodgeId: LODGE });

    const lockedKeys = mocks.executeRaw.mock.calls.flatMap((call) =>
      call.slice(1),
    );
    expect(lockedKeys).toEqual([LODGE]);
    expect(mocks.transaction).toHaveBeenCalledOnce();
  });
});
