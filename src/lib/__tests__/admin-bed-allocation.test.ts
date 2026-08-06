import { readFileSync } from "fs";
import path from "path";
import { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { canonicalPartnerPair } from "@/lib/member-partner-link-shared";
import { BED_ALLOCATION_PRIORITY_VOCABULARY } from "@/lib/bed-allocation-settings";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    // #2286: the self-wrapping placement paths resolve the bed's lodge OUTSIDE
    // their transaction, purely to derive the per-lodge advisory-lock key, so
    // the lock can be the first statement inside it.
    lodgeBed: {
      findUnique: vi.fn().mockResolvedValue({ room: { lodgeId: "lodge-1" } }),
    },
  },
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
  BedAllocationAdminError,
  MAX_BED_ALLOCATION_RANGE_NIGHTS,
  buildBedAllocationWarnings,
  countGuestsAwaitingBed,
  createBedAllocationBed,
  createBedAllocationRoom,
  createBedAllocationRoomsBulk,
  deleteBedAllocation as deleteBedAllocationPublic,
  deleteBedAllocationRoom as deleteBedAllocationRoomPublic,
  approveBedAllocationsWithLocksHeld as approveBedAllocations,
  countApprovedBedAllocationNights,
  isBookingBedAllocationLocked,
  getBedAllocationDashboard,
  getRoomsAndBedsConfiguration,
  listBedAllocationRooms,
  manuallyAllocateBed,
  manuallyAllocateBedForNights as manuallyAllocateBedForNightsPublic,
  manuallyAllocateBedForNightsWithLocksHeld as manuallyAllocateBedForNights,
  moveBedAllocationsSameDate,
  parseBedAllocationDateRange,
  updateBedAllocationBed as updateBedAllocationBedPublic,
  updateBedAllocationBedWithLocksHeld as updateBedAllocationBed,
  deleteBedAllocationWithLocksHeld as deleteBedAllocation,
  deleteBedAllocationRoomWithLocksHeld as deleteBedAllocationRoom,
} from "@/lib/admin-bed-allocation";
import { getLodgePartnerSharedCapacityStatus } from "@/lib/lodge-capacity";
import { lodgeNullTolerantScope } from "@/lib/lodges";
import { parseDateOnly } from "@/lib/date-only";
import { prisma } from "@/lib/prisma";

function readRepoFile(relativePath: string) {
  // Test helper: reads a fixed repo file under process.cwd(); relativePath is test-controlled, not user input.
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
  return readFileSync(path.resolve(process.cwd(), relativePath), "utf8");
}

async function withPrismaRoomDb<T>(
  db: { lodgeRoom: unknown; lodge: unknown },
  run: () => Promise<T>,
): Promise<T> {
  // Room creation has no held-lock implementation: it is a simple public
  // singleton write, not an allocation lifecycle writer. Install only the two
  // delegates this unit needs instead of re-opening a caller-supplied db seam.
  const prismaMock = prisma as unknown as {
    lodgeRoom?: unknown;
    lodge?: unknown;
  };
  const previousRoom = prismaMock.lodgeRoom;
  const previousLodge = prismaMock.lodge;
  prismaMock.lodgeRoom = db.lodgeRoom;
  prismaMock.lodge = db.lodge;
  try {
    return await run();
  } finally {
    if (previousRoom === undefined) delete prismaMock.lodgeRoom;
    else prismaMock.lodgeRoom = previousRoom;
    if (previousLodge === undefined) delete prismaMock.lodge;
    else prismaMock.lodge = previousLodge;
  }
}

describe("admin bed allocation", () => {
  it("validates date-only allocation ranges", () => {
    expect(
      parseBedAllocationDateRange({
        from: "2026-07-01",
        to: "2026-07-08",
      }),
    ).toMatchObject({
      fromDate: "2026-07-01",
      toDate: "2026-07-08",
    });

    expect(() =>
      parseBedAllocationDateRange({
        from: "2026-07-08",
        to: "2026-07-01",
      }),
    ).toThrow(BedAllocationAdminError);

    expect(() =>
      parseBedAllocationDateRange({
        from: "2026-07-01",
        to: "2026-08-15",
      }),
    ).toThrow(
      `Date range cannot exceed ${MAX_BED_ALLOCATION_RANGE_NIGHTS} nights`,
    );
  });

  it("warns when bookings are split or minors are without a booking adult", () => {
    const warnings = buildBedAllocationWarnings({
      allocations: [
        {
          id: "allocation-1",
          bookingId: "booking-1",
          bookingGuestId: "adult-1",
          guestName: "Adult One",
          guestAgeTier: "ADULT",
          roomId: "room-a",
          roomName: "Room A",
          bedId: "bed-a1",
          bedName: "A1",
          stayDate: "2026-07-01",
          source: "MANUAL",
          approvedAt: null,
          approvedByName: null,
          bookingStatus: "CONFIRMED",
          holdsCapacity: true,
        },
        {
          id: "allocation-2",
          bookingId: "booking-1",
          bookingGuestId: "child-1",
          guestName: "Child One",
          guestAgeTier: "CHILD",
          roomId: "room-b",
          roomName: "Room B",
          bedId: "bed-b1",
          bedName: "B1",
          stayDate: "2026-07-01",
          source: "MANUAL",
          approvedAt: null,
          approvedByName: null,
          bookingStatus: "CONFIRMED",
          holdsCapacity: true,
        },
      ],
    });

    expect(warnings.map((warning) => warning.type)).toEqual([
      "BOOKING_SPLIT",
      "MINOR_WITHOUT_BOOKING_ADULT",
    ]);
  });

  it("warns when a room-night mixes one booking's minors with another booking's adults (MINOR_ADULT_MIX, #1768)", () => {
    const base = {
      guestName: "Guest",
      roomId: "room-a",
      roomName: "Room A",
      bedName: "A1",
      stayDate: "2026-07-01",
      source: "MANUAL" as const,
      approvedAt: null,
      approvedByName: null,
      bookingStatus: "CONFIRMED",
      holdsCapacity: true,
    };
    const warnings = buildBedAllocationWarnings({
      allocations: [
        {
          ...base,
          id: "allocation-1",
          bookingId: "booking-kids",
          bookingGuestId: "child-1",
          guestAgeTier: "CHILD",
          bedId: "bed-a1",
        },
        {
          ...base,
          id: "allocation-2",
          bookingId: "booking-kids",
          bookingGuestId: "adult-own",
          guestAgeTier: "ADULT",
          bedId: "bed-a2",
        },
        {
          ...base,
          id: "allocation-3",
          bookingId: "booking-stranger",
          bookingGuestId: "adult-stranger",
          guestAgeTier: "ADULT",
          bedId: "bed-a3",
        },
      ],
    });

    const mixWarnings = warnings.filter(
      (warning) => warning.type === "MINOR_ADULT_MIX",
    );
    expect(mixWarnings).toEqual([
      {
        id: "MINOR_ADULT_MIX:room-a:2026-07-01",
        type: "MINOR_ADULT_MIX",
        severity: "warning",
        bookingId: "booking-kids",
        stayDate: "2026-07-01",
        roomId: "room-a",
        message:
          "Room A on 2026-07-01 mixes minors with adults from a different booking.",
      },
    ]);
  });

  it("raises no MINOR_ADULT_MIX when the only adults in the room-night belong to the minors' own booking", () => {
    const base = {
      guestName: "Guest",
      roomId: "room-a",
      roomName: "Room A",
      bedName: "A1",
      stayDate: "2026-07-01",
      source: "AUTO" as const,
      approvedAt: null,
      approvedByName: null,
      bookingStatus: "CONFIRMED",
      holdsCapacity: true,
    };
    const warnings = buildBedAllocationWarnings({
      allocations: [
        {
          ...base,
          id: "allocation-1",
          bookingId: "booking-family",
          bookingGuestId: "child-1",
          guestAgeTier: "CHILD",
          bedId: "bed-a1",
        },
        {
          ...base,
          id: "allocation-2",
          bookingId: "booking-family",
          bookingGuestId: "adult-1",
          guestAgeTier: "ADULT",
          bedId: "bed-a2",
        },
      ],
    });

    expect(
      warnings.filter((warning) => warning.type === "MINOR_ADULT_MIX"),
    ).toEqual([]);
  });

  it("warns once, stay-level, when a booking's rooms change between nights (ROOM_SWITCH, #1677)", () => {
    const allocation = (overrides: {
      bookingId: string;
      bookingGuestId: string;
      roomId: string;
      bedId: string;
      stayDate: string;
    }) => ({
      id: `${overrides.bookingGuestId}:${overrides.stayDate}`,
      guestName: "Guest",
      guestAgeTier: "ADULT" as const,
      roomName: overrides.roomId,
      bedName: overrides.bedId,
      source: "MANUAL" as const,
      approvedAt: null,
      approvedByName: null,
      bookingStatus: "CONFIRMED",
      holdsCapacity: true,
      ...overrides,
    });

    const warnings = buildBedAllocationWarnings({
      allocations: [
        // booking-switch: room A night 1, room B night 2 → ROOM_SWITCH.
        allocation({
          bookingId: "booking-switch",
          bookingGuestId: "guest-1",
          roomId: "room-a",
          bedId: "bed-a1",
          stayDate: "2026-07-01",
        }),
        allocation({
          bookingId: "booking-switch",
          bookingGuestId: "guest-1",
          roomId: "room-b",
          bedId: "bed-b1",
          stayDate: "2026-07-02",
        }),
        // booking-stable: same room both nights → no ROOM_SWITCH.
        allocation({
          bookingId: "booking-stable",
          bookingGuestId: "guest-2",
          roomId: "room-a",
          bedId: "bed-a2",
          stayDate: "2026-07-01",
        }),
        allocation({
          bookingId: "booking-stable",
          bookingGuestId: "guest-2",
          roomId: "room-a",
          bedId: "bed-a2",
          stayDate: "2026-07-02",
        }),
      ],
    });

    const roomSwitchWarnings = warnings.filter(
      (warning) => warning.type === "ROOM_SWITCH",
    );
    expect(roomSwitchWarnings).toHaveLength(1);
    expect(roomSwitchWarnings[0]).toMatchObject({
      id: "ROOM_SWITCH:booking-switch",
      bookingId: "booking-switch",
      stayDate: "2026-07-02",
    });
    // No same-night split here, so BOOKING_SPLIT stays quiet.
    expect(
      warnings.filter((warning) => warning.type === "BOOKING_SPLIT"),
    ).toHaveLength(0);
  });

  it("keeps bed allocation routes feature gated", () => {
    const featureRoutes = readRepoFile("src/config/feature-routes.ts");
    const sidebar = readRepoFile("src/components/admin-sidebar.tsx");
    const bookingsSetupHub = readRepoFile(
      "src/app/(admin)/admin/bookings-setup/page.tsx"
    );

    expect(featureRoutes).toContain('flag: "bedAllocation"');
    expect(featureRoutes).toContain('"/admin/bed-allocation"');
    expect(featureRoutes).toContain('"/admin/rooms-beds"');
    expect(featureRoutes).toContain('"/api/admin/bed-allocation"');
    expect(sidebar).toContain('href: "/admin/bed-allocation"');
    expect(bookingsSetupHub).toContain('href: "/admin/rooms-beds"');
  });

  it("blocks deactivating a bed with future allocations", async () => {
    const update = vi.fn();
    const db = {
      bedAllocation: {
        findMany: vi.fn().mockResolvedValue([
          { stayDate: parseDateOnly("2026-07-01") },
          { stayDate: parseDateOnly("2026-07-03") },
        ]),
      },
      lodgeBed: {
        update,
      },
    };

    await expect(
      updateBedAllocationBed({
        id: "bed-1",
        active: false,
        db: db as never,
      }),
    ).rejects.toThrow(
      "Cannot deactivate this bed while future allocations exist on 2026-07-01, 2026-07-03.",
    );
    expect(update).not.toHaveBeenCalled();
  });

  it("adds persistent admin-only mode settings", () => {
    const schema = readRepoFile("prisma/schema.prisma");
    const migration = readRepoFile(
      "prisma/migrations/20260607142000_add_bed_allocation_settings/migration.sql",
    );

    expect(schema).toContain("model BedAllocationSettings");
    expect(schema).toMatch(/autoAllocationEnabled\s+Boolean/);
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS "BedAllocationSettings"');
    expect(migration).toContain(
      'INSERT INTO "BedAllocationSettings" ("id")',
    );
  });
});

