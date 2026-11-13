/**
 * The officer work queues: the ONE list of everything an administrator must act
 * on (#4962, `INV-SSOT-007` in docs/invariants/single-source-of-truth.md).
 *
 * The Admin Dashboard's attention cards and the sidebar's "Needs Attention"
 * section both render from `ADMIN_WORK_QUEUES`, and the command palette's
 * pre-filtered queue views come from it too. Before this list each surface was
 * wired by hand, one queue at a time, and they drifted: the dashboard never
 * learned about public booking requests, policy exceptions, applications,
 * family requests, issue reports, manual refund tasks, the silent Xero webhook
 * or admin-initiated deletions. A queue added here appears on every surface.
 *
 * Client-safe on purpose: no Prisma, no server-only import. The counts
 * themselves are read on the server by `getAdminPendingCounts`
 * (`src/lib/admin-pending-counts.ts`), one counter per `AdminPendingCountKey`
 * below, and served to the sidebar by `GET /api/admin/pending-counts`.
 *
 * A queue's permission area is NOT stored here. Both surfaces gate a queue on
 * its `href` with `canViewAdminHrefWithMatrix` (and `isFeatureHrefVisible` for
 * module flags), so the route map stays the one answer to "who may open this"
 * — see `isAdminWorkQueueVisible`.
 */
import type { LucideIcon } from "lucide-react";
import {
  AlertTriangle,
  Bell,
  Bug,
  ClipboardList,
  CreditCard,
  DollarSign,
  RotateCcw,
  Trash2,
  UserX,
  Users,
} from "lucide-react";
import { isFeatureHrefVisible } from "@/config/feature-routes";
import type { FeatureFlags } from "@/config/schema";
import { adminHref, adminLink, type AdminPageId } from "@/lib/admin-hubs";
import {
  BOOKING_REQUESTS_TABS,
  buildBookingRequestsHref,
} from "@/lib/admin-booking-requests-path";
import {
  canViewAdminHrefWithMatrix,
  type AdminPermissionMatrix,
} from "@/lib/admin-permissions";
import type { CalendarDate } from "@/lib/club-time";
import {
  buildUnpaidFinishedStaysHref,
  buildUnsettledAdditionalStaysHref,
} from "@/lib/unpaid-finished-stays-hrefs";

/**
 * Every count the queues read, one per server-side counter. A queue sums one or
 * more of them (Booking Requests sums four).
 */
export const ADMIN_PENDING_COUNT_KEYS = [
  "xeroSilentWebhook",
  "familyRequests",
  "memberApplications",
  "refundAppeals",
  /** B5 (#2262): open hand-back tasks for cancelled cash-settled bookings. */
  "manualRefundTasks",
  "creditApprovals",
  "bookingReviews",
  "bookingChangeRequests",
  /**
   * #2526: NEW-booking policy-exception requests. A MODIFICATION exception is a
   * `BookingChangeRequest` and is already inside `bookingChangeRequests`.
   */
  "newBookingPolicyExceptionRequests",
  "publicBookingRequests",
  "unpaidFinishedStays",
  "unsettledAdditionalFinishedStays",
  /** #2350: disjoint from the finished half above, so the queue sums the pair. */
  "unsettledAdditionalUpcomingStays",
  "membershipCancellations",
  "archiveRequests",
  "deletionRequests",
  "memberDeleteRequests",
  "issueReports",
  /** Uncovered LODGE-nights (#2917), not calendar dates. */
  "unassignedHutLeaderDates",
  /** Stuck States' headline: affected items across every stuck-state tile (#4962). */
  "stuckStatesAffected",
] as const;

export type AdminPendingCountKey = (typeof ADMIN_PENDING_COUNT_KEYS)[number];

/**
 * The counts payload. A counter that threw reads 0 and its key is listed in
 * `unavailable`, so one broken queue never blanks the others and a failure is
 * never mistaken for "nothing to do" (#4962).
 */
