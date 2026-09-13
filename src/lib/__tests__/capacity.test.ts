import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import { BookingStatus } from "@prisma/client";
import { parseDateOnly } from "@/lib/date-only";
import {
  capacityHoldingBookingFilter,
  CAPACITY_HOLDING_BOOKING_STATUSES,
} from "@/lib/booking-status";

const mocks = vi.hoisted(() => ({
  bookingFindMany: vi.fn(),
  clubModuleSettingsFindUnique: vi.fn(),
  lodgeBedCount: vi.fn(),
  lodgeSettingsFindUnique: vi.fn(),
  // #2286: custodian bed holds. Defaults to none in beforeEach.
  hutLeaderAssignmentFindMany: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: {
      findMany: mocks.bookingFindMany,
    },
    clubModuleSettings: {
      findUnique: mocks.clubModuleSettingsFindUnique,
    },
    lodgeBed: {
      count: mocks.lodgeBedCount,
    },
    // Since #1982 the default lodge carries an explicit LodgeSettings.capacity
    // (backfilled by the boot self-heal); the club.json runtime fallback is
    // gone. The engine tests that read capacity without passing their own db
    // therefore model that self-healed override here.
    lodgeSettings: {
      findUnique: mocks.lodgeSettingsFindUnique,
    },
    // #2286: the capacity engines read bed-holding hut-leader assignments
    // (custodian occupancy). No holds by default, so every case below reads
    // exactly as it did before that feature existed.
    hutLeaderAssignment: {
      findMany: mocks.hutLeaderAssignmentFindMany,
    },
  },
}));

import {
  acquireLodgeCapacityLock,
  bookingsOverlap,
  checkCapacity,
  checkCapacityForGuestRanges,
  findOverlappingCapacityHoldingBookings,
  findOverlappingOverriddenNonHoldingBookings,
  // #2307 freeze tests: the public entry point over buildOccupancyIndex +
  // getOccupiedBedsForNightFromIndex, which are private.
  getOccupiedBedsForNight,
  getLodgeHeldNights,
  getMonthAvailability,
  sameLodgeNullTolerant,
} from "@/lib/capacity";
import {
  countActiveGuestsForNight,
  isGuestActiveOnNight,
} from "@/lib/booking-guest-stay-ranges";
import {
  overCapacityNights,
  OverCapacityConfirmationRequiredError,
  wholeLodgeBlockedNights,
  WholeLodgeHoldBlockedError,
} from "@/lib/over-capacity-confirmation";
import {
  FALLBACK_LODGE_CAPACITY,
  getLodgeCapacityStatus,
} from "@/lib/lodge-capacity";

const TEST_LODGE_CAPACITY = FALLBACK_LODGE_CAPACITY;
const LODGE_A = "lodge-a";
const LODGE_B = "lodge-b";

// db without a lodge delegate and, by default, without a lodgeSettings
// delegate: the requested lodge resolves with no capacity override, so an
// unconfigured lodge yields 0 (never overbook — #1982). Tests that need a
// configured capacity pass their own `lodgeSettings` override.
function singleLodgeDb(overrides: Record<string, unknown> = {}) {
  return {
    clubModuleSettings: {
      findUnique: mocks.clubModuleSettingsFindUnique,
    },
    lodgeBed: {
      count: mocks.lodgeBedCount,
    },
    hutLeaderAssignment: {
      findMany: mocks.hutLeaderAssignmentFindMany,
    },
    ...overrides,
  } as never;
}

// db where LODGE_A is the default (oldest active) lodge.
function twoLodgeDb(overrides: Record<string, unknown> = {}) {
  return singleLodgeDb({
    lodge: {
      findFirst: vi.fn().mockResolvedValue({ id: LODGE_A }),
    },
    ...overrides,
  });
}

