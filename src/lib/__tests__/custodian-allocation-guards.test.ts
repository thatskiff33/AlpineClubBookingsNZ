import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseDateOnly } from "@/lib/date-only";


/**
 * #3123 — the club's day now arrives at these lock-bound entry points as a
 * REQUIRED argument, resolved by the caller outside its transaction
 * (`INV-LOCK-004`). This is the same day the frozen clock's default instant
 * produced before the migration, so every assertion below is unchanged.
 */
const CLUB_TODAY_DATE_ONLY = new Date("2026-07-01T00:00:00.000Z");
/**
 * Custodian occupancy — allocation chokepoints (#2286).
 *
 * Enforcement is application-code exclusion (owner decision, option (a)), so
 * these guards ARE the invariant: there is no database constraint behind them
 * that would catch a missed one. Each test corresponds to a numbered
 * chokepoint in the issue's plan.
 */

const mocks = vi.hoisted(() => ({
  hutLeaderAssignmentFindMany: vi.fn(),
  transaction: vi.fn(),
  executeRaw: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: mocks.transaction,
    $executeRaw: mocks.executeRaw,
    hutLeaderAssignment: { findMany: mocks.hutLeaderAssignmentFindMany },
  },
}));

vi.mock("@/lib/lodge-capacity", () => ({
  getLodgeCapacityStatus: vi.fn().mockResolvedValue({
    capacity: 10,
    source: "capacity_override",
    bedAllocationEnabled: true,
    activeBedCount: 10,
    fallbackCapacity: 10,
  }),
  getLodgePartnerSharedCapacityStatus: vi.fn().mockResolvedValue({
    capacity: 10,
    source: "capacity_override",
    bedAllocationEnabled: true,
    activeBedCount: 10,
    fallbackCapacity: 10,
    activeDoubleBedCount: 0,
    partnerSharedHeadroom: 0,
  }),
}));

import {
  BedAllocationAdminError,
} from "@/lib/bed-allocation-admin-contract";
import {
  deleteBedAllocationBedWithLocksHeld as deleteBedAllocationBed,
  updateBedAllocationBedWithLocksHeld as updateBedAllocationBed,
} from "@/lib/bed-allocation-beds";
import {
  manuallyAllocateBedForNightsWithLocksHeld as manuallyAllocateBedForNights,
  manuallyAllocateBedWithLocksHeld as manuallyAllocateBed,
} from "@/lib/bed-allocation-manual-writes";
import {
  deleteBedAllocationRoomWithLocksHeld as deleteBedAllocationRoom,
  updateBedAllocationRoomWithLocksHeld as updateBedAllocationRoom,
} from "@/lib/bed-allocation-rooms";
import {
  buildBedAllocationWarnings,
} from "@/lib/bed-allocation-warnings";

const LODGE = "lodge-a";

function assignmentRow(overrides: Partial<{
  id: string;
  bedId: string;
  startDate: string;
  endDate: string;
}> = {}) {
  const bedId = overrides.bedId ?? "bed-1";
  return {
    id: overrides.id ?? "assignment-1",
    memberId: "member-1",
    lodgeId: LODGE,
    bedId,
    startDate: parseDateOnly(overrides.startDate ?? "2026-07-01"),
    endDate: parseDateOnly(overrides.endDate ?? "2026-07-05"),
    member: { firstName: "Sam", lastName: "Ranger", ageTier: "ADULT" },
    bed: {
      id: bedId,
      name: "A1",
      roomId: "room-1",
      room: { id: "room-1", name: "Kea" },
    },
  };
}

function guestRow() {
  return {
    id: "guest-1",
    bookingId: "booking-1",
    memberId: null,
    stayStart: parseDateOnly("2026-07-01"),
    stayEnd: parseDateOnly("2026-07-06"),
    nights: [],
    booking: {
      id: "booking-1",
      status: "CONFIRMED",
      deletedAt: null,
      lodgeId: LODGE,
      wholeLodgeHold: false,
    },
  };
}

