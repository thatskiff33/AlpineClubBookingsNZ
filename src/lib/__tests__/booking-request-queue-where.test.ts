import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { ADMIN_LIST_DEFAULT_PAGE_SIZE } from "@/lib/admin-list-page";

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

  it.each(["PENDING", "APPROVED", "REJECTED"] as const)(
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

  // #5093 pages every queue (INV-OPS-020); the badge must still count what the
  // tab lists across all its pages, never the one page on screen.
  it("badges a queue longer than one page with every pending row, the list's total", async () => {
    mocks.bookingCount.mockResolvedValue(ADMIN_LIST_DEFAULT_PAGE_SIZE + 15);
    const counts = await getBookingRequestPendingCounts();
    expect(counts.bookingReviews).toBe(ADMIN_LIST_DEFAULT_PAGE_SIZE + 15);
    for (const [args] of mocks.bookingCount.mock.calls) {
      expect(args).not.toHaveProperty("take");
      expect(args).not.toHaveProperty("skip");
    }

    const response = await listBookingReviews(
      new NextRequest("http://localhost/api/admin/booking-reviews?status=PENDING&page=1"),
    );
    const body = await response.json();
    expect(mocks.bookingFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: ADMIN_LIST_DEFAULT_PAGE_SIZE, skip: 0 }),
    );
    expect(body.total).toBe(counts.bookingReviews);
    expect(body.pageSize).toBeLessThan(counts.bookingReviews);
  });

  // #5093 reads ALL as two groups so every pending row pages ahead of the
  // decided ones (INV-OPS-020). Pending plus decided is every reviewed booking,
  // the builder's ALL clause, and both groups start from the builder.
  it("the Approvals list, filtered to ALL, reads the builder's pending clause, then the decided rows of its ALL clause", async () => {
    mocks.bookingCount.mockResolvedValue(1);
    const response = await listBookingReviews(
      new NextRequest("http://localhost/api/admin/booking-reviews?status=ALL"),
    );

    expect(response.status).toBe(200);
    const pending = buildBookingReviewListWhere("PENDING");
    const decided = {
      ...buildBookingReviewListWhere("ALL"),
      adminReviewStatus: { in: ["APPROVED", "REJECTED"] },
    };
    for (const where of [pending, decided]) {
      expect(mocks.bookingFindMany).toHaveBeenCalledWith(expect.objectContaining({ where }));
      expect(mocks.bookingCount).toHaveBeenCalledWith({ where });
    }
  });
});
