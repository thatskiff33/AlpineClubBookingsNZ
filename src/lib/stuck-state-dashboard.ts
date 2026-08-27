import type { FeatureFlags } from "@/config/schema";
import { CLUB_HUT_LEADER_LABEL } from "@/config/club-identity";
import { formatDateOnly } from "@/lib/date-only";
import { addCalendarDays } from "@/lib/club-time";
import { clubTime } from "@/lib/club-time/server";
import { groupSettlementReapDeadline } from "@/lib/cron-group-settlement-reaper";
import { getAdminAlertDeliveryEscalations } from "@/lib/email-admin-alert-escalation";
import { getExhaustedEmailFailureReviewQueue } from "@/lib/email-failure-review";
import { getEmailDeliverabilityTelemetry } from "@/lib/email-suppression";
import {
  coverageNeedsLodgeContext,
  getUnassignedHutLeaderDates,
} from "@/lib/hut-leader-coverage";
import { countActiveLodges } from "@/lib/lodges";
import {
  getUnreachableMemberSummary,
  UNREACHABLE_MEMBER_REASON_LABEL,
} from "@/lib/member-email-inheritance";
import { countBookingsWithUnnamedPlaceholderGuests } from "@/lib/placeholder-guest-name-reminders";
import { countUnconfirmedSchoolAttendeeLists } from "@/lib/school-attendee-confirmation";
import { loadHutLeaderLookaheadDays } from "@/lib/lodge-settings";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";
import {
  MANUAL_SETTLEMENT_CONFLICT_EVENT_REASON,
  MANUAL_SETTLEMENT_REVERSAL_EVENT_REASON,
} from "@/lib/manual-settlement-reversal-event";
import { MAX_PAYMENT_RECOVERY_ATTEMPTS } from "@/lib/payment-recovery-constants";
import { prisma } from "@/lib/prisma";
import { formatBookingReference } from "@/lib/booking-reference";
import { getBedAllocationDashboard } from "@/lib/bed-allocation-board";
import { parseBedAllocationDateRange } from "@/lib/bed-allocation-date-range";
import { getTokenEmailRecoveryQueue } from "@/lib/token-email-recovery";
import { getWaitlistOfferEmailDeliveries } from "@/lib/waitlist-offer-email-visibility";
import {
  getXeroAdminHealthSnapshot,
  type XeroAdminHealthSnapshot,
} from "@/lib/xero-admin-health";

const PAYMENT_PROCESSING_STALE_MINUTES = 30;
const PAYMENT_PENDING_OVERDUE_MINUTES = 15;
const BED_ALLOCATION_LOOKAHEAD_DAYS = 7;
// #1349 (F2): lookback window for the cancelled-with-unrecorded-refund
// detector. Bounds noise from historical deliberate zero-refund cancellations
// that predate BookingEvent narratives while still catching any recent cancel
// that crashed between its claim commit and the Stripe refund.
const CANCELLED_REFUND_UNRECORDED_LOOKBACK_DAYS = 90;

export type StuckStateSeverity = "critical" | "warning" | "info";

export type StuckStateDomain =
  | "payment"
  | "booking"
  | "xero"
  | "email"
  | "waitlist"
  | "bed_allocation"
  | "lodge";

type StuckStateOwner =
  | "Admin"
  | "Booking Officer"
  | "Finance"
  | "Lodge"
  | "System";

export interface StuckStateItem {
  id: string;
  domain: StuckStateDomain;
  domainLabel: string;
  title: string;
  severity: StuckStateSeverity;
  owner: StuckStateOwner;
  count: number;
  href: string;
  summary: string;
  details?: Array<{
    id: string;
    title: string;
    summary: string;
    href: string;
  }>;
}

interface StuckStateDomainSummary {
  domain: StuckStateDomain;
  label: string;
  count: number;
  itemCount: number;
  critical: number;
  warning: number;
  info: number;
  highestSeverity: StuckStateSeverity | null;
}

export interface StuckStateDashboard {
  generatedAt: string;
  totals: {
    affectedCount: number;
    itemCount: number;
    critical: number;
    warning: number;
    info: number;
  };
  domains: StuckStateDomainSummary[];
  items: StuckStateItem[];
}

type CountDelegate = {
  count(args: unknown): Promise<number>;
};

type FindManyDelegate = {
  findMany(args: unknown): Promise<unknown[]>;
};

type StuckStateDashboardDb = {
  paymentRecoveryOperation: CountDelegate;
  hostingCoverageIncident: CountDelegate & FindManyDelegate;
  booking: FindManyDelegate & CountDelegate;
  groupBookingSettlement: FindManyDelegate;
  issueReport: CountDelegate;
};

type WaitlistOfferBooking = Parameters<
  typeof getWaitlistOfferEmailDeliveries
>[0][number] & {
  waitlistOfferExpiresAt: Date | null;
};