describe("manuallyAllocateBedForNights", () => {
  function buildGuest(overrides: Partial<{
    id: string;
    bookingId: string;
    stayStart: Date;
    stayEnd: Date;
    bookingStatus: string;
    bookingDeletedAt: Date | null;
    memberId: string | null;
  }> = {}) {
    return {
      id: overrides.id ?? "guest-1",
      bookingId: overrides.bookingId ?? "booking-1",
      stayStart: overrides.stayStart ?? parseDateOnly("2026-07-01"),
      stayEnd: overrides.stayEnd ?? parseDateOnly("2026-07-04"),
      memberId: overrides.memberId ?? null,
      booking: {
        id: overrides.bookingId ?? "booking-1",
        status: overrides.bookingStatus ?? "CONFIRMED",
        deletedAt: overrides.bookingDeletedAt ?? null,
      },
    };
  }

  function buildBed(overrides: Partial<{
    id: string;
    roomId: string;
    active: boolean;
    roomActive: boolean;
    bedType: string;
  }> = {}) {
    return {
      id: overrides.id ?? "bed-1",
      roomId: overrides.roomId ?? "room-1",
      active: overrides.active ?? true,
      bedType: overrides.bedType ?? "SINGLE",
      room: { id: overrides.roomId ?? "room-1", active: overrides.roomActive ?? true },
    };
  }

  function buildDb(input: {
    guest: ReturnType<typeof buildGuest> | null;
    bed: ReturnType<typeof buildBed> | null;
    upsert: ReturnType<typeof vi.fn>;
    existingOccupants?: ReturnType<typeof vi.fn>;
    // #1750 move-path orphan promotion seams.
    previous?: ReturnType<typeof vi.fn>;
    partner?: ReturnType<typeof vi.fn>;
    update?: ReturnType<typeof vi.fn>;
    members?: Array<{
      id: string;
      ageTier: string;
      active: boolean;
    }>;
    partnerLinks?: Array<{
      memberAId: string;
      memberBId: string;
      status: string;
    }>;
  }) {
    return {
      bookingGuest: {
        findUnique: vi.fn().mockResolvedValue(input.guest),
      },
      lodgeBed: {
        findUnique: vi.fn().mockResolvedValue(input.bed),
      },
      // #2286: allocateBedNight refuses a custodian-held bed-night. No holds in
      // these cases, so every assertion below reads as it did before.
      hutLeaderAssignment: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      // #2286: the self-wrapped placement transaction takes the per-lodge
      // advisory lock as its first statement.
      $executeRaw: vi.fn().mockResolvedValue(1),
      // #1701/#1744: mayShareDoubleBed() resolves both members' age tier and
      // looks up the pair's partner link; findMany filters the seeded members
      // by the queried ids, findUnique matches a seeded link by the canonical
      // pair.
      member: {
        findMany: vi.fn(async (args: { where: { id: { in: string[] } } }) =>
          (input.members ?? []).filter((member) =>
            args.where.id.in.includes(member.id),
          ),
        ),
      },
      memberPartnerLink: {
        findUnique: vi.fn(
          async (args: {
            where: {
              memberAId_memberBId: { memberAId: string; memberBId: string };
            };
          }) => {
            const pair = args.where.memberAId_memberBId;
            return (
              (input.partnerLinks ?? []).find(
                (partnerLink) =>
                  partnerLink.memberAId === pair.memberAId &&
                  partnerLink.memberBId === pair.memberBId,
              ) ?? null
            );
          },
        ),
      },
      bedAllocation: {
        // #1701: resolveSecondOccupant checks the target bed-night's existing
        // occupants; default to empty (a free bed-night → primary allocation).
        findMany: input.existingOccupants ?? vi.fn().mockResolvedValue([]),
        // #1750: allocateBedNight reads the guest's pre-move row (null = fresh
        // CREATE, so no old bed-night to repair) and the orphan-promote helper
        // looks up + flips a surviving partner. Defaults leave promotion inert.
        findUnique: input.previous ?? vi.fn().mockResolvedValue(null),
        findFirst: input.partner ?? vi.fn().mockResolvedValue(null),
        update: input.update ?? vi.fn(),
        upsert: input.upsert,
      },
    };
  }

  it("allocates every requested night to the same bed", async () => {
    const upsert = vi.fn().mockImplementation(({ create }) => ({
      id: `allocation-${create.stayDate.toISOString().slice(0, 10)}`,
      ...create,
    }));
    const db = buildDb({ guest: buildGuest(), bed: buildBed(), upsert });

    const result = await manuallyAllocateBedForNights({
      bookingGuestId: "guest-1",
      bedId: "bed-1",
      stayDates: ["2026-07-02", "2026-07-01", "2026-07-03"],
      db: db as never,
    });

    expect(result.conflicts).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.allocations).toHaveLength(3);
    expect(upsert).toHaveBeenCalledTimes(3);
    // Processed in date order despite unsorted input.
    expect(upsert.mock.calls.map((call) => call[0].create.stayDate)).toEqual([
      parseDateOnly("2026-07-01"),
      parseDateOnly("2026-07-02"),
      parseDateOnly("2026-07-03"),
    ]);
  });

  it("reports a conflict for nights where the bed is already taken, without aborting other nights", async () => {
    const conflictError = new Prisma.PrismaClientKnownRequestError(
      "Unique constraint failed",
      { code: "P2002", clientVersion: "test" },
    );
    const upsert = vi
      .fn()
      .mockResolvedValueOnce({ id: "allocation-1", stayDate: parseDateOnly("2026-07-01") })
      .mockRejectedValueOnce(conflictError)
      .mockResolvedValueOnce({ id: "allocation-3", stayDate: parseDateOnly("2026-07-03") });
    const db = buildDb({ guest: buildGuest(), bed: buildBed(), upsert });

    const result = await manuallyAllocateBedForNights({
      bookingGuestId: "guest-1",
      bedId: "bed-1",
      stayDates: ["2026-07-01", "2026-07-02", "2026-07-03"],
      db: db as never,
    });

    expect(result.allocations).toHaveLength(2);
    expect(result.conflicts).toEqual([{ stayDate: "2026-07-02", reason: "BED_TAKEN" }]);
    expect(result.skipped).toEqual([]);
  });

  it("skips nights outside the guest's stay without treating them as conflicts", async () => {
    const upsert = vi.fn().mockImplementation(({ create }) => ({
      id: "allocation",
      ...create,
    }));
    // Guest only stays 2026-07-01 to 2026-07-03 (2 nights).
    const db = buildDb({
      guest: buildGuest({ stayStart: parseDateOnly("2026-07-01"), stayEnd: parseDateOnly("2026-07-03") }),
      bed: buildBed(),
      upsert,
    });

    const result = await manuallyAllocateBedForNights({
      bookingGuestId: "guest-1",
      bedId: "bed-1",
      stayDates: ["2026-07-01", "2026-07-02", "2026-07-03"],
      db: db as never,
    });

    expect(result.allocations).toHaveLength(2);
    expect(result.skipped).toEqual(["2026-07-03"]);
    expect(result.conflicts).toEqual([]);
  });

  it("rejects an empty stay date list", async () => {
    const db = buildDb({ guest: buildGuest(), bed: buildBed(), upsert: vi.fn() });

    await expect(
      manuallyAllocateBedForNights({
        bookingGuestId: "guest-1",
        bedId: "bed-1",
        stayDates: [],
        db: db as never,
      }),
    ).rejects.toThrow(BedAllocationAdminError);
  });

  it("rejects more nights than the allocation range cap", async () => {
    const db = buildDb({ guest: buildGuest(), bed: buildBed(), upsert: vi.fn() });
    const stayDates = Array.from({ length: MAX_BED_ALLOCATION_RANGE_NIGHTS + 1 }, (_, index) =>
      `2026-${String(Math.floor(index / 28) + 1).padStart(2, "0")}-${String((index % 28) + 1).padStart(2, "0")}`,
    );

    await expect(
      manuallyAllocateBedForNights({
        bookingGuestId: "guest-1",
        bedId: "bed-1",
        stayDates,
        db: db as never,
      }),
    ).rejects.toThrow(`Cannot allocate more than ${MAX_BED_ALLOCATION_RANGE_NIGHTS} nights at once`);
  });

  it("rejects when the guest does not exist", async () => {
    const db = buildDb({ guest: null, bed: buildBed(), upsert: vi.fn() });

    await expect(
      manuallyAllocateBedForNights({
        bookingGuestId: "missing-guest",
        bedId: "bed-1",
        stayDates: ["2026-07-01"],
        db: db as never,
      }),
    ).rejects.toThrow("Guest not found");
  });

  it("rejects when the bed is inactive", async () => {
    const db = buildDb({ guest: buildGuest(), bed: buildBed({ active: false }), upsert: vi.fn() });

    await expect(
      manuallyAllocateBedForNights({
        bookingGuestId: "guest-1",
        bedId: "bed-1",
        stayDates: ["2026-07-01"],
        db: db as never,
      }),
    ).rejects.toThrow("Active bed not found");
  });

  it("rejects when the booking status is not allocatable", async () => {
    const db = buildDb({
      guest: buildGuest({ bookingStatus: "CANCELLED" }),
      bed: buildBed(),
      upsert: vi.fn(),
    });

    await expect(
      manuallyAllocateBedForNights({
        bookingGuestId: "guest-1",
        bedId: "bed-1",
        stayDates: ["2026-07-01"],
        db: db as never,
      }),
    ).rejects.toThrow("Booking status is not allocatable");
  });

  // #1701 double-bed shared occupancy (#1744: eligibility = CONFIRMED partner link).
  const adultMember = (id: string) => ({ id, ageTier: "ADULT", active: true });

  // Seed a link the way the service stores it: as the canonical ordered pair.
  const confirmedPartners = (memberOneId: string, memberTwoId: string) => [
    { ...canonicalPartnerPair(memberOneId, memberTwoId), status: "CONFIRMED" },
  ];

  function primaryOccupant(overrides: Partial<{
    isSecondOccupant: boolean;
    memberId: string | null;
    bookingStatus: string;
  }> = {}) {
    return {
      isSecondOccupant: overrides.isSecondOccupant ?? false,
      bookingGuest: {
        memberId: overrides.memberId ?? "m-primary",
        booking: { status: overrides.bookingStatus ?? "CONFIRMED" },
      },
    };
  }

  it("places the primary's confirmed partner as a second occupant on a double", async () => {
    const upsert = vi.fn().mockImplementation(({ create }) => ({ id: "alloc", ...create }));
    const db = buildDb({
      guest: buildGuest({ id: "guest-2", memberId: "m-new" }),
      bed: buildBed({ bedType: "DOUBLE" }),
      upsert,
      existingOccupants: vi.fn().mockResolvedValue([primaryOccupant()]),
      members: [adultMember("m-primary"), adultMember("m-new")],
      partnerLinks: confirmedPartners("m-primary", "m-new"),
    });

    const result = await manuallyAllocateBedForNights({
      bookingGuestId: "guest-2",
      bedId: "bed-1",
      stayDates: ["2026-07-02"],
      db: db as never,
    });

    expect(result.conflicts).toEqual([]);
    expect(result.allocations).toHaveLength(1);
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ isSecondOccupant: true, bedType: "DOUBLE" }),
      }),
    );
  });

  it("rejects a second occupant on a non-double bed (conflict, not sharing)", async () => {
    const upsert = vi.fn();
    const db = buildDb({
      guest: buildGuest({ id: "guest-2", memberId: "m-new" }),
      bed: buildBed({ bedType: "SINGLE" }),
      upsert,
      existingOccupants: vi.fn().mockResolvedValue([primaryOccupant()]),
      members: [adultMember("m-primary"), adultMember("m-new")],
      partnerLinks: confirmedPartners("m-primary", "m-new"),
    });

    const result = await manuallyAllocateBedForNights({
      bookingGuestId: "guest-2",
      bedId: "bed-1",
      stayDates: ["2026-07-02"],
      db: db as never,
    });

    expect(result.allocations).toEqual([]);
    expect(result.conflicts).toEqual([{ stayDate: "2026-07-02", reason: "BED_TAKEN" }]);
    expect(upsert).not.toHaveBeenCalled();
  });

  it("rejects a second occupant without a confirmed partner link (family-group co-membership is not enough)", async () => {
    const db = buildDb({
      guest: buildGuest({ id: "guest-2", memberId: "m-new" }),
      bed: buildBed({ bedType: "DOUBLE" }),
      upsert: vi.fn(),
      existingOccupants: vi.fn().mockResolvedValue([primaryOccupant()]),
      members: [adultMember("m-primary"), adultMember("m-new")],
    });

    const result = await manuallyAllocateBedForNights({
      bookingGuestId: "guest-2",
      bedId: "bed-1",
      stayDates: ["2026-07-02"],
      db: db as never,
    });

    expect(result.conflicts).toEqual([{ stayDate: "2026-07-02", reason: "BED_TAKEN" }]);
  });

  it("rejects a second occupant when the primary booking is not capacity-holding (displacement pin)", async () => {
    const db = buildDb({
      guest: buildGuest({ id: "guest-2", memberId: "m-new" }),
      bed: buildBed({ bedType: "DOUBLE" }),
      upsert: vi.fn(),
      // PENDING is bed-allocatable but not capacity-holding, so the primary is
      // not pinned from displacement — pairing must be refused.
      existingOccupants: vi.fn().mockResolvedValue([primaryOccupant({ bookingStatus: "PENDING" })]),
      members: [adultMember("m-primary"), adultMember("m-new")],
      partnerLinks: confirmedPartners("m-primary", "m-new"),
    });

    const result = await manuallyAllocateBedForNights({
      bookingGuestId: "guest-2",
      bedId: "bed-1",
      stayDates: ["2026-07-02"],
      db: db as never,
    });

    expect(result.conflicts).toEqual([{ stayDate: "2026-07-02", reason: "BED_TAKEN" }]);
  });

  it("rejects a third occupant when the double already has two", async () => {
    const db = buildDb({
      guest: buildGuest({ id: "guest-3", memberId: "m-third" }),
      bed: buildBed({ bedType: "DOUBLE" }),
      upsert: vi.fn(),
      existingOccupants: vi
        .fn()
        .mockResolvedValue([primaryOccupant(), primaryOccupant({ isSecondOccupant: true, memberId: "m-new" })]),
      members: [adultMember("m-primary"), adultMember("m-third")],
      partnerLinks: confirmedPartners("m-primary", "m-third"),
    });

    const result = await manuallyAllocateBedForNights({
      bookingGuestId: "guest-3",
      bedId: "bed-1",
      stayDates: ["2026-07-02"],
      db: db as never,
    });

    expect(result.conflicts).toEqual([{ stayDate: "2026-07-02", reason: "BED_TAKEN" }]);
  });

  // #1750 move-path orphan promotion.
  it("promotes the partner stranded on the old bed when a shared double's primary moves to another bed", async () => {
    const upsert = vi.fn().mockImplementation(({ create }) => ({ id: "alloc", ...create }));
    const db = buildDb({
      guest: buildGuest(),
      bed: buildBed({ id: "new-bed", roomId: "room-2" }),
      upsert,
      // The guest was the PRIMARY on the old bed on this night.
      previous: vi
        .fn()
        .mockResolvedValue({ bedId: "old-bed", isSecondOccupant: false }),
      // A surviving partner (a DIFFERENT booking) sits on the old bed-night.
      partner: vi.fn().mockResolvedValue({
        id: "alloc-partner",
        bookingId: "booking-2",
        bedId: "old-bed",
        stayDate: parseDateOnly("2026-07-02"),
        isSecondOccupant: true,
        bedType: "DOUBLE",
      }),
      update: vi.fn().mockImplementation(({ where, data }) => ({
        id: where.id,
        bookingId: "booking-2",
        ...data,
      })),
    });

    const result = await manuallyAllocateBedForNights({
      bookingGuestId: "guest-1",
      bedId: "new-bed",
      stayDates: ["2026-07-02"],
      db: db as never,
    });

    expect(result.allocations).toHaveLength(1);
    // Promotion is pinned to the OLD bed-night, not the new one.
    expect(db.bedAllocation.findFirst).toHaveBeenCalledWith({
      where: {
        bedId: "old-bed",
        stayDate: parseDateOnly("2026-07-02"),
        isSecondOccupant: true,
      },
    });
    expect(db.bedAllocation.update).toHaveBeenCalledWith({
      where: { id: "alloc-partner" },
      data: { isSecondOccupant: false },
    });
    expect(result.promotedPartners).toHaveLength(1);
    expect(result.promotedPartners[0]).toMatchObject({
      id: "alloc-partner",
      isSecondOccupant: false,
    });
  });

  it("does not promote when the moved row was itself a second occupant", async () => {
    const upsert = vi.fn().mockImplementation(({ create }) => ({ id: "alloc", ...create }));
    const db = buildDb({
      guest: buildGuest(),
      bed: buildBed({ id: "new-bed", roomId: "room-2" }),
      upsert,
      // Moving a second occupant leaves the old bed's primary in place.
      previous: vi
        .fn()
        .mockResolvedValue({ bedId: "old-bed", isSecondOccupant: true }),
      partner: vi.fn(),
      update: vi.fn(),
    });

    const result = await manuallyAllocateBedForNights({
      bookingGuestId: "guest-1",
      bedId: "new-bed",
      stayDates: ["2026-07-02"],
      db: db as never,
    });

    expect(result.allocations).toHaveLength(1);
    expect(db.bedAllocation.findFirst).not.toHaveBeenCalled();
    expect(db.bedAllocation.update).not.toHaveBeenCalled();
    expect(result.promotedPartners).toEqual([]);
  });

  it("does not promote on a same-bed re-upsert (bed unchanged)", async () => {
    const upsert = vi.fn().mockImplementation(({ create }) => ({ id: "alloc", ...create }));
    const db = buildDb({
      guest: buildGuest(),
      bed: buildBed({ id: "bed-1" }),
      upsert,
      // Re-upserting onto the SAME bed never vacates an old bed-night.
      previous: vi
        .fn()
        .mockResolvedValue({ bedId: "bed-1", isSecondOccupant: false }),
      partner: vi.fn(),
      update: vi.fn(),
    });

    const result = await manuallyAllocateBedForNights({
      bookingGuestId: "guest-1",
      bedId: "bed-1",
      stayDates: ["2026-07-02"],
      db: db as never,
    });

    expect(result.allocations).toHaveLength(1);
    expect(db.bedAllocation.findFirst).not.toHaveBeenCalled();
    expect(db.bedAllocation.update).not.toHaveBeenCalled();
    expect(result.promotedPartners).toEqual([]);
  });

  // #1750 move-path atomicity: manuallyAllocateBed (single night) self-wraps the
  // pre-move read + upsert + partner promotion so a moved primary can't strand
  // its partner between writes. Asserted on the tx client because every other
  // move-path test injects `db` and so never enters the self-wrap branch.
  it("self-wraps the move + promotion in one transaction when no db is injected (single path)", async () => {
    // The mocked prisma singleton is otherwise `{}` (see the #1675 self-wrap
    // suite): a path that skipped the wrap and reached for prisma.bedAllocation
    // would throw here rather than silently pass.
    const prismaMock = prisma as unknown as { $transaction?: unknown };
    const upsert = vi
      .fn()
      .mockImplementation(({ create }) => ({ id: "alloc", ...create }));
    const tx = buildDb({
      guest: buildGuest(),
      bed: buildBed({ id: "new-bed", roomId: "room-2" }),
      upsert,
      // The guest was the PRIMARY on the old bed on this night.
      previous: vi
        .fn()
        .mockResolvedValue({ bedId: "old-bed", isSecondOccupant: false }),
      // A surviving partner (a DIFFERENT booking) sits on the old bed-night.
      partner: vi.fn().mockResolvedValue({
        id: "alloc-partner",
        bookingId: "booking-2",
        bedId: "old-bed",
        stayDate: parseDateOnly("2026-07-02"),
        isSecondOccupant: true,
        bedType: "DOUBLE",
      }),
      update: vi.fn().mockImplementation(({ where, data }) => ({
        id: where.id,
        bookingId: "booking-2",
        ...data,
      })),
    });
    const txnMock = vi.fn(async (cb: (client: typeof tx) => unknown) => cb(tx));
    prismaMock.$transaction = txnMock;
    try {
      const result = await manuallyAllocateBed({
        bookingGuestId: "guest-1",
        bedId: "new-bed",
        stayDate: "2026-07-02",
      });

      expect(txnMock).toHaveBeenCalledTimes(1);
      // The move (upsert) AND the promotion (findFirst + update) all ran on the
      // tx client — inside the wrap, not on the bare prisma singleton. The
      // promotion is pinned to the OLD bed-night.
      expect(tx.bedAllocation.upsert).toHaveBeenCalledTimes(1);
      expect(tx.bedAllocation.findFirst).toHaveBeenCalledWith({
        where: {
          bedId: "old-bed",
          stayDate: parseDateOnly("2026-07-02"),
          isSecondOccupant: true,
        },
      });
      expect(tx.bedAllocation.update).toHaveBeenCalledWith({
        where: { id: "alloc-partner" },
        data: { isSecondOccupant: false },
      });
      expect(result.promotedPartner).toMatchObject({
        id: "alloc-partner",
        isSecondOccupant: false,
      });
    } finally {
      delete prismaMock.$transaction;
    }
  });

  // #1750 bulk atomicity: manuallyAllocateBedForNights self-wraps EACH night's
  // read + upsert + promotion in its OWN transaction (not one outer wrap), so a
  // late night's rollback never undoes a committed earlier night. Every bulk test
  // above injects `db` and so never enters the per-night self-wrap branch.
  it("self-wraps each night's move + promotion in its own transaction when no db is injected (bulk path)", async () => {
    // The pre-loop guest/bed assertion reads the bare prisma singleton; each
    // night's write + promotion must then run inside its own $transaction on the
    // tx client, never on the singleton (whose bedAllocation is undefined).
    const prismaMock = prisma as unknown as {
      $transaction?: unknown;
      bookingGuest?: unknown;
      lodgeBed?: unknown;
    };
    const guest = buildGuest();
    const bed = buildBed({ id: "new-bed", roomId: "room-2" });
    const upsert = vi
      .fn()
      .mockImplementation(({ create }) => ({ id: "alloc", ...create }));
    const tx = buildDb({
      guest,
      bed,
      upsert,
      previous: vi
        .fn()
        .mockResolvedValue({ bedId: "old-bed", isSecondOccupant: false }),
      partner: vi.fn().mockResolvedValue({
        id: "alloc-partner",
        bookingId: "booking-2",
        bedId: "old-bed",
        stayDate: parseDateOnly("2026-07-02"),
        isSecondOccupant: true,
        bedType: "DOUBLE",
      }),
      update: vi.fn().mockImplementation(({ where, data }) => ({
        id: where.id,
        bookingId: "booking-2",
        ...data,
      })),
    });
    prismaMock.bookingGuest = { findUnique: vi.fn().mockResolvedValue(guest) };
    prismaMock.lodgeBed = { findUnique: vi.fn().mockResolvedValue(bed) };
    const txnMock = vi.fn(async (cb: (client: typeof tx) => unknown) => cb(tx));
    prismaMock.$transaction = txnMock;
    try {
      const result = await manuallyAllocateBedForNightsPublic({
        bookingGuestId: "guest-1",
        bedId: "new-bed",
        stayDates: ["2026-07-02", "2026-07-03"],
      });

      // One transaction PER NIGHT — the per-night self-wrap, not a single outer
      // wrap around the whole loop.
      expect(txnMock).toHaveBeenCalledTimes(2);
      // Every night's upsert + promotion (findFirst + update) ran on the tx
      // client, inside the wrap.
      expect(tx.bedAllocation.upsert).toHaveBeenCalledTimes(2);
      expect(tx.bedAllocation.findFirst).toHaveBeenCalledTimes(2);
      expect(tx.bedAllocation.update).toHaveBeenCalledTimes(2);
      expect(result.promotedPartners).toHaveLength(2);
    } finally {
      delete prismaMock.$transaction;
      delete prismaMock.bookingGuest;
      delete prismaMock.lodgeBed;
    }
  });
});

