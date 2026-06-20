import { BookingStatus } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { CAPACITY_HOLDING_BOOKING_STATUSES } from "@/lib/booking-status";
import { BED_ALLOCATABLE_BOOKING_STATUSES } from "@/lib/bed-allocation-lifecycle";

// Regression coverage for the issue #813 lifecycle review (risk #1):
// bed-allocation eligibility and booking-capacity ownership are two distinct
// status sets, and that distinction must stay deliberate. A booking can occupy
// a per-night BedAllocation row before it holds lodge capacity (operator/admin
// pre-assignment), but anything that *does* hold capacity must always be
// eligible for a bed, and terminal/inactive statuses must hold neither.
//
// These assertions are exhaustive over BookingStatus so that adding a new
// status forces an explicit ownership decision instead of silently inheriting
// one set or the other.

const capacityHolding = new Set<string>(CAPACITY_HOLDING_BOOKING_STATUSES);
const bedAllocatable = new Set<string>(BED_ALLOCATABLE_BOOKING_STATUSES);

// Bed-allocatable but intentionally NOT capacity-holding: provisional or
// offered holds that may be pre-assigned a bed before they commit capacity.
const PRE_ASSIGNMENT_ONLY_STATUSES = [
  BookingStatus.PENDING,
  BookingStatus.PAYMENT_PENDING,
  BookingStatus.WAITLIST_OFFERED,
] as const;

// Neither capacity-holding nor bed-allocatable: drafts, bumped/cancelled, and
// plain waitlisted bookings have no reserved bed and consume no capacity.
const NON_OCCUPYING_STATUSES = [
  BookingStatus.DRAFT,
  BookingStatus.BUMPED,
  BookingStatus.CANCELLED,
  BookingStatus.WAITLISTED,
] as const;

describe("booking capacity vs bed-allocation ownership (issue #813)", () => {
  it("treats every capacity-holding status as bed-allocatable", () => {
    const holdsCapacityButNotAllocatable = [
      ...CAPACITY_HOLDING_BOOKING_STATUSES,
    ].filter((status) => !bedAllocatable.has(status));

    expect(holdsCapacityButNotAllocatable).toEqual([]);
  });

  it("documents the exact set that is bed-allocatable without holding capacity", () => {
    const allocatableButNotCapacityHolding = [
      ...BED_ALLOCATABLE_BOOKING_STATUSES,
    ]
      .filter((status) => !capacityHolding.has(status))
      .sort();

    expect(allocatableButNotCapacityHolding).toEqual(
      [...PRE_ASSIGNMENT_ONLY_STATUSES].sort(),
    );
  });

  it("keeps non-occupying statuses out of both sets", () => {
    for (const status of NON_OCCUPYING_STATUSES) {
      expect(capacityHolding.has(status)).toBe(false);
      expect(bedAllocatable.has(status)).toBe(false);
    }
  });

  it("classifies every BookingStatus into exactly one ownership group", () => {
    const classified = new Set<string>([
      ...CAPACITY_HOLDING_BOOKING_STATUSES,
      ...PRE_ASSIGNMENT_ONLY_STATUSES,
      ...NON_OCCUPYING_STATUSES,
    ]);

    const allStatuses = Object.values(BookingStatus);
    const unclassified = allStatuses.filter((status) => !classified.has(status));

    expect(unclassified).toEqual([]);
    // Groups are disjoint and cover the whole enum.
    expect(classified.size).toBe(allStatuses.length);
  });
});