export type AdminPendingCounts = Record<AdminPendingCountKey, number> & {
  unavailable: AdminPendingCountKey[];
};

export const ZERO_ADMIN_PENDING_COUNTS: AdminPendingCounts = {
  ...(Object.fromEntries(
    ADMIN_PENDING_COUNT_KEYS.map((key) => [key, 0]),
  ) as Record<AdminPendingCountKey, number>),
  unavailable: [],
};

export type AdminWorkQueueTone = "warning" | "danger" | "info";

/** What the dashboard card says beyond the queue's label and number. */
type AdminWorkQueueCard = {
  /** Card heading; the queue's label when omitted. */
  title?: string;
  /** One sentence naming what is waiting, from the counts. */
  describe: (counts: AdminPendingCounts) => string;
  /** A deeper link than the sidebar's (a tab, say); the queue's href when omitted. */
  href?: (counts: AdminPendingCounts, clubToday: CalendarDate) => string;
};

export interface AdminWorkQueue {
  key: string;
  label: string;
  /**
   * Where the queue is worked. Takes the club day because one queue is a dated
   * deep link (#3123): the href and the count beside it must describe the same
   * day, so every surface builds it in the same render from the same value.
   */
  href: (clubToday: CalendarDate) => string;
  icon: LucideIcon;
  /** The counts this queue's number sums. */
  counts: readonly AdminPendingCountKey[];
  tone: AdminWorkQueueTone;
  card: AdminWorkQueueCard;
  /**
   * Set on a queue that is a pre-filtered view of another page rather than a
   * page of its own: the command palette offers it under that page's hub
   * (S2 #4797).
   */
  paletteView?: { page: AdminPageId };
}