describe("same-date allocation moves (#2366)", () => {
  function sourceRow(
    overrides: Partial<{
      id: string;
      bedId: string;
      stayDate: Date;
    }> = {},
  ) {
    return {
      id: overrides.id ?? "allocation-1",
      bookingId: "booking-1",
      bookingGuestId: "guest-1",
      roomId: "room-1",
      bedId: overrides.bedId ?? "bed-1",
      stayDate: overrides.stayDate ?? parseDateOnly("2026-07-01"),
      source: "AUTO",
      approvedAt: parseDateOnly("2026-06-01"),
      approvedByMemberId: "admin-old",
      isSecondOccupant: false,
      bedType: "SINGLE",
    };
  }

  function buildMoveTx(input: {
    sources: ReturnType<typeof sourceRow>[];
    destinationBedId?: string;
    targetOccupants?: (stayDate: Date) => unknown[];
    custodianHolds?: unknown[];
    promotedPartner?: ReturnType<typeof sourceRow> | null;
  }) {
    const destinationBedId = input.destinationBedId ?? "bed-2";
    const findMany = vi.fn(
      async (args: {
        where: {
          id?: { in: string[] };
          stayDate?: Date;
        };
      }) => {
        if (args.where.id) {
          return input.sources.filter((row) =>
            args.where.id!.in.includes(row.id),
          );
        }
        return input.targetOccupants?.(args.where.stayDate!) ?? [];
      },
    );
    const upsert = vi.fn(
      async (args: {
        where: {
          bookingGuestId_stayDate: {
            bookingGuestId: string;
            stayDate: Date;
          };
        };
        update: Record<string, unknown>;
      }) => {
        const source = input.sources.find(
          (row) =>
            row.bookingGuestId ===
              args.where.bookingGuestId_stayDate.bookingGuestId &&
            row.stayDate.getTime() ===
              args.where.bookingGuestId_stayDate.stayDate.getTime(),
        )!;
        return {
          ...source,
          ...args.update,
          roomId: "room-2",
          bedId: destinationBedId,
          stayDate: source.stayDate,
        };
      },
    );
    const update = vi.fn(
      async ({ data }: { data: Record<string, unknown> }) => ({
        ...input.promotedPartner,
        ...data,
      }),
    );

    return {
      $executeRaw: vi.fn().mockResolvedValue(1),
      bookingGuest: {
        findUnique: vi.fn().mockResolvedValue({
          id: "guest-1",
          bookingId: "booking-1",
          memberId: null,
          consentStatus: null,
          stayStart: parseDateOnly("2026-07-01"),
          stayEnd: parseDateOnly("2026-07-04"),
          nights: input.sources.map((row) => ({ stayDate: row.stayDate })),
          booking: {
            id: "booking-1",
            status: "CONFIRMED",
            deletedAt: null,
            wholeLodgeHold: false,
            lodgeId: "lodge-1",
          },
        }),
      },
      lodgeBed: {
        findUnique: vi.fn().mockResolvedValue({
          id: destinationBedId,
          roomId: "room-2",
          active: true,
          bedType: "SINGLE",
          room: { id: "room-2", lodgeId: "lodge-1", active: true },
        }),
      },
      hutLeaderAssignment: {
        findMany: vi.fn().mockResolvedValue(input.custodianHolds ?? []),
      },
      member: { findMany: vi.fn().mockResolvedValue([]) },
      memberPartnerLink: { findUnique: vi.fn().mockResolvedValue(null) },
      bedAllocation: {
        findMany,
        findUnique: vi.fn(
          async (args: {
            where: {
              bookingGuestId_stayDate: {
                bookingGuestId: string;
                stayDate: Date;
              };
            };
          }) =>
            input.sources.find(
              (row) =>
                row.bookingGuestId ===
                  args.where.bookingGuestId_stayDate.bookingGuestId &&
                row.stayDate.getTime() ===
                  args.where.bookingGuestId_stayDate.stayDate.getTime(),
            ) ?? null,
        ),
        findFirst: vi.fn().mockResolvedValue(input.promotedPartner ?? null),
        update,
        upsert,
      },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
    };
  }

  async function withMoveTransaction<T>(
    tx: ReturnType<typeof buildMoveTx>,
    run: () => Promise<T>,
  ) {
    const prismaMock = prisma as unknown as {
      $transaction?: unknown;
      lodgeBed: { findUnique: ReturnType<typeof vi.fn> };
    };
    const originalLodgeBed = prismaMock.lodgeBed;
    prismaMock.lodgeBed = {
      findUnique: vi.fn().mockResolvedValue({ room: { lodgeId: "lodge-1" } }),
    };
    prismaMock.$transaction = vi.fn(
      async (callback: (client: typeof tx) => Promise<T>) => callback(tx),
    );
    try {
      return await run();
    } finally {
      delete prismaMock.$transaction;
      prismaMock.lodgeBed = originalLodgeBed;
    }
  }

  it("takes global then destination-lodge locks before re-reading and keeps the persisted original night", async () => {
    const tx = buildMoveTx({ sources: [sourceRow()] });

    const result = await withMoveTransaction(tx, () =>
      moveBedAllocationsSameDate({
        allocationIds: ["allocation-1"],
        bedId: "bed-2",
        actorMemberId: "admin-1",
      }),
    );

    expect(result.noop).toBe(false);
    expect(tx.$executeRaw).toHaveBeenCalledTimes(2);
    expect(tx.$executeRaw.mock.invocationCallOrder[1]).toBeLessThan(
      tx.bedAllocation.findMany.mock.invocationCallOrder[0],
    );
    expect(tx.bedAllocation.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          bookingGuestId_stayDate: {
            bookingGuestId: "guest-1",
            stayDate: parseDateOnly("2026-07-01"),
          },
        },
      }),
    );
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
  });

  it("is a server-side no-op with no write or audit when the normalized bed/date is unchanged", async () => {
    const tx = buildMoveTx({
      sources: [sourceRow({ bedId: "bed-1" })],
      destinationBedId: "bed-1",
    });

    const result = await withMoveTransaction(tx, () =>
      moveBedAllocationsSameDate({
        allocationIds: ["allocation-1"],
        bedId: "bed-1",
        actorMemberId: "admin-1",
      }),
    );

    expect(result).toEqual({
      allocations: [],
      promotedPartners: [],
      noop: true,
    });
    expect(tx.bedAllocation.upsert).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it("rolls an existing-allocation bulk move back as one conflict and writes no audit", async () => {
    const sources = [
      sourceRow(),
      sourceRow({
        id: "allocation-2",
        stayDate: parseDateOnly("2026-07-02"),
      }),
    ];
    const tx = buildMoveTx({
      sources,
      targetOccupants: (stayDate) =>
        stayDate.getTime() === parseDateOnly("2026-07-02").getTime()
          ? [
              {
                isSecondOccupant: false,
                bookingGuest: {
                  memberId: null,
                  booking: { status: "CONFIRMED" },
                },
              },
            ]
          : [],
    });

    await expect(
      withMoveTransaction(tx, () =>
        moveBedAllocationsSameDate({
          allocationIds: ["allocation-1", "allocation-2"],
          bedId: "bed-2",
          actorMemberId: "admin-1",
        }),
      ),
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("No allocations were moved"),
    });
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it("commits shared-double promotion and both audit rows in the move transaction", async () => {
    const partner = {
      ...sourceRow({ id: "allocation-partner", bedId: "bed-1" }),
      bookingId: "booking-2",
      bookingGuestId: "guest-2",
      isSecondOccupant: true,
      bedType: "DOUBLE",
    };
    const tx = buildMoveTx({
      sources: [
        {
          ...sourceRow({ bedId: "bed-1" }),
          isSecondOccupant: false,
          bedType: "DOUBLE",
        },
      ],
      promotedPartner: partner,
    });

    const result = await withMoveTransaction(tx, () =>
      moveBedAllocationsSameDate({
        allocationIds: ["allocation-1"],
        bedId: "bed-2",
        actorMemberId: "admin-1",
      }),
    );

    expect(result.promotedPartners).toHaveLength(1);
    expect(tx.bedAllocation.update).toHaveBeenCalledWith({
      where: { id: "allocation-partner" },
      data: { isSecondOccupant: false },
    });
    expect(tx.auditLog.create).toHaveBeenCalledTimes(2);
    expect(tx.auditLog.create).toHaveBeenLastCalledWith({
      data: expect.objectContaining({
        action: "BED_ALLOCATION_PARTNER_PROMOTED",
        targetId: "booking-2",
        metadata: expect.objectContaining({
          allocationId: "allocation-partner",
          bookingGuestId: "guest-2",
          movedAllocationId: "allocation-1",
          movedBookingId: "booking-1",
          movedBookingGuestId: "guest-1",
        }),
      }),
    });
  });

  it("keeps the custodian guard inside the locked move transaction and audits nothing on refusal", async () => {
    const tx = buildMoveTx({
      sources: [sourceRow()],
      custodianHolds: [
        {
          id: "assignment-1",
          memberId: "custodian-1",
          lodgeId: "lodge-1",
          bedId: "bed-2",
          startDate: parseDateOnly("2026-07-01"),
          endDate: parseDateOnly("2026-07-01"),
          member: {
            firstName: "Casey",
            lastName: "Custodian",
            ageTier: "ADULT",
          },
          bed: {
            id: "bed-2",
            name: "Bed Two",
            roomId: "room-2",
            room: { id: "room-2", name: "Room Two" },
          },
        },
      ],
    });

    await expect(
      withMoveTransaction(tx, () =>
        moveBedAllocationsSameDate({
          allocationIds: ["allocation-1"],
          bedId: "bed-2",
          actorMemberId: "admin-1",
        }),
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });
});

describe("bed type + bunk pairing (#1675)", () => {
  function buildBunkDb(
    overrides: {
      groupMembers?: Array<{
        id: string;
        bedType: string;
        // name/active are optional so the many pre-existing seeds (which omit
        // them) still typecheck; the deactivated-blocker tests set both.
        active?: boolean;
        name?: string;
      }>;
      existingBed?: {
        roomId: string;
        bedType: string;
        bunkGroup: string | null;
      } | null;
      // #1701: mock for bedAllocation.count (shared second-occupant rows on the
      // bed) so the DOUBLE→non-DOUBLE retype guard can be exercised.
      sharedOccupantCount?: ReturnType<typeof vi.fn>;
    } = {},
  ) {
    const create = vi
      .fn()
      .mockImplementation(({ data }) => ({ id: "new-bed", ...data }));
    const update = vi
      .fn()
      .mockImplementation(({ data }) => ({ id: "bed-1", ...data }));
    const findMany = vi
      .fn()
      .mockResolvedValue(overrides.groupMembers ?? []);
    const findUnique = vi
      .fn()
      .mockResolvedValue(overrides.existingBed ?? null);
    // The room-row lock is a tagged-template $executeRaw (#2289: it exists
    // only for the lock, so it returns an affected-row count and is never
    // read); a plain mock suffices.
    const executeRaw = vi.fn().mockResolvedValue(1);
    return {
      db: {
        $executeRaw: executeRaw,
        lodgeBed: { create, update, findMany, findUnique },
        bedAllocation: {
          findMany: vi.fn().mockResolvedValue([]),
          // #1701: a bedType change syncs the denormalized copy and (from a
          // DOUBLE) checks for shared second-occupant rows first.
          count: overrides.sharedOccupantCount ?? vi.fn().mockResolvedValue(0),
          updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
      },
      create,
      update,
      findMany,
      findUnique,
      executeRaw,
    };
  }

  it("creates each bed type; ungrouped beds skip the room lock", async () => {
    for (const bedType of ["SINGLE", "DOUBLE", "BUNK_TOP", "BUNK_BOTTOM"] as const) {
      const { db, create, findMany, executeRaw } = buildBunkDb();
      const bed = await createBedAllocationBed({
        roomId: "room-1",
        name: "Bed",
        bedType,
        db: db as never,
      });
      expect(bed).toMatchObject({ bedType, bunkGroup: null });
      // No bunkGroup => no membership check and no serialising lock.
      expect(findMany).not.toHaveBeenCalled();
      expect(executeRaw).not.toHaveBeenCalled();
      expect(create).toHaveBeenCalledWith({
        data: expect.objectContaining({ bedType, bunkGroup: null }),
      });
    }
  });

  it("pairs a bunk-bottom into a group that already holds a bunk-top", async () => {
    const { db, create, findMany, executeRaw } = buildBunkDb({
      groupMembers: [{ id: "top", bedType: "BUNK_TOP" }],
    });

    await createBedAllocationBed({
      roomId: "room-1",
      name: "Lower",
      bedType: "BUNK_BOTTOM",
      bunkGroup: "Bunk A",
      db: db as never,
    });

    // Serialised under the room lock, scoped to this room + group.
    expect(executeRaw).toHaveBeenCalledTimes(1);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          roomId: "room-1",
          bunkGroup: "Bunk A",
        }),
      }),
    );
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        bedType: "BUNK_BOTTOM",
        bunkGroup: "Bunk A",
      }),
    });
  });

  it("rejects a third bed in a bunk group", async () => {
    const { db, create } = buildBunkDb({
      groupMembers: [
        { id: "top", bedType: "BUNK_TOP" },
        { id: "bottom", bedType: "BUNK_BOTTOM" },
      ],
    });

    await expect(
      createBedAllocationBed({
        roomId: "room-1",
        name: "Extra",
        bedType: "BUNK_TOP",
        bunkGroup: "Bunk A",
        db: db as never,
      }),
    ).rejects.toThrow('Bunk group "Bunk A" already has two beds');
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects two tops in the same group", async () => {
    const { db, create } = buildBunkDb({
      groupMembers: [{ id: "top", bedType: "BUNK_TOP" }],
    });

    await expect(
      createBedAllocationBed({
        roomId: "room-1",
        name: "Another top",
        bedType: "BUNK_TOP",
        bunkGroup: "Bunk A",
        db: db as never,
      }),
    ).rejects.toThrow('already has a bunk-top bed');
    expect(create).not.toHaveBeenCalled();
  });

  it("keeps the active-blocker wording unchanged (no deactivation steer)", async () => {
    // Pins the exact ACTIVE-partner wording so a refactor can't silently alter
    // it. This alone does NOT discriminate `active === false` from `!active`
    // (with active:true both take the active path); the undefined-active test
    // below is the real discriminator for that.
    const { db, create } = buildBunkDb({
      groupMembers: [
        { id: "top", bedType: "BUNK_TOP", active: true, name: "Upper" },
      ],
    });

    await expect(
      createBedAllocationBed({
        roomId: "room-1",
        name: "Another top",
        bedType: "BUNK_TOP",
        bunkGroup: "Bunk A",
        db: db as never,
      }),
    ).rejects.toMatchObject({
      message:
        'Bunk group "Bunk A" already has a bunk-top bed. Pair a top with a bottom.',
      status: 409,
    });
    expect(create).not.toHaveBeenCalled();
  });

  it("treats a partner with an unknown active flag as active (discriminates === false from !active)", async () => {
    // The seed omits `active` (undefined). The production column is always a
    // boolean, but a `!active` regression treats undefined as deactivated and
    // would name an "undefined" bed here — the exact active-path pin fails in
    // that case, so this is the test that actually locks `active === false`.
    const { db, create } = buildBunkDb({
      groupMembers: [{ id: "top", bedType: "BUNK_TOP", name: "Upper" }],
    });

    await expect(
      createBedAllocationBed({
        roomId: "room-1",
        name: "Another top",
        bedType: "BUNK_TOP",
        bunkGroup: "Bunk A",
        db: db as never,
      }),
    ).rejects.toMatchObject({
      message:
        'Bunk group "Bunk A" already has a bunk-top bed. Pair a top with a bottom.',
      status: 409,
    });
    expect(create).not.toHaveBeenCalled();
  });

  it("names the deactivated bed that holds the requested bunk type", async () => {
    // The blocking partner is inactive: it still counts toward the group
    // (membership unchanged), but the steer names it so the admin sees why the
    // slot is taken and can reactivate or delete it.
    const { db, create } = buildBunkDb({
      groupMembers: [
        { id: "top", bedType: "BUNK_TOP", active: false, name: "Old Top" },
      ],
    });

    await expect(
      createBedAllocationBed({
        roomId: "room-1",
        name: "New top",
        bedType: "BUNK_TOP",
        bunkGroup: "Bunk A",
        db: db as never,
      }),
    ).rejects.toMatchObject({
      message:
        'Bunk group "Bunk A" already has a bunk-top bed — the deactivated bed "Old Top". Reactivate or delete it, or use another group.',
      status: 409,
    });
    expect(create).not.toHaveBeenCalled();
  });

  it("names a full group's deactivated OPPOSITE-type bed but steers only to another group", async () => {
    // Group = active top + deactivated bottom; admin adds another top.
    // Reactivating/deleting the bottom can never admit a second top, so the
    // steer must NOT offer that — name the deactivated bed, point elsewhere.
    const { db, create } = buildBunkDb({
      groupMembers: [
        { id: "top", bedType: "BUNK_TOP", active: true, name: "Upper" },
        {
          id: "bottom",
          bedType: "BUNK_BOTTOM",
          active: false,
          name: "Old Bottom",
        },
      ],
    });

    await expect(
      createBedAllocationBed({
        roomId: "room-1",
        name: "Third bunk",
        bedType: "BUNK_TOP",
        bunkGroup: "Bunk A",
        db: db as never,
      }),
    ).rejects.toMatchObject({
      message:
        'Bunk group "Bunk A" already has two beds, including the deactivated bed "Old Bottom". Use another group.',
      status: 409,
    });
    expect(create).not.toHaveBeenCalled();
  });

  it("offers reactivate/delete on a full group only for the SAME-type deactivated bed", async () => {
    // Group = active bottom + deactivated top; admin adds a top. Deleting the
    // deactivated top frees the top slot for the incoming bed, so the steer is
    // accurate and names that bed.
    const { db, create } = buildBunkDb({
      groupMembers: [
        { id: "bottom", bedType: "BUNK_BOTTOM", active: true, name: "Lower" },
        { id: "top", bedType: "BUNK_TOP", active: false, name: "Old Top" },
      ],
    });

    await expect(
      createBedAllocationBed({
        roomId: "room-1",
        name: "Fresh top",
        bedType: "BUNK_TOP",
        bunkGroup: "Bunk A",
        db: db as never,
      }),
    ).rejects.toMatchObject({
      message:
        'Bunk group "Bunk A" already has two beds, including the deactivated bed "Old Top". Reactivate or delete it, or use another group.',
      status: 409,
    });
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects a bunk group on a non-bunk bed type", async () => {
    const { db, create, findMany } = buildBunkDb();

    await expect(
      createBedAllocationBed({
        roomId: "room-1",
        name: "Single with group",
        bedType: "SINGLE",
        bunkGroup: "Bunk A",
        db: db as never,
      }),
    ).rejects.toMatchObject({
      message: "A bunk group needs a bunk-top or bunk-bottom bed type.",
      status: 400,
    });
    // Consistency is checked before any DB work.
    expect(findMany).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("allows an unpaired bunk (bunk type, no group) without a soft error", async () => {
    const { db, create, findMany } = buildBunkDb();

    await createBedAllocationBed({
      roomId: "room-1",
      name: "Lonely bunk",
      bedType: "BUNK_TOP",
      bunkGroup: null,
      db: db as never,
    });

    expect(findMany).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({ bedType: "BUNK_TOP", bunkGroup: null }),
    });
  });

  it("isolates groups by room — same group name in another room does not clash", async () => {
    // findMany is scoped to the requested room, so a full "Bunk A" in room-1
    // is invisible when adding "Bunk A" in room-2.
    const { db, create, findMany } = buildBunkDb({ groupMembers: [] });

    await createBedAllocationBed({
      roomId: "room-2",
      name: "New bunk",
      bedType: "BUNK_TOP",
      bunkGroup: "Bunk A",
      db: db as never,
    });

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ roomId: "room-2", bunkGroup: "Bunk A" }),
      }),
    );
    expect(create).toHaveBeenCalled();
  });

  it("re-validates pairing on update and excludes the bed being edited", async () => {
    const { db, update, findMany, findUnique } = buildBunkDb({
      existingBed: { roomId: "room-1", bedType: "SINGLE", bunkGroup: null },
      groupMembers: [{ id: "top", bedType: "BUNK_TOP" }],
    });

    await updateBedAllocationBed({
      id: "bed-1",
      bedType: "BUNK_BOTTOM",
      bunkGroup: "Bunk A",
      db: db as never,
    });

    expect(findUnique).toHaveBeenCalled();
    // The edited bed must not conflict with itself in the membership check.
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          roomId: "room-1",
          bunkGroup: "Bunk A",
          id: { not: "bed-1" },
        }),
      }),
    );
    expect(update).toHaveBeenCalledWith({
      where: { id: "bed-1" },
      data: expect.objectContaining({
        bedType: "BUNK_BOTTOM",
        bunkGroup: "Bunk A",
      }),
    });
  });

  it("rejects an update that leaves a group on a non-bunk type", async () => {
    // Existing single bed; caller adds a group but keeps the single type.
    const { db, update } = buildBunkDb({
      existingBed: { roomId: "room-1", bedType: "SINGLE", bunkGroup: null },
    });

    await expect(
      updateBedAllocationBed({
        id: "bed-1",
        bunkGroup: "Bunk A",
        db: db as never,
      }),
    ).rejects.toThrow(
      "A bunk group needs a bunk-top or bunk-bottom bed type.",
    );
    expect(update).not.toHaveBeenCalled();
  });

  it("clears a group when updating with an empty bunkGroup string", async () => {
    const { db, update, findMany } = buildBunkDb({
      existingBed: {
        roomId: "room-1",
        bedType: "BUNK_TOP",
        bunkGroup: "Bunk A",
      },
    });

    await updateBedAllocationBed({
      id: "bed-1",
      bunkGroup: "   ",
      db: db as never,
    });

    // No group => no membership check; the column is nulled.
    expect(findMany).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith({
      where: { id: "bed-1" },
      data: expect.objectContaining({ bunkGroup: null }),
    });
  });

  it("re-validates under the stored group when a bedType-only update omits bunkGroup", async () => {
    // A PATCH that changes only the bedType (no bunkGroup key) must layer the
    // change over the bed's *stored* group, not treat the group as null — so it
    // still takes the room lock and runs the membership check against "Bunk A".
    // If the existing.bunkGroup fallback regressed to null, nextBunkGroup would
    // be null and neither the lock nor findMany would run, failing this test.
    const { db, update, findMany, executeRaw } = buildBunkDb({
      existingBed: { roomId: "room-1", bedType: "BUNK_TOP", bunkGroup: "Bunk A" },
      // The bed being edited is excluded from the membership query, so an empty
      // result means "no other bed in this group yet".
      groupMembers: [],
    });

    await updateBedAllocationBed({
      id: "bed-1",
      bedType: "BUNK_BOTTOM",
      db: db as never,
    });

    expect(executeRaw).toHaveBeenCalledTimes(1);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          roomId: "room-1",
          bunkGroup: "Bunk A",
          id: { not: "bed-1" },
        }),
      }),
    );
    // bunkGroup was not in the patch, so the column is left untouched.
    expect(update).toHaveBeenCalledWith({
      where: { id: "bed-1" },
      data: expect.objectContaining({ bedType: "BUNK_BOTTOM" }),
    });
    expect(update.mock.calls[0][0].data.bunkGroup).toBeUndefined();
  });

  // #1701: retyping a bed keeps the denormalized BedAllocation.bedType in sync,
  // and a DOUBLE that currently shares (has a second occupant) cannot be retyped
  // to a non-double until the second occupant is removed.
  it("blocks changing a shared double to a non-double bed type", async () => {
    const { db, update } = buildBunkDb({
      existingBed: { roomId: "room-1", bedType: "DOUBLE", bunkGroup: null },
      sharedOccupantCount: vi.fn().mockResolvedValue(1),
    });

    await expect(
      updateBedAllocationBed({ id: "bed-1", bedType: "SINGLE", db: db as never }),
    ).rejects.toThrow("shared (two-occupant)");
    expect(update).not.toHaveBeenCalled();
  });

  it("retypes a double with no shared occupant and syncs the denormalized bedType", async () => {
    const { db, update } = buildBunkDb({
      existingBed: { roomId: "room-1", bedType: "DOUBLE", bunkGroup: null },
    });

    await updateBedAllocationBed({ id: "bed-1", bedType: "SINGLE", db: db as never });

    expect(update).toHaveBeenCalledWith({
      where: { id: "bed-1" },
      data: expect.objectContaining({ bedType: "SINGLE" }),
    });
    const bedAllocation = (db as unknown as {
      bedAllocation: { updateMany: ReturnType<typeof vi.fn> };
    }).bedAllocation;
    expect(bedAllocation.updateMany).toHaveBeenCalledWith({
      where: { bedId: "bed-1" },
      data: { bedType: "SINGLE" },
    });
  });
});

