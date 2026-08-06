import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Mocks ──────────────────────────────────────────────────────────────────
//
// #2029: the paid -> COMPLETED flip must only fire once the check-out date has
// FULLY passed (NZ time). A booking stays PAID (and therefore editable /
// extendable) through the ENTIRE check-out day; it completes only when the NZ
// calendar date is strictly AFTER `checkOut` (`checkOut < today`), i.e. from the
// first cron run after 11:59pm NZ on the check-out date.
//
// prisma is mocked so the WHERE clause is the unit under test. To pin the
// boundary behaviourally (rather than string-matching the query) the mocked
// `findMany` APPLIES the constructed predicate to an in-memory fixture set, so a
// wrong comparison (`lte`, or filtering on `checkIn`) fails the assertions.

type FixtureBooking = {
  id: string;
  lodgeId: string;
  status: string;
  checkIn: Date;
  checkOut: Date;
};

let fixtures: FixtureBooking[] = [];

const mockFindMany = vi.fn(
  async ({
    where,
    select,
  }: {
    where: {
      status?: string;
      checkOut?: { lt?: Date; lte?: Date; gt?: Date; gte?: Date };
      checkIn?: { lt?: Date; lte?: Date; gt?: Date; gte?: Date };
    };
    select?: Record<string, boolean>;
  }) => {
    const matchRange = (
      value: Date,
      range?: { lt?: Date; lte?: Date; gt?: Date; gte?: Date },
    ) => {
      if (!range) return true;
      if (range.lt && !(value < range.lt)) return false;
      if (range.lte && !(value <= range.lte)) return false;
      if (range.gt && !(value > range.gt)) return false;
      if (range.gte && !(value >= range.gte)) return false;
      return true;
    };

    void select;
    return fixtures.filter(
      (booking) =>
        (where.status === undefined || booking.status === where.status) &&
        matchRange(booking.checkOut, where.checkOut) &&
        matchRange(booking.checkIn, where.checkIn),
    );
  },
);

const mockUpdateMany = vi.fn(async (_args: unknown) => ({ count: 0 }));
const mockFindUnique = vi.fn(async ({ where }: { where: { id: string } }) =>
  fixtures.find((booking) => booking.id === where.id) ?? null,
);
const mockExecuteRaw = vi.fn(async () => undefined);
const txClient = {
  $executeRaw: mockExecuteRaw,
  booking: {
    findUnique: mockFindUnique,
    updateMany: mockUpdateMany,
  },
};
const mockTransaction = vi.fn(
  async (callback: (tx: typeof txClient) => unknown) => callback(txClient),
);

vi.mock("../prisma", () => ({
  prisma: {
    $transaction: (...args: unknown[]) => mockTransaction(...(args as [never])),
    booking: {
      findMany: (...args: unknown[]) => mockFindMany(...(args as [never])),
    },
  },
}));

const mockReconcile = vi.fn(async (_args: unknown) => undefined);
vi.mock("../bed-allocation-lifecycle", () => ({
  reconcileBedAllocationsForBookingWithLodgeLockHeld: (...args: unknown[]) =>
    mockReconcile(...(args as [never])),
}));

const mockAcquireLodgeCapacityLock = vi.fn(async () => undefined);
vi.mock("../capacity", () => ({
  acquireLodgeCapacityLock: (...args: unknown[]) =>
    mockAcquireLodgeCapacityLock(...(args as [never])),
}));

