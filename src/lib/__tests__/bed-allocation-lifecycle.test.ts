import { BookingStatus } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import type { FeatureFlags } from "@/config/schema";
import {
  BED_ALLOCATABLE_BOOKING_STATUSES,
  reconcileBedAllocationsForBooking,
} from "@/lib/bed-allocation-lifecycle";
import { parseDateOnly } from "@/lib/date-only";

const enabledBedAllocationFlags: FeatureFlags = {
  kiosk: false,
  chores: false,
  financeDashboard: false,
  waitlist: false,
  xeroIntegration: false,
  bedAllocation: true,
  internetBankingPayments: false,
};

const disabledBedAllocationFlags: FeatureFlags = {
  ...enabledBedAllocationFlags,
  bedAllocation: false,
};

function makeDb(overrides: Record<string, unknown> = {}) {
  return {
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
    },
    bedAllocationSettings: {
      findUnique: vi.fn().mockResolvedValue({ autoAllocationEnabled: false }),
    },
    lodgeRoom: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    ...overrides,
  };
}

describe("bed allocation lifecycle", () => {
  it("does not touch allocations when the bed allocation module is disabled", async () => {
    const db = makeDb();

    const result = await reconcileBedAllocationsForBooking({
      bookingId: "booking-1",
      db: db as any,
      envCapability: disabledBedAllocationFlags,
    });

    expect(result).toEqual({
      enabled: false,
      deletedCount: 0,
      createdCount: 0,
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
      envCapability: enabledBedAllocationFlags,
    });

    expect(db.bedAllocation.deleteMany).toHaveBeenCalledWith({
      where: { bookingId: "booking-1" },
    });
    expect(result).toEqual({
      enabled: true,
      deletedCount: 2,
      createdCount: 0,
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
      envCapability: enabledBedAllocationFlags,
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
    });
  });
});
