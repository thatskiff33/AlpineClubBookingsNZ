import { BookingStatus } from "@prisma/client";
import { describe, expect, it } from "vitest";

import {
  ACTIVE_BOOKING_STATUSES,
  CAPACITY_HOLDING_BOOKING_STATUSES,
  IMMEDIATE_PAYMENT_BOOKING_STATUSES,
  MEMBER_MODIFIABLE_BOOKING_STATUSES,
  OPERATIONAL_STAY_BOOKING_STATUSES,
  PAYMENT_OWED_BOOKING_STATUSES,
  isCapacityHoldingBookingStatus,
  isOperationalStayBookingStatus,
  isPaymentOwedBookingStatus,
} from "@/lib/booking-status";

// Issue #816 booking capacity/waitlist/bed-allocation review:
// the booking-status helper sets each encode a load-bearing invariant
// (capacity holding, payment owed, operational stay, member-editable, etc.).
// This matrix locks their exact membership and the helper functions that read
// them, so a status accidentally added to or dropped from a set fails loudly.
// It complements booking-status-bed-allocation-ownership.test.ts (#813), which
// covers the capacity-vs-bed-allocation boundary.

const sorted = (values: readonly string[]) => [...values].sort();
const ALL_STATUSES = Object.values(BookingStatus);

describe("booking status set matrix (issue #816)", () => {
  it("pins the exact membership of each booking-status set", () => {
    expect(sorted(CAPACITY_HOLDING_BOOKING_STATUSES)).toEqual(
      sorted([
        BookingStatus.PAID,
        BookingStatus.COMPLETED,
        BookingStatus.CONFIRMED,
        BookingStatus.AWAITING_REVIEW,
      ]),
    );
    expect(sorted(PAYMENT_OWED_BOOKING_STATUSES)).toEqual(
      sorted([BookingStatus.PAYMENT_PENDING, BookingStatus.CONFIRMED]),
    );
    expect(sorted(IMMEDIATE_PAYMENT_BOOKING_STATUSES)).toEqual(
      sorted([
        BookingStatus.PAYMENT_PENDING,
        BookingStatus.CONFIRMED,
        BookingStatus.DRAFT,
        BookingStatus.PENDING,
      ]),
    );
    expect(sorted(MEMBER_MODIFIABLE_BOOKING_STATUSES)).toEqual(
      sorted([
        BookingStatus.PENDING,
        BookingStatus.PAYMENT_PENDING,
        BookingStatus.CONFIRMED,
        BookingStatus.PAID,
        BookingStatus.AWAITING_REVIEW,
      ]),
    );
    expect(sorted(OPERATIONAL_STAY_BOOKING_STATUSES)).toEqual(
      sorted([BookingStatus.PAID, BookingStatus.COMPLETED]),
    );
    expect(sorted(ACTIVE_BOOKING_STATUSES)).toEqual(
      sorted([
        BookingStatus.PENDING,
        BookingStatus.PAYMENT_PENDING,
        BookingStatus.CONFIRMED,
        BookingStatus.PAID,
        BookingStatus.AWAITING_REVIEW,
      ]),
    );
  });

  it("keeps the load-bearing cross-set relationships", () => {
    const capacityHolding = new Set<string>(CAPACITY_HOLDING_BOOKING_STATUSES);
    const paymentOwed = new Set<string>(PAYMENT_OWED_BOOKING_STATUSES);

    // An operationally active stay (checked-in / paid) must always hold capacity.
    for (const status of OPERATIONAL_STAY_BOOKING_STATUSES) {
      expect(capacityHolding.has(status)).toBe(true);
    }

    // CONFIRMED is the one status that both owes payment (pay-on-account) and
    // holds capacity; PAYMENT_PENDING owes payment but does NOT hold capacity.
    expect(capacityHolding.has(BookingStatus.CONFIRMED)).toBe(true);
    expect(paymentOwed.has(BookingStatus.CONFIRMED)).toBe(true);
    expect(paymentOwed.has(BookingStatus.PAYMENT_PENDING)).toBe(true);
    expect(capacityHolding.has(BookingStatus.PAYMENT_PENDING)).toBe(false);

    // PENDING never holds capacity (issue #737).
    expect(capacityHolding.has(BookingStatus.PENDING)).toBe(false);
  });

  it("keeps each predicate consistent with its set across every BookingStatus", () => {
    const capacityHolding = new Set<string>(CAPACITY_HOLDING_BOOKING_STATUSES);
    const paymentOwed = new Set<string>(PAYMENT_OWED_BOOKING_STATUSES);
    const operationalStay = new Set<string>(OPERATIONAL_STAY_BOOKING_STATUSES);

    for (const status of ALL_STATUSES) {
      expect(isCapacityHoldingBookingStatus(status)).toBe(
        capacityHolding.has(status),
      );
      expect(isPaymentOwedBookingStatus(status)).toBe(paymentOwed.has(status));
      expect(isOperationalStayBookingStatus(status)).toBe(
        operationalStay.has(status),
      );
    }
  });

  it("only references valid BookingStatus values in every set", () => {
    const valid = new Set<string>(ALL_STATUSES);
    const allReferenced = [
      ...CAPACITY_HOLDING_BOOKING_STATUSES,
      ...PAYMENT_OWED_BOOKING_STATUSES,
      ...IMMEDIATE_PAYMENT_BOOKING_STATUSES,
      ...MEMBER_MODIFIABLE_BOOKING_STATUSES,
      ...OPERATIONAL_STAY_BOOKING_STATUSES,
      ...ACTIVE_BOOKING_STATUSES,
    ];

    expect(allReferenced.filter((status) => !valid.has(status))).toEqual([]);
  });
});