describe("capacity calendar availability", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.bookingFindMany.mockResolvedValue([]);
    // #2286: no custodian bed holds in these cases.
    mocks.hutLeaderAssignmentFindMany.mockResolvedValue([]);
    mocks.clubModuleSettingsFindUnique.mockResolvedValue(null);
    mocks.lodgeBedCount.mockResolvedValue(0);
    // Default lodge carries a self-healed capacity override (#1982) for the
    // engine tests that read capacity through the global prisma mock.
    mocks.lodgeSettingsFindUnique.mockResolvedValue({ capacity: TEST_LODGE_CAPACITY });
  });

  it("uses the self-healed capacity override for the default lodge when the module is off", async () => {
    mocks.clubModuleSettingsFindUnique.mockResolvedValue({ bedAllocation: false });

    const status = await getLodgeCapacityStatus(
      LODGE_A,
      singleLodgeDb({
        lodgeSettings: {
          findUnique: vi.fn().mockResolvedValue({ capacity: TEST_LODGE_CAPACITY }),
        },
      }),
    );

    expect(status).toMatchObject({
      capacity: TEST_LODGE_CAPACITY,
      source: "capacity_override",
      bedAllocationEnabled: false,
      activeBedCount: 0,
    });
    expect(mocks.lodgeBedCount).not.toHaveBeenCalled();
  });

  it("resolves 0 (unconfigured) for a default lodge with no capacity override (module off, #1982 never-overbook)", async () => {
    mocks.clubModuleSettingsFindUnique.mockResolvedValue({ bedAllocation: false });

    const status = await getLodgeCapacityStatus(LODGE_A, singleLodgeDb());

    expect(status).toMatchObject({
      capacity: 0,
      source: "unconfigured_lodge",
      bedAllocationEnabled: false,
      activeBedCount: 0,
      fallbackCapacity: 0,
    });
    expect(mocks.lodgeBedCount).not.toHaveBeenCalled();
  });

  it("uses active configured beds when the bed allocation module is on with beds", async () => {
    mocks.clubModuleSettingsFindUnique.mockResolvedValue({ bedAllocation: true });
    mocks.lodgeBedCount.mockResolvedValue(17);

    const status = await getLodgeCapacityStatus(LODGE_A, singleLodgeDb());

    expect(status).toMatchObject({
      capacity: 17,
      source: "configured_beds",
      bedAllocationEnabled: true,
      activeBedCount: 17,
    });
  });

  it("scopes the active bed count to the requested lodge's rooms", async () => {
    mocks.clubModuleSettingsFindUnique.mockResolvedValue({ bedAllocation: true });
    mocks.lodgeBedCount.mockResolvedValue(6);

    await getLodgeCapacityStatus(LODGE_A, singleLodgeDb());

    expect(mocks.lodgeBedCount).toHaveBeenCalledWith({
      where: { active: true, room: { lodgeId: LODGE_A } },
    });
  });

  it("resolves 0 (unconfigured) when the module is on with zero active beds and no override (#1982)", async () => {
    mocks.clubModuleSettingsFindUnique.mockResolvedValue({ bedAllocation: true });
    mocks.lodgeBedCount.mockResolvedValue(0);

    const status = await getLodgeCapacityStatus(LODGE_A, singleLodgeDb());

    expect(status).toMatchObject({
      capacity: 0,
      source: "unconfigured_lodge",
      bedAllocationEnabled: true,
      activeBedCount: 0,
    });
  });

  it("uses the capacity override when the module is on with zero active beds", async () => {
    mocks.clubModuleSettingsFindUnique.mockResolvedValue({ bedAllocation: true });
    mocks.lodgeBedCount.mockResolvedValue(0);

    const status = await getLodgeCapacityStatus(
      LODGE_A,
      singleLodgeDb({
        lodgeSettings: {
          findUnique: vi.fn().mockResolvedValue({ capacity: TEST_LODGE_CAPACITY }),
        },
      }),
    );

    expect(status).toMatchObject({
      capacity: TEST_LODGE_CAPACITY,
      source: "capacity_override",
      bedAllocationEnabled: true,
      activeBedCount: 0,
    });
  });

  it("uses the admin lodge capacity override as the fallback", async () => {
    mocks.clubModuleSettingsFindUnique.mockResolvedValue({ bedAllocation: false });

    const status = await getLodgeCapacityStatus(
      LODGE_A,
      singleLodgeDb({
        lodgeSettings: {
          findUnique: vi.fn().mockResolvedValue({ capacity: 42 }),
        },
      }),
    );

    expect(status).toMatchObject({
      capacity: 42,
      source: "capacity_override",
      bedAllocationEnabled: false,
      activeBedCount: 0,
      fallbackCapacity: 42,
    });
  });

  it("prefers active configured beds over the capacity override", async () => {
    mocks.clubModuleSettingsFindUnique.mockResolvedValue({ bedAllocation: true });
    mocks.lodgeBedCount.mockResolvedValue(20);

    const status = await getLodgeCapacityStatus(
      LODGE_A,
      singleLodgeDb({
        lodgeSettings: {
          findUnique: vi.fn().mockResolvedValue({ capacity: 42 }),
        },
      }),
    );

    expect(status).toMatchObject({
      capacity: 20,
      source: "configured_beds",
      bedAllocationEnabled: true,
      activeBedCount: 20,
      fallbackCapacity: 42,
    });
  });

  it("caps configured beds at a lower capacity ceiling (#1653)", async () => {
    mocks.clubModuleSettingsFindUnique.mockResolvedValue({ bedAllocation: true });
    mocks.lodgeBedCount.mockResolvedValue(40);

    const status = await getLodgeCapacityStatus(
      LODGE_A,
      singleLodgeDb({
        lodgeSettings: {
          findUnique: vi.fn().mockResolvedValue({ capacity: 30 }),
        },
      }),
    );

    expect(status).toMatchObject({
      capacity: 30,
      source: "capped_beds",
      bedAllocationEnabled: true,
      activeBedCount: 40,
      fallbackCapacity: 30,
    });
  });

  it("does not cap when the capacity equals the bed count (#1653)", async () => {
    mocks.clubModuleSettingsFindUnique.mockResolvedValue({ bedAllocation: true });
    mocks.lodgeBedCount.mockResolvedValue(30);

    const status = await getLodgeCapacityStatus(
      LODGE_A,
      singleLodgeDb({
        lodgeSettings: {
          findUnique: vi.fn().mockResolvedValue({ capacity: 30 }),
        },
      }),
    );

    expect(status).toMatchObject({
      capacity: 30,
      source: "configured_beds",
      activeBedCount: 30,
    });
  });

  it("uses the per-lodge capacity when the module is on but no beds exist yet (#1653)", async () => {
    mocks.clubModuleSettingsFindUnique.mockResolvedValue({ bedAllocation: true });
    mocks.lodgeBedCount.mockResolvedValue(0);

    const status = await getLodgeCapacityStatus(
      LODGE_A,
      singleLodgeDb({
        lodgeSettings: {
          findUnique: vi.fn().mockResolvedValue({ capacity: 25 }),
        },
      }),
    );

    expect(status).toMatchObject({
      capacity: 25,
      source: "capacity_override",
      bedAllocationEnabled: true,
      activeBedCount: 0,
    });
  });

  it("does not cap the bed count without an explicit capacity — only an explicit capacity caps (#1653)", async () => {
    mocks.clubModuleSettingsFindUnique.mockResolvedValue({ bedAllocation: true });
    // More active beds than the reference total, and NO per-lodge capacity.
    mocks.lodgeBedCount.mockResolvedValue(TEST_LODGE_CAPACITY + 10);

    const status = await getLodgeCapacityStatus(LODGE_A, singleLodgeDb());

    expect(status).toMatchObject({
      capacity: TEST_LODGE_CAPACITY + 10,
      source: "configured_beds",
      activeBedCount: TEST_LODGE_CAPACITY + 10,
    });
  });

  it("checkCapacity enforces the capped capacity, not the raw bed count (#1653)", async () => {
    mocks.clubModuleSettingsFindUnique.mockResolvedValue({ bedAllocation: true });
    mocks.lodgeBedCount.mockResolvedValue(40);
    mocks.bookingFindMany.mockResolvedValue([]);

    const db = singleLodgeDb({
      lodgeSettings: {
        findUnique: vi.fn().mockResolvedValue({ capacity: 30 }),
      },
      booking: { findMany: mocks.bookingFindMany },
    });

    // 35 guests fit the 40 installed beds but exceed the 30 sleeping cap.
    const rejected = await checkCapacity(
      LODGE_A,
      parseDateOnly("2026-04-10"),
      parseDateOnly("2026-04-12"),
      35,
      undefined,
      db,
    );
    expect(rejected.available).toBe(false);
    expect(rejected.minAvailable).toBe(30);

    // 30 guests sit exactly on the cap and are allowed.
    const allowed = await checkCapacity(
      LODGE_A,
      parseDateOnly("2026-04-10"),
      parseDateOnly("2026-04-12"),
      30,
      undefined,
      db,
    );
    expect(allowed.available).toBe(true);
  });

  it("emits one key for each date-only day in the requested month", async () => {
    const availability = await getMonthAvailability(LODGE_A, 2026, 3);
    const keys = [...availability.keys()];

    expect(keys).toHaveLength(30);
    expect(keys[0]).toBe("2026-04-01");
    expect(keys.at(-1)).toBe("2026-04-30");
    expect(availability.get("2026-04-30")).toBe(0);
    expect(availability.has("2026-03-31")).toBe(false);
  });

  it("queries the full month using date-only exclusive end boundaries", async () => {
    await getMonthAvailability(LODGE_A, 2026, 3);

    const call = mocks.bookingFindMany.mock.calls[0][0];
    expect(call.where.checkIn.lt).toEqual(parseDateOnly("2026-05-01"));
    expect(call.where.checkOut.gt).toEqual(parseDateOnly("2026-04-01"));
  });

  it("counts bookings that start on the final day of the month", async () => {
    mocks.bookingFindMany.mockResolvedValue([
      {
        checkIn: parseDateOnly("2026-04-30"),
        checkOut: parseDateOnly("2026-05-02"),
        guests: [{ id: "g1" }, { id: "g2" }],
      },
    ]);

    const availability = await getMonthAvailability(LODGE_A, 2026, 3);

    expect(availability.get("2026-04-29")).toBe(0);
    expect(availability.get("2026-04-30")).toBe(2);
  });

  it("queries completed bookings as capacity-holding bookings", async () => {
    await getMonthAvailability(LODGE_A, 2026, 3);

    // Capacity-holding is now an OR of the holding-status set plus
    // request-converted PENDING holds (issue #1254, refining #737).
    const call = mocks.bookingFindMany.mock.calls[0][0];
    const holdingStatusClause = call.where.OR.find(
      (clause: { status?: { in?: BookingStatus[] } }) =>
        Array.isArray(clause.status?.in)
    );
    expect(holdingStatusClause.status.in).toEqual(
      expect.arrayContaining([BookingStatus.COMPLETED])
    );
    expect(call.where.OR).toContainEqual({
      status: BookingStatus.PENDING,
      originBookingRequest: { isNot: null },
    });
  });

  it("counts completed bookings in monthly occupied beds", async () => {
    mocks.bookingFindMany.mockResolvedValue([
      {
        status: BookingStatus.COMPLETED,
        checkIn: parseDateOnly("2026-04-10"),
        checkOut: parseDateOnly("2026-04-12"),
        guests: [{ id: "g1" }, { id: "g2" }, { id: "g3" }, { id: "g4" }],
      },
    ]);

    const availability = await getMonthAvailability(LODGE_A, 2026, 3);

    expect(availability.get("2026-04-09")).toBe(0);
    expect(availability.get("2026-04-10")).toBe(4);
    expect(availability.get("2026-04-11")).toBe(4);
    expect(availability.get("2026-04-12")).toBe(0);
  });

  it("counts completed bookings when checking capacity", async () => {
    mocks.bookingFindMany.mockResolvedValue([
      {
        status: BookingStatus.COMPLETED,
        checkIn: parseDateOnly("2026-04-10"),
        checkOut: parseDateOnly("2026-04-12"),
        guests: [{ id: "g1" }, { id: "g2" }, { id: "g3" }, { id: "g4" }],
      },
    ]);

    const result = await checkCapacity(
      LODGE_A,
      parseDateOnly("2026-04-10"),
      parseDateOnly("2026-04-12"),
      TEST_LODGE_CAPACITY - 4
    );

    expect(mocks.bookingFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: expect.arrayContaining([
            expect.objectContaining({
              status: { in: expect.arrayContaining([BookingStatus.COMPLETED]) },
            }),
          ]),
        }),
      })
    );
    expect(result.available).toBe(true);
    expect(result.minAvailable).toBe(TEST_LODGE_CAPACITY - 4);
    expect(result.nightDetails.map((night) => night.availableBeds)).toEqual([
      TEST_LODGE_CAPACITY - 4,
      TEST_LODGE_CAPACITY - 4,
    ]);
  });

  it("counts guests only on nights inside their individual stay ranges", async () => {
    mocks.bookingFindMany.mockResolvedValue([
      {
        status: BookingStatus.PAID,
        checkIn: parseDateOnly("2026-04-10"),
        checkOut: parseDateOnly("2026-04-15"),
        guests: [
          {
            id: "full-stay",
            stayStart: parseDateOnly("2026-04-10"),
            stayEnd: parseDateOnly("2026-04-15"),
          },
          {
            id: "cut-short",
            stayStart: parseDateOnly("2026-04-10"),
            stayEnd: parseDateOnly("2026-04-13"),
          },
        ],
      },
    ]);

    const availability = await getMonthAvailability(LODGE_A, 2026, 3);

    expect(availability.get("2026-04-09")).toBe(0);
    expect(availability.get("2026-04-10")).toBe(2);
    expect(availability.get("2026-04-11")).toBe(2);
    expect(availability.get("2026-04-12")).toBe(2);
    expect(availability.get("2026-04-13")).toBe(1);
    expect(availability.get("2026-04-14")).toBe(1);
    expect(availability.get("2026-04-15")).toBe(0);
  });

  it("allows proposed staggered guests when only one bed is available per night", async () => {
    mocks.bookingFindMany.mockResolvedValue([
      {
        status: BookingStatus.PAID,
        checkIn: parseDateOnly("2026-04-10"),
        checkOut: parseDateOnly("2026-04-12"),
        guests: Array.from({ length: TEST_LODGE_CAPACITY - 1 }, (_, index) => ({
          id: `existing-${index}`,
          stayStart: parseDateOnly("2026-04-10"),
          stayEnd: parseDateOnly("2026-04-12"),
        })),
      },
    ]);

    const result = await checkCapacityForGuestRanges(
      LODGE_A,
      parseDateOnly("2026-04-10"),
      parseDateOnly("2026-04-12"),
      [
        {
          stayStart: parseDateOnly("2026-04-10"),
          stayEnd: parseDateOnly("2026-04-11"),
        },
        {
          stayStart: parseDateOnly("2026-04-11"),
          stayEnd: parseDateOnly("2026-04-12"),
        },
      ]
    );

    expect(result.available).toBe(true);
    expect(result.nightDetails.map((night) => night.availableBeds)).toEqual([0, 0]);
  });

  it("still rejects full-span proposed guests when only one bed is available per night", async () => {
    mocks.bookingFindMany.mockResolvedValue([
      {
        status: BookingStatus.PAID,
        checkIn: parseDateOnly("2026-04-10"),
        checkOut: parseDateOnly("2026-04-12"),
        guests: Array.from({ length: TEST_LODGE_CAPACITY - 1 }, (_, index) => ({
          id: `existing-${index}`,
          stayStart: parseDateOnly("2026-04-10"),
          stayEnd: parseDateOnly("2026-04-12"),
        })),
      },
    ]);

    const result = await checkCapacityForGuestRanges(
      LODGE_A,
      parseDateOnly("2026-04-10"),
      parseDateOnly("2026-04-12"),
      [{}, {}]
    );

    expect(result.available).toBe(false);
    expect(result.nightDetails.map((night) => night.availableBeds)).toEqual([-1, -1]);
  });
});

