import { readFileSync } from "fs";
import path from "path";
import { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {},
}));

vi.mock("@/lib/lodge-capacity", () => ({
  getLodgeCapacityStatus: vi.fn().mockResolvedValue({
    capacity: 29,
    source: "club_config",
    bedAllocationEnabled: false,
    activeBedCount: 0,
    fallbackCapacity: 29,
  }),
}));

import {
  BedAllocationAdminError,
  MAX_BED_ALLOCATION_RANGE_NIGHTS,
  buildBedAllocationWarnings,
  manuallyAllocateBedForNights,
  parseBedAllocationDateRange,
  updateBedAllocationBed,
} from "@/lib/admin-bed-allocation";
import { parseDateOnly } from "@/lib/date-only";

function readRepoFile(relativePath: string) {
  return readFileSync(path.resolve(process.cwd(), relativePath), "utf8");
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
        },
      ],
    });

    expect(warnings.map((warning) => warning.type)).toEqual([
      "BOOKING_SPLIT",
      "MINOR_WITHOUT_BOOKING_ADULT",
    ]);
  });

  it("keeps bed allocation routes feature gated", () => {
    const featureRoutes = readRepoFile("src/config/feature-routes.ts");
    const sidebar = readRepoFile("src/components/admin-sidebar.tsx");

    expect(featureRoutes).toContain('flag: "bedAllocation"');
    expect(featureRoutes).toContain('"/admin/bed-allocation"');
    expect(featureRoutes).toContain('"/admin/rooms-beds"');
    expect(featureRoutes).toContain('"/api/admin/bed-allocation"');
    expect(sidebar).toContain('href: "/admin/bed-allocation"');
    expect(sidebar).toContain('href: "/admin/rooms-beds"');
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
    expect(schema).toContain("autoAllocationEnabled Boolean");
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
  }> = {}) {
    return {
      id: overrides.id ?? "guest-1",
      bookingId: overrides.bookingId ?? "booking-1",
      stayStart: overrides.stayStart ?? parseDateOnly("2026-07-01"),
      stayEnd: overrides.stayEnd ?? parseDateOnly("2026-07-04"),
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
  }> = {}) {
    return {
      id: overrides.id ?? "bed-1",
      roomId: overrides.roomId ?? "room-1",
      active: overrides.active ?? true,
      room: { id: overrides.roomId ?? "room-1", active: overrides.roomActive ?? true },
    };
  }

  function buildDb(input: {
    guest: ReturnType<typeof buildGuest> | null;
    bed: ReturnType<typeof buildBed> | null;
    upsert: ReturnType<typeof vi.fn>;
  }) {
    return {
      bookingGuest: {
        findUnique: vi.fn().mockResolvedValue(input.guest),
      },
      lodgeBed: {
        findUnique: vi.fn().mockResolvedValue(input.bed),
      },
      bedAllocation: {
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
});