export interface StuckStateDashboardDependencies {
  db: StuckStateDashboardDb;
  loadEffectiveModuleFlags: typeof loadEffectiveModuleFlags;
  getXeroAdminHealthSnapshot: typeof getXeroAdminHealthSnapshot;
  getEmailDeliverabilityTelemetry: typeof getEmailDeliverabilityTelemetry;
  getExhaustedEmailFailureReviewQueue: typeof getExhaustedEmailFailureReviewQueue;
  getAdminAlertDeliveryEscalations: typeof getAdminAlertDeliveryEscalations;
  getTokenEmailRecoveryQueue: typeof getTokenEmailRecoveryQueue;
  getUnreachableMemberSummary: typeof getUnreachableMemberSummary;
  getWaitlistOfferEmailDeliveries: typeof getWaitlistOfferEmailDeliveries;
  countUnconfirmedSchoolAttendeeLists: typeof countUnconfirmedSchoolAttendeeLists;
  countBookingsWithUnnamedPlaceholderGuests: typeof countBookingsWithUnnamedPlaceholderGuests;
  getBedAllocationDashboard: typeof getBedAllocationDashboard;
  getUnassignedHutLeaderDates: typeof getUnassignedHutLeaderDates;
  loadHutLeaderLookaheadDays: typeof loadHutLeaderLookaheadDays;
  /**
   * The club's active-lodge count, for the ADR-002 Presentation Rule on the
   * hut-leader tile (#2917). A bound thunk rather than `typeof
   * countActiveLodges`, because that helper deliberately takes an explicit
   * Prisma client and this module's injected `db` is a narrowed shape.
   */
  countActiveLodges: () => Promise<number>;
}

const DOMAIN_LABELS: Record<StuckStateDomain, string> = {
  payment: "Payment recovery",
  booking: "Bookings",
  xero: "Xero",
  email: "Email",
  waitlist: "Waitlist",
  bed_allocation: "Bed allocation",
  lodge: "Lodge operations",
};

const DOMAIN_ORDER: StuckStateDomain[] = [
  "payment",
  "booking",
  "xero",
  "email",
  "waitlist",
  "bed_allocation",
  "lodge",
];

const SEVERITY_ORDER: Record<StuckStateSeverity, number> = {
  critical: 0,
  warning: 1,
  info: 2,
};

const defaultDependencies: StuckStateDashboardDependencies = {
  db: prisma as unknown as StuckStateDashboardDb,
  loadEffectiveModuleFlags,
  getXeroAdminHealthSnapshot,
  getEmailDeliverabilityTelemetry,
  getExhaustedEmailFailureReviewQueue,
  getAdminAlertDeliveryEscalations,
  getTokenEmailRecoveryQueue,
  getUnreachableMemberSummary,
  getWaitlistOfferEmailDeliveries,
  countUnconfirmedSchoolAttendeeLists,
  countBookingsWithUnnamedPlaceholderGuests,
  getBedAllocationDashboard,
  getUnassignedHutLeaderDates,
  loadHutLeaderLookaheadDays,
  countActiveLodges: () => countActiveLodges(prisma),
};

function plural(count: number, singular: string, pluralForm = `${singular}s`) {
  return count === 1 ? singular : pluralForm;
}

function addItem(
  items: StuckStateItem[],
  item: Omit<StuckStateItem, "domainLabel">,
) {
  if (item.count <= 0) return;
  items.push({
    ...item,
    domainLabel: DOMAIN_LABELS[item.domain],
  });
}

function sortItems(items: StuckStateItem[]) {
  return items.sort((a, b) => {
    const severityDelta = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    if (severityDelta !== 0) return severityDelta;

    const domainDelta =
      DOMAIN_ORDER.indexOf(a.domain) - DOMAIN_ORDER.indexOf(b.domain);
    if (domainDelta !== 0) return domainDelta;

    return a.title.localeCompare(b.title);
  });
}

function highestSeverity(items: StuckStateItem[]): StuckStateSeverity | null {
  if (items.some((item) => item.severity === "critical")) return "critical";
  if (items.some((item) => item.severity === "warning")) return "warning";
  if (items.some((item) => item.severity === "info")) return "info";
  return null;
}

function buildDomains(items: StuckStateItem[]): StuckStateDomainSummary[] {
  return DOMAIN_ORDER.map((domain) => {
    const domainItems = items.filter((item) => item.domain === domain);

    return {
      domain,
      label: DOMAIN_LABELS[domain],
      count: domainItems.reduce((sum, item) => sum + item.count, 0),
      itemCount: domainItems.length,
      critical: domainItems
        .filter((item) => item.severity === "critical")
        .reduce((sum, item) => sum + item.count, 0),
      warning: domainItems
        .filter((item) => item.severity === "warning")
        .reduce((sum, item) => sum + item.count, 0),
      info: domainItems
        .filter((item) => item.severity === "info")
        .reduce((sum, item) => sum + item.count, 0),
      highestSeverity: highestSeverity(domainItems),
    };
  });
}

function buildTotals(items: StuckStateItem[]) {
  return {
    affectedCount: items.reduce((sum, item) => sum + item.count, 0),
    itemCount: items.length,
    critical: items
      .filter((item) => item.severity === "critical")
      .reduce((sum, item) => sum + item.count, 0),
    warning: items
      .filter((item) => item.severity === "warning")
      .reduce((sum, item) => sum + item.count, 0),
    info: items
      .filter((item) => item.severity === "info")
      .reduce((sum, item) => sum + item.count, 0),
  };
}