describe("multi-lodge capacity scoping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.bookingFindMany.mockResolvedValue([]);
    // #2286: no custodian bed holds in these cases.
    mocks.hutLeaderAssignmentFindMany.mockResolvedValue([]);
    mocks.clubModuleSettingsFindUnique.mockResolvedValue(null);
    mocks.lodgeBedCount.mockResolvedValue(0);
  });

  it("filters capacity queries strictly to the requested lodge", async () => {
    await checkCapacity(
      LODGE_B,
      parseDateOnly("2026-04-10"),
      parseDateOnly("2026-04-12"),
      2
    );

    const call = mocks.bookingFindMany.mock.calls[0][0];
    // lodgeId is NOT NULL on Booking, so the scope is a strict per-lodge
    // match at the top level; the only where.OR is the capacity-holding filter.
    expect(call.where.lodgeId).toBe(LODGE_B);
    expect(call.where.OR).toEqual(capacityHoldingBookingFilter().OR);
  });

  it("applies the same lodge filter to month availability queries", async () => {
    await getMonthAvailability(LODGE_A, 2026, 3);

    const call = mocks.bookingFindMany.mock.calls[0][0];
    expect(call.where.lodgeId).toBe(LODGE_A);
    expect(call.where.OR).toEqual(capacityHoldingBookingFilter().OR);
  });

  it("resolves zero capacity for an unconfigured additional lodge", async () => {
    mocks.clubModuleSettingsFindUnique.mockResolvedValue({ bedAllocation: true });
    mocks.lodgeBedCount.mockResolvedValue(0);

    const status = await getLodgeCapacityStatus(LODGE_B, twoLodgeDb());

    expect(status).toMatchObject({
      capacity: 0,
      source: "unconfigured_lodge",
      activeBedCount: 0,
      fallbackCapacity: 0,
    });
  });

  it("resolves 0 for the default lodge with no capacity override (#1982: club-config fallback removed)", async () => {
    mocks.clubModuleSettingsFindUnique.mockResolvedValue({ bedAllocation: true });
    mocks.lodgeBedCount.mockResolvedValue(0);

    // twoLodgeDb has no lodgeSettings delegate → no override for the default
    // lodge either. Without the removed club-config fallback it resolves to 0,
    // the same never-overbook outcome as an unconfigured additional lodge; the
    // boot self-heal is what gives a live default lodge its explicit override.
    const status = await getLodgeCapacityStatus(LODGE_A, twoLodgeDb());

    expect(status).toMatchObject({
      capacity: 0,
      source: "unconfigured_lodge",
    });
  });

  it("uses the self-healed override for the default lodge in a multi-lodge club", async () => {
    mocks.clubModuleSettingsFindUnique.mockResolvedValue({ bedAllocation: true });
    mocks.lodgeBedCount.mockResolvedValue(0);

    const status = await getLodgeCapacityStatus(
      LODGE_A,
      twoLodgeDb({
        lodgeSettings: {
          findUnique: vi.fn().mockResolvedValue({ capacity: TEST_LODGE_CAPACITY }),
        },
      }),
    );

    expect(status).toMatchObject({
      capacity: TEST_LODGE_CAPACITY,
      source: "capacity_override",
    });
  });

  it("uses configured beds for an additional lodge once its rooms have beds", async () => {
    mocks.clubModuleSettingsFindUnique.mockResolvedValue({ bedAllocation: true });
    mocks.lodgeBedCount.mockResolvedValue(8);

    const status = await getLodgeCapacityStatus(LODGE_B, twoLodgeDb());

    expect(status).toMatchObject({
      capacity: 8,
      source: "configured_beds",
      activeBedCount: 8,
    });
    expect(mocks.lodgeBedCount).toHaveBeenCalledWith({
      where: { active: true, room: { lodgeId: LODGE_B } },
    });
  });

  it("does not apply another lodge's capacity override", async () => {
    mocks.clubModuleSettingsFindUnique.mockResolvedValue({ bedAllocation: false });

    const status = await getLodgeCapacityStatus(
      LODGE_B,
      twoLodgeDb({
        lodgeSettings: {
          // Id-keyed like the per-lodge read path: LODGE_B has no row of
          // its own; the legacy "default" row is linked to LODGE_A.
          findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
            where.id === "default"
              ? { capacity: 42, lodgeId: LODGE_A }
              : null,
          ),
        },
      }),
    );

    expect(status).toMatchObject({
      capacity: 0,
      source: "unconfigured_lodge",
    });
  });

  it("applies an unlinked (legacy) capacity override to any lodge", async () => {
    mocks.clubModuleSettingsFindUnique.mockResolvedValue({ bedAllocation: false });

    const status = await getLodgeCapacityStatus(
      LODGE_A,
      singleLodgeDb({
        lodgeSettings: {
          findUnique: vi.fn().mockResolvedValue({ capacity: 42, lodgeId: null }),
        },
      }),
    );

    expect(status).toMatchObject({ capacity: 42, source: "capacity_override" });
  });

  it("acquires a per-lodge advisory lock keyed by the lodge id", async () => {
    // $executeRaw, never $queryRaw: pg_advisory_xact_lock returns void and
    // the driver adapter fails to deserialize it as a result row.
    const executeRaw = vi.fn().mockResolvedValue(0);

    await acquireLodgeCapacityLock({ $executeRaw: executeRaw } as never, LODGE_A);

    expect(executeRaw).toHaveBeenCalledTimes(1);
    const [strings, ...values] = executeRaw.mock.calls[0];
    expect(strings.join("?")).toContain("pg_advisory_xact_lock(hashtextextended(");
    expect(values).toEqual([LODGE_A]);
  });

  it("never acquires the capacity lock through $queryRaw", () => {
    // Regression pin for the runtime failure this caused: every booking
    // transaction died with a void-deserialization error under the pg
    // driver adapter.
    const source = readFileSync(
      path.join(process.cwd(), "src/lib/lodge-capacity-lock.ts"),
      "utf8",
    );
    const lockFn = source.slice(
      source.indexOf("export async function acquireLodgeCapacityLock"),
      source.indexOf("}", source.indexOf("export async function acquireLodgeCapacityLock")) + 1,
    );
    expect(lockFn).toContain("$executeRaw");
    expect(lockFn).not.toContain("$queryRaw");
  });
});