describe("bunk write transaction self-wrap (#1675)", () => {
  // These exercise the branches that self-wrap in prisma.$transaction when no
  // db is injected — the room-row FOR UPDATE lock is only a real serialisation
  // point inside a transaction, so dropping the wrap (leaving the lock as a
  // statement-scoped no-op) must fail a test. The mocked prisma singleton is
  // otherwise `{}`, so any path that skips the wrap and reaches for
  // prisma.lodgeBed would throw here rather than silently pass.
  const prismaMock = prisma as unknown as {
    $transaction?: unknown;
    lodgeBed?: unknown;
  };

  it("self-wraps a grouped create and runs the lock, membership check, and write on the tx client", async () => {
    const tx = {
      $executeRaw: vi.fn().mockResolvedValue(1),
      lodgeBed: {
        findMany: vi.fn().mockResolvedValue([{ id: "top", bedType: "BUNK_TOP" }]),
        create: vi
          .fn()
          .mockImplementation(({ data }) => ({ id: "new-bed", ...data })),
      },
    };
    const txnMock = vi.fn(async (cb: (client: typeof tx) => unknown) => cb(tx));
    prismaMock.$transaction = txnMock;
    try {
      await createBedAllocationBed({
        roomId: "room-1",
        name: "Lower",
        bedType: "BUNK_BOTTOM",
        bunkGroup: "Bunk A",
      });

      expect(txnMock).toHaveBeenCalledTimes(1);
      // Lock, membership check, and write all ran on the tx client.
      expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
      expect(tx.lodgeBed.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            roomId: "room-1",
            bunkGroup: "Bunk A",
          }),
        }),
      );
      expect(tx.lodgeBed.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          bedType: "BUNK_BOTTOM",
          bunkGroup: "Bunk A",
        }),
      });
    } finally {
      delete prismaMock.$transaction;
    }
  });

  it("self-wraps a bunk-affecting update and runs the lock, membership check, and write on the tx client", async () => {
    const tx = {
      $executeRaw: vi.fn().mockResolvedValue(1),
      lodgeBed: {
        findUnique: vi
          .fn()
          .mockResolvedValueOnce({ room: { lodgeId: "lodge-1" } })
          .mockResolvedValue({ roomId: "room-1", bedType: "SINGLE", bunkGroup: null }),
        findMany: vi.fn().mockResolvedValue([]),
        update: vi
          .fn()
          .mockImplementation(({ data }) => ({ id: "bed-1", ...data })),
      },
      // #1701: the bedType change syncs the denormalized BedAllocation.bedType.
      bedAllocation: {
        count: vi.fn().mockResolvedValue(0),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
    };
    const txnMock = vi.fn(async (cb: (client: typeof tx) => unknown) => cb(tx));
    prismaMock.$transaction = txnMock;
    try {
      await updateBedAllocationBedPublic({
        id: "bed-1",
        bedType: "BUNK_TOP",
        bunkGroup: "Bunk A",
      });

      expect(txnMock).toHaveBeenCalledTimes(1);
      // Public ownership: global, owning lodge, then the grouped-bed room lock.
      expect(tx.$executeRaw).toHaveBeenCalledTimes(3);
      expect(tx.lodgeBed.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            roomId: "room-1",
            bunkGroup: "Bunk A",
            id: { not: "bed-1" },
          }),
        }),
      );
      expect(tx.lodgeBed.update).toHaveBeenCalledWith({
        where: { id: "bed-1" },
        data: expect.objectContaining({
          bedType: "BUNK_TOP",
          bunkGroup: "Bunk A",
        }),
      });
    } finally {
      delete prismaMock.$transaction;
    }
  });

  it("does NOT open a transaction for an ungrouped create without a db", async () => {
    // No bunkGroup => nothing to serialise, so the create runs directly on the
    // prisma singleton and never touches $transaction.
    const create = vi
      .fn()
      .mockImplementation(({ data }) => ({ id: "new-bed", ...data }));
    const txnMock = vi.fn();
    prismaMock.$transaction = txnMock;
    prismaMock.lodgeBed = { create };
    try {
      await createBedAllocationBed({
        roomId: "room-1",
        name: "Solo",
        bedType: "SINGLE",
      });

      expect(txnMock).not.toHaveBeenCalled();
      expect(create).toHaveBeenCalledWith({
        data: expect.objectContaining({ bedType: "SINGLE", bunkGroup: null }),
      });
    } finally {
      delete prismaMock.$transaction;
      delete prismaMock.lodgeBed;
    }
  });

  it("self-wraps even a name-only update so the public writer owns global then lodge", async () => {
    const update = vi
      .fn()
      .mockImplementation(({ data }) => ({ id: "bed-1", ...data }));
    const tx = {
      $executeRaw: vi.fn().mockResolvedValue(1),
      lodgeBed: {
        findUnique: vi.fn().mockResolvedValue({ room: { lodgeId: "lodge-1" } }),
        update,
      },
    };
    const txnMock = vi.fn(async (cb: (client: typeof tx) => unknown) => cb(tx));
    prismaMock.$transaction = txnMock;
    try {
      await updateBedAllocationBedPublic({ id: "bed-1", name: "Renamed" });

      expect(txnMock).toHaveBeenCalledOnce();
      expect(tx.$executeRaw).toHaveBeenCalledTimes(2);
      expect(update).toHaveBeenCalledWith({
        where: { id: "bed-1" },
        data: { name: "Renamed" },
      });
    } finally {
      delete prismaMock.$transaction;
    }
  });
});