function buildPaymentItems(items: StuckStateItem[], counts: {
  exhaustedFailed: number;
  staleProcessing: number;
  overduePending: number;
  staleSettlements: number;
  cancelledUnrecordedRefunds: number;
  unexecutedSettlementRefunds: number;
}) {
  addItem(items, {
    id: "payment-group-settlement-refund-unexecuted",
    domain: "payment",
    title: "Unexecuted group settlement refunds",
    severity: "critical",
    owner: "Finance",
    count: counts.unexecutedSettlementRefunds,
    href: "/admin/bookings",
    summary: `${counts.unexecutedSettlementRefunds} cancelled organiser-pays ${plural(
      counts.unexecutedSettlementRefunds,
      "group",
    )} still ${
      counts.unexecutedSettlementRefunds === 1 ? "holds" : "hold"
    } an unexecuted settlement refund plan — the organiser has not been refunded yet; the recovery queue retries it and alerts if retries exhaust.`,
  });
  addItem(items, {
    id: "payment-cancelled-refund-unrecorded",
    domain: "payment",
    title: "Cancelled bookings with unrecorded refunds",
    severity: "critical",
    owner: "Finance",
    count: counts.cancelledUnrecordedRefunds,
    href: "/admin/health",
    summary: `${counts.cancelledUnrecordedRefunds} cancelled ${plural(
      counts.cancelledUnrecordedRefunds,
      "booking",
    )} in the last ${CANCELLED_REFUND_UNRECORDED_LOOKBACK_DAYS} days ${
      counts.cancelledUnrecordedRefunds === 1 ? "holds" : "hold"
    } a captured payment with no recorded refund, no recovery operation, and no cancellation settlement record — the cancel may have crashed before the card refund; verify the member was refunded.`,
  });
  addItem(items, {
    id: "payment-recovery-exhausted",
    domain: "payment",
    title: "Exhausted recovery operations",
    severity: "critical",
    owner: "Finance",
    count: counts.exhaustedFailed,
    href: "/admin/health",
    summary: `${counts.exhaustedFailed} payment recovery ${plural(
      counts.exhaustedFailed,
      "operation",
    )} reached ${MAX_PAYMENT_RECOVERY_ATTEMPTS} attempts and need manual reconciliation.`,
  });
  addItem(items, {
    id: "payment-recovery-stale-processing",
    domain: "payment",
    title: "Stale processing operations",
    severity: "critical",
    owner: "Finance",
    count: counts.staleProcessing,
    href: "/admin/health",
    summary: `${counts.staleProcessing} payment recovery ${plural(
      counts.staleProcessing,
      "operation",
    )} have been processing for more than ${PAYMENT_PROCESSING_STALE_MINUTES} minutes.`,
  });
  addItem(items, {
    id: "payment-group-settlement-stale",
    domain: "payment",
    title: "Stale group settlements",
    severity: "warning",
    owner: "Admin",
    count: counts.staleSettlements,
    href: "/admin/bookings",
    summary: `${counts.staleSettlements} organiser-pays group ${plural(
      counts.staleSettlements,
      "settlement",
    )} are unpaid past the reap deadline and still hold (or recently held) beds; the group-settlement reaper releases them on its next run.`,
  });
  addItem(items, {
    id: "payment-recovery-overdue-pending",
    domain: "payment",
    title: "Overdue pending operations",
    severity: "warning",
    owner: "Finance",
    count: counts.overduePending,
    href: "/admin/health",
    summary: `${counts.overduePending} payment recovery ${plural(
      counts.overduePending,
      "operation",
    )} are more than ${PAYMENT_PENDING_OVERDUE_MINUTES} minutes past their retry time and have not been claimed.`,
  });
}

function addXeroItems(items: StuckStateItem[], snapshot: XeroAdminHealthSnapshot) {
  addItem(items, {
    id: "xero-failed-operations",
    domain: "xero",
    title: "Failed active outbox operations",
    severity: "critical",
    owner: "Finance",
    count: snapshot.failedOperations.count,
    href: "/admin/xero?section=operations&opStatus=FAILED&opFailureState=ACTIVE",
    summary: `${snapshot.failedOperations.count} active Xero outbox ${plural(
      snapshot.failedOperations.count,
      "operation",
    )} failed and remain replayable or unresolved.`,
  });
  addItem(items, {
    id: "xero-stale-running-operations",
    domain: "xero",
    title: "Stale running outbox operations",
    severity: "critical",
    owner: "Finance",
    count: snapshot.staleRunningOperations.count,
    href: "/admin/xero?section=operations&opStatus=RUNNING",
    summary: `${snapshot.staleRunningOperations.count} Xero outbox ${plural(
      snapshot.staleRunningOperations.count,
      "operation",
    )} have been RUNNING longer than ${snapshot.staleRunningOperations.thresholdMinutes} minutes.`,
  });
  addItem(items, {
    id: "xero-stale-inbound-events",
    domain: "xero",
    title: "Stale inbound events",
    severity: "critical",
    owner: "Finance",
    count: snapshot.staleProcessingInboundEvents.count,
    href: "/admin/xero?section=inbound&inStatus=PROCESSING",
    summary: `${snapshot.staleProcessingInboundEvents.count} inbound Xero ${plural(
      snapshot.staleProcessingInboundEvents.count,
      "event",
    )} have been PROCESSING longer than ${snapshot.staleProcessingInboundEvents.thresholdMinutes} minutes.`,
  });
  addItem(items, {
    id: "xero-missing-invoices",
    domain: "xero",
    title: "Paid bookings missing Xero invoices",
    severity: "critical",
    owner: "Finance",
    count: snapshot.missingInvoices.count,
    href: "/admin/xero",
    summary: `${snapshot.missingInvoices.count} paid ${plural(
      snapshot.missingInvoices.count,
      "booking",
    )} have no completed Xero invoice evidence.`,
  });
  addItem(items, {
    id: "xero-refunds-missing-credit-notes",
    domain: "xero",
    title: "Refunds missing Xero credit notes",
    severity: "critical",
    owner: "Finance",
    count: snapshot.refundsMissingCreditNotes.count,
    href: "/admin/xero",
    summary: `${snapshot.refundsMissingCreditNotes.count} refunded Stripe ${plural(
      snapshot.refundsMissingCreditNotes.count,
      "payment",
    )} are older than ${snapshot.refundsMissingCreditNotes.graceHours} hours and still missing Xero refund credit notes.`,
  });
  addItem(items, {
    id: "xero-contact-link-mismatches",
    domain: "xero",
    title: "Contact link mismatches",
    severity: "warning",
    owner: "Finance",
    count: snapshot.contactLinkMismatches.count,
    href: "/admin/xero",
    summary: `${snapshot.contactLinkMismatches.count} member/Xero contact ${plural(
      snapshot.contactLinkMismatches.count,
      "link",
    )} disagree with cached Xero contact evidence.`,
  });
  addItem(items, {
    id: "xero-contact-group-mismatches",
    domain: "xero",
    title: "Contact group mismatches",
    severity: "warning",
    owner: "Finance",
    count: snapshot.contactGroupMismatches.count,
    href: "/admin/xero",
    summary: `${snapshot.contactGroupMismatches.count} active member ${plural(
      snapshot.contactGroupMismatches.count,
      "contact group",
    )} need Xero age-tier group repair.`,
  });

  if (
    snapshot.apiBudget.status === "critical" ||
    snapshot.apiBudget.status === "exhausted" ||
    snapshot.apiBudget.status === "warning"
  ) {
    addItem(items, {
      id: "xero-api-budget",
      domain: "xero",
      title: "Xero API budget pressure",
      severity:
        snapshot.apiBudget.status === "warning" ? "warning" : "critical",
      owner: "System",
      count: 1,
      href: "/admin/xero",
      summary: `Xero API budget is ${snapshot.apiBudget.status}${
        snapshot.apiBudget.usagePercent === null
          ? ""
          : ` at ${snapshot.apiBudget.usagePercent}%`
      }.`,
    });
  }
}