describe("overCapacityNights (issue #1668 admin override)", () => {
  it("returns only the nights whose availableBeds went negative, as YYYY-MM-DD", () => {
    const nights = overCapacityNights({
      nightDetails: [
        // `wholeLodgeHeld` is REQUIRED since #2930 — a night that cannot say
        // whether it is held cannot be classified, because a held night sits at
        // exactly 0 rather than below it (`INV-CAP-021`).
        { date: parseDateOnly("2026-09-01"), occupiedBeds: 10, availableBeds: 2, wholeLodgeHeld: false },
        { date: parseDateOnly("2026-09-02"), occupiedBeds: 30, availableBeds: -1, wholeLodgeHeld: false },
        { date: parseDateOnly("2026-09-03"), occupiedBeds: 31, availableBeds: -2, wholeLodgeHeld: false },
        { date: parseDateOnly("2026-09-04"), occupiedBeds: 29, availableBeds: 0, wholeLodgeHeld: false },
      ],
    });

    expect(nights).toEqual([
      { date: "2026-09-02", availableBeds: -1 },
      { date: "2026-09-03", availableBeds: -2 },
    ]);
  });

  it("returns an empty list when nothing is over capacity", () => {
    expect(
      overCapacityNights({
        nightDetails: [
          { date: parseDateOnly("2026-09-01"), occupiedBeds: 1, availableBeds: 5, wholeLodgeHeld: false },
        ],
      }),
    ).toEqual([]);
  });
});

describe("OverCapacityConfirmationRequiredError (issue #1668)", () => {
  it("is a 409 carrying the OVER_CAPACITY_CONFIRM_REQUIRED code and the night list", () => {
    const nightDetails = [{ date: "2026-09-02", availableBeds: -1 }];
    const err = new OverCapacityConfirmationRequiredError(nightDetails);

    expect(err.status).toBe(409);
    expect(err.code).toBe("OVER_CAPACITY_CONFIRM_REQUIRED");
    expect(err.nightDetails).toEqual(nightDetails);
  });
});