describe("multi-lodge room scoping (phase 7)", () => {
  it("filters rooms strictly to a lodge", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const db = { lodgeRoom: { findMany } };

    await listBedAllocationRooms(db as never, "lodge-2");

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { lodgeId: "lodge-2" },
      }),
    );
  });

  it("lists every room when no lodge filter is given", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const db = { lodgeRoom: { findMany } };

    await listBedAllocationRooms(db as never);

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: undefined }),
    );
  });

  it("creates rooms at the requested lodge without consulting the default", async () => {
    const create = vi.fn().mockResolvedValue({ id: "room-1" });
    const findFirst = vi.fn();
    const db = {
      // Per-lodge name pre-check: no clash in these fixtures.
      lodgeRoom: { create, findFirst: vi.fn().mockResolvedValue(null) },
      lodge: { findFirst },
    };

    await withPrismaRoomDb(db, () =>
      createBedAllocationRoom({
        name: "Bunkroom 1",
        lodgeId: "lodge-2",
      }),
    );

    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({ lodgeId: "lodge-2" }),
    });
    expect(findFirst).not.toHaveBeenCalled();
  });

  it("stamps the default lodge when no lodge is requested", async () => {
    const create = vi.fn().mockResolvedValue({ id: "room-1" });
    const findFirst = vi.fn().mockResolvedValue({ id: "lodge-default" });
    const db = {
      lodgeRoom: { create, findFirst: vi.fn().mockResolvedValue(null) },
      lodge: { findFirst },
    };

    await withPrismaRoomDb(db, () =>
      createBedAllocationRoom({ name: "Bunkroom 1" }),
    );

    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({ lodgeId: "lodge-default" }),
    });
  });

  it("reports capacity for the requested lodge and keeps the import offer global", async () => {
    const db = {
      lodgeRoom: {
        findMany: vi.fn().mockResolvedValue([]),
        count: vi.fn().mockResolvedValue(3),
      },
      lodgeBed: {
        count: vi.fn().mockResolvedValue(12),
      },
      lodge: { findFirst: vi.fn() },
    };

    const payload = await getRoomsAndBedsConfiguration(db as never, "lodge-2");

    expect(getLodgePartnerSharedCapacityStatus).toHaveBeenCalledWith("lodge-2", db);
    // The card reads the headroom straight off this payload (#1745).
    expect(payload.capacity.partnerSharedHeadroom).toBe(0);
    expect(payload.capacity.activeDoubleBedCount).toBe(0);
    // Rooms exist elsewhere in the club, so the empty selected lodge must
    // not offer the config import (it only seeds the first lodge).
    expect(payload.canImportFromConfig).toBe(false);
    expect(db.lodge.findFirst).not.toHaveBeenCalled();
  });
});

describe("createBedAllocationRoomsBulk (ADR-003 bulk seeding)", () => {
  function buildBulkDb(overrides: {
    clashName?: string | null;
    existingRoomCount?: number;
  } = {}) {
    const roomCreate = vi
      .fn()
      .mockImplementation(({ data }) =>
        Promise.resolve({ id: `room-${data.name}`, ...data }),
      );
    const bedCreateMany = vi.fn().mockResolvedValue({ count: 0 });
    return {
      db: {
        lodgeRoom: {
          create: roomCreate,
          count: vi.fn().mockResolvedValue(overrides.existingRoomCount ?? 0),
          findFirst: vi
            .fn()
            .mockResolvedValue(
              overrides.clashName ? { name: overrides.clashName } : null,
            ),
        },
        lodgeBed: { createMany: bedCreateMany },
        lodge: { findFirst: vi.fn().mockResolvedValue({ id: "lodge-1" }) },
      },
      roomCreate,
      bedCreateMany,
    };
  }

  it("creates N rooms of M beds with sequential names at the given lodge", async () => {
    const { db, roomCreate, bedCreateMany } = buildBulkDb();

    const result = await createBedAllocationRoomsBulk({
      roomCount: 3,
      bedsPerRoom: 4,
      lodgeId: "lodge-2",
      db: db as never,
    });

    expect(result).toEqual({ createdRoomCount: 3, createdBedCount: 12 });
    expect(roomCreate).toHaveBeenCalledTimes(3);
    expect(roomCreate).toHaveBeenNthCalledWith(1, {
      data: expect.objectContaining({
        name: "Room 1",
        sortOrder: 1,
        lodgeId: "lodge-2",
      }),
    });
    expect(bedCreateMany).toHaveBeenCalledTimes(3);
    expect(bedCreateMany.mock.calls[0][0].data).toHaveLength(4);
    expect(bedCreateMany.mock.calls[0][0].data[0]).toEqual(
      expect.objectContaining({ name: "Bed 1", sortOrder: 1, active: true }),
    );
  });

  it("continues sort order after the lodge's existing rooms and honours the prefix", async () => {
    const { db, roomCreate } = buildBulkDb({ existingRoomCount: 5 });

    await createBedAllocationRoomsBulk({
      roomCount: 1,
      bedsPerRoom: 0,
      namePrefix: "Bunkroom",
      lodgeId: "lodge-2",
      db: db as never,
    });

    expect(roomCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ name: "Bunkroom 1", sortOrder: 6 }),
    });
  });

  it("rejects the whole batch when a generated name already exists", async () => {
    const { db, roomCreate } = buildBulkDb({ clashName: "Room 2" });

    await expect(
      createBedAllocationRoomsBulk({
        roomCount: 3,
        bedsPerRoom: 2,
        lodgeId: "lodge-2",
        db: db as never,
      }),
    ).rejects.toThrow('A room named "Room 2" already exists');
    expect(roomCreate).not.toHaveBeenCalled();
  });

  it("allows the same room name at a different lodge", async () => {
    const create = vi.fn().mockResolvedValue({ id: "room-1" });
    // The pre-check runs strictly against the lodge's own partition — a
    // "Room 1" at another lodge must not match.
    const roomFindFirst = vi.fn(async ({ where }: { where: { lodgeId?: unknown } }) => {
      expect(where).toMatchObject({
        name: "Room 1",
        lodgeId: "lodge-2",
      });
      return null;
    });
    const db = { lodgeRoom: { create, findFirst: roomFindFirst }, lodge: { findFirst: vi.fn() } };

    await withPrismaRoomDb(db, () =>
      createBedAllocationRoom({
        name: "Room 1",
        lodgeId: "lodge-2",
      }),
    );

    expect(roomFindFirst).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalled();
  });

  it("rejects a duplicate room name within the same lodge", async () => {
    const create = vi.fn();
    const db = {
      lodgeRoom: {
        create,
        findFirst: vi.fn().mockResolvedValue({ id: "existing" }),
      },
      lodge: { findFirst: vi.fn() },
    };

    await expect(
      withPrismaRoomDb(db, () =>
        createBedAllocationRoom({
          name: "Room 1",
          lodgeId: "lodge-2",
        }),
      ),
    ).rejects.toThrow('A room named "Room 1" already exists at this lodge.');
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects out-of-range counts", async () => {
    const { db } = buildBulkDb();

    await expect(
      createBedAllocationRoomsBulk({
        roomCount: 0,
        bedsPerRoom: 2,
        lodgeId: "lodge-2",
        db: db as never,
      }),
    ).rejects.toThrow("Room count must be between");
    await expect(
      createBedAllocationRoomsBulk({
        roomCount: 1,
        bedsPerRoom: 99,
        lodgeId: "lodge-2",
        db: db as never,
      }),
    ).rejects.toThrow("Beds per room must be between");
  });
});

describe("bed allocation board lodge scope (ADR-003)", () => {
  function buildDashboardDb() {
    const bookingFindMany = vi.fn().mockResolvedValue([]);
    const allocationFindMany = vi.fn().mockResolvedValue([]);
    const roomFindMany = vi.fn().mockResolvedValue([]);
    return {
      db: {
        bedAllocationSettings: {
          findUnique: vi.fn().mockResolvedValue({
            autoAllocationEnabled: false,
            allocationPriorityOrder: [...BED_ALLOCATION_PRIORITY_VOCABULARY],
            updatedByMemberId: null,
            updatedAt: parseDateOnly("2026-07-01"),
          }),
        },
        lodgeRoom: { findMany: roomFindMany },
        booking: { findMany: bookingFindMany },
        bedAllocation: { findMany: allocationFindMany },
        // #2286: the board loads custodian bed holds for its range. None here.
        hutLeaderAssignment: { findMany: vi.fn().mockResolvedValue([]) },
      },
      bookingFindMany,
      allocationFindMany,
      roomFindMany,
    };
  }

  const range = parseBedAllocationDateRange({
    from: "2026-07-01",
    to: "2026-07-08",
  });

  it("scopes rooms, bookings, and allocations strictly to the lodge", async () => {
    const { db, bookingFindMany, allocationFindMany, roomFindMany } =
      buildDashboardDb();

    await getBedAllocationDashboard({ range, lodgeId: "lodge-2", db: db as never });

    expect(roomFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { lodgeId: "lodge-2" },
      }),
    );
    expect(bookingFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          lodgeId: "lodge-2",
        }),
      }),
    );
    expect(allocationFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          room: { lodgeId: "lodge-2" },
        }),
      }),
    );
  });

  it("stays club-wide when no lodge is given", async () => {
    const { db, bookingFindMany, allocationFindMany, roomFindMany } =
      buildDashboardDb();

    await getBedAllocationDashboard({ range, db: db as never });

    expect(roomFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: undefined }),
    );
    expect(bookingFindMany.mock.calls[0][0].where.OR).toBeUndefined();
    expect(allocationFindMany.mock.calls[0][0].where.room).toBeUndefined();
  });

  it("scopes range approval to the lodge's rooms", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 2 });
    const db = { bedAllocation: { updateMany } };

    await approveBedAllocations({
      approvedByMemberId: "admin-1",
      range,
      lodgeId: "lodge-2",
      db: db as never,
    });

    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          room: { lodgeId: "lodge-2" },
        }),
      }),
    );
  });

  it("rejects allocating a guest to another lodge's bed", async () => {
    const upsert = vi.fn();
    const db = {
      bookingGuest: {
        findUnique: vi.fn().mockResolvedValue({
          id: "guest-1",
          bookingId: "booking-1",
          stayStart: parseDateOnly("2026-07-01"),
          stayEnd: parseDateOnly("2026-07-04"),
          booking: {
            id: "booking-1",
            status: "CONFIRMED",
            deletedAt: null,
            lodgeId: "lodge-1",
          },
        }),
      },
      lodgeBed: {
        findUnique: vi.fn().mockResolvedValue({
          id: "bed-1",
          roomId: "room-1",
          active: true,
          room: { id: "room-1", active: true, lodgeId: "lodge-2" },
        }),
      },
      bedAllocation: { upsert },
    };

    await expect(
      manuallyAllocateBedForNights({
        bookingGuestId: "guest-1",
        bedId: "bed-1",
        stayDates: ["2026-07-01"],
        db: db as never,
      }),
    ).rejects.toThrow("Bed belongs to a different lodge than the booking");
    expect(upsert).not.toHaveBeenCalled();
  });
});