function bedRow() {
  return {
    id: "bed-1",
    roomId: "room-1",
    active: true,
    bedType: "SINGLE",
    name: "A1",
    room: { id: "room-1", active: true, lodgeId: LODGE, name: "Kea" },
  };
}

/** A transactional client covering every delegate the guarded paths touch. */
function buildDb(overrides: Record<string, unknown> = {}) {
  return {
    $executeRaw: mocks.executeRaw,
    hutLeaderAssignment: { findMany: mocks.hutLeaderAssignmentFindMany },
    bookingGuest: { findUnique: vi.fn().mockResolvedValue(guestRow()) },
    lodgeBed: {
      findUnique: vi.fn().mockResolvedValue(bedRow()),
      findMany: vi.fn().mockResolvedValue([{ id: "bed-1" }]),
      delete: vi.fn().mockResolvedValue({ id: "bed-1" }),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      update: vi.fn().mockResolvedValue({ id: "bed-1" }),
    },
    lodgeRoom: {
      findFirst: vi.fn().mockResolvedValue({ id: "room-1" }),
      delete: vi.fn().mockResolvedValue({ id: "room-1" }),
      update: vi.fn().mockResolvedValue({ id: "room-1" }),
    },
    bedAllocation: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(null),
      findUnique: vi.fn().mockResolvedValue(null),
      upsert: vi.fn(({ create }) => ({ id: "allocation-1", ...create })),
    },
    ...overrides,
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.hutLeaderAssignmentFindMany.mockResolvedValue([]);
  mocks.executeRaw.mockResolvedValue(1);
});

describe("chokepoint 1 — the manual placement funnel", () => {
  it("refuses a single-night placement onto a custodian-held bed-night with a 409 that names the page to fix it on", async () => {
    mocks.hutLeaderAssignmentFindMany.mockResolvedValue([assignmentRow()]);

    await expect(
      manuallyAllocateBed({
        bookingGuestId: "guest-1",
        bedId: "bed-1",
        stayDate: "2026-07-02",
        db: buildDb(),
      }),
    ).rejects.toMatchObject({
      name: "BedAllocationAdminError",
      status: 409,
      message: expect.stringContaining("Hut Leaders"),
    });
  });

  it("still allows a night the hold does not cover", async () => {
    mocks.hutLeaderAssignmentFindMany.mockResolvedValue([
      assignmentRow({ startDate: "2026-07-01", endDate: "2026-07-02" }),
    ]);

    const result = await manuallyAllocateBed({
      bookingGuestId: "guest-1",
      bedId: "bed-1",
      stayDate: "2026-07-03",
      db: buildDb(),
    });
    expect(result.allocation).toMatchObject({ bedId: "bed-1" });
  });

  it("reports a bulk drop's held nights as their OWN conflict reason, not as BED_TAKEN", async () => {
    mocks.hutLeaderAssignmentFindMany.mockImplementation(
      async (args: { where: { startDate: { lt: Date } } }) =>
        // The hold covers 07-03 only.
        args.where.startDate.lt > parseDateOnly("2026-07-03")
          ? [assignmentRow({ startDate: "2026-07-03", endDate: "2026-07-03" })]
          : [],
    );

    const result = await manuallyAllocateBedForNights({
      bookingGuestId: "guest-1",
      bedId: "bed-1",
      stayDates: ["2026-07-02", "2026-07-03"],
      db: buildDb(),
    });

    expect(result.conflicts).toEqual([
      { stayDate: "2026-07-03", reason: "CUSTODIAN_HOLD" },
    ]);
    // The unheld night still lands — a bulk drop places what it can.
    expect(result.allocations).toHaveLength(1);
  });
});

