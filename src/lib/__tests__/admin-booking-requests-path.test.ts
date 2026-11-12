import { describe, expect, it } from "vitest";
import {
  bookingRequestsTabCounts,
  firstBookingRequestsTabWithWork,
  totalBookingRequestsPending,
  type BookingRequestsTab,
  type BookingRequestsTabCounts,
} from "@/lib/admin-booking-requests-path";

// Every combination of zero and non-zero across the four tabs, written out so
// the expected landing tab is stated, not re-derived from the rule under test.
const COMBINATIONS: [
  approvals: number,
  changes: number,
  exceptions: number,
  publicRequests: number,
  expected: BookingRequestsTab,
][] = [
  [0, 0, 0, 0, "approvals"],
  [1, 0, 0, 0, "approvals"],
  [0, 2, 0, 0, "changes"],
  [1, 2, 0, 0, "approvals"],
  [0, 0, 3, 0, "exceptions"],
  [1, 0, 3, 0, "approvals"],
  [0, 2, 3, 0, "changes"],
  [1, 2, 3, 0, "approvals"],
  [0, 0, 0, 4, "public"],
  [1, 0, 0, 4, "approvals"],
  [0, 2, 0, 4, "changes"],
  [1, 2, 0, 4, "approvals"],
  [0, 0, 3, 4, "exceptions"],
  [1, 0, 3, 4, "approvals"],
  [0, 2, 3, 4, "changes"],
  [1, 2, 3, 4, "approvals"],
];

describe("firstBookingRequestsTabWithWork (#4969)", () => {
  it.each(COMBINATIONS)(
    "approvals=%i changes=%i exceptions=%i public=%i opens %s",
    (approvals, changes, exceptions, publicRequests, expected) => {
      const counts: BookingRequestsTabCounts = {
        approvals,
        changes,
        exceptions,
        public: publicRequests,
      };

      expect(firstBookingRequestsTabWithWork(counts)).toBe(expected);
    },
  );

  it("stays on approvals when nothing is waiting", () => {
    expect(
      firstBookingRequestsTabWithWork({
        approvals: 0,
        changes: 0,
        exceptions: 0,
        public: 0,
      }),
    ).toBe("approvals");
  });

  it("prefers an earlier tab over a busier later one", () => {
    expect(
      firstBookingRequestsTabWithWork({
        approvals: 0,
        changes: 1,
        exceptions: 9,
        public: 9,
      }),
    ).toBe("changes");
  });
});

describe("bookingRequestsTabCounts (#4969)", () => {
  const pending = {
    bookingReviews: 1,
    lockedPeriodChangeRequests: 2,
    policyExceptionRequests: 3,
    publicBookingRequests: 4,
  };

  it("puts each queue on the tab that lists it", () => {
    expect(bookingRequestsTabCounts(pending)).toEqual({
      approvals: 1,
      changes: 2,
      exceptions: 3,
      public: 4,
    });
  });

  it("adds the tab counts up to the sidebar badge total", () => {
    expect(totalBookingRequestsPending(pending)).toBe(10);
  });
});
