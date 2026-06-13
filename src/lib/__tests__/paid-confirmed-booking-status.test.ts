import { readFileSync } from "fs";
import path from "path";
import { BookingStatus } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMocks = vi.hoisted(() => ({
  bookingFindMany: vi.fn(),
  bookingGuestFindFirst: vi.fn(),
  bookingGuestFindMany: vi.fn(),
  choreAssignmentFindFirst: vi.fn(),
}));

vi.mock("../prisma", () => ({
  prisma: {
    booking: {
      findMany: prismaMocks.bookingFindMany,
    },
    bookingGuest: {
      findFirst: prismaMocks.bookingGuestFindFirst,
      findMany: prismaMocks.bookingGuestFindMany,
    },
    choreAssignment: {
      findFirst: prismaMocks.choreAssignmentFindFirst,
    },
  },
}));

import {
  CAPACITY_HOLDING_BOOKING_STATUSES,
  OPERATIONAL_STAY_BOOKING_STATUSES,
  PAYMENT_OWED_BOOKING_STATUSES,
} from "../booking-status";
import { checkCapacity } from "../capacity";
import {
  findLodgeGuestForDate,
  validateRosterAllocationsForDate,
} from "../lodge-date-scoping";
import { FALLBACK_LODGE_CAPACITY as LODGE_CAPACITY } from "../lodge-capacity";

function readRepoFile(relativePath: string) {
  return readFileSync(path.resolve(process.cwd(), relativePath), "utf8");
}

function dateOnly(year: number, monthIndex: number, day: number) {
  return new Date(year, monthIndex, day);
}

function makeBooking(guestCount: number, status: BookingStatus) {
  return {
    id: `booking-${status}`,
    checkIn: dateOnly(2026, 6, 10),
    checkOut: dateOnly(2026, 6, 12),
    status,
    guests: Array.from({ length: guestCount }, (_, index) => ({
      id: `guest-${index}`,
    })),
  };
}

