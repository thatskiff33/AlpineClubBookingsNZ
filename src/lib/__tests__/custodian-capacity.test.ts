import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseDateOnly } from "@/lib/date-only";

/**
 * Custodian occupancy — capacity arithmetic (#2286, epic #2245).
 *
 * A `HutLeaderAssignment` with a bed holds that bed for the night of every
 * covered date, with NO booking and NO BedAllocation row anywhere. These tests
 * pin the arithmetic every admission path depends on:
 *
 *   - the reduction lands on exactly the covered nights (inclusive endDate),
 *   - `occupiedBeds + availableBeds === lodgeCapacity` still holds (#155),
 *   - a stay that fits without the hold is refused with it,
 *   - a bed-LESS assignment subtracts nothing at all, and
 *   - two custodians handing over subtract TWO — it is a count, never a flag.
 */

const mocks = vi.hoisted(() => ({
  bookingFindMany: vi.fn(),
  hutLeaderAssignmentFindMany: vi.fn(),
  clubModuleSettingsFindUnique: vi.fn(),
  lodgeBedCount: vi.fn(),
  lodgeSettingsFindUnique: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: { findMany: mocks.bookingFindMany },
    hutLeaderAssignment: { findMany: mocks.hutLeaderAssignmentFindMany },
    clubModuleSettings: { findUnique: mocks.clubModuleSettingsFindUnique },
    lodgeBed: { count: mocks.lodgeBedCount },
    lodgeSettings: { findUnique: mocks.lodgeSettingsFindUnique },
  },
}));

import {
  checkCapacity,
  checkCapacityForGuestRanges,
  getMonthAvailability,
} from "@/lib/capacity";

const LODGE = "lodge-a";
const CAPACITY = 4;

function db(overrides: Record<string, unknown> = {}) {
  return {
    booking: { findMany: mocks.bookingFindMany },
    hutLeaderAssignment: { findMany: mocks.hutLeaderAssignmentFindMany },
    clubModuleSettings: { findUnique: mocks.clubModuleSettingsFindUnique },
    lodgeBed: { count: mocks.lodgeBedCount },
    lodgeSettings: { findUnique: mocks.lodgeSettingsFindUnique },
    ...overrides,
  } as never;
}

