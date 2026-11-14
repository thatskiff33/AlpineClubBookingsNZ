import logger from "@/lib/logger";
import { getXeroWebhookHealth } from "@/lib/xero-webhook-health";
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
import { getStuckStateAffectedCount } from "@/lib/stuck-state-affected-count";
import {
  ADMIN_PENDING_COUNT_KEYS,
  type AdminPendingCountKey,
  type AdminPendingCounts,
} from "@/lib/admin-work-queues";

export type { AdminPendingCounts } from "@/lib/admin-work-queues";

type PendingCounter = (context: { today: Date }) => Promise<number>;

/**
 * One counter per count the officer work queues read (`ADMIN_WORK_QUEUES` in
 * `src/lib/admin-work-queues.ts`).
 *
 * ponytail: each counter mirrors the where-clause of its queue route/service
 * (family-groups/requests, member-applications, refund-requests,
 * manual refund tasks (#2262, the cash hand-back queue),
 * credit-approvals, booking-reviews, booking-change-requests,
 * new-booking policy-exception requests (#2526),
 * booking-requests, unpaid-finished-stays and unsettled stay
 * additions, both finished and still-upcoming (shared predicates,
 * #1709/#1731/#1723/#2350),
 * membership-cancellation-requests,
 * member-lifecycle-action-requests (ARCHIVE and DELETE review queues),
 * deletion-requests, issue-reports,
 * hut-leaders/unassigned-dates, the silent Xero webhook, and Stuck States'
 * affected-item headline (#4962)); update both together if a queue definition
 * changes.
 */
const PENDING_COUNTERS = {
  xeroSilentWebhook: async () => ((await getXeroWebhookHealth()).silent ? 1 : 0),
  familyRequests: () =>
    prisma.familyGroupJoinRequest.count({
      where: { status: "PENDING", type: { in: [...REVIEWED_REQUEST_TYPES] } },
    }),
  memberApplications: () =>
    prisma.memberApplication.count({ where: { status: "PENDING_ADMIN" } }),
  refundAppeals: () => prisma.refundRequest.count({ where: { status: "PENDING" } }),
  manualRefundTasks: () =>
    prisma.manualRefundTask.count({ where: { status: "OPEN" } }),
  creditApprovals: () =>
    prisma.adminCreditAdjustmentRequest.count({ where: { status: "PENDING" } }),
  bookingReviews: () =>
    prisma.booking.count({
      where: { deletedAt: null, adminReviewStatus: "PENDING" },
    }),
  bookingChangeRequests: () =>
    prisma.bookingChangeRequest.count({ where: { status: "REQUESTED" } }),
  newBookingPolicyExceptionRequests: () =>
    prisma.newBookingPolicyExceptionRequest.count({
      where: { status: "REQUESTED" },
    }),
  publicBookingRequests: () =>
    prisma.bookingRequest.count({
      where: buildBookingRequestListWhere("QUEUE"),
    }),
  unpaidFinishedStays: ({ today }) =>
    prisma.booking.count({ where: buildUnpaidFinishedStaysWhere(today) }),
  unsettledAdditionalFinishedStays: ({ today }) =>
    prisma.booking.count({
      where: buildUnsettledAdditionalFinishedStaysWhere(today),
    }),
  unsettledAdditionalUpcomingStays: ({ today }) =>
    prisma.booking.count({
      where: buildUnsettledAdditionalUpcomingStaysWhere(today),
    }),
  membershipCancellations: () => getPendingMembershipCancellationReviewCount(),
  archiveRequests: () => getPendingMemberArchiveReviewCount(),
  deletionRequests: () =>
    prisma.deletionRequest.count({
      where: { status: { in: OPEN_DELETION_REQUEST_STATUSES } },
    }),
  memberDeleteRequests: () => getPendingMemberDeleteReviewCount(),
  issueReports: () => prisma.issueReport.count({ where: { resolvedAt: null } }),
  unassignedHutLeaderDates: async ({ today }) =>
    (await getUnassignedHutLeaderDates({ today, scope: { kind: "all" } })).length,
  // Cached for a minute: the sidebar asks on every admin navigation, and the
  // stuck-state scan is many queries (no provider network call).
  stuckStatesAffected: () => getStuckStateAffectedCount(),
} satisfies Record<AdminPendingCountKey, PendingCounter>;

/**
 * Every officer queue count in one batch, for the dashboard cards and the
 * sidebar badges alike.
 *
 * Each counter settles on its own (#4962): one that throws is logged, reads 0,
 * and is named in `unavailable`, so the rest still arrive and the caller can
 * say which number it could not load rather than show a false zero.
 *
 * `today` is ONE club day for the whole panel (#3123): four of these queues
 * are bounded on it, and independent reads across the batch could straddle club
 * midnight. A caller that already holds the day (the dashboard) passes it, so
 * its own cards and these counts describe the same day.
 */
export async function getAdminPendingCounts(input?: {
  today?: Date;
}): Promise<AdminPendingCounts> {
  const today = input?.today ?? (await clubTodayDateOnlyInstant());
  const settled = await Promise.allSettled(
    ADMIN_PENDING_COUNT_KEYS.map((key) => PENDING_COUNTERS[key]({ today })),
  );

  const counts = { unavailable: [] } as unknown as AdminPendingCounts;
  ADMIN_PENDING_COUNT_KEYS.forEach((key, index) => {
    const result = settled[index]!;
    if (result.status === "fulfilled") {
      counts[key] = result.value;
      return;
    }
    counts[key] = 0;
    counts.unavailable.push(key);
    logger.error(
      { err: result.reason, count: key },
      "Admin pending count failed; reporting it as unavailable",
    );
  });
  return counts;
}