vi.mock("../logger", () => ({
  default: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { completeBookings } from "../cron-complete-bookings";
import {
  addDaysDateOnly,
  getTodayDateOnly,
  parseDateOnly,
} from "../date-only";

const PAID = "PAID";
const CONFIRMED = "CONFIRMED";

beforeEach(() => {
  fixtures = [];
  mockFindMany.mockClear();
  mockFindUnique.mockClear();
  mockUpdateMany.mockClear();
  mockTransaction.mockClear();
  mockExecuteRaw.mockClear();
  mockAcquireLodgeCapacityLock.mockClear();
  mockReconcile.mockClear();
  mockUpdateMany.mockImplementation(async (_args: unknown) => ({ count: 1 }));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("completeBookings — #2029 check-out-day boundary", () => {
  it("keeps a PAID booking whose check-out is TODAY (NZ) un-completed, and completes one whose check-out was yesterday", async () => {
    // Anchor mid-afternoon NZ so UTC and NZ share the calendar date; the
    // dedicated edge test below covers the cross-midnight case.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-18T02:00:00.000Z")); // 14:00 NZ, 2026-07-18

    const today = getTodayDateOnly(); // 2026-07-18 (NZ)
    const yesterday = addDaysDateOnly(today, -1);
    const tomorrow = addDaysDateOnly(today, 1);

    fixtures = [
      // Check-out is TODAY: guests may still be at the lodge — must stay PAID.
      { id: "checkout-today", lodgeId: "lodge-1", status: PAID, checkIn: addDaysDateOnly(today, -2), checkOut: today },
      // Check-out was YESTERDAY: the whole check-out day has passed — complete.
      { id: "checkout-yesterday", lodgeId: "lodge-1", status: PAID, checkIn: addDaysDateOnly(today, -3), checkOut: yesterday },
      // Check-out is in the future — never complete.
      { id: "checkout-future", lodgeId: "lodge-1", status: PAID, checkIn: today, checkOut: tomorrow },
      // Correct check-out but not PAID — never touched by this cron.
      { id: "confirmed-past", lodgeId: "lodge-1", status: CONFIRMED, checkIn: addDaysDateOnly(today, -3), checkOut: yesterday },
    ];

    const result = await completeBookings();

    expect(result.completedBookingIds).toEqual(["checkout-yesterday"]);
    expect(result.completedCount).toBe(1);

    // Only the yesterday-checkout booking is flipped to COMPLETED.
    expect(mockUpdateMany).toHaveBeenCalledTimes(1);
    expect(mockUpdateMany).toHaveBeenCalledWith({
      where: {
        id: "checkout-yesterday",
        status: "PAID",
        checkOut: { lt: today },
      },
      data: { status: "COMPLETED" },
    });
    // And its bed allocations are reconciled with its date envelope.
    expect(mockReconcile).toHaveBeenCalledTimes(1);
    expect(mockReconcile).toHaveBeenCalledWith({
      bookingId: "checkout-yesterday",
      db: txClient,
      previousRange: { checkIn: addDaysDateOnly(today, -3), checkOut: yesterday },
    });
  });

  it("uses the constructed WHERE clause: status PAID and checkOut strictly-less-than NZ today", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-18T02:00:00.000Z"));

    await completeBookings();

    expect(mockFindMany).toHaveBeenCalledTimes(1);
    const where = mockFindMany.mock.calls[0][0].where;
    expect(where.status).toBe("PAID");
    // Strictly-less-than (lt), never lte — an lte would complete on the
    // check-out day itself and re-introduce the #2029 regression.
    expect(where.checkOut).toEqual({ lt: getTodayDateOnly() });
    expect(where.checkIn).toBeUndefined();
  });

  it("resolves the boundary in NZ time, not UTC (post-midnight NZ while UTC is still the previous day)", async () => {
    vi.useFakeTimers();
    // 2026-07-17T12:30Z is 2026-07-18 00:30 in NZ (UTC+12). NZ date is 07-18.
    vi.setSystemTime(new Date("2026-07-17T12:30:00.000Z"));

    // Prove getTodayDateOnly picked the NZ date, not the UTC date.
    expect(getTodayDateOnly()).toEqual(parseDateOnly("2026-07-18"));

    fixtures = [
      // Its NZ check-out day (07-18) is the current NZ day — must stay PAID.
      // A UTC-based boundary (today = 07-17) would wrongly complete this.
      { id: "nz-checkout-today", lodgeId: "lodge-1", status: PAID, checkIn: parseDateOnly("2026-07-15"), checkOut: parseDateOnly("2026-07-18") },
      // Check-out 07-17 is now a full NZ day in the past — complete it.
      { id: "nz-checkout-yesterday", lodgeId: "lodge-1", status: PAID, checkIn: parseDateOnly("2026-07-14"), checkOut: parseDateOnly("2026-07-17") },
    ];

    const result = await completeBookings();

    expect(result.completedBookingIds).toEqual(["nz-checkout-yesterday"]);
    expect(mockFindMany.mock.calls[0][0].where.checkOut).toEqual({
      lt: parseDateOnly("2026-07-18"),
    });
  });

  it("is a no-op (no update / no reconcile) when nothing is due", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-18T02:00:00.000Z"));

    const today = getTodayDateOnly();
    fixtures = [
      { id: "still-staying", lodgeId: "lodge-1", status: PAID, checkIn: addDaysDateOnly(today, -1), checkOut: today },
    ];

    const result = await completeBookings();

    expect(result).toEqual({ completedCount: 0, completedBookingIds: [] });
    expect(mockUpdateMany).not.toHaveBeenCalled();
    expect(mockReconcile).not.toHaveBeenCalled();
  });

  it("does not reconcile or report a candidate that loses the PAID claim", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-18T02:00:00.000Z"));
    const today = getTodayDateOnly();
    fixtures = [
      {
        id: "lost-claim",
        lodgeId: "lodge-1",
        status: PAID,
        checkIn: addDaysDateOnly(today, -3),
        checkOut: addDaysDateOnly(today, -1),
      },
    ];
    mockUpdateMany.mockResolvedValue({ count: 0 });

    await expect(completeBookings()).resolves.toEqual({
      completedCount: 0,
      completedBookingIds: [],
    });
    expect(mockReconcile).not.toHaveBeenCalled();
  });
});