describe("paid legacy CONFIRMED booking repair", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("promotes CONFIRMED bookings with succeeded payments after unpaid bookings are backfilled", () => {
    const unpaidBackfill = readRepoFile(
      "prisma/migrations/20260511113000_backfill_payment_pending_booking_status/migration.sql"
    );
    const paidRepair = readRepoFile(
      "prisma/migrations/20260511124500_promote_paid_confirmed_bookings/migration.sql"
    );

    expect(unpaidBackfill).toContain('SET "status" = \'PAYMENT_PENDING\'');
    expect(unpaidBackfill).toContain("NOT EXISTS");
    expect(unpaidBackfill).toContain('p."status" = \'SUCCEEDED\'');

    expect(paidRepair).toContain('SET "status" = \'PAID\'');
    expect(paidRepair).toContain('b."status" = \'CONFIRMED\'');
    expect(paidRepair).toContain("EXISTS");
    expect(paidRepair).toContain('p."status" = \'SUCCEEDED\'');
    expect(paidRepair).toContain('"updatedAt" = NOW()');
  });

  it("backfills booking guest stay ranges from parent booking dates", () => {
    const stayRangeMigration = readRepoFile(
      "prisma/migrations/20260524090000_add_booking_guest_stay_ranges/migration.sql"
    );

    expect(stayRangeMigration).toContain('ADD COLUMN "stayStart" DATE');
    expect(stayRangeMigration).toContain('ADD COLUMN "stayEnd" DATE');
    expect(stayRangeMigration).toContain('"stayStart" = b."checkIn"::date');
    expect(stayRangeMigration).toContain('"stayEnd" = b."checkOut"::date');
    expect(stayRangeMigration).toContain(
      'ALTER COLUMN "stayStart" SET NOT NULL'
    );
    expect(stayRangeMigration).toContain(
      'ALTER COLUMN "stayEnd" SET NOT NULL'
    );
  });

  it("keeps status helper semantics aligned with the paid repair", () => {
    expect(CAPACITY_HOLDING_BOOKING_STATUSES).toContain(BookingStatus.PAID);
    expect(CAPACITY_HOLDING_BOOKING_STATUSES).toContain(BookingStatus.PENDING);
    expect(CAPACITY_HOLDING_BOOKING_STATUSES).toContain(
      BookingStatus.COMPLETED
    );
    expect(CAPACITY_HOLDING_BOOKING_STATUSES).not.toContain(
      BookingStatus.CONFIRMED
    );
    // AWAITING_REVIEW must hold capacity so admins decisions don't
    // overbook against members who booked the same nights in parallel.
    expect(CAPACITY_HOLDING_BOOKING_STATUSES).toContain(
      BookingStatus.AWAITING_REVIEW
    );

    expect(OPERATIONAL_STAY_BOOKING_STATUSES).toContain(BookingStatus.PAID);
    expect(OPERATIONAL_STAY_BOOKING_STATUSES).toContain(BookingStatus.COMPLETED);
    expect(OPERATIONAL_STAY_BOOKING_STATUSES).not.toContain(
      BookingStatus.CONFIRMED
    );

    expect(PAYMENT_OWED_BOOKING_STATUSES).toContain(BookingStatus.CONFIRMED);
    expect(PAYMENT_OWED_BOOKING_STATUSES).toContain(
      BookingStatus.PAYMENT_PENDING
    );
    expect(PAYMENT_OWED_BOOKING_STATUSES).not.toContain(BookingStatus.PAID);
    // AWAITING_REVIEW must NOT be payable — that's the whole point of the gate.
    expect(PAYMENT_OWED_BOOKING_STATUSES).not.toContain(
      BookingStatus.AWAITING_REVIEW
    );
  });

  it("counts PAID bookings when checking capacity", async () => {
    prismaMocks.bookingFindMany.mockResolvedValueOnce([
      makeBooking(2, BookingStatus.PAID),
    ]);

    const requestedGuests = LODGE_CAPACITY - 2;
    const result = await checkCapacity(
      dateOnly(2026, 6, 10),
      dateOnly(2026, 6, 12),
      requestedGuests
    );

    expect(prismaMocks.bookingFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: {
            in: expect.arrayContaining([BookingStatus.PAID]),
          },
        }),
      })
    );
    expect(result.available).toBe(true);
    expect(result.minAvailable).toBe(requestedGuests);
    expect(result.nightDetails.map((night) => night.occupiedBeds)).toEqual([
      2,
      2,
    ]);
  });

  it("counts COMPLETED bookings when checking capacity", async () => {
    prismaMocks.bookingFindMany.mockResolvedValueOnce([
      makeBooking(4, BookingStatus.COMPLETED),
    ]);

    const result = await checkCapacity(
      dateOnly(2026, 6, 10),
      dateOnly(2026, 6, 12),
      LODGE_CAPACITY - 4
    );

    expect(prismaMocks.bookingFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: {
            in: expect.arrayContaining([BookingStatus.COMPLETED]),
          },
        }),
      })
    );
    expect(result.available).toBe(true);
    expect(result.minAvailable).toBe(LODGE_CAPACITY - 4);
    expect(result.nightDetails.map((night) => night.occupiedBeds)).toEqual([
      4,
      4,
    ]);
  });

  it("uses PAID operational bookings for lodge guest lookup and roster validation", async () => {
    prismaMocks.bookingGuestFindFirst.mockResolvedValueOnce({
      id: "guest-1",
      bookingId: "booking-1",
      arrivedAt: null,
      departedAt: null,
    });
    prismaMocks.bookingGuestFindMany.mockResolvedValueOnce([
      { id: "guest-1", bookingId: "booking-1" },
    ]);

    await findLodgeGuestForDate("guest-1", dateOnly(2026, 6, 10));
    const valid = await validateRosterAllocationsForDate(
      [{ bookingGuestId: "guest-1", bookingId: "booking-1" }],
      dateOnly(2026, 6, 10)
    );

    expect(valid).toBe(true);
    expect(prismaMocks.bookingGuestFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          stayStart: { lte: dateOnly(2026, 6, 10) },
          stayEnd: { gt: dateOnly(2026, 6, 10) },
          booking: expect.objectContaining({
            status: { in: expect.arrayContaining([BookingStatus.PAID]) },
          }),
        }),
      })
    );
    expect(prismaMocks.bookingGuestFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          stayStart: { lte: dateOnly(2026, 6, 10) },
          stayEnd: { gt: dateOnly(2026, 6, 10) },
          booking: expect.objectContaining({
            status: { in: expect.arrayContaining([BookingStatus.PAID]) },
          }),
        }),
      })
    );
  });
});
