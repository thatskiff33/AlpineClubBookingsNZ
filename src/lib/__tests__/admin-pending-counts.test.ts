import { describe, expect, it, vi, beforeEach } from "vitest";
import { BookingRequestStatus } from "@prisma/client";

/*
  The three date-bounded queues below are bounded on the CLUB's day, from its
  persisted timezone, never on the container's (#3123). `APP_TIME_ZONE` is pinned
  to `Pacific/Auckland` — what the replaced `getTodayDateOnly()` answered here,
  and this codebase's own fallback — while the persisted club zone is
  `America/Denver`. Under the frozen clock that is 1 July against 30 June, so a
  bound taken from the environment fails these assertions instead of matching
  them. Before #3123 this file compared against `getTodayDateOnly()` itself,
  which agreed with the subject however wrong both were.
*/
vi.mock("server-only", () => ({}));
vi.mock("@/config/operational", () => ({
  APP_CURRENCY: "NZD",
  APP_STRIPE_CURRENCY: "nzd",
  APP_TIME_ZONE: "Pacific/Auckland",
  APP_LOCALE: "en-NZ",
}));

const mocks = vi.hoisted(() => ({
  familyGroupJoinRequestCount: vi.fn(),
  memberApplicationCount: vi.fn(),
  refundRequestCount: vi.fn(),
  manualRefundTaskCount: vi.fn(),
  adminCreditAdjustmentRequestCount: vi.fn(),
  bookingCount: vi.fn(),
  bookingChangeRequestCount: vi.fn(),
  newBookingPolicyExceptionRequestCount: vi.fn(),
  bookingRequestCount: vi.fn(),
  deletionRequestCount: vi.fn(),
  issueReportCount: vi.fn(),
  getPendingMembershipCancellationReviewCount: vi.fn(),
  getPendingMemberArchiveReviewCount: vi.fn(),
  getPendingMemberDeleteReviewCount: vi.fn(),
  getUnassignedHutLeaderDates: vi.fn(),
  clubTimeSettingsFindUnique: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    familyGroupJoinRequest: { count: mocks.familyGroupJoinRequestCount },
    memberApplication: { count: mocks.memberApplicationCount },
    refundRequest: { count: mocks.refundRequestCount },
    manualRefundTask: { count: mocks.manualRefundTaskCount },
    adminCreditAdjustmentRequest: {
      count: mocks.adminCreditAdjustmentRequestCount,
    },
    booking: { count: mocks.bookingCount },
    bookingChangeRequest: { count: mocks.bookingChangeRequestCount },
    newBookingPolicyExceptionRequest: {
      count: mocks.newBookingPolicyExceptionRequestCount,
    },
    bookingRequest: { count: mocks.bookingRequestCount },
    deletionRequest: { count: mocks.deletionRequestCount },
    issueReport: { count: mocks.issueReportCount },
    // Load-bearing: `getClubTimeZone` is fail-soft on a missing delegate and
    // degrades silently to the environment, which is precisely the reading
    // this file must be able to reject (#3123).
    clubTimeSettings: { findUnique: mocks.clubTimeSettingsFindUnique },
  },
}));

vi.mock("@/lib/membership-cancellation-admin", () => ({
  getPendingMembershipCancellationReviewCount:
    mocks.getPendingMembershipCancellationReviewCount,
}));

vi.mock("@/lib/member-lifecycle-actions", () => ({
  getPendingMemberArchiveReviewCount: mocks.getPendingMemberArchiveReviewCount,
  getPendingMemberDeleteReviewCount: mocks.getPendingMemberDeleteReviewCount,
}));

vi.mock("@/lib/hut-leader-coverage", () => ({
  getUnassignedHutLeaderDates: mocks.getUnassignedHutLeaderDates,
}));

import { getAdminPendingCounts } from "@/lib/admin-pending-counts";

/** The club's day at the frozen instant, as Prisma's `@db.Date` encoding. */
const CLUB_DAY = new Date("2026-06-30T00:00:00.000Z");
/** What `Pacific/Auckland` would have said. No bound below may equal this. */
const ENVIRONMENT_DAY = new Date("2026-07-01T00:00:00.000Z");

