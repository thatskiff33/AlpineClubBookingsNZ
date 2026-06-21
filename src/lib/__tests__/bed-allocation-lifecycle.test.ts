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
      envCapability: enabledBedAllocationFlags,
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
    });
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
      envCapability: enabledBedAllocationFlags,
    });

    expect(db.bedAllocation.deleteMany).toHaveBeenCalledWith({
      where: {
        bookingId: "booking-1",
        OR: [
          { bookingGuestId: { notIn: ["guest-1"] } },
          {
            bookingGuestId: "guest-1",
            stayDate: { lt: parseDateOnly("2026-07-03") },
          },
          {
            bookingGuestId: "guest-1",
            stayDate: { gte: parseDateOnly("2026-07-06") },
          },
        ],
      },
    });
    expect(db.bedAllocation.createMany).not.toHaveBeenCalled();
    expect(result).toEqual({
      enabled: true,
      deletedCount: 2,
      createdCount: 0,
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
      envCapability: enabledBedAllocationFlags,
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

  it("re-checks the merged (union) range when a booking date range shrinks (issue #816)", async () => {
    // Booking shrank from 07-01..07-05 to 07-01..07-03. Reconciliation must
    // re-evaluate auto allocation across the union of the old and new ranges so
    // beds freed on the dropped nights can be re-filled (e.g. for another
    // booking). No other booking needs the freed nights here, so nothing is
    // created, but the scan must cover the old wider range.
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
      envCapability: enabledBedAllocationFlags,
    });

    // The existing-allocation scan and the overlapping-booking scan both use the
    // union range 07-01..07-05, not just the new narrower 07-01..07-03.
    expect(db.bedAllocation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          stayDate: {
            gte: parseDateOnly("2026-07-01"),
            lt: parseDateOnly("2026-07-05"),
          },
        }),
      }),
    );
    expect(db.booking.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          checkIn: { lt: parseDateOnly("2026-07-05") },
          checkOut: { gt: parseDateOnly("2026-07-01") },
        }),
      }),
    );
    expect(result).toEqual({
      enabled: true,
      deletedCount: 2,
      createdCount: 0,
    });
  });
});