function plural(count: number, singular: string, pluralForm = `${singular}s`) {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

/** `parts` with every zero-count part dropped, joined as prose. */
function joinNonZero(parts: ReadonlyArray<readonly [number, string, string?]>) {
  return parts
    .filter(([count]) => count > 0)
    .map(([count, singular, pluralForm]) => plural(count, singular, pluralForm))
    .join(" and ");
}

const BOOKING_REQUEST_TAB_COUNTS = {
  approvals: "bookingReviews",
  changes: "bookingChangeRequests",
  exceptions: "newBookingPolicyExceptionRequests",
  public: "publicBookingRequests",
} as const satisfies Record<
  (typeof BOOKING_REQUESTS_TABS)[number],
  AdminPendingCountKey
>;

/**
 * The queues, in the order both surfaces show them. Adding one here is the
 * whole change for the dashboard, the sidebar and the palette; its counter goes
 * in `getAdminPendingCounts`.
 */
export const ADMIN_WORK_QUEUES: readonly AdminWorkQueue[] = [
  {
    key: "xero-silent-webhook",
    label: "Silent Xero Webhook",
    href: () => adminHref("xero"),
    icon: Bell,
    counts: ["xeroSilentWebhook"],
    tone: "danger",
    card: {
      describe: () =>
        "Xero has not delivered a webhook event for longer than expected. Check the Xero connection and webhook settings.",
    },
  },
  {
    key: "booking-requests",
    label: adminLink("booking-requests").label,
    href: () => adminHref("booking-requests"),
    icon: ClipboardList,
    // #2526: a NEW-booking policy exception lives in its own table, so it is a
    // separate term; a MODIFICATION exception is already a change request.
    counts: [
      "bookingReviews",
      "bookingChangeRequests",
      "newBookingPolicyExceptionRequests",
      "publicBookingRequests",
    ],
    tone: "warning",
    card: {
      describe: (counts) =>
        `${joinNonZero([
          [counts.bookingReviews, "new booking review"],
          [counts.bookingChangeRequests, "change request"],
          [counts.newBookingPolicyExceptionRequests, "policy exception request"],
          [counts.publicBookingRequests, "public booking request"],
        ])} waiting for an officer's decision.`,
      // The first tab with something on it.
      href: (counts) =>
        buildBookingRequestsHref(
          BOOKING_REQUESTS_TABS.find(
            (tab) => counts[BOOKING_REQUEST_TAB_COUNTS[tab]] > 0,
          ) ?? "approvals",
        ),
    },
  },
  {
    // #1709/#1731: the dated deep link and the count share one club day.
    key: "unpaid-finished-stays",
    label: "Unpaid Finished Stays",
    href: (clubToday) => buildUnpaidFinishedStaysHref(clubToday),
    icon: DollarSign,
    counts: ["unpaidFinishedStays"],
    tone: "warning",
    card: {
      describe: (counts) =>
        `${plural(counts.unpaidFinishedStays, "booking")} still payment pending after check-out. Follow up on payment or settle the booking.`,
    },
    paletteView: { page: "bookings" },
  },
  {
    // #1723 path 2, widened by #2350: both halves behind one link.
    key: "unsettled-additions",
    label: "Unpaid Stay Additions",
    href: () => buildUnsettledAdditionalStaysHref(),
    icon: DollarSign,
    counts: [
      "unsettledAdditionalFinishedStays",
      "unsettledAdditionalUpcomingStays",
    ],
    tone: "warning",
    card: {
      title: "Bookings With Unpaid Additions",
      describe: (counts) =>
        `${plural(
          counts.unsettledAdditionalFinishedStays +
            counts.unsettledAdditionalUpcomingStays,
          "confirmed booking",
        )} with an additional payment still owing (${counts.unsettledAdditionalUpcomingStays} upcoming, ${counts.unsettledAdditionalFinishedStays} finished). Collect the outstanding amount or adjust the booking.`,
    },
    paletteView: { page: "bookings" },
  },
  {
    key: "member-applications",
    label: adminLink("member-applications").label,
    href: () => adminHref("member-applications"),
    icon: ClipboardList,
    counts: ["memberApplications"],
    tone: "warning",
    card: {
      title: "Membership Applications",
      describe: (counts) =>
        `${plural(counts.memberApplications, "membership application")} waiting for admin approval.`,
    },
  },
  {
    key: "family-groups",
    label: adminLink("family-groups").label,
    href: () => adminHref("family-groups"),
    icon: Users,
    counts: ["familyRequests"],
    tone: "warning",
    card: {
      title: "Family Group Requests",
      describe: (counts) =>
        `${plural(counts.familyRequests, "family group request")} waiting for admin review.`,
    },
  },
  {
    key: "refund-requests",
    label: adminLink("refund-requests").label,
    href: () => adminHref("refund-requests"),
    icon: RotateCcw,
    counts: ["refundAppeals", "creditApprovals"],
    tone: "danger",
    card: {
      title: "Pending Review Queue",
      describe: (counts) =>
        `${joinNonZero([
          [counts.refundAppeals, "refund appeal"],
          [counts.creditApprovals, "manual credit approval"],
        ])} waiting for admin review.`,
    },
  },
  {
    // B5 (#2262): open cash hand-back tasks live on the payments board, where
    // an admin closes them once the money has actually been paid back. Listed
    // here too so a collapsed Finance section cannot hide them (#4962).
    key: "manual-refund-tasks",
    label: "Manual Refund Tasks",
    href: () => adminHref("payments"),
    icon: CreditCard,
    counts: ["manualRefundTasks"],
    tone: "danger",
    card: {
      describe: (counts) =>
        `${plural(counts.manualRefundTasks, "cash refund")} the club owes back by hand. Pay the member, then close the task on Payments.`,
    },
  },
  {
    key: "membership-cancellations",
    label: adminLink("membership-cancellations").label,
    href: () => adminHref("membership-cancellations"),
    icon: UserX,
    counts: ["membershipCancellations", "archiveRequests"],
    tone: "warning",
    card: {
      title: "Membership Lifecycle Review",
      describe: (counts) =>
        `${joinNonZero([
          [counts.membershipCancellations, "cancellation request"],
          [counts.archiveRequests, "archive request"],
        ])} waiting for admin review.`,
    },
  },
  {
    // The page hosts both flows (#1938): self-service account deletions and
    // admin-initiated hard-delete reviews.
    key: "deletion-requests",
    label: adminLink("deletion-requests").label,
    href: () => adminHref("deletion-requests"),
    icon: Trash2,
    counts: ["deletionRequests", "memberDeleteRequests"],
    tone: "danger",
    card: {
      title: "Account Deletion Requests",
      describe: (counts) =>
        `${joinNonZero([
          [counts.deletionRequests, "account deletion request"],
          [counts.memberDeleteRequests, "admin-initiated member deletion"],
        ])} waiting for admin review.`,
    },
  },
  {
    key: "issue-reports",
    label: adminLink("issue-reports").label,
    href: () => adminHref("issue-reports"),
    icon: Bug,
    counts: ["issueReports"],
    tone: "warning",
    card: {
      describe: (counts) =>
        `${plural(counts.issueReports, "issue report")} not yet resolved.`,
    },
  },
  {
    // Relabelled with the club's hut-leader term where it is shown (#3976).
    key: "hut-leaders",
    label: "Hut Leaders",
    href: () => "/admin/hut-leaders",
    icon: Bell,
    counts: ["unassignedHutLeaderDates"],
    tone: "warning",
    card: {
      describe: (counts) =>
        `${plural(counts.unassignedHutLeaderDates, "upcoming night")} with guests but no leader who counts.`,
    },
  },
  {
    // #4962: Stuck States was counted nowhere, so failed Xero operations,
    // exhausted emails and given-up refunds waited until someone looked.
    key: "stuck-states",
    label: adminLink("stuck-states").label,
    href: () => adminHref("stuck-states"),
    icon: AlertTriangle,
    counts: ["stuckStatesAffected"],
    tone: "danger",
    card: {
      describe: (counts) =>
        `${plural(counts.stuckStatesAffected, "item")} stuck in payments, bookings, Xero, email or lodge operations.`,
    },
  },
];

/** The queue's number: the sum of its counts. */
export function adminWorkQueueCount(
  queue: AdminWorkQueue,
  counts: AdminPendingCounts,
): number {
  return queue.counts.reduce((sum, key) => sum + (counts[key] ?? 0), 0);
}

/** Whether any count behind the queue failed to load. */
export function isAdminWorkQueueUnavailable(
  queue: AdminWorkQueue,
  counts: AdminPendingCounts,
): boolean {
  return queue.counts.some((key) => counts.unavailable.includes(key));
}

/**
 * Whether this viewer is shown the queue at all: its module is on and they may
 * open its page. Both surfaces ask exactly this, the sidebar through
 * `getVisibleAdminNavSections`' per-item filter (the same two predicates on the
 * same href), the dashboard directly.
 */
export function isAdminWorkQueueVisible(
  queue: AdminWorkQueue,
  clubToday: CalendarDate,
  features: FeatureFlags,
  permissionMatrix: AdminPermissionMatrix,
): boolean {
  const href = queue.href(clubToday);
  return (
    isFeatureHrefVisible(href, features) &&
    canViewAdminHrefWithMatrix(permissionMatrix, href)
  );
}

/** Sidebar badge counts by href, for every queue with work in it. */
export function adminWorkQueueBadges(
  clubToday: CalendarDate,
  counts: AdminPendingCounts,
): Record<string, number> {
  const badges: Record<string, number> = {};
  for (const queue of ADMIN_WORK_QUEUES) {
    const count = adminWorkQueueCount(queue, counts);
    if (count > 0) badges[queue.href(clubToday)] = count;
  }
  return badges;
}

/** Each queue's href -> the queue, for one club day. */
export function adminWorkQueuesByHref(
  clubToday: CalendarDate,
): ReadonlyMap<string, AdminWorkQueue> {
  return new Map(ADMIN_WORK_QUEUES.map((queue) => [queue.href(clubToday), queue]));
}