async function addEmailItems(
  items: StuckStateItem[],
  deps: StuckStateDashboardDependencies,
  // #2823: whether the caller holds membership:view. The stuck-state dashboard
  // lives in the `support` area behind a bare requireAdmin(), so a support-only
  // admin without membership:view reaches it — but must not be handed the
  // named membership-roll rows below. Fail closed: absent/false ⇒ no names.
  viewerCanViewMembership: boolean,
) {
  const [
    deliverability,
    exhaustedFailures,
    adminAlertDelivery,
    tokenRecovery,
    unreachableMembers,
  ] = await Promise.all([
    deps.getEmailDeliverabilityTelemetry(),
    deps.getExhaustedEmailFailureReviewQueue(),
    deps.getAdminAlertDeliveryEscalations(),
    deps.getTokenEmailRecoveryQueue(),
    deps.getUnreachableMemberSummary(),
  ]);

  // #2716: the accepted cost of direct-parent-only email inheritance, made
  // findable. Where a middle generation has no address the descendant inherits
  // nobody — the correct failure direction, because a gap somebody can see beats
  // a message going somewhere nobody chose, but ONLY while somebody can see it.
  // This is the seeing.
  //
  // WARNING rather than critical, and deliberately so. Nothing is stuck or
  // corrupt: the club simply has no way to reach these members, and the remedy
  // is to ask a person for an address rather than to repair a record. Ranking it
  // beside a failed payment would train admins to scroll past the criticals.
  addItem(items, {
    id: "email-unreachable-members",
    domain: "email",
    title: "Members with no reachable email address",
    severity: "warning",
    owner: "Admin",
    count: unreachableMembers.total,
    href: "/admin/members?contactability=unreachable",
    summary: `${unreachableMembers.total} active ${plural(
      unreachableMembers.total,
      "member",
    )} ${plural(unreachableMembers.total, "has", "have")} no email address the club can send to${
      unreachableMembers.inheritanceUnresolved > 0
        ? `, ${unreachableMembers.inheritanceUnresolved} of them waiting on a parent's address to inherit`
        : ""
    }.`,
    // #2823 privacy gate: the count and the card-level link stay visible to
    // every support-area admin, but the per-member named rows (full name + id +
    // /admin/members/{id} deep link) are the membership roll and are dropped
    // unless the caller also holds membership:view — the same permission
    // /api/admin/members itself requires.
    details: viewerCanViewMembership
      ? unreachableMembers.members.map((member) => ({
          id: member.id,
          title: member.name,
          summary: UNREACHABLE_MEMBER_REASON_LABEL[member.reason],
          href: `/admin/members/${member.id}`,
        }))
      : undefined,
  });

  addItem(items, {
    id: "email-admin-alert-delivery",
    domain: "email",
    title: "Undeliverable admin alerts",
    severity: "critical",
    owner: "System",
    count: adminAlertDelivery.summary.recentCount,
    href: "/admin/email-deliverability",
    summary: `${adminAlertDelivery.summary.recentCount} admin alert ${plural(
      adminAlertDelivery.summary.recentCount,
      "delivery",
      "deliveries",
    )} failed to reach any opted-in admin in the last ${adminAlertDelivery.summary.lookbackDays} days.`,
  });
  addItem(items, {
    id: "email-token-recovery",
    domain: "email",
    title: "Token-bearing lifecycle emails",
    severity: "critical",
    owner: "Admin",
    count: tokenRecovery.summary.activeCount,
    href: "/admin/email-deliverability",
    summary: `${tokenRecovery.summary.activeCount} failed nomination, setup, or cancellation-confirmation ${plural(
      tokenRecovery.summary.activeCount,
      "email",
    )} need a fresh token reissue.`,
  });
  addItem(items, {
    id: "email-exhausted-failures",
    domain: "email",
    title: "Exhausted email retries",
    severity: "warning",
    owner: "Admin",
    count: exhaustedFailures.summary.activeCount,
    href: "/admin/email-deliverability",
    summary: `${exhaustedFailures.summary.activeCount} email ${plural(
      exhaustedFailures.summary.activeCount,
      "failure",
      "failures",
    )} reached ${exhaustedFailures.summary.maxAttempts} attempts and still need operator review.`,
  });
  addItem(items, {
    id: "email-active-suppressions",
    domain: "email",
    title: "Active SES suppressions",
    severity: "warning",
    owner: "Admin",
    count: deliverability.summary.activeCount,
    href: "/admin/email-deliverability",
    summary: `${deliverability.summary.activeCount} recipient ${plural(
      deliverability.summary.activeCount,
      "address",
      "addresses",
    )} are actively suppressed after SES bounce or complaint feedback.`,
  });
}

/**
 * Projection for the waitlist-offer email visibility read (#2258). Declared
 * separately so it can be checked against WaitlistOfferBooking below: the `db`
 * dependency is loosely typed, so an inline select plus a cast would let a
 * dropped column through silently.
 */
const WAITLIST_OFFER_BOOKING_SELECT = {
  id: true,
  status: true,
  waitlistOfferedAt: true,
  waitlistOfferExpiresAt: true,
  // A deliberately-silenced booking is not a delivery failure — unless its
  // offer is still live, which the expiry decides.
  noEmails: true,
  member: { select: { email: true } },
} as const;

async function addWaitlistItems(
  items: StuckStateItem[],
  deps: StuckStateDashboardDependencies,
  now: Date,
) {
  const bookings = (await deps.db.booking.findMany({
    where: {
      status: "WAITLIST_OFFERED",
      deletedAt: null,
    },
    select: WAITLIST_OFFER_BOOKING_SELECT,
    orderBy: [{ waitlistOfferExpiresAt: "asc" }, { createdAt: "asc" }],
    take: 500,
  })) as WaitlistOfferBooking[];
  // #2258: the cast above satisfies the loose `db` dependency type, so it would
  // happily swallow a dropped column. Pin the projection separately: removing a
  // field from the select above (waitlistOfferExpiresAt, noEmails, ...) now
  // fails to compile here instead of silently degrading the board to the
  // benign state.
  void (WAITLIST_OFFER_BOOKING_SELECT satisfies Record<
    keyof Omit<WaitlistOfferBooking, "member">| "member",
    true | { select: { email: true } }
  >);
  const deliveries = await deps.getWaitlistOfferEmailDeliveries(bookings);
  const offerEmailFailures = [...deliveries.values()].filter(
    (delivery) => delivery.needsOperatorAction,
  ).length;
  const expiredOffers = bookings.filter(
    (booking) =>
      booking.waitlistOfferExpiresAt &&
      booking.waitlistOfferExpiresAt.getTime() < now.getTime(),
  ).length;

  addItem(items, {
    id: "waitlist-offer-email-failures",
    domain: "waitlist",
    title: "Offer email recovery",
    severity: "critical",
    owner: "Admin",
    count: offerEmailFailures,
    href: "/admin/waitlist",
    summary: `${offerEmailFailures} active waitlist ${plural(
      offerEmailFailures,
      "offer",
    )} have missing, bounced, or exhausted offer-email delivery, or are silenced by the booking's "No emails" switch while their offer is still live.`,
  });
  addItem(items, {
    id: "waitlist-expired-offers",
    domain: "waitlist",
    title: "Expired offers awaiting expiry",
    severity: "warning",
    owner: "Admin",
    count: expiredOffers,
    href: "/admin/waitlist",
    summary: `${expiredOffers} waitlist ${plural(
      expiredOffers,
      "offer",
    )} expired and still need cron/operator follow-up.`,
  });
}