/** A bed-holding assignment row as `findCustodianBedHolds` selects it. */
function holdRow(overrides: Partial<{
  id: string;
  bedId: string;
  startDate: string;
  endDate: string;
  ageTier: string;
}> = {}) {
  const bedId = overrides.bedId ?? "bed-1";
  return {
    id: overrides.id ?? "assignment-1",
    memberId: "member-1",
    lodgeId: LODGE,
    bedId,
    startDate: parseDateOnly(overrides.startDate ?? "2026-07-02"),
    endDate: parseDateOnly(overrides.endDate ?? "2026-07-03"),
    member: {
      firstName: "Sam",
      lastName: "Ranger",
      ageTier: overrides.ageTier ?? "ADULT",
    },
    bed: {
      id: bedId,
      name: bedId.toUpperCase(),
      roomId: "room-1",
      room: { id: "room-1", name: "Kea" },
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.bookingFindMany.mockResolvedValue([]);
  mocks.hutLeaderAssignmentFindMany.mockResolvedValue([]);
  mocks.lodgeSettingsFindUnique.mockResolvedValue({ capacity: CAPACITY });
  mocks.clubModuleSettingsFindUnique.mockResolvedValue({
    bedAllocation: false,
  });
  mocks.lodgeBedCount.mockResolvedValue(0);
});

describe("custodian bed holds reduce bookable capacity", () => {
  it("holds exactly the covered nights — the night before is free, the endDate night is held, the night after is free", async () => {
    mocks.hutLeaderAssignmentFindMany.mockResolvedValue([
      holdRow({ startDate: "2026-07-02", endDate: "2026-07-03" }),
    ]);

    const result = await checkCapacity(
      LODGE,
      parseDateOnly("2026-07-01"),
      parseDateOnly("2026-07-05"),
      1,
      undefined,
      db(),
    );

    // Nights of 07-01, 07-02, 07-03, 07-04.
    expect(
      result.nightDetails.map((night) => ({
        occupied: night.occupiedBeds,
        available: night.availableBeds,
      })),
    ).toEqual([
      { occupied: 0, available: CAPACITY },
      { occupied: 1, available: CAPACITY - 1 },
      { occupied: 1, available: CAPACITY - 1 },
      { occupied: 0, available: CAPACITY },
    ]);
  });

  it("keeps occupiedBeds + availableBeds === lodgeCapacity on every night (the #155 payload contract)", async () => {
    mocks.hutLeaderAssignmentFindMany.mockResolvedValue([holdRow()]);

    const result = await checkCapacity(
      LODGE,
      parseDateOnly("2026-07-01"),
      parseDateOnly("2026-07-05"),
      1,
      undefined,
      db(),
    );

    for (const night of result.nightDetails) {
      expect(night.occupiedBeds + night.availableBeds).toBe(CAPACITY);
    }
  });

  it("counts the custodian as an occupant, so a stay that fits without the hold is refused with it", async () => {
    const guests = [
      {
        stayStart: parseDateOnly("2026-07-02"),
        stayEnd: parseDateOnly("2026-07-04"),
        memberId: null,
      },
      {
        stayStart: parseDateOnly("2026-07-02"),
        stayEnd: parseDateOnly("2026-07-04"),
        memberId: null,
      },
      {
        stayStart: parseDateOnly("2026-07-02"),
        stayEnd: parseDateOnly("2026-07-04"),
        memberId: null,
      },
      {
        stayStart: parseDateOnly("2026-07-02"),
        stayEnd: parseDateOnly("2026-07-04"),
        memberId: null,
      },
    ];

    const withoutHold = await checkCapacityForGuestRanges(
      LODGE,
      parseDateOnly("2026-07-02"),
      parseDateOnly("2026-07-04"),
      guests,
      undefined,
      db(),
    );
    expect(withoutHold.available).toBe(true);

    mocks.hutLeaderAssignmentFindMany.mockResolvedValue([
      holdRow({ startDate: "2026-07-02", endDate: "2026-07-03" }),
    ]);
    const withHold = await checkCapacityForGuestRanges(
      LODGE,
      parseDateOnly("2026-07-02"),
      parseDateOnly("2026-07-04"),
      guests,
      undefined,
      db(),
    );
    expect(withHold.available).toBe(false);
    expect(withHold.minAvailable).toBe(-1);
  });

  it("asks only for BED-HOLDING or TICKED-CUSTODIAN assignments, so a role-only (cron-created) assignment subtracts nothing", async () => {
    await checkCapacity(
      LODGE,
      parseDateOnly("2026-07-01"),
      parseDateOnly("2026-07-03"),
      1,
      undefined,
      db(),
    );

    // The bed-or-tick filter is the whole feature gate (#3817): without it a
    // role-only, unticked assignment would silently start removing a bed from
    // the pool.
    const where = mocks.hutLeaderAssignmentFindMany.mock.calls[0][0].where;
    expect(where.OR).toEqual([{ bedId: { not: null } }, { isCustodian: true }]);
    expect(where.lodgeId).toBe(LODGE);
  });

  it("subtracts TWO on a handover night when two custodians hold different beds", async () => {
    mocks.hutLeaderAssignmentFindMany.mockResolvedValue([
      holdRow({
        id: "outgoing",
        bedId: "bed-1",
        startDate: "2026-07-01",
        endDate: "2026-07-02",
      }),
      holdRow({
        id: "incoming",
        bedId: "bed-2",
        startDate: "2026-07-02",
        endDate: "2026-07-03",
      }),
    ]);

    const result = await checkCapacity(
      LODGE,
      parseDateOnly("2026-07-01"),
      parseDateOnly("2026-07-04"),
      1,
      undefined,
      db(),
    );

    expect(result.nightDetails.map((night) => night.occupiedBeds)).toEqual([
      1, // 07-01: outgoing only
      2, // 07-02: BOTH — a count, never a boolean
      1, // 07-03: incoming only
    ]);
  });

  it("reduces the member-facing month calendar with no custodian-specific label (owner decision: one fewer bed, nothing more)", async () => {
    mocks.hutLeaderAssignmentFindMany.mockResolvedValue([
      holdRow({ startDate: "2026-07-02", endDate: "2026-07-02" }),
    ]);

    const availability = await getMonthAvailability(LODGE, 2026, 6);

    // The map's VALUE is the occupied count and nothing else — there is no
    // field a member-facing calendar could render as "custodian".
    expect(availability.get("2026-07-01")).toBe(0);
    expect(availability.get("2026-07-02")).toBe(1);
    expect(availability.get("2026-07-03")).toBe(0);
  });

  it("leaves the whole-lodge-hold pin untouched: a held night still reports a full lodge and zero available", async () => {
    mocks.hutLeaderAssignmentFindMany.mockResolvedValue([
      holdRow({ startDate: "2026-07-02", endDate: "2026-07-02" }),
    ]);
    mocks.bookingFindMany.mockResolvedValue([
      {
        checkIn: parseDateOnly("2026-07-02"),
        checkOut: parseDateOnly("2026-07-03"),
        wholeLodgeHold: true,
        guests: [
          {
            stayStart: parseDateOnly("2026-07-02"),
            stayEnd: parseDateOnly("2026-07-03"),
            nights: [],
          },
        ],
      },
    ]);

    const result = await checkCapacity(
      LODGE,
      parseDateOnly("2026-07-02"),
      parseDateOnly("2026-07-03"),
      1,
      undefined,
      db(),
    );

    const [night] = result.nightDetails;
    expect(night.wholeLodgeHeld).toBe(true);
    expect(night.occupiedBeds).toBe(CAPACITY);
    expect(night.availableBeds).toBe(0);
    expect(night.occupiedBeds + night.availableBeds).toBe(CAPACITY);
  });

  it("does not let excludeBookingId hide the custodian — the hold is not a booking", async () => {
    mocks.hutLeaderAssignmentFindMany.mockResolvedValue([
      holdRow({ startDate: "2026-07-02", endDate: "2026-07-02" }),
    ]);

    const result = await checkCapacity(
      LODGE,
      parseDateOnly("2026-07-02"),
      parseDateOnly("2026-07-03"),
      1,
      "booking-being-modified",
      db(),
    );

    expect(result.nightDetails[0].occupiedBeds).toBe(1);
  });
});

/**
 * #3817 (owner decision "Yes, one space per night" on #3820): a ticked
 * custodian takes one space off the lodge on each covered night, with or
 * without a bed and whether or not bed allocation is on — and a custodian who
 * also holds a bed counts ONCE. The double below applies the loader's own
 * bed-or-tick filter, so the filter is what is under test.
 */
describe("a ticked custodian takes one space per night (#3817)", () => {
  type Row = { id: string; bedId: string | null; isCustodian: boolean; startDate: Date; endDate: Date };
  function serve(rows: Row[]) {
    mocks.hutLeaderAssignmentFindMany.mockImplementation(
      async ({ where }: { where: { OR?: Array<Record<string, unknown>> } }) =>
        rows.filter((row) =>
          (where.OR ?? []).some((arm) =>
            "isCustodian" in arm ? row.isCustodian === arm.isCustodian : row.bedId !== null,
          ),
        ),
    );
  }
  const night = (iso: string) => parseDateOnly(iso);

  async function occupiedOn(iso: string) {
    const result = await checkCapacity(LODGE, night(iso), night("2026-07-05"), 1, undefined, db());
    return result.nightDetails[0]!.occupiedBeds;
  }

  it.each([false, true])("counts a bedless ticked custodian (bed allocation on: %s)", async (bedAllocation) => {
    mocks.clubModuleSettingsFindUnique.mockResolvedValue({ bedAllocation });
    serve([{ id: "c1", bedId: null, isCustodian: true, startDate: night("2026-07-02"), endDate: night("2026-07-03") }]);
    expect(await occupiedOn("2026-07-02")).toBe(1);
    expect(await occupiedOn("2026-07-04")).toBe(0);
  });

  it("counts a custodian who also holds a bed once, not twice", async () => {
    serve([{ id: "c1", bedId: "bed-1", isCustodian: true, startDate: night("2026-07-02"), endDate: night("2026-07-03") }]);
    expect(await occupiedOn("2026-07-02")).toBe(1);
  });

  it("does not count an unticked role-only assignment", async () => {
    serve([{ id: "r1", bedId: null, isCustodian: false, startDate: night("2026-07-02"), endDate: night("2026-07-03") }]);
    expect(await occupiedOn("2026-07-02")).toBe(0);
  });

  it("refuses a stay that no longer fits once a ticked custodian takes the last space", async () => {
    mocks.lodgeSettingsFindUnique.mockResolvedValue({ capacity: 1 });
    serve([{ id: "c1", bedId: null, isCustodian: true, startDate: night("2026-07-02"), endDate: night("2026-07-02") }]);
    const result = await checkCapacity(LODGE, night("2026-07-02"), night("2026-07-03"), 1, undefined, db());
    expect(result.available).toBe(false);
  });
});
