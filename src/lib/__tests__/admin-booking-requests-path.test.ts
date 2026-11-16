import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  BOOKING_REQUEST_PENDING_COUNTS_PATH,
  bookingRequestsTabCounts,
  firstBookingRequestsTabWithWork,
  readBookingRequestPendingCounts,
  type BookingRequestsTab,
  type BookingRequestsTabCounts,
} from "@/lib/admin-booking-requests-path";
import {
  ADMIN_WORK_QUEUES,
  ZERO_ADMIN_PENDING_COUNTS,
  adminWorkQueueCount,
} from "@/lib/admin-work-queues";

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
    // The sidebar badge is the work queue registry's number (#4962).
    const sidebarQueue = ADMIN_WORK_QUEUES.find((queue) => queue.key === "booking-requests")!;
    expect(
      adminWorkQueueCount(sidebarQueue, { ...ZERO_ADMIN_PENDING_COUNTS, ...pending }),
    ).toBe(10);
  });
});

describe("readBookingRequestPendingCounts (#4969)", () => {
  const pending = {
    bookingReviews: 1,
    lockedPeriodChangeRequests: 2,
    policyExceptionRequests: 3,
    publicBookingRequests: 4,
  };

  it("reads the four counts and drops everything else in the payload", () => {
    expect(
      readBookingRequestPendingCounts({ ...pending, issueReports: 9 }),
    ).toEqual(pending);
  });

  it.each(Object.keys(pending))("rejects a payload missing %s", (field) => {
    const payload: Record<string, unknown> = { ...pending };
    delete payload[field];
    expect(readBookingRequestPendingCounts(payload)).toBeNull();
  });

  it.each(Object.keys(pending))("rejects a payload whose %s is not a number", (field) => {
    expect(
      readBookingRequestPendingCounts({ ...pending, [field]: "3" }),
    ).toBeNull();
  });

  it.each([null, undefined, "counts", 4, []])("rejects %j", (payload) => {
    expect(readBookingRequestPendingCounts(payload)).toBeNull();
  });
});

describe("BOOKING_REQUEST_PENDING_COUNTS_PATH (#4969)", () => {
  it("is a bookings-area API route that exists", () => {
    // The page fetches this path; the route file is the only place that
    // answers it, so a rename of either side fails here, not in a browser.
    expect(BOOKING_REQUEST_PENDING_COUNTS_PATH).toMatch(
      /^\/api\/admin\/booking-requests\//,
    );
    const routeFile = path.join(
      process.cwd(),
      "src/app",
      BOOKING_REQUEST_PENDING_COUNTS_PATH,
      "route.ts",
    );
    expect(fs.existsSync(routeFile)).toBe(true);
  });
});