// ADR-001 exclusive whole-lodge hold (issue #118). A capacity-holding booking
// with wholeLodgeHold=true hard-blocks its nights: to members the night is
// indistinguishable from a full lodge (decision 6), and an admin over-capacity
// override cannot punch into it (decision 5).
describe("whole-lodge exclusive hold — capacity engine (issue #118)", () => {
  const HELD_IN = parseDateOnly("2026-08-10");
  const HELD_OUT = parseDateOnly("2026-08-12");

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.bookingFindMany.mockResolvedValue([]);
    // #2286: no custodian bed holds in these cases.
    mocks.hutLeaderAssignmentFindMany.mockResolvedValue([]);
    mocks.clubModuleSettingsFindUnique.mockResolvedValue(null);
    mocks.lodgeBedCount.mockResolvedValue(0);
  });

  function heldBooking(overrides: Record<string, unknown> = {}) {
    return {
      id: "held-booking",
      status: BookingStatus.CONFIRMED,
      checkIn: HELD_IN,
      checkOut: HELD_OUT,
      wholeLodgeHold: true,
      // A single guest: numeric beds (19 of 20 free) would easily fit a new
      // small booking. The hold — not the arithmetic — is what must block.
      guests: [{ id: "school-1" }],
      ...overrides,
    };
  }

  it("blocks a NEW admission on overlapping nights even though numeric beds fit (checkCapacityForGuestRanges)", async () => {
    mocks.bookingFindMany.mockResolvedValue([heldBooking()]);

    const result = await checkCapacityForGuestRanges(
      LODGE_A,
      HELD_IN,
      HELD_OUT,
      [{ stayStart: HELD_IN, stayEnd: HELD_OUT }],
    );

    expect(result.available).toBe(false);
    expect(result.nightDetails.map((n) => n.wholeLodgeHeld)).toEqual([true, true]);
    // Pinned to 0, never negative — so it can never enter the confirmable set.
    expect(result.nightDetails.map((n) => n.availableBeds)).toEqual([0, 0]);
  });

  it("blocks a NEW admission in checkCapacity as well (available forced false, beds pinned to 0)", async () => {
    mocks.bookingFindMany.mockResolvedValue([heldBooking()]);

    const result = await checkCapacity(LODGE_A, HELD_IN, HELD_OUT, 1);

    expect(result.available).toBe(false);
    expect(result.nightDetails.map((n) => n.wholeLodgeHeld)).toEqual([true, true]);
    expect(result.nightDetails.map((n) => n.availableBeds)).toEqual([0, 0]);
  });

  it("issue #155: checkCapacity pins occupiedBeds to lodgeCapacity on a held-but-not-full night, so occupiedBeds + availableBeds === lodgeCapacity", async () => {
    // Only one guest occupies the held nights — numerically 19 of 20 beds are
    // free — but the real headcount must not leak through occupiedBeds either
    // (mirrors getMonthAvailability's pin, ADR-001 decision 6).
    mocks.bookingFindMany.mockResolvedValue([heldBooking()]);

    const result = await checkCapacity(LODGE_A, HELD_IN, HELD_OUT, 1);

    expect(result.nightDetails.map((n) => n.occupiedBeds)).toEqual([
      TEST_LODGE_CAPACITY,
      TEST_LODGE_CAPACITY,
    ]);
    expect(result.nightDetails.map((n) => n.availableBeds)).toEqual([0, 0]);
    for (const night of result.nightDetails) {
      expect(night.occupiedBeds + night.availableBeds).toBe(TEST_LODGE_CAPACITY);
    }
  });

  it("issue #155: an unheld night's occupiedBeds is unchanged (real headcount, not pinned)", async () => {
    // Two guests, no hold: occupiedBeds must stay the real count, not capacity.
    mocks.bookingFindMany.mockResolvedValue([
      {
        status: BookingStatus.CONFIRMED,
        checkIn: HELD_IN,
        checkOut: HELD_OUT,
        wholeLodgeHold: false,
        guests: [{ id: "g1" }, { id: "g2" }],
      },
    ]);

    const result = await checkCapacity(LODGE_A, HELD_IN, HELD_OUT, 1);

    expect(result.nightDetails.every((n) => !n.wholeLodgeHeld)).toBe(true);
    expect(result.nightDetails.map((n) => n.occupiedBeds)).toEqual([2, 2]);
    expect(result.nightDetails.map((n) => n.availableBeds)).toEqual([
      TEST_LODGE_CAPACITY - 2,
      TEST_LODGE_CAPACITY - 2,
    ]);
  });

  it("member parity: held nights are NOT in overCapacityNights, so members get the ordinary no-space path", async () => {
    mocks.bookingFindMany.mockResolvedValue([heldBooking()]);

    const result = await checkCapacityForGuestRanges(
      LODGE_A,
      HELD_IN,
      HELD_OUT,
      [{ stayStart: HELD_IN, stayEnd: HELD_OUT }],
    );

    // Unavailable exactly like a full lodge, but with NO confirmable night —
    // the hold is never surfaced as a bypassable over-capacity signal.
    expect(result.available).toBe(false);
    expect(overCapacityNights(result)).toEqual([]);
    expect(wholeLodgeBlockedNights(result)).toEqual(["2026-08-10", "2026-08-11"]);
  });

  it("edge-night handover: a hold departing on day D does NOT block a booking arriving night D ([checkIn, checkOut))", async () => {
    // Held booking runs 08-08 → 08-10 (checkout day 08-10). A new booking
    // arriving the night of 08-10 must NOT be blocked: the hold spans only
    // 08-08 and 08-09.
    mocks.bookingFindMany.mockResolvedValue([
      heldBooking({
        checkIn: parseDateOnly("2026-08-08"),
        checkOut: parseDateOnly("2026-08-10"),
      }),
    ]);

    const result = await checkCapacityForGuestRanges(
      LODGE_A,
      parseDateOnly("2026-08-10"),
      parseDateOnly("2026-08-12"),
      [{ stayStart: parseDateOnly("2026-08-10"), stayEnd: parseDateOnly("2026-08-12") }],
    );

    expect(result.available).toBe(true);
    expect(result.nightDetails.some((n) => n.wholeLodgeHeld)).toBe(false);
  });

  it("editing the hold's OWN dates: excludeBookingId removes it from the overlap query so its nights are not blocked against itself", async () => {
    // Prisma applies the exclude; the mock returns the post-exclusion set.
    mocks.bookingFindMany.mockResolvedValue([]);

    const result = await checkCapacityForGuestRanges(
      LODGE_A,
      HELD_IN,
      HELD_OUT,
      [{ stayStart: HELD_IN, stayEnd: HELD_OUT }],
      "held-booking",
    );

    expect(result.available).toBe(true);
    expect(result.nightDetails.some((n) => n.wholeLodgeHeld)).toBe(false);
    // The held booking's own id is excluded from the overlap query.
    expect(mocks.bookingFindMany.mock.calls[0][0].where).toMatchObject({
      id: { not: "held-booking" },
    });
  });

  it("regression: a genuinely full (numeric) lodge with NO hold still yields overCapacityNights and stays override-confirmable", async () => {
    // 20 guests fill a 20-bed lodge; a proposed 21st goes to -1. No hold.
    mocks.bookingFindMany.mockResolvedValue([
      {
        status: BookingStatus.PAID,
        checkIn: HELD_IN,
        checkOut: HELD_OUT,
        wholeLodgeHold: false,
        guests: Array.from({ length: TEST_LODGE_CAPACITY }, (_, i) => ({ id: `g${i}` })),
      },
    ]);

    const result = await checkCapacityForGuestRanges(
      LODGE_A,
      HELD_IN,
      HELD_OUT,
      [{ stayStart: HELD_IN, stayEnd: HELD_OUT }],
    );

    expect(result.available).toBe(false);
    expect(result.nightDetails.every((n) => !n.wholeLodgeHeld)).toBe(true);
    // Negative, so it IS confirmable — the ordinary #1668 override still works.
    expect(overCapacityNights(result)).toEqual([
      { date: "2026-08-10", availableBeds: -1 },
      { date: "2026-08-11", availableBeds: -1 },
    ]);
    expect(wholeLodgeBlockedNights(result)).toEqual([]);
  });

  it("month calendar parity (getMonthAvailability): a held-but-not-full night reports as FULL, indistinguishable from a genuinely full lodge (decision 6)", async () => {
    // A single guest holds the whole lodge for 08-10 → 08-12. Numerically 19 of
    // 20 beds are free, but the public calendar must show ZERO availability.
    mocks.bookingFindMany.mockResolvedValue([heldBooking()]);

    const availability = await getMonthAvailability(LODGE_A, 2026, 7); // August

    // Held nights report full occupancy (= capacity), so the frontend's
    // capacity - occupied yields no free beds.
    expect(availability.get("2026-08-10")).toBe(TEST_LODGE_CAPACITY);
    expect(availability.get("2026-08-11")).toBe(TEST_LODGE_CAPACITY);
    // The checkout day (08-12) is outside [checkIn, checkOut): not held, and no
    // guest occupies it, so it stays free.
    expect(availability.get("2026-08-12")).toBe(0);
  });

  it("a CANCELLED whole-lodge-hold booking cannot block: the capacity query filters to holding statuses only (CANCELLED excluded)", async () => {
    await checkCapacityForGuestRanges(
      LODGE_A,
      HELD_IN,
      HELD_OUT,
      [{ stayStart: HELD_IN, stayEnd: HELD_OUT }],
    );

    // The overlap query is scoped by capacityHoldingBookingFilter(), whose
    // status set never includes CANCELLED — a cancelled hold is never even
    // fetched, so its wholeLodgeHold flag is irrelevant.
    const where = mocks.bookingFindMany.mock.calls[0][0].where;
    expect(where.OR).toEqual(capacityHoldingBookingFilter().OR);
    expect(CAPACITY_HOLDING_BOOKING_STATUSES).not.toContain(BookingStatus.CANCELLED);
  });
});