describe("chokepoint 5 — bed and room admin guards", () => {
  it("refuses to DEACTIVATE a bed with a future custodian hold", async () => {
    mocks.hutLeaderAssignmentFindMany.mockResolvedValue([
      { id: "a1", startDate: parseDateOnly("2099-07-01"), endDate: parseDateOnly("2099-07-05") },
    ]);

    await expect(
      updateBedAllocationBed({
        id: "bed-1",
        active: false,
        db: buildDb(),
        today: CLUB_TODAY_DATE_ONLY,
      }),
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("held by a hut-leader assignment"),
    });
  });

  it("refuses to DELETE a bed with ANY custodian hold, past included — the FK is Restrict and a raw P2003 is unactionable", async () => {
    mocks.hutLeaderAssignmentFindMany.mockResolvedValue([
      {
        id: "a1",
        bedId: "bed-1",
        startDate: parseDateOnly("2020-07-01"),
        endDate: parseDateOnly("2020-07-05"),
      },
    ]);

    await expect(
      deleteBedAllocationBed({ id: "bed-1", db: buildDb() }),
    ).rejects.toBeInstanceOf(BedAllocationAdminError);
  });

  it("closes the room-DELETE gap: the bulk bed delete used to bypass the per-bed custodian check entirely", async () => {
    mocks.hutLeaderAssignmentFindMany.mockResolvedValue([
      {
        id: "a1",
        bedId: "bed-1",
        startDate: parseDateOnly("2026-07-01"),
        endDate: parseDateOnly("2026-07-05"),
      },
    ]);
    const db = buildDb();

    await expect(
      deleteBedAllocationRoom({ id: "room-1", db }),
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("held by a hut-leader assignment"),
    });
    // Nothing was deleted — the guard runs before the bulk bed delete.
    expect(
      (db as unknown as { lodgeBed: { deleteMany: ReturnType<typeof vi.fn> } })
        .lodgeBed.deleteMany,
    ).not.toHaveBeenCalled();
  });

  it("refuses to DEACTIVATE a room when one of its beds has a future custodian hold", async () => {
    mocks.hutLeaderAssignmentFindMany.mockResolvedValue([
      { id: "a1", startDate: parseDateOnly("2099-07-01"), endDate: parseDateOnly("2099-07-05") },
    ]);

    await expect(
      updateBedAllocationRoom({
        id: "room-1",
        active: false,
        db: buildDb(),
        today: CLUB_TODAY_DATE_ONLY,
      }),
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("held by a hut-leader assignment"),
    });
  });

  it("lets an ordinary room deactivate through when no bed is held", async () => {
    await expect(
      updateBedAllocationRoom({
        id: "room-1",
        active: false,
        db: buildDb(),
        today: CLUB_TODAY_DATE_ONLY,
      }),
    ).resolves.toMatchObject({ id: "room-1" });
  });

  /*
   * The FK backstop, for the guard->delete race a concurrent hold can win. The
   * ORDER of the classifier's tests is the whole point (#2286 review L1): the raw
   * pg message for a HutLeaderAssignment_bedId_fkey violation names BOTH
   * "hutleaderassignment" (the referencing table) and "lodgebed" (the table being
   * modified), so a classifier that tested lodgebed first would answer "Refresh
   * and try again" — a retry that can NEVER succeed, forever.
   */
  describe("P2003 classification when a hold lands mid-delete", () => {
    function p2003(meta: Record<string, unknown>, message = "Foreign key constraint violated") {
      const error = new Prisma.PrismaClientKnownRequestError(message, {
        code: "P2003",
        clientVersion: "test",
      });
      (error as { meta?: unknown }).meta = meta;
      return error;
    }

    it("reads the structured field_name and steers to the Hut Leaders page", async () => {
      const db = buildDb({
        lodgeBed: {
          findUnique: vi.fn().mockResolvedValue(bedRow()),
          findMany: vi.fn().mockResolvedValue([{ id: "bed-1" }]),
          deleteMany: vi
            .fn()
            .mockRejectedValue(
              p2003({ field_name: "HutLeaderAssignment_bedId_fkey" }),
            ),
        },
      });

      await expect(
        deleteBedAllocationRoom({ id: "room-1", db }),
      ).rejects.toMatchObject({
        status: 409,
        message: expect.stringContaining("held by a hut-leader assignment"),
      });
    });

    it("wins over the LodgeBed test when the raw message names BOTH tables", async () => {
      // What the pg driver adapter actually produces once it has dropped the
      // structured constraint field: one string naming both tables.
      const db = buildDb({
        lodgeBed: {
          findUnique: vi.fn().mockResolvedValue(bedRow()),
          findMany: vi.fn().mockResolvedValue([{ id: "bed-1" }]),
          deleteMany: vi.fn().mockRejectedValue(
            p2003(
              {},
              'update or delete on table "LodgeBed" violates foreign key constraint "HutLeaderAssignment_bedId_fkey" on table "HutLeaderAssignment"',
            ),
          ),
        },
      });

      await expect(
        deleteBedAllocationRoom({ id: "room-1", db }),
      ).rejects.toMatchObject({
        status: 409,
        message: expect.stringContaining("held by a hut-leader assignment"),
      });
      // NOT the "a bed was just added, refresh" steer, which is unactionable
      // here: the retry can never succeed while the hold exists.
      await expect(
        deleteBedAllocationRoom({ id: "room-1", db }),
      ).rejects.not.toMatchObject({
        message: expect.stringContaining("Refresh and try again"),
      });
    });

    it("still steers a genuine mid-delete bed addition to a retry", async () => {
      const db = buildDb({
        lodgeBed: {
          findUnique: vi.fn().mockResolvedValue(bedRow()),
          findMany: vi.fn().mockResolvedValue([{ id: "bed-1" }]),
          deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
        lodgeRoom: {
          findFirst: vi.fn().mockResolvedValue({ id: "room-1" }),
          delete: vi.fn().mockRejectedValue(
            p2003(
              {},
              'update or delete on table "LodgeRoom" violates foreign key constraint "LodgeBed_roomId_fkey" on table "LodgeBed"',
            ),
          ),
        },
      });

      await expect(
        deleteBedAllocationRoom({ id: "room-1", db }),
      ).rejects.toMatchObject({
        status: 409,
        message: expect.stringContaining("Refresh and try again"),
      });
    });
  });
});