async function addBedAllocationItems(
  items: StuckStateItem[],
  deps: StuckStateDashboardDependencies,
) {
  // ONE club day for the whole lookahead window, and no `@db.Date` encoding on
  // the way through: every value here is a calendar day, which takes no
  // timezone at all (#3123).
  const clubToday = (await clubTime()).today();
  const range = parseBedAllocationDateRange(
    {
      from: clubToday,
      to: addCalendarDays(clubToday, BED_ALLOCATION_LOOKAHEAD_DAYS),
    },
    clubToday,
  );
  const dashboard = await deps.getBedAllocationDashboard({ range });

  addItem(items, {
    id: "bed-allocation-unallocated",
    domain: "bed_allocation",
    title: "Unallocated guest nights",
    severity: "warning",
    owner: "Lodge",
    count: dashboard.unallocatedGuestNights.length,
    href: "/admin/bed-allocation",
    summary: `${dashboard.unallocatedGuestNights.length} guest ${plural(
      dashboard.unallocatedGuestNights.length,
      "night",
    )} in the next ${BED_ALLOCATION_LOOKAHEAD_DAYS} days still need bed allocation.`,
  });
  addItem(items, {
    id: "bed-allocation-unplaceable",
    domain: "bed_allocation",
    title: "Auto-allocation gaps",
    severity: "critical",
    owner: "Lodge",
    count: dashboard.suggestedUnallocatedGuestNights.length,
    href: "/admin/bed-allocation",
    summary: `${dashboard.suggestedUnallocatedGuestNights.length} guest ${plural(
      dashboard.suggestedUnallocatedGuestNights.length,
      "night",
    )} cannot be placed by the current auto-allocation plan.`,
  });
  addItem(items, {
    id: "bed-allocation-warnings",
    domain: "bed_allocation",
    title: "Allocation warnings",
    severity: "warning",
    owner: "Lodge",
    count: dashboard.warnings.length,
    href: "/admin/bed-allocation",
    summary: `${dashboard.warnings.length} bed allocation ${plural(
      dashboard.warnings.length,
      "warning",
    )} need review for split bookings or minor/adult placement.`,
  });
}