describe("wholeLodgeBlockedNights + WholeLodgeHoldBlockedError (issue #118)", () => {
  it("wholeLodgeBlockedNights returns only the held nights as YYYY-MM-DD", () => {
    expect(
      wholeLodgeBlockedNights({
        nightDetails: [
          {
            date: parseDateOnly("2026-09-01"),
            occupiedBeds: 5,
            availableBeds: 15,
            wholeLodgeHeld: false,
          },
          {
            date: parseDateOnly("2026-09-02"),
            occupiedBeds: 3,
            availableBeds: 0,
            wholeLodgeHeld: true,
          },
          {
            date: parseDateOnly("2026-09-03"),
            occupiedBeds: 31,
            availableBeds: -1,
            wholeLodgeHeld: false,
          },
        ],
      }),
    ).toEqual(["2026-09-02"]);
  });

  it("is a non-confirmable 409 carrying the WHOLE_LODGE_HOLD_BLOCKED code and the blocked nights", () => {
    const err = new WholeLodgeHoldBlockedError(["2026-09-02", "2026-09-03"]);

    expect(err.status).toBe(409);
    expect(err.code).toBe("WHOLE_LODGE_HOLD_BLOCKED");
    expect(err.blockedNights).toEqual(["2026-09-02", "2026-09-03"]);
  });
});

// Admin conflict-surfacing helpers (issue #119). Shared by the exclusive-hold
// route, the school approval, the booking detail page, and the admin bookings
// list — reusing the capacity engine's overlap window / hold population.
describe("bookingsOverlap + sameLodgeNullTolerant (issue #119)", () => {
  it("uses the half-open span: a back-to-back handover does NOT overlap", () => {
    const a = {
      checkIn: parseDateOnly("2026-08-08"),
      checkOut: parseDateOnly("2026-08-10"),
    };
    const backToBack = {
      checkIn: parseDateOnly("2026-08-10"),
      checkOut: parseDateOnly("2026-08-12"),
    };
    const overlapping = {
      checkIn: parseDateOnly("2026-08-09"),
      checkOut: parseDateOnly("2026-08-11"),
    };
    expect(bookingsOverlap(a, backToBack)).toBe(false);
    expect(bookingsOverlap(a, overlapping)).toBe(true);
  });

  it("tolerates a null lodgeId on either side (expand-release)", () => {
    expect(sameLodgeNullTolerant(null, "lodge-a")).toBe(true);
    expect(sameLodgeNullTolerant("lodge-a", undefined)).toBe(true);
    expect(sameLodgeNullTolerant("lodge-a", "lodge-a")).toBe(true);
    expect(sameLodgeNullTolerant("lodge-a", "lodge-b")).toBe(false);
  });
});

describe("findOverlappingCapacityHoldingBookings (issue #119)", () => {
  const db = { booking: { findMany: mocks.bookingFindMany } } as never;

  beforeEach(() => {
    vi.clearAllMocks();
    // #2286: no custodian bed holds in these cases.
    mocks.hutLeaderAssignmentFindMany.mockResolvedValue([]);
  });

  it("returns the overlapping capacity-holding bookings, excluding the held booking", async () => {
    mocks.bookingFindMany.mockResolvedValue([
      {
        id: "booking-2",
        checkIn: parseDateOnly("2026-08-10"),
        checkOut: parseDateOnly("2026-08-12"),
        status: "CONFIRMED",
        member: { firstName: "Jane", lastName: "Doe", email: "j@x.nz" },
        _count: { guests: 3 },
      },
    ]);

    const result = await findOverlappingCapacityHoldingBookings(db, {
      lodgeId: "lodge-a",
      checkIn: parseDateOnly("2026-08-10"),
      checkOut: parseDateOnly("2026-08-12"),
      excludeBookingId: "held-1",
    });

    expect(result).toEqual([
      {
        id: "booking-2",
        memberName: "Jane Doe",
        checkIn: "2026-08-10",
        checkOut: "2026-08-12",
        guestCount: 3,
        status: "CONFIRMED",
      },
    ]);
    const where = mocks.bookingFindMany.mock.calls[0][0].where;
    expect(where).toMatchObject({
      lodgeId: "lodge-a",
      id: { not: "held-1" },
      deletedAt: null,
    });
    // Reuses the capacity-holding population filter, not a bespoke status list.
    expect(where.OR).toEqual(capacityHoldingBookingFilter().OR);
  });

  it("returns [] when nothing overlaps", async () => {
    mocks.bookingFindMany.mockResolvedValue([]);
    expect(
      await findOverlappingCapacityHoldingBookings(db, {
        lodgeId: "lodge-a",
        checkIn: parseDateOnly("2026-08-10"),
        checkOut: parseDateOnly("2026-08-12"),
      }),
    ).toEqual([]);
  });
});

