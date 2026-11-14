import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// #4969 review (INV-SSOT): the where-clause behind each Booking Requests queue
// is built once, and the list a tab shows and the count that badges it both
// read it. These pin the clauses themselves, then that the count helper and the
// Approvals list pass exactly the builder's output to Prisma, so narrowing a
// queue in one place cannot leave the other behind.

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  bookingFindMany: vi.fn(),
  bookingCount: vi.fn(),
  bookingChangeRequestCount: vi.fn(),
  newBookingPolicyExceptionRequestCount: vi.fn(),
  bookingRequestCount: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: { findMany: mocks.bookingFindMany, count: mocks.bookingCount },
    bookingChangeRequest: { count: mocks.bookingChangeRequestCount },
    newBookingPolicyExceptionRequest: {
      count: mocks.newBookingPolicyExceptionRequestCount,
    },
    bookingRequest: { count: mocks.bookingRequestCount },
  },
}));

vi.mock("@/lib/session-guards", () => ({
  requireAdmin: vi.fn(async () => ({ ok: true, session: { user: { id: "a1" } } })),
}));

import { getBookingRequestPendingCounts } from "@/lib/admin-booking-request-pending-counts";
import { GET as listBookingReviews } from "@/app/api/admin/booking-reviews/route";
import {
  buildBookingReviewListWhere,
  buildLockedPeriodChangeRequestListWhere,
  buildModificationExceptionQueueWhere,
  buildNewBookingExceptionQueueWhere,
} from "@/lib/booking-request-queue-where";

describe("booking request queue where-builders (#4969)", () => {
  it("Approvals: undeleted bookings in the asked review status, or any review for ALL", () => {
    expect(buildBookingReviewListWhere("PENDING")).toEqual({
      deletedAt: null,
      adminReviewStatus: "PENDING",
    });
    expect(buildBookingReviewListWhere("ALL")).toEqual({
      deletedAt: null,
      adminReviewStatus: { not: null },
    });
  });

  it("Changes: locked-period requests only, whatever the status", () => {
    expect(buildLockedPeriodChangeRequestListWhere("REQUESTED")).toEqual({
      kind: "LOCKED_PERIOD",
      status: "REQUESTED",
    });
    expect(buildLockedPeriodChangeRequestListWhere("ALL")).toEqual({
      kind: "LOCKED_PERIOD",
    });
  });

  it("Policy Exceptions: new-booking requests by status, modification requests by kind and status", () => {
    expect(buildNewBookingExceptionQueueWhere("REQUESTED")).toEqual({
      status: "REQUESTED",
    });
    expect(buildNewBookingExceptionQueueWhere("ALL")).toEqual({});
    expect(buildModificationExceptionQueueWhere("REQUESTED")).toEqual({
      kind: "POLICY_EXCEPTION",
      status: "REQUESTED",
    });
    expect(buildModificationExceptionQueueWhere("ALL")).toEqual({
      kind: "POLICY_EXCEPTION",
    });
  });

  it("the two change-request queues never select the same row", () => {
    // One table, two tabs: a row counted on Changes must not also count on
    // Policy Exceptions, or the sidebar total would count it twice.
    expect(buildLockedPeriodChangeRequestListWhere("ALL").kind).toBe(
      "LOCKED_PERIOD",
    );
    expect(buildModificationExceptionQueueWhere("ALL").kind).toBe(
      "POLICY_EXCEPTION",
    );
  });
});

describe("the counts and the lists read the same clauses (#4969)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.bookingCount.mockResolvedValue(0);
    mocks.bookingFindMany.mockResolvedValue([]);
    mocks.bookingChangeRequestCount.mockResolvedValue(0);
    mocks.newBookingPolicyExceptionRequestCount.mockResolvedValue(0);
    mocks.bookingRequestCount.mockResolvedValue(0);
  });

  it("the pending counts query each queue with its builder's pending clause", async () => {
    await getBookingRequestPendingCounts();

    expect(mocks.bookingCount).toHaveBeenCalledWith({
      where: buildBookingReviewListWhere("PENDING"),
    });
    expect(mocks.bookingChangeRequestCount).toHaveBeenCalledWith({
      where: buildLockedPeriodChangeRequestListWhere("REQUESTED"),
    });
    expect(mocks.bookingChangeRequestCount).toHaveBeenCalledWith({
      where: buildModificationExceptionQueueWhere("REQUESTED"),
    });
    expect(mocks.newBookingPolicyExceptionRequestCount).toHaveBeenCalledWith({
      where: buildNewBookingExceptionQueueWhere("REQUESTED"),
    });
  });

  it.each(["PENDING", "APPROVED", "REJECTED", "ALL"] as const)(
    "the Approvals list, filtered to %s, queries and totals with the builder's clause",
    async (status) => {
      const response = await listBookingReviews(
        new NextRequest(
          `http://localhost/api/admin/booking-reviews?status=${status}`,
        ),
      );

      expect(response.status).toBe(200);
      const where = buildBookingReviewListWhere(status);
      expect(mocks.bookingFindMany).toHaveBeenCalledWith(
        expect.objectContaining({ where }),
      );
      expect(mocks.bookingCount).toHaveBeenCalledWith({ where });
    },
  );
});
