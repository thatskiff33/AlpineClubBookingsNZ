import { beforeEach, describe, expect, it, vi } from "vitest";
import { BookingStatus } from "@prisma/client";

import {
  bookingHoldsCapacity,
  capacityHoldingBookingFilter,
  RELEASE_ADMIN_CAPACITY_HOLD_UPDATE,
  RELEASE_WHOLE_LODGE_HOLD_UPDATE,
} from "@/lib/booking-status";

// Behavioural coverage for the admin capacity hold (issue #1764): a Full
// Admin / Booking Officer can reserve lodge capacity for a PAYMENT_PENDING
// booking without changing its status. The disjunct is status-scoped so a
// cancelled/expired booking with a stale flag never holds, and a booking that
// pays is counted exactly once via the status clause (OR semantics).
describe("capacityHoldingBookingFilter admin-hold disjunct (issue #1764)", () => {
  const filter = capacityHoldingBookingFilter();
  const orClauses = filter.OR ?? [];

  it("is an OR of holding statuses, request-converted PENDING, and admin-held PAYMENT_PENDING", () => {
    expect(Array.isArray(orClauses)).toBe(true);
    expect(orClauses).toHaveLength(3);
  });

  it("holds PAYMENT_PENDING only under an admin capacity hold, status-scoped", () => {
    const adminHoldClause = orClauses.find(
      (clause) => clause?.status === BookingStatus.PAYMENT_PENDING,
    );
    expect(adminHoldClause).toEqual({
      status: BookingStatus.PAYMENT_PENDING,
      adminCapacityHoldAt: { not: null },
    });
  });

  it("does NOT hold PAYMENT_PENDING by status alone (#737 preserved)", () => {
    const statusClause = orClauses.find(
      (clause) =>
        clause &&
        typeof clause.status === "object" &&
        clause.status !== null &&
        "in" in clause.status,
    );
    const held = (statusClause!.status as { in: BookingStatus[] }).in;
    expect(held).not.toContain(BookingStatus.PAYMENT_PENDING);
  });
});

describe("bookingHoldsCapacity admin-hold cases (issue #1764)", () => {
  it("holds an admin-held PAYMENT_PENDING booking", () => {
    expect(
      bookingHoldsCapacity({
        status: BookingStatus.PAYMENT_PENDING,
        hasAdminCapacityHold: true,
      }),
    ).toBe(true);
  });

  it("does NOT hold PAYMENT_PENDING without the admin hold", () => {
    expect(
      bookingHoldsCapacity({ status: BookingStatus.PAYMENT_PENDING }),
    ).toBe(false);
    expect(
      bookingHoldsCapacity({
        status: BookingStatus.PAYMENT_PENDING,
        hasAdminCapacityHold: false,
      }),
    ).toBe(false);
  });

  it("a stale hold flag on a non-PAYMENT_PENDING booking never holds (status-scoped)", () => {
    for (const status of [
      BookingStatus.PENDING,
      BookingStatus.DRAFT,
      BookingStatus.CANCELLED,
      BookingStatus.BUMPED,
      BookingStatus.WAITLISTED,
      BookingStatus.WAITLIST_OFFERED,
    ]) {
      expect(
        bookingHoldsCapacity({ status, hasAdminCapacityHold: true }),
      ).toBe(false);
    }
  });

  it("counts a paid booking with a leftover hold flag exactly once (via status)", () => {
    // OR semantics: the status clause holds; the admin-hold clause is inert.
    expect(
      bookingHoldsCapacity({
        status: BookingStatus.PAID,
        hasAdminCapacityHold: true,
      }),
    ).toBe(true);
  });

  it("RELEASE_ADMIN_CAPACITY_HOLD_UPDATE clears exactly the two hold fields", () => {
    expect(RELEASE_ADMIN_CAPACITY_HOLD_UPDATE).toEqual({
      adminCapacityHoldAt: null,
      adminCapacityHoldByMemberId: null,
    });
  });
});