describe("getBedAllocationDashboard school-group threading (#1768)", () => {
  it("suggests teachers together and students separately for a SCHOOL-request booking", async () => {
    const range = parseBedAllocationDateRange({
      from: "2026-07-01",
      to: "2026-07-02",
    });
    const room = (id: string, sortOrder: number) => ({
      id,
      name: `Room ${id}`,
      sortOrder,
      active: true,
      notes: null,
      lodgeId: null,
      beds: [1, 2, 3, 4].map((n) => ({
        id: `bed-${id}-${n}`,
        roomId: id,
        name: `${id}${n}`,
        sortOrder: n,
        active: true,
        bedType: "SINGLE",
        bunkGroup: null,
      })),
    });
    const guest = (id: string, ageTier: string) => ({
      id,
      bookingId: "booking-school",
      firstName: id,
      lastName: "Test",
      ageTier,
      stayStart: parseDateOnly("2026-07-01"),
      stayEnd: parseDateOnly("2026-07-02"),
      nights: [{ stayDate: parseDateOnly("2026-07-01") }],
      member: null,
    });
    const db = {
      bedAllocationSettings: {
        findUnique: vi.fn().mockResolvedValue({
          autoAllocationEnabled: true,
          allocationPriorityOrder: [...BED_ALLOCATION_PRIORITY_VOCABULARY],
          updatedByMemberId: null,
          updatedAt: parseDateOnly("2026-06-30"),
        }),
      },
      lodgeRoom: {
        findMany: vi.fn().mockResolvedValue([room("ra", 1), room("rb", 2)]),
      },
      // #2286: the board loads custodian bed holds for its range. None here.
      hutLeaderAssignment: { findMany: vi.fn().mockResolvedValue([]) },
      booking: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "booking-school",
            status: "PAID",
            createdAt: new Date("2026-06-01T00:00:00.000Z"),
            checkIn: parseDateOnly("2026-07-01"),
            checkOut: parseDateOnly("2026-07-02"),
            lodgeId: null,
            requestedRoomId: null,
            parentBookingId: null,
            originBookingRequest: { id: "req-1", type: "SCHOOL" },
            heldForBookingRequest: null,
            requestedRoom: null,
            member: { firstName: "Org", lastName: "Contact", email: "s@x.nz" },
            guests: [
              guest("teacher-1", "ADULT"),
              guest("teacher-2", "ADULT"),
              guest("student-1", "YOUTH"),
              guest("student-2", "YOUTH"),
              guest("student-3", "CHILD"),
            ],
          },
        ]),
      },
      bedAllocation: { findMany: vi.fn().mockResolvedValue([]) },
    };

    const dashboard = await getBedAllocationDashboard({
      range,
      db: db as never,
    });

    const teacherRooms = new Set(
      dashboard.suggestedAllocations
        .filter((a) => a.bookingGuestId.startsWith("teacher-"))
        .map((a) => a.roomId),
    );
    const studentRooms = new Set(
      dashboard.suggestedAllocations
        .filter((a) => a.bookingGuestId.startsWith("student-"))
        .map((a) => a.roomId),
    );
    expect(dashboard.suggestedAllocations).toHaveLength(5);
    expect(dashboard.suggestedUnallocatedGuestNights).toEqual([]);
    expect(teacherRooms.size).toBe(1);
    for (const roomId of studentRooms) {
      expect(teacherRooms.has(roomId)).toBe(false);
    }
  });

  it("uses off-screen allocation rows for continuity without returning them", async () => {
    const range = parseBedAllocationDateRange({
      from: "2026-07-02",
      to: "2026-07-03",
    });
    const room = (id: string, sortOrder: number) => ({
      id,
      name: `Room ${id}`,
      sortOrder,
      active: true,
      notes: null,
      lodgeId: null,
      beds: [
        {
          id: `bed-${id}`,
          roomId: id,
          name: `Bed ${id}`,
          sortOrder: 1,
          active: true,
          bedType: "SINGLE",
          bunkGroup: null,
        },
      ],
    });
    const guest = {
      id: "guest-1",
      bookingId: "booking-1",
      firstName: "Guest",
      lastName: "One",
      ageTier: "ADULT",
      stayStart: parseDateOnly("2026-07-01"),
      stayEnd: parseDateOnly("2026-07-03"),
      nights: [{ stayDate: parseDateOnly("2026-07-02") }],
      member: null,
    };
    const booking = {
      id: "booking-1",
      status: "PAID",
      createdAt: new Date("2026-06-01T00:00:00.000Z"),
      checkIn: parseDateOnly("2026-07-01"),
      checkOut: parseDateOnly("2026-07-03"),
      lodgeId: null,
      requestedRoomId: null,
      parentBookingId: null,
      originBookingRequest: null,
      heldForBookingRequest: null,
      adminCapacityHoldAt: null,
      wholeLodgeHold: false,
      requestedRoom: null,
      member: { firstName: "Member", lastName: "One", email: "m@example.nz" },
      guests: [guest],
    };
    const contextAllocation = {
      id: "allocation-before-window",
      bookingId: booking.id,
      bookingGuestId: guest.id,
      roomId: "rb",
      bedId: "bed-rb",
      stayDate: parseDateOnly("2026-07-01"),
      source: "AUTO",
      approvedAt: null,
      approvedBy: null,
      isSecondOccupant: false,
      booking: {
        status: "PAID",
        originBookingRequest: null,
        adminCapacityHoldAt: null,
      },
      bookingGuest: {
        id: guest.id,
        bookingId: booking.id,
        firstName: guest.firstName,
        lastName: guest.lastName,
        ageTier: guest.ageTier,
        member: null,
      },
      room: { id: "rb", name: "Room rb" },
      bed: { id: "bed-rb", name: "Bed rb" },
    };
    const allocationFindMany = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([contextAllocation]);
    const db = {
      bedAllocationSettings: {
        findUnique: vi.fn().mockResolvedValue({
          id: "default",
          lodgeId: null,
          autoAllocationEnabled: true,
          allocationPriorityOrder: ["STAY_CONTINUITY"],
          updatedByMemberId: null,
          updatedAt: parseDateOnly("2026-06-30"),
        }),
      },
      lodgeRoom: {
        findMany: vi.fn().mockResolvedValue([room("ra", 1), room("rb", 2)]),
      },
      hutLeaderAssignment: { findMany: vi.fn().mockResolvedValue([]) },
      booking: { findMany: vi.fn().mockResolvedValue([booking]) },
      bedAllocation: { findMany: allocationFindMany },
    };

    const dashboard = await getBedAllocationDashboard({
      range,
      db: db as never,
    });

    expect(allocationFindMany).toHaveBeenCalledTimes(2);
    expect(dashboard.allocations).toEqual([]);
    expect(dashboard.suggestedAllocations).toEqual([
      expect.objectContaining({
        bookingGuestId: "guest-1",
        stayDate: "2026-07-02",
        roomId: "rb",
        bedId: "bed-rb",
      }),
    ]);
  });
});

describe("getBedAllocationDashboard focused booking (#1302)", () => {
  function buildDashboardDb(overrides: {
    bookingFindMany?: unknown[];
    focusedBooking?: {
      id: string;
      checkIn: Date;
      checkOut: Date;
    } | null;
  }) {
    const findFirst = vi
      .fn()
      .mockResolvedValue(overrides.focusedBooking ?? null);
    return {
      db: {
        bedAllocationSettings: { findUnique: vi.fn().mockResolvedValue(null) },
        lodgeRoom: { findMany: vi.fn().mockResolvedValue([]) },
        bedAllocation: { findMany: vi.fn().mockResolvedValue([]) },
        // #2286: the board loads custodian bed holds for its range. None here.
        hutLeaderAssignment: { findMany: vi.fn().mockResolvedValue([]) },
        booking: {
          findMany: vi
            .fn()
            .mockResolvedValue(overrides.bookingFindMany ?? []),
          findFirst,
        },
      },
      findFirst,
    };
  }

  const range = {
    from: parseDateOnly("2026-07-01"),
    to: parseDateOnly("2026-07-08"),
    fromDate: "2026-07-01",
    toDate: "2026-07-08",
  };

  it("returns the stay window when the focused booking is out of range", async () => {
    const { db, findFirst } = buildDashboardDb({
      focusedBooking: {
        id: "booking-past",
        checkIn: new Date("2026-06-10"),
        checkOut: new Date("2026-06-12"),
      },
    });

    const dashboard = await getBedAllocationDashboard({
      range,
      bookingId: "booking-past",
      db: db as never,
    });

    expect(findFirst).toHaveBeenCalledTimes(1);
    expect(dashboard.focusedBooking).toEqual({
      id: "booking-past",
      checkIn: "2026-06-10",
      checkOut: "2026-06-12",
    });
  });

  it("skips the lookup and returns null when the focused booking is already in range", async () => {
    const { db, findFirst } = buildDashboardDb({
      bookingFindMany: [
        {
          id: "booking-in-range",
          status: "CONFIRMED",
          createdAt: new Date("2026-06-01"),
          checkIn: new Date("2026-07-02"),
          checkOut: new Date("2026-07-04"),
          requestedRoomId: null,
          parentBookingId: null,
          originBookingRequest: null,
          requestedRoom: null,
          member: { firstName: "Ada", lastName: "Lovelace", email: null },
          guests: [],
        },
      ],
    });

    const dashboard = await getBedAllocationDashboard({
      range,
      bookingId: "booking-in-range",
      db: db as never,
    });

    expect(findFirst).not.toHaveBeenCalled();
    expect(dashboard.focusedBooking).toBeNull();
  });

  it("returns null when the focused booking is not an allocatable booking", async () => {
    const { db } = buildDashboardDb({ focusedBooking: null });

    const dashboard = await getBedAllocationDashboard({
      range,
      bookingId: "booking-cancelled",
      db: db as never,
    });

    expect(dashboard.focusedBooking).toBeNull();
  });

  it("returns null when no booking is focused", async () => {
    const { db, findFirst } = buildDashboardDb({});

    const dashboard = await getBedAllocationDashboard({
      range,
      db: db as never,
    });

    expect(findFirst).not.toHaveBeenCalled();
    expect(dashboard.focusedBooking).toBeNull();
  });
});

describe("deleteBedAllocationRoom (#1674 guarded hard delete)", () => {
  function buildDeleteDb(overrides: {
    room?: { id: string; lodgeId?: string } | null;
    allocation?: { id: string } | null;
    deleteRejects?: unknown;
  } = {}) {
    const roomFindFirst = vi
      .fn()
      .mockResolvedValue(
        overrides.room === undefined ? { id: "room-1" } : overrides.room,
      );
    const allocationFindFirst = vi
      .fn()
      .mockResolvedValue(overrides.allocation ?? null);
    const bedDeleteMany = vi.fn().mockResolvedValue({ count: 2 });
    const roomDelete =
      overrides.deleteRejects !== undefined
        ? vi.fn().mockRejectedValue(overrides.deleteRejects)
        : vi.fn().mockResolvedValue({ id: "room-1", name: "Bunkroom" });
    return {
      db: {
        lodgeRoom: { findFirst: roomFindFirst, delete: roomDelete },
        bedAllocation: { findFirst: allocationFindFirst },
        lodgeBed: {
          deleteMany: bedDeleteMany,
          // #2286: the room guard now also asks which beds the room holds, so
          // it can refuse a delete that would strand a custodian.
          findMany: vi.fn().mockResolvedValue([{ id: "bed-1" }]),
        },
        hutLeaderAssignment: { findMany: vi.fn().mockResolvedValue([]) },
      },
      roomFindFirst,
      allocationFindFirst,
      bedDeleteMany,
      roomDelete,
    };
  }

  it("deletes the room and its beds when there is no allocation history", async () => {
    const { db, allocationFindFirst, bedDeleteMany, roomDelete } =
      buildDeleteDb();

    const result = await deleteBedAllocationRoom({
      id: "room-1",
      db: db as never,
    });

    // Guard checks any allocation for the room, with no date filter, so any
    // history (past or future) blocks the delete.
    expect(allocationFindFirst).toHaveBeenCalledWith({
      where: { roomId: "room-1" },
      select: { id: true },
    });
    expect(bedDeleteMany).toHaveBeenCalledWith({
      where: { roomId: "room-1" },
    });
    expect(roomDelete).toHaveBeenCalledWith({ where: { id: "room-1" } });
    expect(result).toEqual({ id: "room-1", name: "Bunkroom" });
  });

  it("blocks deletion when the room has past allocation history", async () => {
    const { db, bedDeleteMany, roomDelete } = buildDeleteDb({
      allocation: { id: "allocation-past" },
    });

    await expect(
      deleteBedAllocationRoom({ id: "room-1", db: db as never }),
    ).rejects.toThrow(
      "This room has allocation history and cannot be deleted. Deactivate it instead.",
    );
    expect(bedDeleteMany).not.toHaveBeenCalled();
    expect(roomDelete).not.toHaveBeenCalled();
  });

  it("blocks deletion when the room has only future allocations", async () => {
    // Same guard as the past-only case: the history check is date-agnostic, so
    // a future-dated allocation blocks a hard delete just the same.
    const { db, roomDelete } = buildDeleteDb({
      allocation: { id: "allocation-future" },
    });

    await expect(
      deleteBedAllocationRoom({ id: "room-1", db: db as never }),
    ).rejects.toThrow(BedAllocationAdminError);
    expect(roomDelete).not.toHaveBeenCalled();
  });

  it("throws a 404 for an unknown room", async () => {
    const { db, allocationFindFirst } = buildDeleteDb({ room: null });

    await expect(
      deleteBedAllocationRoom({ id: "missing", db: db as never }),
    ).rejects.toMatchObject({ message: "Room not found", status: 404 });
    expect(allocationFindFirst).not.toHaveBeenCalled();
  });

  it("scopes the lookup to the given lodge and 404s on a mismatch", async () => {
    const { db, roomFindFirst } = buildDeleteDb({ room: null });

    await expect(
      deleteBedAllocationRoom({
        id: "room-1",
        lodgeId: "lodge-2",
        db: db as never,
      }),
    ).rejects.toMatchObject({ status: 404 });
    expect(roomFindFirst).toHaveBeenCalledWith({
      where: { id: "room-1", lodgeId: "lodge-2" },
      select: { id: true },
    });
  });

  it("wraps in a transaction and runs the guard + deletes on the tx client when no db is passed", async () => {
    // Without an injected db the function must self-wrap in prisma.$transaction
    // and run the guard AND deletes on the tx client the callback receives, so
    // the guard cannot be hoisted out of the transaction (or the wrap dropped)
    // without failing this test. The tx client is a distinct object from the
    // top-level prisma singleton, which has no room/bed methods here.
    const tx = {
      $executeRaw: vi.fn().mockResolvedValue(1),
      lodgeRoom: {
        findFirst: vi
          .fn()
          .mockResolvedValueOnce({ lodgeId: "lodge-1" })
          .mockResolvedValue({ id: "room-1" }),
        delete: vi.fn().mockResolvedValue({ id: "room-1", name: "Bunkroom" }),
      },
      bedAllocation: { findFirst: vi.fn().mockResolvedValue(null) },
      lodgeBed: {
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
        // #2286: the room guard also reads the room's beds.
        findMany: vi.fn().mockResolvedValue([{ id: "bed-1" }]),
      },
      hutLeaderAssignment: { findMany: vi.fn().mockResolvedValue([]) },
    };
    const txnMock = vi.fn(async (cb: (client: typeof tx) => unknown) => cb(tx));
    const prismaMock = prisma as unknown as { $transaction?: unknown };
    prismaMock.$transaction = txnMock;
    try {
      const result = await deleteBedAllocationRoomPublic({ id: "room-1" });

      expect(txnMock).toHaveBeenCalledTimes(1);
      expect(tx.$executeRaw).toHaveBeenCalledTimes(2);
      expect(tx.bedAllocation.findFirst).toHaveBeenCalledWith({
        where: { roomId: "room-1" },
        select: { id: true },
      });
      expect(tx.lodgeBed.deleteMany).toHaveBeenCalledWith({
        where: { roomId: "room-1" },
      });
      expect(tx.lodgeRoom.delete).toHaveBeenCalledWith({
        where: { id: "room-1" },
      });
      expect(result).toEqual({ id: "room-1", name: "Bunkroom" });
    } finally {
      delete prismaMock.$transaction;
    }
  });

  it("maps an ambiguous P2003 (no constraint metadata) to the allocation-history message", async () => {
    // The pg adapter can drop the constraint field; with nothing to classify
    // on, fall back to the allocation-history steer (the common case).
    const { db, roomDelete } = buildDeleteDb({
      deleteRejects: new Prisma.PrismaClientKnownRequestError("FK", {
        code: "P2003",
        clientVersion: "test",
      }),
    });

    await expect(
      deleteBedAllocationRoom({ id: "room-1", db: db as never }),
    ).rejects.toThrow(
      "This room has allocation history and cannot be deleted. Deactivate it instead.",
    );
    expect(roomDelete).toHaveBeenCalled();
  });

  it("maps a BedAllocation FK violation to the allocation-history message", async () => {
    const { db } = buildDeleteDb({
      deleteRejects: new Prisma.PrismaClientKnownRequestError(
        "Foreign key constraint violated",
        {
          code: "P2003",
          clientVersion: "test",
          meta: { field_name: "BedAllocation_bedId_roomId_fkey (index)" },
        },
      ),
    });

    await expect(
      deleteBedAllocationRoom({ id: "room-1", db: db as never }),
    ).rejects.toThrow(
      "This room has allocation history and cannot be deleted. Deactivate it instead.",
    );
  });

  it("maps a concurrent bed-creation FK (LodgeBed->room) to a retry message, not history", async () => {
    // A bed added by another admin between the guard and the room delete trips
    // the LodgeBed->room Restrict FK — not allocation history, so steer to a
    // retry rather than to Deactivate.
    const { db, roomDelete } = buildDeleteDb({
      deleteRejects: new Prisma.PrismaClientKnownRequestError(
        "Foreign key constraint violated",
        {
          code: "P2003",
          clientVersion: "test",
          meta: { field_name: "LodgeBed_roomId_fkey (index)" },
        },
      ),
    });

    await expect(
      deleteBedAllocationRoom({ id: "room-1", db: db as never }),
    ).rejects.toThrow(
      "Room changed while deleting (a bed was just added). Refresh and try again.",
    );
    expect(roomDelete).toHaveBeenCalled();
  });

  it("rethrows a non-FK Prisma error (P2025) unmapped", async () => {
    const notFound = new Prisma.PrismaClientKnownRequestError("Record not found", {
      code: "P2025",
      clientVersion: "test",
    });
    const { db } = buildDeleteDb({ deleteRejects: notFound });

    await expect(
      deleteBedAllocationRoom({ id: "room-1", db: db as never }),
    ).rejects.toBe(notFound);
  });

  it("rethrows a non-Prisma error unmapped", async () => {
    const boom = new Error("boom");
    const { db } = buildDeleteDb({ deleteRejects: boom });

    await expect(
      deleteBedAllocationRoom({ id: "room-1", db: db as never }),
    ).rejects.toBe(boom);
  });
});