async function addLodgeItems(
  items: StuckStateItem[],
  deps: StuckStateDashboardDependencies,
) {
  const [hutLeaderLookaheadDays, openIssueReports, activeLodgeCount] =
    await Promise.all([
      deps.loadHutLeaderLookaheadDays(),
      deps.db.issueReport.count({
        where: {
          resolvedAt: null,
        },
      }),
      deps.countActiveLodges(),
    ]);
  const unassignedDates = await deps.getUnassignedHutLeaderDates({
    lookAheadDays: hutLeaderLookaheadDays,
    scope: { kind: "all" },
  });

  // Uncovered LODGE-nights (#2917): two lodges uncovered on one night is two
  // rows. The noun follows the CLUB, not the rows — a multi-lodge club counts
  // lodge-nights even on a day when only one lodge is short — so a single-lodge
  // tile is unchanged and a multi-lodge one never changes noun between loads.
  const unassignedNoun = coverageNeedsLodgeContext({
    activeLodgeCount,
    rows: unassignedDates,
  })
    ? "lodge-night"
    : "lodge date";

  addItem(items, {
    id: "lodge-unassigned-hut-leaders",
    domain: "lodge",
    // The title carries the same unit as the summary below it (#2917 review):
    // a heading saying "dates" above a count of lodge-nights is the very
    // conflation this issue exists to remove.
    title: `Unassigned ${CLUB_HUT_LEADER_LABEL.toLowerCase()} ${unassignedNoun}s`,
    severity: "warning",
    owner: "Lodge",
    count: unassignedDates.length,
    href: "/admin/hut-leaders",
    summary: `${unassignedDates.length} upcoming ${plural(
      unassignedDates.length,
      unassignedNoun,
    )} in the next ${hutLeaderLookaheadDays} days with bookings have no ${CLUB_HUT_LEADER_LABEL.toLowerCase()} assigned.`,
  });
  addItem(items, {
    id: "lodge-open-issue-reports",
    domain: "lodge",
    title: "Open issue reports",
    severity: "info",
    owner: "Admin",
    count: openIssueReports,
    href: "/admin/issue-reports",
    summary: `${openIssueReports} member or lodge issue ${plural(
      openIssueReports,
      "report",
    )} remain unresolved.`,
  });
}

