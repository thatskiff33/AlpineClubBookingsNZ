import { beforeEach, describe, expect, it, vi } from "vitest";
import { BookingStatus } from "@prisma/client";

import {
  bookingHoldsCapacity,
  CAPACITY_HOLDING_BOOKING_STATUSES,
  capacityHoldingBookingFilter,
} from "@/lib/booking-status";

// Behavioural coverage for the quote-hold capacity rule (issue #1254, refining
// #737). "Holds capacity" is NO LONGER a pure function of status: an
// accepted-but-unpaid quote / directly-approved request stays PENDING but must
// reserve its beds, while generic PENDING (split-booking children #738, member
// "only-if-my-guests-come" holds) must stay non-holding and bumpable.
describe("capacityHoldingBookingFilter (issue #1254)", () => {
  const filter = capacityHoldingBookingFilter();
  const orClauses = filter.OR ?? [];

  it("is an OR of the holding-status set, request-converted PENDING, and admin-held PAYMENT_PENDING (#1764)", () => {
    expect(Array.isArray(orClauses)).toBe(true);
    expect(orClauses).toHaveLength(3);
  });

  it("holds capacity for every capacity-holding status", () => {
    const statusClause = orClauses.find(
      (clause) =>
        clause &&
        typeof clause.status === "object" &&
        clause.status !== null &&
        "in" in clause.status,
    );
    expect(statusClause).toBeDefined();
    const held = (statusClause!.status as { in: BookingStatus[] }).in;
    for (const status of CAPACITY_HOLDING_BOOKING_STATUSES) {
      expect(held).toContain(status);
    }
  });

  it("does NOT hold generic PENDING by status alone (#737 preserved)", () => {
    const statusClause = orClauses.find(
      (clause) =>
        clause &&
        typeof clause.status === "object" &&
        clause.status !== null &&
        "in" in clause.status,
    );
    const held = (statusClause!.status as { in: BookingStatus[] }).in;
    expect(held).not.toContain(BookingStatus.PENDING);
  });

  it("holds PENDING only when it is a converted booking request (#1254)", () => {
    const pendingClause = orClauses.find(
      (clause) => clause?.status === BookingStatus.PENDING,
    );
    expect(pendingClause).toEqual({
      status: BookingStatus.PENDING,
      // originBookingRequest set => accepted-but-unpaid quote / approved request.
      originBookingRequest: { isNot: null },
    });
  });
});

describe("bookingHoldsCapacity (per-booking form, issue #1254)", () => {
  it("holds for every capacity-holding status regardless of origin", () => {
    for (const status of CAPACITY_HOLDING_BOOKING_STATUSES) {
      expect(bookingHoldsCapacity({ status })).toBe(true);
      expect(bookingHoldsCapacity({ status, isRequestConverted: false })).toBe(true);
    }
  });

  it("holds a request-converted PENDING booking (accepted-but-unpaid quote)", () => {
    expect(
      bookingHoldsCapacity({ status: BookingStatus.PENDING, isRequestConverted: true }),
    ).toBe(true);
  });

  it("does NOT hold generic PENDING (no origin request) — #737 preserved", () => {
    expect(bookingHoldsCapacity({ status: BookingStatus.PENDING })).toBe(false);
    expect(
      bookingHoldsCapacity({ status: BookingStatus.PENDING, isRequestConverted: false }),
    ).toBe(false);
  });

  it("does NOT hold non-occupying / pre-assignment statuses even if request-derived", () => {
    for (const status of [
      BookingStatus.PAYMENT_PENDING,
      BookingStatus.WAITLIST_OFFERED,
      BookingStatus.DRAFT,
      BookingStatus.CANCELLED,
      BookingStatus.BUMPED,
      BookingStatus.WAITLISTED,
    ]) {
      expect(bookingHoldsCapacity({ status, isRequestConverted: true })).toBe(false);
    }
  });
});

// Prove the availability queries actually apply the filter, so a future refactor
// cannot silently drop the request-converted PENDING hold and re-open the
// overbook-before-payment gap.
const capacityMocks = vi.hoisted(() => ({
  bookingFindMany: vi.fn(),
  clubModuleSettingsFindUnique: vi.fn(),
  lodgeBedCount: vi.fn(),
  // #2286: custodian bed holds. Defaults to none.
  hutLeaderAssignmentFindMany: vi.fn().mockResolvedValue([]),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: { findMany: capacityMocks.bookingFindMany },
    clubModuleSettings: { findUnique: capacityMocks.clubModuleSettingsFindUnique },
    lodgeBed: { count: capacityMocks.lodgeBedCount },
    // #2286: the capacity engines read bed-holding hut-leader assignments
    // (custodian occupancy). No holds by default, so every case below reads
    // exactly as it did before that feature existed.
    hutLeaderAssignment: {
      findMany: capacityMocks.hutLeaderAssignmentFindMany,
    },
  },
}));

import {
  checkCapacity,
  checkCapacityForGuestRanges,
  getMonthAvailability,
} from "@/lib/capacity";
import { parseDateOnly } from "@/lib/date-only";

function whereOf(callIndex = 0) {
  const call = capacityMocks.bookingFindMany.mock.calls[callIndex];
  return (call?.[0] as { where?: Record<string, unknown> })?.where;
}

function expectsRequestConvertedPendingHold(where?: Record<string, unknown>) {
  expect(where).toBeDefined();
  const or = (where as { OR?: unknown[] }).OR;
  expect(Array.isArray(or)).toBe(true);
  expect(or).toContainEqual({
    status: BookingStatus.PENDING,
    originBookingRequest: { isNot: null },
  });
}

describe("capacity queries apply capacityHoldingBookingFilter (issue #1254)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // #2286: no custodian bed holds in these cases.
    capacityMocks.hutLeaderAssignmentFindMany.mockResolvedValue([]);
    capacityMocks.bookingFindMany.mockResolvedValue([]);
    capacityMocks.clubModuleSettingsFindUnique.mockResolvedValue(null);
    capacityMocks.lodgeBedCount.mockResolvedValue(0);
  });

  const checkIn = parseDateOnly("2026-08-01");
  const checkOut = parseDateOnly("2026-08-03");

  it("checkCapacity counts request-converted PENDING holds", async () => {
    await checkCapacity("lodge-1", checkIn, checkOut, 1);
    expectsRequestConvertedPendingHold(whereOf());
  });

  it("checkCapacityForGuestRanges counts request-converted PENDING holds", async () => {
    await checkCapacityForGuestRanges("lodge-1", checkIn, checkOut, [
      { memberId: null, stayStart: checkIn, stayEnd: checkOut },
    ]);
    expectsRequestConvertedPendingHold(whereOf());
  });

  it("getMonthAvailability counts request-converted PENDING holds", async () => {
    await getMonthAvailability("lodge-1", 2026, 7);
    expectsRequestConvertedPendingHold(whereOf());
  });
});