describe("deleteBedAllocation orphan auto-promote (#1743)", () => {
  function allocationRow(overrides: Partial<{
    id: string;
    bookingId: string;
    bedId: string;
    stayDate: Date;
    isSecondOccupant: boolean;
    bedType: string;
  }> = {}) {
    return {
      id: overrides.id ?? "alloc-1",
      bookingId: overrides.bookingId ?? "booking-1",
      bookingGuestId: "guest-1",
      roomId: "room-1",
      bedId: overrides.bedId ?? "bed-1",
      stayDate: overrides.stayDate ?? parseDateOnly("2026-07-02"),
      isSecondOccupant: overrides.isSecondOccupant ?? false,
      bedType: overrides.bedType ?? "DOUBLE",
    };
  }

  function buildDeleteDb(input: {
    deleted: ReturnType<typeof allocationRow>;
    partner?: ReturnType<typeof allocationRow> | null;
  }) {
    return {
      bedAllocation: {
        delete: vi.fn().mockResolvedValue(input.deleted),
        findFirst: vi.fn().mockResolvedValue(input.partner ?? null),
        update: vi
          .fn()
          .mockImplementation(({ where, data }) => ({
            ...(input.partner ?? {}),
            ...where,
            ...data,
          })),
      },
    };
  }

  it("promotes the surviving partner when the primary of a shared double is removed", async () => {
    const deleted = allocationRow();
    const partner = allocationRow({
      id: "alloc-partner",
      bookingId: "booking-2",
      isSecondOccupant: true,
    });
    const db = buildDeleteDb({ deleted, partner });

    const result = await deleteBedAllocation({ id: "alloc-1", db: db as never });

    expect(result.deleted).toBe(deleted);
    expect(db.bedAllocation.delete).toHaveBeenCalledWith({
      where: { id: "alloc-1" },
    });
    // The partner lookup is pinned to the deleted row's own bed-night.
    expect(db.bedAllocation.findFirst).toHaveBeenCalledWith({
      where: {
        bedId: "bed-1",
        stayDate: parseDateOnly("2026-07-02"),
        isSecondOccupant: true,
      },
    });
    expect(db.bedAllocation.update).toHaveBeenCalledWith({
      where: { id: "alloc-partner" },
      data: { isSecondOccupant: false },
    });
    // The promoted row (possibly a different booking) is surfaced for auditing.
    expect(result.promotedPartner).toMatchObject({
      id: "alloc-partner",
      isSecondOccupant: false,
    });
  });

  it("still promotes when the deleted primary carries a stale non-DOUBLE denormalized bedType (AUTO row on a double)", async () => {
    // AUTO allocation (replaceBedAllocationsForBooking) never sets bedType, so
    // an auto-placed primary on a real DOUBLE has the SINGLE default. The
    // promotion gate must not trust the deleted row's denormalized bedType.
    const deleted = allocationRow({ bedType: "SINGLE" });
    const partner = allocationRow({
      id: "alloc-partner",
      isSecondOccupant: true,
    });
    const db = buildDeleteDb({ deleted, partner });

    const result = await deleteBedAllocation({ id: "alloc-1", db: db as never });

    expect(db.bedAllocation.update).toHaveBeenCalledWith({
      where: { id: "alloc-partner" },
      data: { isSecondOccupant: false },
    });
    expect(result.promotedPartner).toMatchObject({ id: "alloc-partner" });
  });

  it("leaves the primary untouched when the second occupant is removed", async () => {
    const db = buildDeleteDb({
      deleted: allocationRow({ isSecondOccupant: true }),
    });

    const result = await deleteBedAllocation({ id: "alloc-1", db: db as never });

    expect(db.bedAllocation.findFirst).not.toHaveBeenCalled();
    expect(db.bedAllocation.update).not.toHaveBeenCalled();
    expect(result.promotedPartner).toBeNull();
  });

  it("is a no-op when the deleted primary has no partner on the bed-night", async () => {
    const db = buildDeleteDb({ deleted: allocationRow(), partner: null });

    const result = await deleteBedAllocation({ id: "alloc-1", db: db as never });

    expect(db.bedAllocation.findFirst).toHaveBeenCalledTimes(1);
    expect(db.bedAllocation.update).not.toHaveBeenCalled();
    expect(result.promotedPartner).toBeNull();
  });

  it("applies promotion per night: each delete pins its own bed-night", async () => {
    const night1 = allocationRow({ id: "alloc-1", stayDate: parseDateOnly("2026-07-01") });
    const night2 = allocationRow({ id: "alloc-2", stayDate: parseDateOnly("2026-07-02") });
    const db = {
      bedAllocation: {
        delete: vi
          .fn()
          .mockResolvedValueOnce(night1)
          .mockResolvedValueOnce(night2),
        findFirst: vi.fn().mockResolvedValue(null),
        update: vi.fn(),
      },
    };

    await deleteBedAllocation({ id: "alloc-1", db: db as never });
    await deleteBedAllocation({ id: "alloc-2", db: db as never });

    expect(db.bedAllocation.findFirst.mock.calls.map((call) => call[0].where.stayDate)).toEqual([
      parseDateOnly("2026-07-01"),
      parseDateOnly("2026-07-02"),
    ]);
  });

  it("self-wraps delete + promotion in one transaction when no db is injected", async () => {
    // The mocked prisma singleton is otherwise `{}` (see the #1675 self-wrap
    // suite): a path that skips the wrap and reaches for prisma.bedAllocation
    // would throw here rather than silently pass.
    const prismaMock = prisma as unknown as { $transaction?: unknown };
    const deleteDb = buildDeleteDb({
      deleted: allocationRow(),
      partner: allocationRow({ id: "alloc-partner", isSecondOccupant: true }),
    });
    const tx = {
      ...deleteDb,
      $executeRaw: vi.fn().mockResolvedValue(1),
      bedAllocation: {
        ...deleteDb.bedAllocation,
        findUnique: vi
          .fn()
          .mockResolvedValue({ room: { lodgeId: "lodge-1" } }),
      },
    };
    const txnMock = vi.fn(async (cb: (client: typeof tx) => unknown) => cb(tx));
    prismaMock.$transaction = txnMock;
    try {
      await deleteBedAllocationPublic({ id: "alloc-1" });

      expect(txnMock).toHaveBeenCalledTimes(1);
      expect(tx.$executeRaw).toHaveBeenCalledTimes(2);
      // All three statements ran on the tx client.
      expect(tx.bedAllocation.delete).toHaveBeenCalledTimes(1);
      expect(tx.bedAllocation.findFirst).toHaveBeenCalledTimes(1);
      expect(tx.bedAllocation.update).toHaveBeenCalledTimes(1);
    } finally {
      delete prismaMock.$transaction;
    }
  });
});

describe("getBedAllocationDashboard exclusive whole-lodge holds (#119/#120)", () => {
  const room = {
    id: "room-a",
    name: "Room A",
    sortOrder: 1,
    active: true,
    notes: null,
    lodgeId: "lodge-1",
    beds: [1, 2, 3, 4].map((n) => ({
      id: `bed-a-${n}`,
      roomId: "room-a",
      name: `A${n}`,
      sortOrder: n,
      active: true,
      bedType: "SINGLE",
      bunkGroup: null,
    })),
  };

  const guest = (id: string, bookingId: string) => ({
    id,
    bookingId,
    firstName: id,
    lastName: "Test",
    ageTier: "ADULT",
    stayStart: parseDateOnly("2026-07-01"),
    stayEnd: parseDateOnly("2026-07-04"),
    nights: ["2026-07-01", "2026-07-02", "2026-07-03"].map((stayDate) => ({
      stayDate: parseDateOnly(stayDate),
    })),
  });

  function bookingRow(overrides: Record<string, unknown>) {
    return {
      status: "CONFIRMED",
      createdAt: new Date("2026-06-01T00:00:00.000Z"),
      checkIn: parseDateOnly("2026-07-01"),
      checkOut: parseDateOnly("2026-07-04"),
      lodgeId: "lodge-1",
      requestedRoomId: null,
      parentBookingId: null,
      originBookingRequest: null,
      heldForBookingRequest: null,
      requestedRoom: null,
      adminCapacityHoldAt: null,
      wholeLodgeHold: false,
      member: { firstName: "Org", lastName: "Contact", email: "s@x.nz" },
      guests: [],
      ...overrides,
    };
  }

  function buildDb(bookings: unknown[]) {
    return {
      bedAllocationSettings: {
        findUnique: vi.fn().mockResolvedValue({
          autoAllocationEnabled: true,
          allocationPriorityOrder: [...BED_ALLOCATION_PRIORITY_VOCABULARY],
          updatedByMemberId: null,
          updatedAt: parseDateOnly("2026-06-30"),
        }),
      },
      lodgeRoom: { findMany: vi.fn().mockResolvedValue([room]) },
      booking: { findMany: vi.fn().mockResolvedValue(bookings) },
      bedAllocation: { findMany: vi.fn().mockResolvedValue([]) },
      // #2286: custodian bed holds feed the board payload and the planner.
      // None here.
      hutLeaderAssignment: { findMany: vi.fn().mockResolvedValue([]) },
    };
  }

  it("short-circuits a held booking out of allocation, represents it distinctly, and flags overlapping bookings", async () => {
    const range = parseBedAllocationDateRange({
      from: "2026-07-01",
      to: "2026-07-05",
    });
    const held = bookingRow({
      id: "held",
      wholeLodgeHold: true,
      guests: [guest("held-g1", "held"), guest("held-g2", "held")],
    });
    const ordinary = bookingRow({
      id: "ordinary",
      checkIn: parseDateOnly("2026-07-02"),
      checkOut: parseDateOnly("2026-07-03"),
      guests: [
        {
          id: "ord-g1",
          bookingId: "ordinary",
          firstName: "Ord",
          lastName: "Guest",
          ageTier: "ADULT",
          stayStart: parseDateOnly("2026-07-02"),
          stayEnd: parseDateOnly("2026-07-03"),
          nights: [{ stayDate: parseDateOnly("2026-07-02") }],
        },
      ],
    });

    const dashboard = await getBedAllocationDashboard({
      range,
      db: buildDb([held, ordinary]) as never,
    });

    // #120: the held booking's guests are NOT awaiting allocation and are never
    // fed to the planner (no suggested allocation, no gap/stuck state).
    expect(
      dashboard.unallocatedGuestNights.every((g) => g.bookingId !== "held"),
    ).toBe(true);
    expect(
      dashboard.suggestedAllocations.every((a) => a.bookingId !== "held"),
    ).toBe(true);

    // #120: the held booking is represented distinctly instead.
    expect(dashboard.exclusiveHolds).toHaveLength(1);
    expect(dashboard.exclusiveHolds[0]).toMatchObject({
      bookingId: "held",
      guestCount: 2,
    });
    expect(dashboard.exclusiveHolds[0].nights).toEqual([
      "2026-07-01",
      "2026-07-02",
      "2026-07-03",
    ]);

    // Regression: an ordinary overlapping booking still needs a bed AND is
    // flagged as overlapping the hold (#119, the other direction).
    expect(
      dashboard.unallocatedGuestNights.some((g) => g.bookingId === "ordinary"),
    ).toBe(true);
    const ordinaryRow = dashboard.bookings.find((b) => b.id === "ordinary");
    expect(ordinaryRow?.overlapsExclusiveHold).toBe(true);
    expect(ordinaryRow?.wholeLodgeHold).toBe(false);

    // The held booking itself is never flagged as "overlapping".
    const heldRow = dashboard.bookings.find((b) => b.id === "held");
    expect(heldRow?.wholeLodgeHold).toBe(true);
    expect(heldRow?.overlapsExclusiveHold).toBe(false);
  });

  it("a non-held booking with no hold nearby is unaffected (regression)", async () => {
    const range = parseBedAllocationDateRange({
      from: "2026-07-01",
      to: "2026-07-05",
    });
    const ordinary = bookingRow({
      id: "solo",
      guests: [guest("solo-g1", "solo")],
    });

    const dashboard = await getBedAllocationDashboard({
      range,
      db: buildDb([ordinary]) as never,
    });

    expect(dashboard.exclusiveHolds).toEqual([]);
    const soloRow = dashboard.bookings.find((b) => b.id === "solo");
    expect(soloRow?.overlapsExclusiveHold).toBe(false);
    expect(
      dashboard.unallocatedGuestNights.some((g) => g.bookingId === "solo"),
    ).toBe(true);
  });
});