async function getPaymentCounts(
  deps: StuckStateDashboardDependencies,
  now: Date,
) {
  const staleProcessingThreshold = new Date(
    now.getTime() - PAYMENT_PROCESSING_STALE_MINUTES * 60 * 1000,
  );
  const pendingOverdueThreshold = new Date(
    now.getTime() - PAYMENT_PENDING_OVERDUE_MINUTES * 60 * 1000,
  );

  // F3 (#1351): a SUCCEEDED settlement under a CANCELLED group whose persisted
  // refund plan was never executed — the organiser's settlement refund has not
  // completed. The recovery queue retries it (and alerts on exhaustion); this
  // tile keeps the state visible to operators the whole time, including for
  // incidents that predate the durable retry.
  const unexecutedSettlementRefunds = (
    (await deps.db.groupBookingSettlement.findMany({
      where: {
        status: "SUCCEEDED",
        groupBooking: { status: "CANCELLED" },
      },
      select: { refundPlan: true },
    })) as Array<{ refundPlan: unknown }>
  ).filter((settlement) => settlement.refundPlan != null).length;

  const staleSettlements = (
    (await deps.db.groupBookingSettlement.findMany({
      where: { status: { in: ["PENDING", "FAILED"] } },
      select: {
        updatedAt: true,
        groupBooking: {
          select: { organiserBooking: { select: { checkIn: true } } },
        },
      },
    })) as Array<{
      updatedAt: Date;
      groupBooking: { organiserBooking: { checkIn: Date } };
    }>
  ).filter(
    (settlement) =>
      now >=
      groupSettlementReapDeadline(
        settlement.updatedAt,
        settlement.groupBooking.organiserBooking.checkIn,
      ),
  ).length;

  const cancelledRefundLookbackThreshold = new Date(
    now.getTime() -
      CANCELLED_REFUND_UNRECORDED_LOOKBACK_DAYS * 24 * 60 * 60 * 1000,
  );

  const [
    exhaustedFailed,
    staleProcessing,
    overduePending,
    cancelledUnrecordedRefunds,
  ] = await Promise.all([
    deps.db.paymentRecoveryOperation.count({
      where: {
        status: "FAILED",
        attempts: { gte: MAX_PAYMENT_RECOVERY_ATTEMPTS },
      },
    }),
    deps.db.paymentRecoveryOperation.count({
      where: {
        status: "PROCESSING",
        processingStartedAt: { lt: staleProcessingThreshold },
      },
    }),
    deps.db.paymentRecoveryOperation.count({
      where: {
        status: "PENDING",
        nextRetryAt: { lte: pendingOverdueThreshold },
      },
    }),
    // #1349 (F2) crash-window detector: a CANCELLED booking that kept a fully
    // captured, unrefunded payment with NO refund-recovery operation and NO
    // cancellation narrative event can only be a cancel that died between the
    // claim commit and Phase 2 (deliberate zero-refund cancels write their
    // CANCELLED BookingEvent; refunds bump refundedAmountCents; the #1349
    // in-transaction enqueue leaves a recovery operation). Before #1349
    // NOTHING fired for this state — the member's refund was silently lost.
    deps.db.booking.count({
      where: {
        status: "CANCELLED",
        deletedAt: null,
        updatedAt: { gte: cancelledRefundLookbackThreshold },
        payment: {
          is: {
            status: "SUCCEEDED",
            refundedAmountCents: 0,
            amountCents: { gt: 0 },
          },
        },
        paymentRecoveryOperations: {
          none: { type: "REFUND_BOOKING_MODIFICATION" },
        },
        events: {
          // #2262 — the two manual-settlement admin markers are stored as
          // CANCELLED events (reversal / reciprocal-fence conflict) but cancel
          // nothing, so they must not count as "the cancel wrote its
          // narrative event" here: a genuinely crashed cancel on a booking
          // that once hit a marker would otherwise be invisible. The DB-level
          // twin of booking-narrative's isManualSettlementMarkerEvent
          // exclusion, keyed on the markers' constant `reason` strings (the
          // snapshot discriminator is not expressible in this relation
          // filter). The OR keeps a NULL-reason genuine cancel event counted —
          // a bare notIn would drop NULL rows under SQL three-valued logic.
          // #2008's duplicate-capture marker does NOT share this shape (it is
          // a REFUNDED event), so it needs no exclusion here.
          none: {
            type: "CANCELLED",
            OR: [
              { reason: null },
              {
                reason: {
                  notIn: [
                    MANUAL_SETTLEMENT_REVERSAL_EVENT_REASON,
                    MANUAL_SETTLEMENT_CONFLICT_EVENT_REASON,
                  ],
                },
              },
            ],
          },
        },
      },
    }),
  ]);

  return {
    exhaustedFailed,
    staleProcessing,
    overduePending,
    staleSettlements,
    cancelledUnrecordedRefunds,
    unexecutedSettlementRefunds,
  };
}

function isModuleEnabled(modules: FeatureFlags, key: keyof FeatureFlags) {
  return Boolean(modules[key]);
}