describe("findOverlappingOverriddenNonHoldingBookings (issue #177)", () => {
  const db = { booking: { findMany: mocks.bookingFindMany } } as never;

  beforeEach(() => {
    vi.clearAllMocks();
    // #2286: no custodian bed holds in these cases.
    mocks.hutLeaderAssignmentFindMany.mockResolvedValue([]);
  });

  it("surfaces an overridden PAYMENT_PENDING overlap, marked overridden", async () => {
    mocks.bookingFindMany.mockResolvedValue([
      {
        id: "booking-9",
        checkIn: parseDateOnly("2026-08-10"),
        checkOut: parseDateOnly("2026-08-12"),
        status: "PAYMENT_PENDING",
        member: { firstName: "Sam", lastName: "Over", email: "s@x.nz" },
        _count: { guests: 2 },
      },
    ]);

    const result = await findOverlappingOverriddenNonHoldingBookings(db, {
      lodgeId: "lodge-a",
      checkIn: parseDateOnly("2026-08-10"),
      checkOut: parseDateOnly("2026-08-12"),
      excludeBookingId: "held-1",
    });

    expect(result).toEqual([
      {
        id: "booking-9",
        memberName: "Sam Over",
        checkIn: "2026-08-10",
        checkOut: "2026-08-12",
        guestCount: 2,
        status: "PAYMENT_PENDING",
        overridden: true,
      },
    ]);
  });

  it("scopes to overridden + active + NOT capacity-holding (no double-count, no terminal noise)", async () => {
    mocks.bookingFindMany.mockResolvedValue([]);

    await findOverlappingOverriddenNonHoldingBookings(db, {
      lodgeId: "lodge-a",
      checkIn: parseDateOnly("2026-08-10"),
      checkOut: parseDateOnly("2026-08-12"),
      excludeBookingId: "held-1",
    });

    const where = mocks.bookingFindMany.mock.calls[0][0].where;
    expect(where).toMatchObject({
      lodgeId: "lodge-a",
      id: { not: "held-1" },
      deletedAt: null,
      capacityOverriddenAt: { not: null },
    });
    // Excludes the capacity-holding population so it never double-lists a
    // booking already surfaced by findOverlappingCapacityHoldingBookings.
    expect(where.NOT).toEqual(capacityHoldingBookingFilter());
    // Only active statuses — a cancelled/bumped overridden row can never settle
    // onto the held nights, so it must not be surfaced.
    expect(Array.isArray(where.status.in)).toBe(true);
    expect(where.status.in).not.toContain("CANCELLED");
    expect(where.status.in).not.toContain("BUMPED");
  });
});

describe("getLodgeHeldNights — admin companion to getLodgeCapacityStatus (issue #119)", () => {
  const db = { booking: { findMany: mocks.bookingFindMany } } as never;

  beforeEach(() => {
    vi.clearAllMocks();
    // #2286: no custodian bed holds in these cases.
    mocks.hutLeaderAssignmentFindMany.mockResolvedValue([]);
  });

  it("reports the whole-lodge-held nights within the range (half-open span)", async () => {
    mocks.bookingFindMany.mockResolvedValue([
      {
        checkIn: parseDateOnly("2026-08-10"),
        checkOut: parseDateOnly("2026-08-12"),
        wholeLodgeHold: true,
      },
    ]);

    const nights = await getLodgeHeldNights(
      "lodge-a",
      parseDateOnly("2026-08-09"),
      parseDateOnly("2026-08-13"),
      db,
    );

    // Held 08-10 and 08-11; the checkout day 08-12 is outside [checkIn, checkOut).
    expect(nights).toEqual(["2026-08-10", "2026-08-11"]);
    const where = mocks.bookingFindMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ lodgeId: "lodge-a", wholeLodgeHold: true });
    expect(where.OR).toEqual(capacityHoldingBookingFilter().OR);
  });

  it("returns [] when no hold overlaps the range", async () => {
    mocks.bookingFindMany.mockResolvedValue([]);
    expect(
      await getLodgeHeldNights(
        "lodge-a",
        parseDateOnly("2026-08-09"),
        parseDateOnly("2026-08-13"),
        db,
      ),
    ).toEqual([]);
  });
});

