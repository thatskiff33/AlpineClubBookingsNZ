import { describe, expect, it } from "vitest";
import { BookingStatus } from "@prisma/client";
import { isSplitGuestChild, SPLIT_GUEST_CHILD_WHERE } from "@/lib/split-guest-children";

/**
 * The one rule for which linked bookings are genuine split guest children,
 * shared by the member's "send guest payment link" route and the officer's
 * fresh-copy panel (INV-SSOT).
 */
describe("split guest children", () => {
  const child = {
    parentBookingId: "parent-1",
    status: BookingStatus.PENDING,
    hasNonMembers: true,
    groupBookingJoin: null,
  };

  it("is PENDING, carries non-members and is not a group joiner", () => {
    expect(SPLIT_GUEST_CHILD_WHERE).toEqual({
      status: BookingStatus.PENDING,
      hasNonMembers: true,
      groupBookingJoin: { is: null },
    });
  });

  it("accepts a genuine split child and refuses each way it can differ", () => {
    expect(isSplitGuestChild(child)).toBe(true);
    expect(isSplitGuestChild({ ...child, parentBookingId: null })).toBe(false);
    expect(isSplitGuestChild({ ...child, status: BookingStatus.CONFIRMED })).toBe(false);
    expect(isSplitGuestChild({ ...child, hasNonMembers: false })).toBe(false);
    expect(isSplitGuestChild({ ...child, groupBookingJoin: { id: "join-1" } })).toBe(false);
  });
});