// Exclusive whole-lodge hold release on terminal transitions (ADR-001, #177).
// The fragment is spread beside RELEASE_ADMIN_CAPACITY_HOLD_UPDATE at every
// terminal transition; its shape is pinned here so the field clearing stays
// exhaustive.
describe("RELEASE_WHOLE_LODGE_HOLD_UPDATE (issue #177)", () => {
  it("clears exactly the flag and the two who/when hold fields", () => {
    expect(RELEASE_WHOLE_LODGE_HOLD_UPDATE).toEqual({
      wholeLodgeHold: false,
      wholeLodgeHoldAt: null,
      wholeLodgeHoldByMemberId: null,
    });
  });

  it("turns the hold OFF so a reinstated booking cannot re-arm a stale hold", () => {
    // A cancelled-then-reinstated booking must start from no hold: the flag is
    // false and the actor/timestamp are null, so a later status flip back to a
    // capacity-holding state can never re-consult a stale actor/audit trail —
    // the officer must re-set the hold deliberately through the audited route.
    expect(RELEASE_WHOLE_LODGE_HOLD_UPDATE.wholeLodgeHold).toBe(false);
    expect(RELEASE_WHOLE_LODGE_HOLD_UPDATE.wholeLodgeHoldByMemberId).toBeNull();
    expect(RELEASE_WHOLE_LODGE_HOLD_UPDATE.wholeLodgeHoldAt).toBeNull();
  });
});

// Prove the availability queries apply the admin-hold disjunct, so an
// admin-held booking's nights are invisible to other bookers on every
// capacity read (availability, month calendar, waitlist processing, stats —
// all read through these helpers).
const capacityMocks = vi.hoisted(() => ({
  bookingFindMany: vi.fn(),
  clubModuleSettingsFindUnique: vi.fn(),
  lodgeBedCount: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: { findMany: capacityMocks.bookingFindMany },
    // #2286: the capacity engines read bed-holding hut-leader assignments
    // (custodian occupancy). None in these cases, so the arithmetic below is
    // exactly what it was before that feature.
    hutLeaderAssignment: { findMany: vi.fn().mockResolvedValue([]) },

    clubModuleSettings: {
      findUnique: capacityMocks.clubModuleSettingsFindUnique,
    },
    lodgeBed: { count: capacityMocks.lodgeBedCount },
  },
}));

import {
  checkCapacity,
  checkCapacityForGuestRanges,
  getMonthAvailability,
} from "@/lib/capacity";
import { FALLBACK_LODGE_CAPACITY } from "@/lib/lodge-capacity";
import { parseDateOnly } from "@/lib/date-only";

function whereOf(callIndex = 0) {
  const call = capacityMocks.bookingFindMany.mock.calls[callIndex];
  return (call?.[0] as { where?: Record<string, unknown> })?.where;
}

function expectsAdminHeldPaymentPendingHold(where?: Record<string, unknown>) {
  expect(where).toBeDefined();
  const or = (where as { OR?: unknown[] }).OR;
  expect(Array.isArray(or)).toBe(true);
  expect(or).toContainEqual({
    status: BookingStatus.PAYMENT_PENDING,
    adminCapacityHoldAt: { not: null },
  });
}

describe("capacity queries count admin-held bookings (issue #1764)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capacityMocks.bookingFindMany.mockResolvedValue([]);
    capacityMocks.clubModuleSettingsFindUnique.mockResolvedValue(null);
    capacityMocks.lodgeBedCount.mockResolvedValue(0);
  });

  const checkIn = parseDateOnly("2026-09-01");
  const checkOut = parseDateOnly("2026-09-03");

  it("checkCapacity counts admin-held PAYMENT_PENDING holds", async () => {
    await checkCapacity("lodge-1", checkIn, checkOut, 1);
    expectsAdminHeldPaymentPendingHold(whereOf());
  });

  it("checkCapacityForGuestRanges counts admin-held PAYMENT_PENDING holds", async () => {
    await checkCapacityForGuestRanges("lodge-1", checkIn, checkOut, [
      { memberId: null, stayStart: checkIn, stayEnd: checkOut },
    ]);
    expectsAdminHeldPaymentPendingHold(whereOf());
  });

  it("getMonthAvailability counts admin-held PAYMENT_PENDING holds", async () => {
    await getMonthAvailability("lodge-1", 2026, 8);
    expectsAdminHeldPaymentPendingHold(whereOf());
  });

  it("an admin-held booking's occupancy blocks an overlapping proposal (held nights invisible to other bookers)", async () => {
    // The one admin-held booking (returned by the holding-population query)
    // fills the whole lodge, so any overlapping proposal must be refused.
    capacityMocks.bookingFindMany.mockResolvedValue([
      {
        checkIn,
        checkOut,
        guests: Array.from({ length: FALLBACK_LODGE_CAPACITY }, () => ({
          stayStart: checkIn,
          stayEnd: checkOut,
          nights: [],
        })),
      },
    ]);

    const result = await checkCapacityForGuestRanges(
      "lodge-1",
      checkIn,
      checkOut,
      [{ memberId: null, stayStart: checkIn, stayEnd: checkOut }],
    );

    expect(result.available).toBe(false);
    expectsAdminHeldPaymentPendingHold(whereOf());
  });
});