// --- D-12 (#2307): the admin bed board's awaiting-allocation queue ----------
//
// Owner decision D-12: a member guest whose consent is still PENDING holds a bed
// against capacity (D-4) but is not somebody an officer should be placing in a
// bunk. Two queries in this module load the guests the board works from — the
// board's own booking load and the dashboard card's window-scoped mirror of it —
// and both must exclude them or the board offers work that should not exist.
//
// Occupancy is unaffected by design: the board reads BedAllocation rows through
// `loadAllocationRecords` and names their guests from the allocation row itself,
// so a bed that IS occupied still shows as occupied whatever the consent says.
describe("bed allocation board member-guest consent exclusion (D-12, #2307)", () => {
  const PRESENT_OR = [{ consentStatus: null }, { consentStatus: "CONFIRMED" }];

  function dashboardDb() {
    const bookingFindMany = vi.fn().mockResolvedValue([]);
    const allocationFindMany = vi.fn().mockResolvedValue([]);
    const roomFindMany = vi.fn().mockResolvedValue([]);
    return {
      db: {
        bedAllocationSettings: {
          findUnique: vi.fn().mockResolvedValue({
            autoAllocationEnabled: false,
            allocationPriorityOrder: [...BED_ALLOCATION_PRIORITY_VOCABULARY],
            updatedByMemberId: null,
            updatedAt: parseDateOnly("2026-07-01"),
          }),
        },
        lodgeRoom: { findMany: roomFindMany },
        booking: { findMany: bookingFindMany },
        bedAllocation: { findMany: allocationFindMany },
        // Custodian occupancy (#2286/#2339): the board now also asks which
        // beds a hut-leader assignment holds. Nobody in residence here — this
        // block is about the D-12 consent exclusion, and a custodian would
        // only add noise to the two queries it inspects.
        hutLeaderAssignment: { findMany: vi.fn().mockResolvedValue([]) },
      },
      bookingFindMany,
      allocationFindMany,
    };
  }

  const range = parseBedAllocationDateRange({ from: "2026-07-01", to: "2026-07-08" });

  it("excludes unconsented guests from the board's booking load", async () => {
    const { db, bookingFindMany } = dashboardDb();

    await getBedAllocationDashboard({ range, lodgeId: "lodge-2", db: db as never });

    const args = bookingFindMany.mock.calls[0][0];
    expect(args.select.guests.where.OR).toEqual(PRESENT_OR);
  });

  it("leaves the board's OCCUPANCY read unfiltered", async () => {
    // The allocation rows describe the beds as written. A consent filter here
    // would make an occupied bed look free on the board an officer is dragging
    // guests around on.
    const { db, allocationFindMany } = dashboardDb();

    await getBedAllocationDashboard({ range, lodgeId: "lodge-2", db: db as never });

    expect(JSON.stringify(allocationFindMany.mock.calls[0][0])).not.toContain(
      "consentStatus",
    );
  });

  it("excludes unconsented guests from the awaiting-allocation counter", async () => {
    // A window-scoped mirror of the board's own construction, so it has to apply
    // the same exclusion — otherwise the dashboard officer card advertises work
    // the board itself does not list.
    const bookingFindMany = vi.fn().mockResolvedValue([]);
    const allocationFindMany = vi.fn().mockResolvedValue([]);

    const count = await countGuestsAwaitingBed({
      from: parseDateOnly("2026-07-01"),
      to: parseDateOnly("2026-07-08"),
      db: {
        booking: { findMany: bookingFindMany },
        bedAllocation: { findMany: allocationFindMany },
      } as never,
    });

    expect(count).toBe(0);
    const args = bookingFindMany.mock.calls[0][0];
    expect(args.select.guests.where.OR).toEqual(PRESENT_OR);
  });

  it("counts a null-consent guest as awaiting, and never a PENDING one", async () => {
    // The outcome, not just the query: an ordinary (null-consent) guest with no
    // bed is still work to do — the case the `not: "PENDING"` trap would have
    // silently emptied — while the pending guest is not.
    const bookingFindMany = vi.fn().mockImplementation(async (args: any) => {
      const where = args.select.guests.where as
        | { OR?: Array<{ consentStatus: string | null }> }
        | undefined;
      const guests = [
        {
          id: "guest-ordinary",
          stayStart: parseDateOnly("2026-07-01"),
          stayEnd: parseDateOnly("2026-07-03"),
          consentStatus: null,
        },
        {
          id: "guest-awaiting",
          stayStart: parseDateOnly("2026-07-01"),
          stayEnd: parseDateOnly("2026-07-03"),
          consentStatus: "PENDING",
        },
      ];
      return [
        {
          id: "booking-1",
          guests: where?.OR
            ? guests.filter((guest) =>
                where.OR!.some(
                  (branch) => branch.consentStatus === guest.consentStatus,
                ),
              )
            : guests,
        },
      ];
    });

    const count = await countGuestsAwaitingBed({
      from: parseDateOnly("2026-07-01"),
      to: parseDateOnly("2026-07-08"),
      db: {
        booking: { findMany: bookingFindMany },
        bedAllocation: { findMany: vi.fn().mockResolvedValue([]) },
      } as never,
    });

    expect(count).toBe(1);
  });
});

/*
 * #2252 — the in-booking Bed allocation panel confirms ONE booking's drafts.
 *
 * The sharpest edge in the whole issue is approve scope. The panel must never
 * issue a `from`/`to` approval: that form stamps every pending allocation of
 * every booking in the window, so confirming one booking from its own page
 * would silently confirm other people's drafts. `bookingId` is therefore a
 * first-class selector that is sufficient ON ITS OWN, and these tests pin both
 * halves of that: it works alone, and it never widens the set.
 */
describe("approveBedAllocations — booking selector (#2252)", () => {
  it("accepts { bookingId } alone and scopes to that booking's draft rows only", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 3 });
    const db = { bedAllocation: { updateMany } };

    const result = await approveBedAllocations({
      approvedByMemberId: "admin-1",
      bookingId: "booking-1",
      db: db as never,
    });

    expect(result.count).toBe(3);
    const call = updateMany.mock.calls[0][0];
    expect(call.where).toEqual({ approvedAt: null, bookingId: "booking-1" });
    // Never a window approval: no date predicate at all, so no other booking's
    // drafts can be swept up by a Confirm pressed inside one booking.
    expect(call.where.stayDate).toBeUndefined();
    expect(call.where.room).toBeUndefined();
    expect(call.where.id).toBeUndefined();
    expect(call.data).toMatchObject({ approvedByMemberId: "admin-1" });
    expect(call.data.approvedAt).toBeInstanceOf(Date);
  });

  it("only ever stamps rows that are still drafts, so already-approved rows keep their original stamps", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 0 });
    const db = { bedAllocation: { updateMany } };

    await approveBedAllocations({
      approvedByMemberId: "admin-2",
      bookingId: "booking-1",
      db: db as never,
    });

    // `approvedAt: null` is the status guard: re-pressing Confirm is a no-op on
    // rows another admin already approved — it cannot restamp their approval.
    expect(updateMany.mock.calls[0][0].where.approvedAt).toBeNull();
  });

  it("narrows rather than replaces when a booking is given alongside allocation ids", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const db = { bedAllocation: { updateMany } };

    await approveBedAllocations({
      approvedByMemberId: "admin-1",
      allocationIds: ["alloc-1", "alloc-2"],
      bookingId: "booking-1",
      db: db as never,
    });

    expect(updateMany.mock.calls[0][0].where).toEqual({
      approvedAt: null,
      bookingId: "booking-1",
      id: { in: ["alloc-1", "alloc-2"] },
    });
  });

  it("narrows a range approval to the booking when both are given", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const db = { bedAllocation: { updateMany } };
    const approvalRange = parseBedAllocationDateRange({
      from: "2026-07-01",
      to: "2026-07-08",
    });

    await approveBedAllocations({
      approvedByMemberId: "admin-1",
      range: approvalRange,
      bookingId: "booking-1",
      db: db as never,
    });

    const where = updateMany.mock.calls[0][0].where;
    expect(where.bookingId).toBe("booking-1");
    expect(where.stayDate).toEqual({
      gte: approvalRange.from,
      lt: approvalRange.to,
    });
  });

  it("still refuses an approval with no selector at all", async () => {
    const updateMany = vi.fn();
    const db = { bedAllocation: { updateMany } };

    await expect(
      approveBedAllocations({
        approvedByMemberId: "admin-1",
        db: db as never,
      }),
    ).rejects.toBeInstanceOf(BedAllocationAdminError);
    // An unselected approve would stamp every pending allocation in the
    // database; nothing must reach updateMany.
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("treats an empty allocation id list as no id selector, not as a wildcard", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 2 });
    const db = { bedAllocation: { updateMany } };

    await approveBedAllocations({
      approvedByMemberId: "admin-1",
      allocationIds: [],
      bookingId: "booking-1",
      db: db as never,
    });

    expect(updateMany.mock.calls[0][0].where).toEqual({
      approvedAt: null,
      bookingId: "booking-1",
    });
  });

  /*
   * #2252 review: the write scope must not be wider than the read scope.
   *
   * The in-booking panel's GET is lodge-scoped (ADR-003), so a row of this
   * booking sitting in ANOTHER lodge's room — an anomaly, but reachable via a
   * booking that changed lodge or a pre-backfill row — never appears on the
   * card. Without the lodge predicate the approve stamped it anyway, so the
   * officer confirmed a bed they were never shown.
   */
  it("scopes a booking approval to the lodge the panel read, so an off-lodge anomaly row is not swept in", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 2 });
    const db = { bedAllocation: { updateMany } };

    await approveBedAllocations({
      approvedByMemberId: "admin-1",
      bookingId: "booking-1",
      lodgeId: "lodge-1",
      db: db as never,
    });

    const where = updateMany.mock.calls[0][0].where;
    expect(where.bookingId).toBe("booking-1");
    // The same null-tolerant room scope the board's range approval uses.
    expect(where.room).toEqual(lodgeNullTolerantScope("lodge-1"));
    // Still not a window approval.
    expect(where.stayDate).toBeUndefined();
  });

  it("keeps a booking approval club-wide when no lodge is given", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 2 });
    const db = { bedAllocation: { updateMany } };

    await approveBedAllocations({
      approvedByMemberId: "admin-1",
      bookingId: "booking-1",
      db: db as never,
    });

    // Pre-backfill tolerance: a booking with no lodge must still be approvable.
    expect(updateMany.mock.calls[0][0].where.room).toBeUndefined();
  });

  it("leaves the board's own allocationIds approval byte-unchanged", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 2 });
    const db = { bedAllocation: { updateMany } };

    // The board sends ids (and may send a lodge) but never a bookingId, so the
    // new lodge predicate must not appear on its path.
    await approveBedAllocations({
      approvedByMemberId: "admin-1",
      allocationIds: ["alloc-1"],
      lodgeId: "lodge-1",
      db: db as never,
    });

    expect(updateMany.mock.calls[0][0].where).toEqual({
      approvedAt: null,
      id: { in: ["alloc-1"] },
    });
  });
});

describe("countApprovedBedAllocationNights (#2252 review)", () => {
  it("counts a booking's approved bed nights across the whole booking, not a window", async () => {
    const count = vi.fn().mockResolvedValue(7);
    const db = { bedAllocation: { count } };

    await expect(
      countApprovedBedAllocationNights({
        bookingId: "booking-1",
        db: db as never,
      }),
    ).resolves.toBe(7);

    // No date predicate: the panel's 31-night page cannot see the approved
    // nights on a longer stay's other pages, which is the whole point.
    expect(count.mock.calls[0][0].where).toEqual({
      bookingId: "booking-1",
      approvedAt: { not: null },
    });
  });
});

/*
 * #2252 — the member room-request lock (#776) is NOT one-way.
 *
 * The panel's copy has to be honest about this: two existing paths take the
 * booking's last approved row away again and re-open the member's editor. No
 * dedicated un-approve action exists (and none is invented here) — these are
 * documented side effects, which is exactly why the panel warns before removing
 * the last approved row.
 */
describe("bed allocation lock semantics are two-way (#2252)", () => {
  it("a board move re-drafts the row it updates", async () => {
    const upsert = vi.fn(
      ({ create }: {
        create: Record<string, unknown>;
        update: Record<string, unknown>;
      }) => ({
        id: "alloc",
        ...create,
      }),
    );
    const db = {
      bookingGuest: {
        findUnique: vi.fn().mockResolvedValue({
          id: "guest-1",
          bookingId: "booking-1",
          stayStart: parseDateOnly("2026-07-01"),
          stayEnd: parseDateOnly("2026-07-04"),
          memberId: null,
          booking: { id: "booking-1", status: "CONFIRMED", deletedAt: null },
        }),
      },
      lodgeBed: {
        findUnique: vi.fn().mockResolvedValue({
          id: "bed-2",
          roomId: "room-1",
          active: true,
          bedType: "SINGLE",
          room: { id: "room-1", active: true },
        }),
      },
      member: { findMany: vi.fn().mockResolvedValue([]) },
      memberPartnerLink: { findUnique: vi.fn().mockResolvedValue(null) },
      bedAllocation: {
        findMany: vi.fn().mockResolvedValue([]),
        findUnique: vi
          .fn()
          .mockResolvedValue({ bedId: "bed-1", isSecondOccupant: false }),
        findFirst: vi.fn().mockResolvedValue(null),
        update: vi.fn(),
        upsert,
      },
      // #2286: allocateBedNight refuses a custodian-held bed-night. No holds
      // here, so the move behaves exactly as before.
      hutLeaderAssignment: { findMany: vi.fn().mockResolvedValue([]) },
    };

    await manuallyAllocateBedForNights({
      bookingGuestId: "guest-1",
      bedId: "bed-2",
      stayDates: ["2026-07-02"],
      db: db as never,
    });

    // Moving an approved row clears its approval — the lock can flip back off
    // without anyone pressing an "un-approve" button, because there isn't one.
    expect(upsert.mock.calls[0][0].update).toMatchObject({
      approvedAt: null,
      approvedByMemberId: null,
    });
  });

  it("reports the booking locked while an approved row exists, and unlocked once it is deleted", async () => {
    const approvedRow = {
      id: "alloc-1",
      bookingId: "booking-1",
      bedId: "bed-1",
      stayDate: parseDateOnly("2026-07-02"),
      isSecondOccupant: false,
    };
    let rows = [approvedRow];

    const db = {
      bedAllocation: {
        findFirst: vi.fn(async (_args: unknown) => rows[0] ?? null),
        delete: vi.fn(async ({ where }: { where: { id: string } }) => {
          const removed = rows.find((row) => row.id === where.id);
          rows = rows.filter((row) => row.id !== where.id);
          return removed;
        }),
        findMany: vi.fn().mockResolvedValue([]),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
    };

    await expect(
      isBookingBedAllocationLocked({
        bookingId: "booking-1",
        db: db as never,
      }),
    ).resolves.toBe(true);
    expect(db.bedAllocation.findFirst.mock.calls[0]?.[0]).toMatchObject({
      where: { bookingId: "booking-1", approvedAt: { not: null } },
    });

    await deleteBedAllocation({ id: "alloc-1", db: db as never });

    await expect(
      isBookingBedAllocationLocked({
        bookingId: "booking-1",
        db: db as never,
      }),
    ).resolves.toBe(false);
  });
});