// ============================================================================
// FREEZE TESTS (#2307): a PENDING member guest HOLDS A BED
// ============================================================================
//
// Owner decision D-4: a member guest whose consent is still PENDING holds the
// bed until the hold expires. Owner decision D-12 keeps that same guest off every
// OPERATIONAL surface — the kiosk, the roster, bed allocation, the arrival
// emails, the wall. The two decisions pull in opposite directions on purpose, and
// this file is the side that must NOT move.
//
// The failure these tests exist to prevent: somebody applies D-12 tidily by
// spreading OPERATIONALLY_PRESENT_GUEST_WHERE into "the guest queries", capacity
// included, and the lodge quietly overbooks by exactly the number of pending
// member guests — a category of bug that shows up as a family with no bed on
// arrival night, not as a failing build.
//
// Person-night conflicts are frozen for a sharper reason still: a PENDING guest
// holds a bed, so it MUST hold that member's person-night as well, or the same
// member can be placed in two beds on one night.
describe("#2307 capacity freeze: a PENDING member guest still occupies a bed (D-4)", () => {
  const CAPACITY = 10;

  // A guest row exactly as MG2 writes it for an approval-required cross-family
  // add: PENDING, requested, unanswered, with an expiry the sweep will read.
  function pendingGuest(id: string) {
    return {
      id,
      stayStart: parseDateOnly("2026-08-01"),
      stayEnd: parseDateOnly("2026-08-03"),
      nights: [],
      consentStatus: "PENDING",
      consentRequestedAt: new Date("2026-07-25T00:00:00.000Z"),
      consentRespondedAt: null,
      consentRespondedByMemberId: null,
      consentExpiresAt: new Date("2026-07-31T12:00:00.000Z"),
    };
  }

  function ordinaryGuest(id: string) {
    return {
      id,
      stayStart: parseDateOnly("2026-08-01"),
      stayEnd: parseDateOnly("2026-08-03"),
      nights: [],
      // Every non-member guest, every family-scope add, every pre-feature row.
      consentStatus: null,
    };
  }

  function holdingBooking(guests: Array<Record<string, unknown>>) {
    return {
      id: "booking-existing",
      checkIn: parseDateOnly("2026-08-01"),
      checkOut: parseDateOnly("2026-08-03"),
      status: BookingStatus.PAID,
      lodgeId: LODGE_A,
      wholeLodgeHold: false,
      guests,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.bookingFindMany.mockResolvedValue([]);
    mocks.clubModuleSettingsFindUnique.mockResolvedValue(null);
    mocks.lodgeBedCount.mockResolvedValue(0);
    mocks.lodgeSettingsFindUnique.mockResolvedValue({ capacity: CAPACITY });
  });

  it("counts a PENDING guest in checkCapacity's occupancy", async () => {
    mocks.bookingFindMany.mockResolvedValue([
      holdingBooking([ordinaryGuest("g-ordinary"), pendingGuest("g-pending")]),
    ]);

    const result = await checkCapacity(
      LODGE_A,
      parseDateOnly("2026-08-01"),
      parseDateOnly("2026-08-03"),
      1,
    );

    // Two occupants, not one. If the pending guest were filtered out, this reads
    // 1 and the lodge is one bed overbooked on both nights.
    for (const night of result.nightDetails) {
      expect(night.occupiedBeds).toBe(2);
      expect(night.availableBeds).toBe(CAPACITY - 2);
    }
  });

  it("sends no consent filter in checkCapacity's guest include", async () => {
    await checkCapacity(
      LODGE_A,
      parseDateOnly("2026-08-01"),
      parseDateOnly("2026-08-03"),
      1,
    );

    const args = mocks.bookingFindMany.mock.calls[0][0];
    expect(JSON.stringify(args.include)).not.toContain("consentStatus");
    expect(JSON.stringify(args.where)).not.toContain("consentStatus");
  });

  it("counts a PENDING guest in checkCapacityForGuestRanges", async () => {
    mocks.bookingFindMany.mockResolvedValue([
      holdingBooking([ordinaryGuest("g-ordinary"), pendingGuest("g-pending")]),
    ]);

    const result = await checkCapacityForGuestRanges(
      LODGE_A,
      parseDateOnly("2026-08-01"),
      parseDateOnly("2026-08-03"),
      [
        {
          stayStart: parseDateOnly("2026-08-01"),
          stayEnd: parseDateOnly("2026-08-03"),
        },
      ],
    );

    // This function reports existing occupancy PLUS the proposal: 2 existing
    // (one of them the pending member guest) + 1 proposed = 3. Drop the pending
    // guest and this reads 2, which is how a booking gets accepted onto a bed
    // that is already held.
    for (const night of result.nightDetails) {
      expect(night.occupiedBeds).toBe(3);
      expect(night.availableBeds).toBe(CAPACITY - 3);
    }
    const args = mocks.bookingFindMany.mock.calls[0][0];
    expect(JSON.stringify(args)).not.toContain("consentStatus");
  });

  it("counts a PENDING guest in getMonthAvailability", async () => {
    mocks.bookingFindMany.mockResolvedValue([
      holdingBooking([ordinaryGuest("g-ordinary"), pendingGuest("g-pending")]),
    ]);

    // A Map of date key -> occupied beds; this is what the public availability
    // calendar renders, so an undercount here shows the lodge as having a free
    // bed that a pending member guest is holding.
    // month is 0-indexed here, as everywhere else in this suite.
    const availability = await getMonthAvailability(LODGE_A, 2026, 7);

    expect(availability.get("2026-08-01")).toBe(2);
    expect(availability.get("2026-08-02")).toBe(2);
    const args = mocks.bookingFindMany.mock.calls[0][0];
    expect(JSON.stringify(args)).not.toContain("consentStatus");
  });

  it("counts a PENDING guest in getOccupiedBedsForNight (and its index twin)", async () => {
    // getOccupiedBedsForNight delegates to buildOccupancyIndex +
    // getOccupiedBedsForNightFromIndex, so this covers all three: the public
    // entry point and the two private halves it is built from.
    const occupied = getOccupiedBedsForNight(parseDateOnly("2026-08-01"), [
      holdingBooking([
        ordinaryGuest("g-ordinary"),
        pendingGuest("g-pending"),
      ]) as never,
    ]);

    expect(occupied).toBe(2);
  });

  it("counts a PENDING guest in findOverlappingCapacityHoldingBookings' _count", async () => {
    // The _count.guests here is a Prisma relation count with no filter, so this
    // pins the query shape: a `where` on the counted relation would silently
    // shrink the conflict message an admin reads before overriding.
    const bookingFindMany = vi.fn().mockResolvedValue([
      {
        id: "booking-existing",
        checkIn: parseDateOnly("2026-08-01"),
        checkOut: parseDateOnly("2026-08-03"),
        status: BookingStatus.PAID,
        member: { firstName: "Ada", lastName: "Holder", email: "ada@example.org" },
        _count: { guests: 2 },
      },
    ]);

    const conflicts = await findOverlappingCapacityHoldingBookings(
      { booking: { findMany: bookingFindMany } } as never,
      {
        lodgeId: LODGE_A,
        checkIn: parseDateOnly("2026-08-01"),
        checkOut: parseDateOnly("2026-08-03"),
      },
    );

    expect(conflicts[0].guestCount).toBe(2);
    const args = bookingFindMany.mock.calls[0][0];
    expect(args.select._count).toEqual({ select: { guests: true } });
    expect(JSON.stringify(args)).not.toContain("consentStatus");
  });

  it("counts a PENDING guest in the overridden-non-holding twin's _count", async () => {
    const bookingFindMany = vi.fn().mockResolvedValue([
      {
        id: "booking-overridden",
        checkIn: parseDateOnly("2026-08-01"),
        checkOut: parseDateOnly("2026-08-03"),
        status: BookingStatus.PAYMENT_PENDING,
        member: { firstName: "Bo", lastName: "Override", email: "bo@example.org" },
        _count: { guests: 3 },
      },
    ]);

    const conflicts = await findOverlappingOverriddenNonHoldingBookings(
      { booking: { findMany: bookingFindMany } } as never,
      {
        lodgeId: LODGE_A,
        checkIn: parseDateOnly("2026-08-01"),
        checkOut: parseDateOnly("2026-08-03"),
      },
    );

    expect(conflicts[0].guestCount).toBe(3);
    const args = bookingFindMany.mock.calls[0][0];
    expect(args.select._count).toEqual({ select: { guests: true } });
    expect(JSON.stringify(args)).not.toContain("consentStatus");
  });

  it("has no consent filter anywhere in capacity.ts", () => {
    // The catch-all, and the reason it is worth having: buildOccupancyIndex and
    // getOccupiedBedsForNightFromIndex are private, and future capacity paths
    // will be added without anyone thinking to extend this suite. Any mention of
    // consent in this file is either an intentional change to D-4 — which is the
    // owner's call, not a refactor's — or the overbooking bug.
    const source = readFileSync(
      path.resolve(process.cwd(), "src/lib/capacity.ts"),
      "utf8",
    );
    expect(source).not.toContain("consentStatus");
    expect(source).not.toContain("OPERATIONALLY_PRESENT_GUEST_WHERE");
    expect(source).not.toContain("isOperationallyPresentConsent");
  });
});

// ============================================================================
// FREEZE TEST (#2307): the stay-range occupancy primitives are consent-blind
// ============================================================================
//
// `isGuestActiveOnNight` and its `countActiveGuestsForNight` wrapper are the
// primitives every capacity path in the repo counts with. They take a guest's
// stay envelope (or explicit night set) and a night, and answer "is this person
// occupying a bed tonight". Consent has no place in that question: a PENDING
// member guest IS occupying the bed (D-4), and D-12's exclusion belongs on the
// operational QUERIES, not on the arithmetic they all share.
//
// A filter added here would leak into every caller at once — capacity, pricing,
// the roster headcount, the print sheet — which is exactly why it is frozen in
// its own suite rather than left implied by the callers' tests.
describe("#2307 stay-range occupancy primitives ignore consent (D-4)", () => {
  const NIGHT = parseDateOnly("2026-08-01");
  const BOOKING = {
    checkIn: parseDateOnly("2026-08-01"),
    checkOut: parseDateOnly("2026-08-03"),
  };

  const guestWithConsent = (consentStatus: string | null) => ({
    stayStart: parseDateOnly("2026-08-01"),
    stayEnd: parseDateOnly("2026-08-03"),
    nights: [],
    consentStatus,
  });

  it("treats every consent state as occupying the night", () => {
    for (const consentStatus of [
      null,
      "PENDING",
      "CONFIRMED",
      "DECLINED",
      "EXPIRED",
    ]) {
      expect(
        isGuestActiveOnNight(guestWithConsent(consentStatus) as never, NIGHT, BOOKING),
        `a ${String(consentStatus)} guest must still occupy the night`,
      ).toBe(true);
    }
  });

  it("counts a mixed-consent booking at full headcount", () => {
    const guests = [
      guestWithConsent(null),
      guestWithConsent("CONFIRMED"),
      guestWithConsent("PENDING"),
      guestWithConsent("DECLINED"),
      guestWithConsent("EXPIRED"),
    ];

    expect(countActiveGuestsForNight(guests as never, NIGHT, BOOKING)).toBe(5);
  });

  it("has no consent filter anywhere in booking-guest-stay-ranges.ts", () => {
    const source = readFileSync(
      path.resolve(process.cwd(), "src/lib/booking-guest-stay-ranges.ts"),
      "utf8",
    );
    expect(source).not.toContain("consentStatus");
    expect(source).not.toContain("OPERATIONALLY_PRESENT_GUEST_WHERE");
    expect(source).not.toContain("isOperationallyPresentConsent");
  });
});
