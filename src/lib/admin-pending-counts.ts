import { prisma } from "@/lib/prisma";
import { buildBookingRequestListWhere } from "@/lib/booking-request";
import { getPendingMembershipCancellationReviewCount } from "@/lib/membership-cancellation-admin";
import {
  getPendingMemberArchiveReviewCount,
  getPendingMemberDeleteReviewCount,
} from "@/lib/member-lifecycle-actions";
import { getUnassignedHutLeaderDates } from "@/lib/hut-leader-coverage";
import { OPEN_DELETION_REQUEST_STATUSES } from "@/lib/deletion-request-decision";
import { REVIEWED_REQUEST_TYPES } from "@/lib/admin-family-group-requests-service";
import {
  buildUnpaidFinishedStaysWhere,
  buildUnsettledAdditionalFinishedStaysWhere,
  buildUnsettledAdditionalUpcomingStaysWhere,
} from "@/lib/unpaid-finished-stays";
import { clubTodayDateOnlyInstant } from "@/lib/club-time/server";

export type AdminPendingCounts = {
  familyRequests: number;
  memberApplications: number;
  refundAppeals: number;
  /** B5 (#2262): open hand-back tasks for cancelled cash-settled bookings. */
  manualRefundTasks: number;
  creditApprovals: number;
  bookingReviews: number;
  bookingChangeRequests: number;
  /**
   * #2526: NEW-booking policy-exception requests awaiting a Booking Officer.
   * Counted separately because they live in their own table — a MODIFICATION
   * exception request is a `BookingChangeRequest` and is already inside
   * `bookingChangeRequests` above. The sidebar sums the two, so a member waiting
   * on either kind raises the same badge.
   */
  newBookingPolicyExceptionRequests: number;
  publicBookingRequests: number;
  unpaidFinishedStays: number;
  unsettledAdditionalFinishedStays: number;
  /**
   * #2350: the same uncollected addition on a stay that has not finished yet.
   * Disjoint from the finished count above, so the sidebar badge sums the pair.
   */
  unsettledAdditionalUpcomingStays: number;
  membershipCancellations: number;
  archiveRequests: number;
  deletionRequests: number;
  memberDeleteRequests: number;
  issueReports: number;
  /**
   * Uncovered LODGE-nights, not calendar dates (#2917): each lodge runs its own
   * hut leader, so a night on which two lodges both lack one is two pieces of
   * work and the sidebar badge counts two. Identical to the old number on a
   * single-lodge club.
   */
  unassignedHutLeaderDates: number;
};

/**
 * All admin queue counts in one query batch, for the sidebar badges.
 *
 * ponytail: each count mirrors the where-clause of its queue route/service
 * (family-groups/requests, member-applications, refund-requests,
 * manual refund tasks (#2262, the cash hand-back queue),
 * credit-approvals, booking-reviews, booking-change-requests,
 * new-booking policy-exception requests (#2526),
 * booking-requests, unpaid-finished-stays and unsettled stay
 * additions, both finished and still-upcoming (shared helpers with the
 * dashboard cards, #1709/#1731/#1723/#2350),
 * membership-cancellation-requests,
 * member-lifecycle-action-requests (ARCHIVE and DELETE review queues),
 * deletion-requests, issue-reports,
 * hut-leaders/unassigned-dates); update both together if a queue definition
 * changes.
 */
export async function getAdminPendingCounts(): Promise<AdminPendingCounts> {
  // ONE club day for the whole panel. Three of these queues and the hut-leader
  // coverage read are all bounded on today, and three independent reads across
  // this `Promise.all` could straddle club midnight and report counts from two
  // different days beside each other (#3123).
  const today = await clubTodayDateOnlyInstant();
  const [
    familyRequests,
    memberApplications,
    refundAppeals,
    manualRefundTasks,
    creditApprovals,
    bookingReviews,
    bookingChangeRequests,
    newBookingPolicyExceptionRequests,
    publicBookingRequests,
    unpaidFinishedStays,
    unsettledAdditionalFinishedStays,
    unsettledAdditionalUpcomingStays,
    membershipCancellations,
    archiveRequests,
    deletionRequests,
    memberDeleteRequests,
    issueReports,
    unassignedDates,
  ] = await Promise.all([
    prisma.familyGroupJoinRequest.count({
      where: { status: "PENDING", type: { in: [...REVIEWED_REQUEST_TYPES] } },
    }),
    prisma.memberApplication.count({ where: { status: "PENDING_ADMIN" } }),
    prisma.refundRequest.count({ where: { status: "PENDING" } }),
    prisma.manualRefundTask.count({ where: { status: "OPEN" } }),
    prisma.adminCreditAdjustmentRequest.count({ where: { status: "PENDING" } }),
    prisma.booking.count({
      where: { deletedAt: null, adminReviewStatus: "PENDING" },
    }),
    prisma.bookingChangeRequest.count({ where: { status: "REQUESTED" } }),
    prisma.newBookingPolicyExceptionRequest.count({
      where: { status: "REQUESTED" },
    }),
    prisma.bookingRequest.count({
      where: buildBookingRequestListWhere("QUEUE"),
    }),
    prisma.booking.count({
      where: buildUnpaidFinishedStaysWhere(today),
    }),
    prisma.booking.count({
      where: buildUnsettledAdditionalFinishedStaysWhere(today),
    }),
    prisma.booking.count({
      where: buildUnsettledAdditionalUpcomingStaysWhere(today),
    }),
    getPendingMembershipCancellationReviewCount(),
    getPendingMemberArchiveReviewCount(),
    prisma.deletionRequest.count({
      where: { status: { in: OPEN_DELETION_REQUEST_STATUSES } },
    }),
    getPendingMemberDeleteReviewCount(),
    prisma.issueReport.count({ where: { resolvedAt: null } }),
    getUnassignedHutLeaderDates({ today, scope: { kind: "all" } }),
  ]);

  return {
    familyRequests,
    memberApplications,
    refundAppeals,
    manualRefundTasks,
    creditApprovals,
    bookingReviews,
    bookingChangeRequests,
    newBookingPolicyExceptionRequests,
    publicBookingRequests,
    unpaidFinishedStays,
    unsettledAdditionalFinishedStays,
    unsettledAdditionalUpcomingStays,
    membershipCancellations,
    archiveRequests,
    deletionRequests,
    memberDeleteRequests,
    issueReports,
    unassignedHutLeaderDates: unassignedDates.length,
  };
}