function persistClubZone(timeZone: string) {
  mocks.clubTimeSettingsFindUnique.mockResolvedValue({
    timeZone,
    updatedByMemberId: null,
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  });
}

describe("getAdminPendingCounts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    persistClubZone("America/Denver");
    mocks.familyGroupJoinRequestCount.mockResolvedValue(1);
    mocks.memberApplicationCount.mockResolvedValue(2);
    mocks.refundRequestCount.mockResolvedValue(3);
    mocks.manualRefundTaskCount.mockResolvedValue(15);
    mocks.adminCreditAdjustmentRequestCount.mockResolvedValue(4);
    // prisma.booking.count backs four queues: pending admin booking reviews,
    // unpaid finished stays (#1731), and the two halves of the unsettled stay
    // additions queue — finished (#1723) and still upcoming (#2350).
    // Discriminate on the where-clause; the additions halves differ only in the
    // direction of their check-out bound.
    mocks.bookingCount.mockImplementation(
      async ({
        where,
      }: {
        where: { status?: unknown; payment?: unknown; checkOut?: { gt?: Date } };
      }) => {
        if (where.payment) return where.checkOut?.gt ? 15 : 13;
        return where.status === "PAYMENT_PENDING" ? 12 : 5;
      },
    );
    mocks.bookingChangeRequestCount.mockResolvedValue(6);
    mocks.newBookingPolicyExceptionRequestCount.mockResolvedValue(16);
    mocks.bookingRequestCount.mockResolvedValue(7);
    mocks.getPendingMembershipCancellationReviewCount.mockResolvedValue(8);
    mocks.getPendingMemberArchiveReviewCount.mockResolvedValue(9);
    mocks.deletionRequestCount.mockResolvedValue(10);
    mocks.getPendingMemberDeleteReviewCount.mockResolvedValue(14);
    mocks.issueReportCount.mockResolvedValue(11);
    // Uncovered lodge-nights (#2917), not bare dates: the SAME night at two
    // lodges is two rows, and the badge counts two — the sidebar number is
    // pieces of work, not calendar days.
    mocks.getUnassignedHutLeaderDates.mockResolvedValue([
      {
        date: "2026-07-04",
        lodgeId: "lodge-a",
        lodgeName: "Alpine Lodge",
        lodgeActive: true,
        bookingCount: 1,
        guestCount: 2,
      },
      {
        date: "2026-07-04",
        lodgeId: "lodge-b",
        lodgeName: "Basin Lodge",
        lodgeActive: true,
        bookingCount: 1,
        guestCount: 1,
      },
    ]);
  });

  it("returns every queue count keyed for the sidebar", async () => {
    expect(await getAdminPendingCounts()).toEqual({
      familyRequests: 1,
      memberApplications: 2,
      refundAppeals: 3,
      manualRefundTasks: 15,
      creditApprovals: 4,
      bookingReviews: 5,
      bookingChangeRequests: 6,
      newBookingPolicyExceptionRequests: 16,
      publicBookingRequests: 7,
      unpaidFinishedStays: 12,
      unsettledAdditionalFinishedStays: 13,
      unsettledAdditionalUpcomingStays: 15,
      membershipCancellations: 8,
      archiveRequests: 9,
      deletionRequests: 10,
      memberDeleteRequests: 14,
      issueReports: 11,
      unassignedHutLeaderDates: 2,
    });
  });

  // These where-clauses mirror the individual queue routes; if one of these
  // assertions fails, the matching route's queue definition changed and
  // admin-pending-counts.ts must be updated with it.
  it("counts with the same where-clauses as the queue routes", async () => {
    await getAdminPendingCounts();

    expect(mocks.familyGroupJoinRequestCount).toHaveBeenCalledWith({
      where: {
        status: "PENDING",
        type: {
          in: [
            "JOIN_REQUEST",
            "CHILD_REQUEST",
            "ADULT_REQUEST",
            "REMOVAL_REQUEST",
            "GROUP_CREATE",
          ],
        },
      },
    });
    expect(mocks.memberApplicationCount).toHaveBeenCalledWith({
      where: { status: "PENDING_ADMIN" },
    });
    expect(mocks.refundRequestCount).toHaveBeenCalledWith({
      where: { status: "PENDING" },
    });
    expect(mocks.adminCreditAdjustmentRequestCount).toHaveBeenCalledWith({
      where: { status: "PENDING" },
    });
    expect(mocks.bookingCount).toHaveBeenCalledWith({
      where: { deletedAt: null, adminReviewStatus: "PENDING" },
    });
    // Unpaid finished stays (#1709/#1731): mirrors the dashboard attention
    // card via the shared src/lib/unpaid-finished-stays.ts predicate.
    expect(mocks.bookingCount).toHaveBeenCalledWith({
      where: {
        deletedAt: null,
        status: "PAYMENT_PENDING",
        checkOut: { lte: CLUB_DAY },
      },
    });
    // Unsettled finished-stay additions (#1723 path 2): mirrors the sibling
    // dashboard card via the same shared module. Statuses deliberately
    // exclude PAYMENT_PENDING so the two booking queues stay disjoint.
    expect(mocks.bookingCount).toHaveBeenCalledWith({
      where: {
        deletedAt: null,
        checkOut: { lte: CLUB_DAY },
        status: { in: ["CONFIRMED", "PAID", "COMPLETED"] },
        payment: {
          is: {
            additionalAmountCents: { gt: 0 },
            OR: [
              { additionalPaymentStatus: null },
              { additionalPaymentStatus: { not: "SUCCEEDED" } },
            ],
          },
        },
      },
    });
    expect(mocks.bookingChangeRequestCount).toHaveBeenCalledWith({
      where: { status: "REQUESTED" },
    });
    expect(mocks.bookingRequestCount).toHaveBeenCalledWith({
      where: {
        status: {
          in: [
            BookingRequestStatus.VERIFIED,
            BookingRequestStatus.PRICED,
            BookingRequestStatus.QUOTED,
            BookingRequestStatus.QUOTE_SENT,
            BookingRequestStatus.QUERY_PENDING,
            BookingRequestStatus.MODIFICATION_REQUESTED,
          ],
        },
      },
    });
    // #2597: a request mid-approval has already cancelled bookings and still
    // owes the member its anonymisation, so it stays in the admin's count.
    expect(mocks.deletionRequestCount).toHaveBeenCalledWith({
      where: { status: { in: ["PENDING", "APPROVAL_IN_PROGRESS"] } },
    });
    expect(mocks.issueReportCount).toHaveBeenCalledWith({
      where: { resolvedAt: null },
    });
  });

  it("bounds every date-sensitive queue on ONE club day, hut-leader coverage included", async () => {
    // Three queues and the coverage read all key on today. Resolved
    // independently they could straddle club midnight and report counts from two
    // different days beside each other in the same sidebar (#3123).
    await getAdminPendingCounts();

    const bounds = mocks.bookingCount.mock.calls
      .map(([args]) => (args as { where: { checkOut?: { lte?: Date } } }).where.checkOut?.lte)
      .filter((bound): bound is Date => bound instanceof Date);
    expect(bounds).toHaveLength(2);
    expect(new Set(bounds.map((bound) => bound.toISOString()))).toEqual(
      new Set([CLUB_DAY.toISOString()]),
    );
    expect(mocks.getUnassignedHutLeaderDates).toHaveBeenCalledWith({
      today: CLUB_DAY,
      scope: { kind: "all" },
    });
  });

  it("moves those bounds when the persisted club zone moves", async () => {
    // Kills a hard-coded `Pacific/Auckland` and every other way of ignoring the
    // stored row. Same clock, same mocks; only the club's zone differs.
    persistClubZone("Pacific/Kiritimati"); // UTC+14 — the club's day is 1 July

    await getAdminPendingCounts();

    expect(mocks.getUnassignedHutLeaderDates).toHaveBeenCalledWith({
      today: ENVIRONMENT_DAY,
      scope: { kind: "all" },
    });
  });

  it("really asks the ClubTimeSettings row for the zone", async () => {
    await getAdminPendingCounts();

    expect(mocks.clubTimeSettingsFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "default" } }),
    );
  });
});
