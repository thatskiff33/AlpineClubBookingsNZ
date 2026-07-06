import { prisma } from "@/lib/prisma";
import { buildBookingRequestListWhere } from "@/lib/booking-request";
import { getPendingMembershipCancellationReviewCount } from "@/lib/membership-cancellation-admin";
import { getPendingMemberArchiveReviewCount } from "@/lib/member-lifecycle-actions";
import { getUnassignedHutLeaderDates } from "@/lib/hut-leader-coverage";
import { REVIEWED_REQUEST_TYPES } from "@/lib/admin-family-group-requests-service";

export type AdminPendingCounts = {
  familyRequests: number;
  memberApplications: number;
  refundAppeals: number;
  creditApprovals: number;
  bookingReviews: number;
  bookingChangeRequests: number;
  publicBookingRequests: number;
  membershipCancellations: number;
  archiveRequests: number;
  deletionRequests: number;
  issueReports: number;
  unassignedHutLeaderDates: number;
};

/**
 * All admin queue counts in one query batch, for the sidebar badges.
 *
 * ponytail: each count mirrors the where-clause of its queue route/service
 * (family-groups/requests, member-applications, refund-requests,
 * credit-approvals, booking-reviews, booking-change-requests,
 * booking-requests, membership-cancellation-requests,
 * member-lifecycle-action-requests, deletion-requests, issue-reports,
 * hut-leaders/unassigned-dates); update both together if a queue definition
 * changes.
 */
export async function getAdminPendingCounts(): Promise<AdminPendingCounts> {
  const [
    familyRequests,
    memberApplications,
    refundAppeals,
    creditApprovals,
    bookingReviews,
    bookingChangeRequests,
    publicBookingRequests,
    membershipCancellations,
    archiveRequests,
    deletionRequests,
    issueReports,
    unassignedDates,
  ] = await Promise.all([
    prisma.familyGroupJoinRequest.count({
      where: { status: "PENDING", type: { in: [...REVIEWED_REQUEST_TYPES] } },
    }),
    prisma.memberApplication.count({ where: { status: "PENDING_ADMIN" } }),
    prisma.refundRequest.count({ where: { status: "PENDING" } }),
    prisma.adminCreditAdjustmentRequest.count({ where: { status: "PENDING" } }),
    prisma.booking.count({
      where: { deletedAt: null, adminReviewStatus: "PENDING" },
    }),
    prisma.bookingChangeRequest.count({ where: { status: "REQUESTED" } }),
    prisma.bookingRequest.count({
      where: buildBookingRequestListWhere("QUEUE"),
    }),
    getPendingMembershipCancellationReviewCount(),
    getPendingMemberArchiveReviewCount(),
    prisma.deletionRequest.count({ where: { status: "PENDING" } }),
    prisma.issueReport.count({ where: { resolvedAt: null } }),
    getUnassignedHutLeaderDates(),
  ]);

  return {
    familyRequests,
    memberApplications,
    refundAppeals,
    creditApprovals,
    bookingReviews,
    bookingChangeRequests,
    publicBookingRequests,
    membershipCancellations,
    archiveRequests,
    deletionRequests,
    issueReports,
    unassignedHutLeaderDates: unassignedDates.length,
  };
}
