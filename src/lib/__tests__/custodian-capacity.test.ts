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

/**
 * "One person is one space" (#3817, owner decision on #3820, 3 Oct 2026). A
 * ticked custodian with no bed who is also a guest at the lodge is not counted
 * twice — not by the count, and not by the admission check, which adds the
 * requested party on top of it. A held bed is a physical bed kept out of the
 * pool, so it still takes its own space whoever the guests are.
 */
describe("a ticked custodian who is also a guest takes one space (#3817)", () => {
  const OTHER_LODGE = "lodge-b";
  const night = (iso: string) => parseDateOnly(iso);
  type Row = {
    id: string;
    memberId: string;
    lodgeId?: string;
    bedId: string | null;
    isCustodian: boolean;
    startDate: Date;
    endDate: Date;
  };
  type Booking = {
    id: string;
    lodgeId?: string;
    checkIn: Date;
    checkOut: Date;
    guests: Array<{ memberId: string | null; stayStart: Date; stayEnd: Date; nights: [] }>;
  };

  /** Query-faithful doubles: the lodge scope, the bed-or-tick filter and the edit's exclusion. */
  function serve(rows: Row[], bookings: Booking[]) {
    mocks.hutLeaderAssignmentFindMany.mockImplementation(
      async ({ where }: { where: { lodgeId?: string; OR?: Array<Record<string, unknown>> } }) =>
        rows.filter(
          (row) =>
            (row.lodgeId ?? LODGE) === where.lodgeId &&
            (where.OR ?? []).some((arm) =>
              "isCustodian" in arm ? row.isCustodian === arm.isCustodian : row.bedId !== null,
            ),
        ),
    );
    mocks.bookingFindMany.mockImplementation(
      async ({ where }: { where: { lodgeId?: string; id?: { not?: string } } }) =>
        bookings.filter(
          (booking) =>
            (booking.lodgeId ?? LODGE) === where.lodgeId && booking.id !== where.id?.not,
        ),
    );
  }

  const guest = (memberId: string | null, from: string, to: string) => ({
    memberId,
    stayStart: night(from),
    stayEnd: night(to),
    nights: [] as [],
  });
  const tick = (overrides: Partial<Row> = {}): Row => ({
    id: "c1",
    memberId: "custodian",
    bedId: null,
    isCustodian: true,
    startDate: night("2026-07-02"),
    endDate: night("2026-07-03"),
    ...overrides,
  });
  /** Night 07-02 is full at capacity 2: the custodian's tick plus one other guest. */
  const otherGuestBooking: Booking = {
    id: "bk-other",
    checkIn: night("2026-07-02"),
    checkOut: night("2026-07-03"),
    guests: [guest("someone-else", "2026-07-02", "2026-07-03")],
  };

  async function admit(party: Array<string | null>, excludeBookingId?: string) {
    return checkCapacityForGuestRanges(
      LODGE,
      night("2026-07-02"),
      night("2026-07-03"),
      party.map((memberId) => guest(memberId, "2026-07-02", "2026-07-03")),
      excludeBookingId,
      db(),
    );
  }

  beforeEach(() => {
    mocks.lodgeSettingsFindUnique.mockResolvedValue({ capacity: 2 });
  });

  it("the count does not add the tick on a night the custodian is a guest, and does on the nights they are not", async () => {
    serve([tick()], [
      {
        id: "bk-custodian",
        checkIn: night("2026-07-02"),
        checkOut: night("2026-07-03"),
        guests: [guest("custodian", "2026-07-02", "2026-07-03")],
      },
    ]);
    const result = await checkCapacity(LODGE, night("2026-07-02"), night("2026-07-04"), 0, undefined, db());
    expect(result.nightDetails.map((n) => n.occupiedBeds)).toEqual([1, 1]);
  });

  it("admits the custodian as a guest on a night the lodge is full: they are one space", async () => {
    serve([tick()], [otherGuestBooking]);
    expect((await admit(["custodian"])).available).toBe(true);
  });

  it("still refuses anyone else on that full night (a non-custodian is unchanged)", async () => {
    serve([tick()], [otherGuestBooking]);
    expect((await admit([null])).available).toBe(false);
    expect((await admit(["someone-new"])).available).toBe(false);
  });

  it("gives back one tick however many rows the party gives the custodian", async () => {
    serve([tick()], [otherGuestBooking]);
    const result = await admit(["custodian", "custodian"]);
    // Two guest rows are two guests; only the tick is de-duplicated.
    expect(result.nightDetails[0]!.occupiedBeds).toBe(3);
  });

  it("keeps a held bed's own space when its custodian is also a guest, while bed allocation is on", async () => {
    // The allocators refuse to put the guest row on the held bed, so the guest
    // needs a second bed: two spaces (ticked or not).
    mocks.clubModuleSettingsFindUnique.mockResolvedValue({ bedAllocation: true });
    for (const isCustodian of [true, false]) {
      serve([tick({ bedId: "bed-1", isCustodian })], [otherGuestBooking]);
      expect((await admit(["custodian"])).available).toBe(false);
    }
  });

  it("counts a bed-holding custodian who is also a guest once while bed allocation is off", async () => {
    // Nothing keeps the guest row off the held bed with the module off, so
    // the held bed is counted like a tick: one person, one space.
    mocks.clubModuleSettingsFindUnique.mockResolvedValue({ bedAllocation: false });
    for (const isCustodian of [true, false]) {
      serve([tick({ bedId: "bed-1", isCustodian })], [otherGuestBooking]);
      expect((await admit(["custodian"])).available).toBe(true);
      // Anyone else still finds the night full.
      expect((await admit(["someone-new"])).available).toBe(false);
    }
  });

  it("still counts the tick when the custodian's booking is at a different lodge", async () => {
    serve([tick()], [
      otherGuestBooking,
      {
        id: "bk-away",
        lodgeId: OTHER_LODGE,
        checkIn: night("2026-07-02"),
        checkOut: night("2026-07-03"),
        guests: [guest("custodian", "2026-07-02", "2026-07-03")],
      },
    ]);
    const here = await checkCapacity(LODGE, night("2026-07-02"), night("2026-07-03"), 0, undefined, db());
    expect(here.nightDetails[0]!.occupiedBeds).toBe(2);
    // And admitting them at the OTHER lodge gives back nothing here or there.
    mocks.lodgeSettingsFindUnique.mockResolvedValue({ capacity: 1 });
    const away = await checkCapacityForGuestRanges(
      OTHER_LODGE,
      night("2026-07-02"),
      night("2026-07-03"),
      [guest("custodian", "2026-07-02", "2026-07-03")],
      "bk-away",
      db(),
    );
    expect(away.available).toBe(true);
    expect(away.nightDetails[0]!.occupiedBeds).toBe(1);
  });

  it("an edit that adds the custodian to a booking at their lodge fits a full night", async () => {
    // bk-edit holds the one other guest; the edit adds the custodian to it.
    serve([tick()], [{ ...otherGuestBooking, id: "bk-edit" }]);
    expect((await admit(["someone-else", "custodian"], "bk-edit")).available).toBe(true);
    expect((await admit(["someone-else", null], "bk-edit")).available).toBe(false);
  });

  it("checkCapacity gives back the tick for a party it is told about (the date-move path)", async () => {
    serve([tick()], [otherGuestBooking]);
    const told = await checkCapacity(
      LODGE, night("2026-07-02"), night("2026-07-03"), 1, undefined, db(), ["custodian"],
    );
    expect(told.available).toBe(true);
    const untold = await checkCapacity(LODGE, night("2026-07-02"), night("2026-07-03"), 1, undefined, db());
    expect(untold.available).toBe(false);
  });
});
