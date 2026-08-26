import { readFileSync } from "fs";
import { dateOnlyFromParts } from "@/lib/date-only";
import path from "path";
import { BookingStatus } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMocks = vi.hoisted(() => ({
  bookingFindMany: vi.fn(),
  bookingGuestFindFirst: vi.fn(),
  bookingGuestFindMany: vi.fn(),
  choreAssignmentFindFirst: vi.fn(),
  lodgeSettingsFindUnique: vi.fn(),
}));

vi.mock("../prisma", () => ({
  prisma: {
    booking: {
      findMany: prismaMocks.bookingFindMany,
    },
    // #2286: custodian bed holds are base occupancy. None in these cases.
    hutLeaderAssignment: { findMany: vi.fn().mockResolvedValue([]) },
    bookingGuest: {
      findFirst: prismaMocks.bookingGuestFindFirst,
      findMany: prismaMocks.bookingGuestFindMany,
    },
    choreAssignment: {
      findFirst: prismaMocks.choreAssignmentFindFirst,
    },
    // Since #1982 the default lodge's capacity is a DB override (self-healed
    // from the config bed total), not a club.json runtime fallback. Model it so
    // capacity resolves to LODGE_CAPACITY (set in beforeEach).
    lodgeSettings: {
      findUnique: prismaMocks.lodgeSettingsFindUnique,
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
  // Test helper: reads a fixed repo file under process.cwd(); relativePath is test-controlled, not user input.
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
  return readFileSync(path.resolve(process.cwd(), relativePath), "utf8");
}

// #3107: a `@db.Date` fixture is the calendar day encoded at UTC MIDNIGHT.
// This was `new Date(year, monthIndex, day)` - HOST-LOCAL midnight, which on a
// UTC+12 host is noon UTC the previous day and on a UTC-6 host is 06:00 UTC.
// PostgreSQL cannot keep a time in a `date` column, so no such value can ever
// come back from the database: the fixture described a row that cannot exist,
// and it only read back correctly while the code under test projected it
// through a zone that happened to undo the host offset. `dateOnlyFromParts`
// avoids `Date.UTC`, whose two-digit-year rule would map year 47 onto 1947.
function dateOnly(year: number, monthIndex: number, day: number) {
  return dateOnlyFromParts(year, monthIndex, day);
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
    prismaMocks.lodgeSettingsFindUnique.mockResolvedValue({
      capacity: LODGE_CAPACITY,
    });
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
    // PENDING no longer holds capacity (issue #737): only bookings with money
    // committed reserve beds, and members pay up front so they land on PAID.
    expect(CAPACITY_HOLDING_BOOKING_STATUSES).not.toContain(
      BookingStatus.PENDING
    );
    expect(CAPACITY_HOLDING_BOOKING_STATUSES).toContain(
      BookingStatus.COMPLETED
    );
    // CONFIRMED holds capacity for pay-on-account bookings (school groups,
    // issue #709): the lodge is reserved at approval while the emailed Xero
    // invoice is outstanding, and the booking flips to PAID once it is paid.
    expect(CAPACITY_HOLDING_BOOKING_STATUSES).toContain(
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
      "lodge-1",
      dateOnly(2026, 6, 10),
      dateOnly(2026, 6, 12),
      requestedGuests
    );

    // Capacity-holding status filter now lives under OR[0] (issue #1254): the
    // query is (holding status) OR (request-converted PENDING).
    expect(prismaMocks.bookingFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: expect.arrayContaining([
            expect.objectContaining({
              status: { in: expect.arrayContaining([BookingStatus.PAID]) },
            }),
          ]),
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
      "lodge-1",
      dateOnly(2026, 6, 10),
      dateOnly(2026, 6, 12),
      LODGE_CAPACITY - 4
    );

    expect(prismaMocks.bookingFindMany).toHaveBeenCalledWith(
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
    expect(result.minAvailable).toBe(LODGE_CAPACITY - 4);
    expect(result.nightDetails.map((night) => night.occupiedBeds)).toEqual([
      4,
      4,
    ]);
  });

  it("excludes bare PENDING from the capacity-holding query; only request-converted PENDING holds (issue #737 refined by #1254)", async () => {
    prismaMocks.bookingFindMany.mockResolvedValueOnce([]);

    await checkCapacity("lodge-1", dateOnly(2026, 6, 10), dateOnly(2026, 6, 12), 1);

    // Holding is now (holding status) OR (PENDING AND request-converted).
    const call = prismaMocks.bookingFindMany.mock.calls[0][0] as {
      where: {
        OR: Array<{
          status?: { in: BookingStatus[] } | BookingStatus;
          originBookingRequest?: { isNot: null };
        }>;
      };
    };
    const orBranches = call.where.OR;

    // Branch 1: capacity-holding statuses. PENDING must NOT be among them.
    const statusBranch = orBranches.find(
      (branch) =>
        branch.status &&
        typeof branch.status === "object" &&
        "in" in branch.status
    ) as { status: { in: BookingStatus[] } } | undefined;
    expect(statusBranch).toBeDefined();
    expect(statusBranch!.status.in).not.toContain(BookingStatus.PENDING);
    expect(statusBranch!.status.in).toEqual(
      expect.arrayContaining([
        BookingStatus.PAID,
        BookingStatus.COMPLETED,
        BookingStatus.CONFIRMED,
        BookingStatus.AWAITING_REVIEW,
      ])
    );

    // Branch 2: bare PENDING only holds when it is a converted booking request
    // (originBookingRequest set) — generic PENDING (#737) still never holds.
    const pendingBranch = orBranches.find(
      (branch) => branch.status === BookingStatus.PENDING
    ) as
      | { status: BookingStatus; originBookingRequest: { isNot: null } }
      | undefined;
    expect(pendingBranch).toBeDefined();
    expect(pendingBranch!.originBookingRequest).toEqual({ isNot: null });
  });

  it("uses PAID operational bookings for lodge guest lookup and roster validation", async () => {
    prismaMocks.bookingGuestFindFirst.mockResolvedValueOnce({
      id: "guest-1",
      bookingId: "booking-1",
      arrivedAt: null,
      departedAt: null,
      // #2628: the arrive lookup loads the stay bounds and the night rows so it
      // can tell a first arrival from a return, so the double carries them —
      // the 10th and the 11th, exactly what the envelope below describes.
      stayStart: dateOnly(2026, 6, 10),
      stayEnd: dateOnly(2026, 6, 12),
      nights: [
        { stayDate: dateOnly(2026, 6, 10) },
        { stayDate: dateOnly(2026, 6, 11) },
      ],
    });
    prismaMocks.bookingGuestFindMany.mockResolvedValueOnce([
      {
        id: "guest-1",
        bookingId: "booking-1",
        stayStart: dateOnly(2026, 6, 10),
        stayEnd: dateOnly(2026, 6, 12),
        // #2628: roster validation decides from the night rows it loads, so
        // this double lists the two nights its envelope describes.
        nights: [
          { stayDate: dateOnly(2026, 6, 10) },
          { stayDate: dateOnly(2026, 6, 11) },
        ],
        booking: {
          checkIn: dateOnly(2026, 6, 10),
          checkOut: dateOnly(2026, 6, 12),
        },
      },
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
          // #2622: roster validation is checkout-INCLUSIVE — a guest who leaves
          // this morning may legitimately hold a chore today. The arrive lookup
          // above stays night-only and keeps its `gt`; only the roster question
          // moved to the operational day. What this test is pinning — that PAID
          // and CONFIRMED are both operational statuses — is unchanged.
          stayEnd: { gte: dateOnly(2026, 6, 10) },
          booking: expect.objectContaining({
            status: { in: expect.arrayContaining([BookingStatus.PAID]) },
          }),
        }),
      })
    );
  });
});