describe("chokepoint 6 — the warning net", () => {
  const allocation = {
    id: "allocation-1",
    bookingId: "booking-1",
    bookingGuestId: "guest-1",
    guestName: "Ordinary Guest",
    guestAgeTier: "ADULT" as const,
    roomId: "room-1",
    roomName: "Kea",
    bedId: "bed-1",
    bedName: "A1",
    stayDate: "2026-07-02",
    source: "MANUAL" as const,
    approvedAt: null,
    approvedByName: null,
    bookingStatus: "CONFIRMED",
    holdsCapacity: true,
  };

  const custodianHold = {
    assignmentId: "assignment-1",
    memberName: "Sam Ranger",
    bedId: "bed-1",
    bedName: "A1",
    roomId: "room-1",
    roomName: "Kea",
    startDate: "2026-07-01",
    endDate: "2026-07-05",
    nights: ["2026-07-01", "2026-07-02", "2026-07-03"],
  };

  it("flags an allocation row sitting on a held bed-night — the only way a deploy-drain write becomes visible", () => {
    const warnings = buildBedAllocationWarnings({
      allocations: [allocation],
      custodianHolds: [custodianHold],
    });
    const conflict = warnings.find(
      (warning) => warning.type === "CUSTODIAN_BED_CONFLICT",
    );
    expect(conflict).toBeDefined();
    expect(conflict?.message).toContain("Sam Ranger");
    expect(conflict?.stayDate).toBe("2026-07-02");
  });

  it("stays silent for an allocation on a night the hold does not cover", () => {
    const warnings = buildBedAllocationWarnings({
      allocations: [{ ...allocation, stayDate: "2026-07-09" }],
      custodianHolds: [custodianHold],
    });
    expect(
      warnings.filter((warning) => warning.type === "CUSTODIAN_BED_CONFLICT"),
    ).toEqual([]);
  });

  it("stays silent when no custodian holds are supplied at all", () => {
    expect(
      buildBedAllocationWarnings({ allocations: [allocation] }).filter(
        (warning) => warning.type === "CUSTODIAN_BED_CONFLICT",
      ),
    ).toEqual([]);
  });
});