export async function getStuckStateDashboard(input?: {
  deps?: Partial<StuckStateDashboardDependencies>;
  now?: Date;
  /**
   * #2823: whether the caller holds `{ area: "membership", level: "view" }`.
   * The dashboard is a `support`-area surface, so a support-only admin without
   * membership:view can reach it; when this is false the named member /
   * booking-owner rows are omitted (count and card-level link are always kept).
   * Defaults to false so a caller that forgets to pass it fails closed to no
   * names rather than leaking the membership roll.
   */
  viewerCanViewMembership?: boolean;
}): Promise<StuckStateDashboard> {
  const deps = {
    ...defaultDependencies,
    ...input?.deps,
  };
  const now = input?.now ?? new Date();
  const viewerCanViewMembership = input?.viewerCanViewMembership ?? false;
  const items: StuckStateItem[] = [];

  const [modules, paymentCounts] = await Promise.all([
    deps.loadEffectiveModuleFlags(),
    getPaymentCounts(deps, now),
  ]);

  buildPaymentItems(items, paymentCounts);

  // School attendee lists inside their confirmation window (#1101): the
  // school has been prompted (or is about to be) but has not confirmed who
  // is attending; the chore roster still shows placeholder names.
  const unconfirmedSchoolAttendeeLists =
    await deps.countUnconfirmedSchoolAttendeeLists(now);
  addItem(items, {
    id: "booking-school-attendees-unconfirmed",
    domain: "booking",
    title: "Unconfirmed school attendee lists",
    severity: "warning",
    owner: "Admin",
    count: unconfirmedSchoolAttendeeLists,
    href: "/admin/booking-requests?tab=approvals",
    summary: `${unconfirmedSchoolAttendeeLists} school ${plural(
      unconfirmedSchoolAttendeeLists,
      "booking",
    )} inside the attendee-confirmation window still ${
      unconfirmedSchoolAttendeeLists === 1 ? "needs" : "need"
    } the school contact to confirm who is attending.`,
  });

  // #2550: bookings arriving soon whose party is STILL literally unnamed —
  // "School Child 1", "Guest 2" — read off the guest rows themselves, so it
  // covers school/organisation and member whole-lodge bookings alike. A
  // deliberate sibling of the school tile above rather than a replacement: that
  // one asks whether the school signed the list off, this one asks what the
  // chore roster will actually print at the lodge. Both are visibility only —
  // nothing here withholds a check-in, a confirmation, or a roster.
  //
  // The summary deliberately does NOT promise that every row is being chased.
  // Because this count reads guest rows rather than a request type, it also
  // catches parties no sweep will email: a school list the contact CONFIRMED
  // while leaving the generated names in place (`applySchoolAttendeeConfirmation`
  // accepts `confirm: true` with no `guestUpdates`, and the school sweep filters
  // `attendeesConfirmedAt: null`), and a booking still held for approval, which
  // has no `convertedBookingId` for either sweep to find. Those are precisely
  // the rows an admin must fix by hand, so the copy has to say so.
  const unnamedPlaceholderBookings =
    await deps.countBookingsWithUnnamedPlaceholderGuests(now);
  addItem(items, {
    id: "booking-unnamed-placeholder-guests",
    domain: "booking",
    title: "Bookings with unnamed guests",
    severity: "warning",
    owner: "Admin",
    count: unnamedPlaceholderBookings,
    href: "/admin/bookings",
    summary: `${unnamedPlaceholderBookings} upcoming ${plural(
      unnamedPlaceholderBookings,
      "booking",
    )} still ${
      unnamedPlaceholderBookings === 1 ? "lists" : "list"
    } placeholder guest names ("Guest 2", "School Child 5"), so the chore list and arrival roster would show those instead of real people. Most bookers are chased automatically, but some rows are not — a school list already confirmed with its placeholder names, or a booking still held for approval — so treat this as a list to work through: open the booking and edit the names, which an admin or Booking Officer can always do. The stay is never held up over this.`,
  });

  // #2576 §7 and §16: a CONFIRMED booking at an enforcing lodge that has lost the
  // adult-member cover the club requires. CRITICAL, and that is the owner's word —
  // "appear prominently in the Booking Officer work queue" — because the club is
  // carrying a booking its own rule would refuse, with beds allocated and money
  // taken. Deliberately NOT auto-cancelled (§7, §16 both forbid it), so this queue
  // entry is the whole mechanism by which anybody finds out. Resolved incidents are
  // outside the count: the predicate is the same `resolvedAt: null` the partial
  // unique index uses, so the card and the invariant cannot disagree.
  const [hostingCoverageIncidents, hostingCoverageIncidentRows] =
    await Promise.all([
      deps.db.hostingCoverageIncident.count({
        where: { resolvedAt: null },
      }),
      deps.db.hostingCoverageIncident.findMany({
        where: { resolvedAt: null },
        orderBy: [{ openedAt: "asc" }, { id: "asc" }],
        take: 50,
        select: {
          id: true,
          cause: true,
          openedAt: true,
          evidence: true,
          booking: {
            select: {
              id: true,
              checkIn: true,
              checkOut: true,
              member: { select: { firstName: true, lastName: true } },
              lodge: { select: { name: true } },
            },
          },
        },
      }),
    ]);
  const hostingCoverageDetails = (
    hostingCoverageIncidentRows as Array<{
      id: string;
      cause: string;
      openedAt: Date;
      evidence: unknown;
      booking: {
        id: string;
        checkIn: Date;
        checkOut: Date;
        member: { firstName: string; lastName: string };
        lodge: { name: string } | null;
      };
    }>
  ).map((incident) => {
    const evidence = incident.evidence as { affectedNights?: unknown } | null;
    const nights = Array.isArray(evidence?.affectedNights)
      ? evidence.affectedNights.filter(
          (night): night is string => typeof night === "string",
        )
      : [];
    const ownerName =
      `${incident.booking.member.firstName} ${incident.booking.member.lastName}`.trim();
    return {
      id: incident.id,
      title: `${formatBookingReference(incident.booking.id)} - ${ownerName}`,
      summary:
        `${incident.booking.lodge?.name ?? "Lodge"}; ` +
        `${formatDateOnly(incident.booking.checkIn)} to ${formatDateOnly(incident.booking.checkOut)}; ` +
        `${nights.length} uncovered ${plural(nights.length, "night")}; ` +
        `${incident.cause === "OFFICER_OVERRIDE" ? "officer override" : "system change"}.`,
      href: `/bookings/${incident.booking.id}`,
    };
  });
  addItem(items, {
    id: "booking-hosting-coverage-incidents",
    domain: "booking",
    title: "Bookings without required adult member cover",
    severity: "critical",
    owner: "Booking Officer",
    count: hostingCoverageIncidents,
    href: "/admin/bookings#hosting-coverage-incidents",
    summary: `${hostingCoverageIncidents} confirmed ${plural(
      hostingCoverageIncidents,
      "booking",
    )} ${
      hostingCoverageIncidents === 1 ? "has" : "have"
    } lost the adult member cover this club requires and ${
      hostingCoverageIncidents === 1 ? "needs" : "need"
    } an officer to restore cover, amend the booking, or approve an exception. Beds and payments are untouched.`,
    // #2823 privacy gate: each hosting-coverage row names its booking owner
    // (booking reference - member full name) and deep-links to the booking, so
    // it is membership-roll detail in the same sense as the unreachable-members
    // rows. The count and the card-level link stay for every support-area
    // admin; the named rows are dropped unless the caller holds membership:view.
    details: viewerCanViewMembership ? hostingCoverageDetails : undefined,
  });

  await addEmailItems(items, deps, viewerCanViewMembership);

  if (isModuleEnabled(modules, "xeroIntegration")) {
    addXeroItems(items, await deps.getXeroAdminHealthSnapshot());
  }

  if (isModuleEnabled(modules, "waitlist")) {
    await addWaitlistItems(items, deps, now);
  }

  if (isModuleEnabled(modules, "bedAllocation")) {
    await addBedAllocationItems(items, deps);
  }

  await addLodgeItems(items, deps);

  sortItems(items);

  return {
    generatedAt: now.toISOString(),
    totals: buildTotals(items),
    domains: buildDomains(items),
    items,
  };
}
