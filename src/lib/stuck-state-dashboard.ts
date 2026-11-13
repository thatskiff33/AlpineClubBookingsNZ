import type { PaymentRecoveryOperationType, Prisma } from "@prisma/client";
import {
  countExhaustedCashSettlementAlerts,
  listExhaustedCashSettlementAlerts,
} from "@/lib/xero-inbound/cash-settlement-alert-retry";
import { countBankRefundVoidsToAnswer } from "@/lib/bank-refund-void-follow-up";
import type { FeatureFlags } from "@/config/schema";
import { CLUB_HUT_LEADER_LABEL } from "@/config/club-identity";
import { BOOKING_OWNER_NAME_SELECT, bookingOwnerName } from "@/lib/booking-owner-name";
import { listDeadCardRefunds } from "@/lib/card-refund-paid-another-way";
import { clubFormat } from "@/lib/club-format-server";
import { describeHostingCoverageIncidentCause } from "@/lib/adult-member-hosting-coverage-incidents";
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
import {
  countBookingsWithUnnamedPlaceholderGuests,
  listBookingsWithUnnamedPlaceholderGuests,
} from "@/lib/placeholder-guest-name-reminders";
import { countUnconfirmedSchoolAttendeeLists } from "@/lib/school-attendee-confirmation";
import { loadHutLeaderLookaheadDays } from "@/lib/lodge-settings";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";
import { SETTLEMENT_MARKER_EVENT_REASONS } from "@/lib/manual-settlement-reversal-event";
import { MAX_PAYMENT_RECOVERY_ATTEMPTS, PAYMENT_RECOVERY_EXHAUSTED_WHERE } from "@/lib/payment-recovery-constants";
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

import { adminHref, adminAnchorHref } from "@/lib/admin-hubs";
const PAYMENT_PROCESSING_STALE_MINUTES = 30;
const PAYMENT_PENDING_OVERDUE_MINUTES = 15;
const BED_ALLOCATION_LOOKAHEAD_DAYS = 7;
// #1349 (F2): lookback window for the cancelled-with-unrecorded-refund
// detector. Bounds noise from historical deliberate zero-refund cancellations
// that predate BookingEvent narratives while still catching any recent cancel
// that crashed between its claim commit and the Stripe refund.
const CANCELLED_REFUND_UNRECORDED_LOOKBACK_DAYS = 90;
/**
 * #4959: the most named rows one signal lists. Its count stays the full total,
 * and the page says how many more there are.
 */
export const STUCK_STATE_DETAIL_ROW_CAP = 50;

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
  details?: StuckStateDetail[];
}

/** One named row under a signal: a booking, its owner, and a plain line. */
interface StuckStateDetail {
  id: string;
  title: string;
  summary: string;
  href: string;
}

/** How a detail row prints money and an instant (#4959), in the club's format and zone. */
interface StuckStateDetailFormat {
  cents(cents: number): string;
  instantDate(instant: Date): string;
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
  paymentRecoveryOperation: CountDelegate & FindManyDelegate;
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
  /** #4959: the bookings the count above counts; called instead of it when the rows may be shown. */
  listBookingsWithUnnamedPlaceholderGuests: typeof listBookingsWithUnnamedPlaceholderGuests;
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
  /** #4162: how many voided bank refund notes wait for a person (`countBankRefundVoidsToAnswer`). */
  countBankRefundVoidsToAnswer: () => Promise<number>;
  countExhaustedCashSettlementAlerts: () => Promise<number>;
  /** #4959: the oldest exhausted alerts, with their bookings, for the named rows. */
  listExhaustedCashSettlementAlerts: typeof listExhaustedCashSettlementAlerts;
  /**
   * #4959: the recovery operations listed under "Card refunds Stripe gave up
   * on", so an exhausted row can send the officer there. The page passes the
   * list it already read.
   */
  listDeadCardRefundOperationIds: () => Promise<ReadonlySet<string>>;
  /** #4959: the club's money format and zone for the payment rows. */
  loadDetailFormat: () => Promise<StuckStateDetailFormat>;
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
  listBookingsWithUnnamedPlaceholderGuests,
  getBedAllocationDashboard,
  getUnassignedHutLeaderDates,
  loadHutLeaderLookaheadDays,
  countActiveLodges: () => countActiveLodges(prisma),
  countBankRefundVoidsToAnswer,
  countExhaustedCashSettlementAlerts,
  listExhaustedCashSettlementAlerts,
  listDeadCardRefundOperationIds: async () =>
    new Set((await listDeadCardRefunds()).map((row) => row.operationId)),
  loadDetailFormat: async () => {
    const [format, time] = await Promise.all([clubFormat(), clubTime()]);
    return { cents: format.cents, instantDate: time.instantDate };
  },
};

type OwnedBooking = Prisma.BookingGetPayload<{
  select: typeof OWNED_BOOKING_SELECT;
}>;

/** What a named row selects of its booking: the id and the owner's name. */
const OWNED_BOOKING_SELECT = {
  id: true,
  ...BOOKING_OWNER_NAME_SELECT,
} satisfies Prisma.BookingSelect;

/**
 * #4959: one named row — the booking's reference and owner (`bookingOwnerName`,
 * an organisation as well as a member), a plain line, and the booking's page.
 */
function bookingDetailRow(
  id: string,
  booking: OwnedBooking,
  summary: string,
): StuckStateDetail {
  return {
    id,
    title: `${formatBookingReference(booking.id)} - ${bookingOwnerName(booking)}`,
    summary,
    href: `/bookings/${booking.id}`,
  };
}

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

type PaymentSignal =
  | "exhaustedFailed"
  | "staleProcessing"
  | "overduePending"
  | "staleSettlements"
  | "cancelledUnrecordedRefunds"
  | "unexecutedSettlementRefunds";

function buildPaymentItems(
  items: StuckStateItem[],
  counts: Record<PaymentSignal, number>,
  // #4959: undefined unless the viewer may see named payment rows.
  details: Record<PaymentSignal, StuckStateDetail[]> | undefined,
) {
  addItem(items, {
    id: "payment-group-settlement-refund-unexecuted",
    domain: "payment",
    title: "Unexecuted group settlement refunds",
    severity: "critical",
    owner: "Finance",
    count: counts.unexecutedSettlementRefunds,
    href: adminAnchorHref("stuck-states", "payment-group-settlement-refund-unexecuted"),
    summary: `${counts.unexecutedSettlementRefunds} cancelled organiser-pays ${plural(
      counts.unexecutedSettlementRefunds,
      "group",
    )} still ${
      counts.unexecutedSettlementRefunds === 1 ? "holds" : "hold"
    } an unexecuted settlement refund plan — the organiser has not been refunded yet; the recovery queue retries it and alerts if retries exhaust.`,
    details: details?.unexecutedSettlementRefunds,
  });
  addItem(items, {
    id: "payment-cancelled-refund-unrecorded",
    domain: "payment",
    title: "Cancelled bookings with unrecorded refunds",
    severity: "critical",
    owner: "Finance",
    count: counts.cancelledUnrecordedRefunds,
    href: adminAnchorHref("stuck-states", "payment-cancelled-refund-unrecorded"),
    summary: `${counts.cancelledUnrecordedRefunds} cancelled ${plural(
      counts.cancelledUnrecordedRefunds,
      "booking",
    )} in the last ${CANCELLED_REFUND_UNRECORDED_LOOKBACK_DAYS} days ${
      counts.cancelledUnrecordedRefunds === 1 ? "holds" : "hold"
    } a captured payment with no recorded refund, no recovery operation, and no cancellation settlement record — the cancel may have crashed before the card refund; verify the member was refunded.`,
    details: details?.cancelledUnrecordedRefunds,
  });
  addItem(items, {
    id: "payment-recovery-exhausted",
    domain: "payment",
    title: "Exhausted recovery operations",
    severity: "critical",
    owner: "Finance",
    count: counts.exhaustedFailed,
    href: adminAnchorHref("stuck-states", "payment-recovery-exhausted"),
    summary: `${counts.exhaustedFailed} payment recovery ${plural(
      counts.exhaustedFailed,
      "operation",
    )} reached ${MAX_PAYMENT_RECOVERY_ATTEMPTS} attempts, or stopped on a failure a retry cannot fix, and need manual reconciliation. A card refund among them that the member was paid another way can be closed under "Card refunds Stripe gave up on" on this page (Finance view).`,
    details: details?.exhaustedFailed,
  });
  addItem(items, {
    id: "payment-recovery-stale-processing",
    domain: "payment",
    title: "Stale processing operations",
    severity: "critical",
    owner: "Finance",
    count: counts.staleProcessing,
    href: adminHref("background-jobs"),
    summary: `${counts.staleProcessing} payment recovery ${plural(
      counts.staleProcessing,
      "operation",
    )} have been processing for more than ${PAYMENT_PROCESSING_STALE_MINUTES} minutes.`,
    details: details?.staleProcessing,
  });
  addItem(items, {
    id: "payment-group-settlement-stale",
    domain: "payment",
    title: "Stale group settlements",
    severity: "warning",
    owner: "Admin",
    count: counts.staleSettlements,
    href: adminAnchorHref("stuck-states", "payment-group-settlement-stale"),
    summary: `${counts.staleSettlements} organiser-pays group ${plural(
      counts.staleSettlements,
      "settlement",
    )} are unpaid past the reap deadline and still hold (or recently held) beds; the group-settlement reaper releases them on its next run.`,
    details: details?.staleSettlements,
  });
  addItem(items, {
    id: "payment-recovery-overdue-pending",
    domain: "payment",
    title: "Overdue pending operations",
    severity: "warning",
    owner: "Finance",
    count: counts.overduePending,
    href: adminHref("background-jobs"),
    summary: `${counts.overduePending} payment recovery ${plural(
      counts.overduePending,
      "operation",
    )} are more than ${PAYMENT_PENDING_OVERDUE_MINUTES} minutes past their retry time and have not been claimed.`,
    details: details?.overduePending,
  });
}

function addXeroItems(items: StuckStateItem[], snapshot: XeroAdminHealthSnapshot) {
  addItem(items, {
    id: "xero-silent-webhook", domain: "xero", title: "Silent Xero webhook",
    severity: "warning", owner: "Finance", count: snapshot.webhookHealth?.silent ? 1 : 0,
    href: adminHref("xero"), summary: `No webhook received for more than ${snapshot.webhookHealth?.hours} hours. Check the Xero webhook subscription and sync now to catch up.`,
  });
  addItem(items, {
    id: "xero-failed-operations",
    domain: "xero",
    title: "Failed active outbox operations",
    severity: "critical",
    owner: "Finance",
    count: snapshot.failedOperations.count,
    href: `${adminHref("xero")}?section=operations&opStatus=FAILED&opFailureState=ACTIVE`,
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
    href: `${adminHref("xero")}?section=operations&opStatus=RUNNING`,
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
    href: `${adminHref("xero")}?section=inbound&inStatus=PROCESSING`,
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
    href: adminHref("xero"),
    summary: `The club's records hold no Xero invoice for ${snapshot.missingInvoices.count} paid ${plural(
      snapshot.missingInvoices.count,
      "booking",
    )}.`,
  });
  addItem(items, {
    id: "xero-refunds-missing-credit-notes",
    domain: "xero",
    title: "Refunds missing Xero credit notes",
    severity: "critical",
    owner: "Finance",
    count: snapshot.refundsMissingCreditNotes.count,
    href: adminHref("xero"),
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
    href: adminHref("xero"),
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
    href: adminHref("xero"),
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
      href: adminHref("xero"),
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
    href: `${adminHref("members")}?contactability=unreachable`,
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
          href: `${adminHref("member-detail", { id: member.id })}`,
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
    href: adminHref("email-deliverability"),
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
    href: adminHref("email-deliverability"),
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
    href: adminHref("email-deliverability"),
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
    href: adminHref("email-deliverability"),
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
  // #3369: the owner may be an Organisation; bookingOwner() reads both.
  organisation: { select: { name: true, email: true } },
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
    href: adminHref("waitlist"),
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
    href: adminHref("waitlist"),
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
    href: adminHref("bed-allocation"),
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
    href: adminHref("bed-allocation"),
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
    href: adminHref("bed-allocation"),
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
    )} in the next ${hutLeaderLookaheadDays} days with guests have no ${CLUB_HUT_LEADER_LABEL.toLowerCase()} who counts.`,
  });
  addItem(items, {
    id: "lodge-open-issue-reports",
    domain: "lodge",
    title: "Open issue reports",
    severity: "info",
    owner: "Admin",
    count: openIssueReports,
    href: adminHref("issue-reports"),
    summary: `${openIssueReports} member or lodge issue ${plural(
      openIssueReports,
      "report",
    )} remain unresolved.`,
  });
}

/** #4959: what a recovery operation is for, in words an officer reads. */
const RECOVERY_OPERATION_PURPOSE: Record<PaymentRecoveryOperationType, string> = {
  CANCEL_PAYMENT_INTENT: "Cancel an unused card payment",
  REFUND_SUPERSEDED_PAYMENT: "Refund a replaced card payment",
  REFUND_BOOKING_MODIFICATION: "Card refund",
  CREATE_ADDITIONAL_PAYMENT_INTENT: "Create a card request",
};

/**
 * What a recovery operation's named row reads (#4959). Never `lastError`, a
 * Stripe id or an idempotency key: the row names the booking, not the provider.
 */
const RECOVERY_OPERATION_ROW_SELECT = {
  id: true,
  type: true,
  amountCents: true,
  createdAt: true,
  booking: { select: OWNED_BOOKING_SELECT },
} satisfies Prisma.PaymentRecoveryOperationSelect;

type RecoveryOperationRow = Prisma.PaymentRecoveryOperationGetPayload<{
  select: typeof RECOVERY_OPERATION_ROW_SELECT;
}>;

/** An operation PROCESSING longer than a worker run can last. One where for the count and its rows. */
function staleProcessingRecoveryWhere(now: Date) {
  return {
    status: "PROCESSING",
    processingStartedAt: {
      lt: new Date(now.getTime() - PAYMENT_PROCESSING_STALE_MINUTES * 60 * 1000),
    },
  } satisfies Prisma.PaymentRecoveryOperationWhereInput;
}

/** A retryable PENDING operation nobody claimed past its retry time. One where for the count and its rows. */
function overduePendingRecoveryWhere(now: Date) {
  return {
    status: "PENDING",
    nextRetryAt: {
      lte: new Date(now.getTime() - PAYMENT_PENDING_OVERDUE_MINUTES * 60 * 1000),
    },
    attempts: { lt: MAX_PAYMENT_RECOVERY_ATTEMPTS },
  } satisfies Prisma.PaymentRecoveryOperationWhereInput;
}

/**
 * #1349 (F2) crash-window detector: a CANCELLED booking that kept a fully
 * captured, unrefunded payment with NO refund-recovery operation and NO
 * cancellation narrative event can only be a cancel that died between the
 * claim commit and Phase 2 (deliberate zero-refund cancels write their
 * CANCELLED BookingEvent; refunds bump refundedAmountCents; the #1349
 * in-transaction enqueue leaves a recovery operation). Before #1349 NOTHING
 * fired for this state — the member's refund was silently lost. #4959: the
 * count and the named rows both read this one where.
 */
function cancelledRefundUnrecordedWhere(now: Date) {
  return {
    status: "CANCELLED",
    deletedAt: null,
    updatedAt: {
      gte: new Date(
        now.getTime() -
          CANCELLED_REFUND_UNRECORDED_LOOKBACK_DAYS * 24 * 60 * 60 * 1000,
      ),
    },
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
      // #2262 — the admin-only settlement markers are stored as
      // CANCELLED events (reversal / reciprocal-fence conflict, and
      // #3638's second-instrument conflict) but cancel
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
              notIn: [...SETTLEMENT_MARKER_EVENT_REASONS],
            },
          },
        ],
      },
    },
  } satisfies Prisma.BookingWhereInput;
}

/** The organiser's booking behind a group settlement, for its named row. */
const SETTLEMENT_ORGANISER_SELECT = {
  groupBooking: { select: { organiserBooking: { select: OWNED_BOOKING_SELECT } } },
} satisfies Prisma.GroupBookingSettlementSelect;

type SettlementOrganiser = Prisma.GroupBookingSettlementGetPayload<{
  select: typeof SETTLEMENT_ORGANISER_SELECT;
}>;

async function getPaymentSignals(
  deps: StuckStateDashboardDependencies,
  now: Date,
  // #4959 (#2823): read and name the rows only for a viewer allowed to see them.
  showRows: boolean,
): Promise<{
  counts: Record<PaymentSignal, number>;
  details: Record<PaymentSignal, StuckStateDetail[]> | undefined;
}> {
  // F3 (#1351): a SUCCEEDED settlement under a CANCELLED group whose persisted
  // refund plan was never executed — the organiser's settlement refund has not
  // completed. The recovery queue retries it (and alerts on exhaustion); this
  // tile keeps the state visible to operators the whole time, including for
  // incidents that predate the durable retry. #4959: the rows are this same
  // filtered read, oldest first, so they cannot drift from the count.
  const unexecuted = (
    (await deps.db.groupBookingSettlement.findMany({
      where: {
        status: "SUCCEEDED",
        groupBooking: { status: "CANCELLED" },
      },
      select: showRows
        ? { refundPlan: true, id: true, amountCents: true, ...SETTLEMENT_ORGANISER_SELECT }
        : { refundPlan: true },
      orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
    })) as Array<{ refundPlan: unknown } & Partial<{ id: string; amountCents: number } & SettlementOrganiser>>
  ).filter((settlement) => settlement.refundPlan != null);

  const stale = (
    (await deps.db.groupBookingSettlement.findMany({
      where: { status: { in: ["PENDING", "FAILED"] } },
      select: {
        updatedAt: true,
        ...(showRows ? { id: true, amountCents: true } : {}),
        groupBooking: {
          select: {
            organiserBooking: {
              select: { checkIn: true, ...(showRows ? OWNED_BOOKING_SELECT : {}) },
            },
          },
        },
      },
      orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
    })) as Array<{
      updatedAt: Date;
      id?: string;
      amountCents?: number;
      groupBooking: { organiserBooking: { checkIn: Date } & Partial<OwnedBooking> };
    }>
  )
    .map((settlement) => ({
      settlement,
      deadline: groupSettlementReapDeadline(
        settlement.updatedAt,
        settlement.groupBooking.organiserBooking.checkIn,
      ),
    }))
    .filter(({ deadline }) => now >= deadline);

  const [
    exhaustedFailed,
    staleProcessing,
    overduePending,
    cancelledUnrecordedRefunds,
  ] = await Promise.all([
    // #4104: a card refund raised dead is PENDING with its attempts spent.
    deps.db.paymentRecoveryOperation.count({ where: PAYMENT_RECOVERY_EXHAUSTED_WHERE }),
    deps.db.paymentRecoveryOperation.count({ where: staleProcessingRecoveryWhere(now) }),
    deps.db.paymentRecoveryOperation.count({ where: overduePendingRecoveryWhere(now) }),
    deps.db.booking.count({ where: cancelledRefundUnrecordedWhere(now) }),
  ]);

  const counts = {
    exhaustedFailed,
    staleProcessing,
    overduePending,
    staleSettlements: stale.length,
    cancelledUnrecordedRefunds,
    unexecutedSettlementRefunds: unexecuted.length,
  };
  if (!showRows) return { counts, details: undefined };

  const recoveryRows = (where: Prisma.PaymentRecoveryOperationWhereInput, count: number) =>
    count > 0
      ? (deps.db.paymentRecoveryOperation.findMany({
          where,
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          take: STUCK_STATE_DETAIL_ROW_CAP,
          select: RECOVERY_OPERATION_ROW_SELECT,
        }) as Promise<RecoveryOperationRow[]>)
      : Promise.resolve([]);
  const [format, exhaustedRows, staleRows, overdueRows, cancelledRows, deadCardRefunds] =
    await Promise.all([
      deps.loadDetailFormat(),
      recoveryRows(PAYMENT_RECOVERY_EXHAUSTED_WHERE, exhaustedFailed),
      recoveryRows(staleProcessingRecoveryWhere(now), staleProcessing),
      recoveryRows(overduePendingRecoveryWhere(now), overduePending),
      cancelledUnrecordedRefunds > 0
        ? (deps.db.booking.findMany({
            where: cancelledRefundUnrecordedWhere(now),
            orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
            take: STUCK_STATE_DETAIL_ROW_CAP,
            select: {
              ...OWNED_BOOKING_SELECT,
              updatedAt: true,
              lodge: { select: { name: true } },
              payment: { select: { amountCents: true } },
            },
          }) as Promise<Array<OwnedBooking & {
            updatedAt: Date;
            lodge: { name: string } | null;
            payment: { amountCents: number } | null;
          }>>)
        : Promise.resolve([]),
      exhaustedFailed > 0 ? deps.listDeadCardRefundOperationIds() : Promise.resolve(new Set<string>()),
    ]);

  const recoveryDetail = (operation: RecoveryOperationRow, close?: string) =>
    bookingDetailRow(
      operation.id,
      operation.booking,
      `${RECOVERY_OPERATION_PURPOSE[operation.type]} of ${format.cents(operation.amountCents)}, raised ${format.instantDate(operation.createdAt)}.${close ? ` ${close}` : ""}`,
    );
  const settlementDetail = (
    settlement: { id?: string; amountCents?: number } & { groupBooking: { organiserBooking: Partial<OwnedBooking> } },
    summary: string,
  ) =>
    bookingDetailRow(
      settlement.id as string,
      settlement.groupBooking.organiserBooking as OwnedBooking,
      summary,
    );

  return {
    counts,
    details: {
      exhaustedFailed: exhaustedRows.map((operation) =>
        recoveryDetail(
          operation,
          deadCardRefunds.has(operation.id)
            ? 'Settle it under "Card refunds Stripe gave up on" on this page.'
            : undefined,
        ),
      ),
      staleProcessing: staleRows.map((operation) => recoveryDetail(operation)),
      overduePending: overdueRows.map((operation) => recoveryDetail(operation)),
      cancelledUnrecordedRefunds: cancelledRows.map((booking) =>
        bookingDetailRow(
          booking.id,
          booking,
          `${booking.lodge?.name ?? "Lodge"}; ${format.cents(booking.payment?.amountCents ?? 0)} captured and not refunded; cancelled, last changed ${format.instantDate(booking.updatedAt)}.`,
        ),
      ),
      unexecutedSettlementRefunds: unexecuted
        .slice(0, STUCK_STATE_DETAIL_ROW_CAP)
        .map((settlement) =>
          settlementDetail(
            settlement as typeof settlement & SettlementOrganiser,
            `Group cancelled; the organiser's ${format.cents(settlement.amountCents ?? 0)} settlement has a refund plan not yet carried out.`,
          ),
        ),
      staleSettlements: stale
        .slice(0, STUCK_STATE_DETAIL_ROW_CAP)
        .map(({ settlement, deadline }) =>
          settlementDetail(
            settlement,
            `Group settlement of ${format.cents(settlement.amountCents ?? 0)} unpaid since its reap deadline, ${format.instantDate(deadline)}.`,
          ),
        ),
    },
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
  /** #4162: the caller holds finance:view (the voided bank refund notes' panel); false links that item to /admin/xero. */
  viewerCanViewFinance?: boolean;
}): Promise<StuckStateDashboard> {
  const deps = {
    ...defaultDependencies,
    ...input?.deps,
  };
  const now = input?.now ?? new Date();
  const viewerCanViewMembership = input?.viewerCanViewMembership ?? false;
  // #4959 (#2823): a named payment row is a booking owner beside their money,
  // so it needs both finance:view and membership:view. Fail closed: without
  // both, the rows' queries never run; the count and card link always stay.
  const viewerCanViewPaymentRows =
    viewerCanViewMembership && (input?.viewerCanViewFinance ?? false);
  const items: StuckStateItem[] = [];

  const [modules, paymentSignals] = await Promise.all([
    deps.loadEffectiveModuleFlags(),
    getPaymentSignals(deps, now, viewerCanViewPaymentRows),
  ]);

  buildPaymentItems(items, paymentSignals.counts, paymentSignals.details);
  const [exhaustedSettlementAlerts, exhaustedSettlementAlertRows] = await Promise.all([
    deps.countExhaustedCashSettlementAlerts(),
    viewerCanViewPaymentRows
      ? deps.listExhaustedCashSettlementAlerts(STUCK_STATE_DETAIL_ROW_CAP)
      : Promise.resolve(undefined),
  ]);
  addItem(items, {
    id: "payment-settlement-alert-undelivered",
    domain: "payment",
    title: "Bank transfer amount alerts not delivered",
    severity: "critical",
    owner: "Finance",
    count: exhaustedSettlementAlerts,
    href: adminHref("payments"),
    summary: `${exhaustedSettlementAlerts} settlement figure alerts exhausted their retries. Check the bank transfer amounts against Xero and the staff booking timeline; no further alert emails are attempted.`,
    details: exhaustedSettlementAlertRows?.map((alert) =>
      bookingDetailRow(
        alert.id,
        alert.booking,
        `${formatDateOnly(alert.booking.checkIn)} to ${formatDateOnly(alert.booking.checkOut)}; open the booking's staff timeline for the figures to check against Xero.`,
      ),
    ),
  });

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
    href: `${adminHref("booking-requests")}?tab=approvals`,
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
  //
  // #4959: a membership viewer reads the list the count is the length of, and
  // its first rows are named here; anyone else reads the count alone.
  const unnamedPlaceholderList = viewerCanViewMembership
    ? await deps.listBookingsWithUnnamedPlaceholderGuests(now)
    : undefined;
  const unnamedPlaceholderBookings =
    unnamedPlaceholderList?.length ??
    (await deps.countBookingsWithUnnamedPlaceholderGuests(now));
  addItem(items, {
    id: "booking-unnamed-placeholder-guests",
    domain: "booking",
    title: "Bookings with unnamed guests",
    severity: "warning",
    owner: "Admin",
    count: unnamedPlaceholderBookings,
    href: adminAnchorHref("stuck-states", "booking-unnamed-placeholder-guests"),
    summary: `${unnamedPlaceholderBookings} upcoming ${plural(
      unnamedPlaceholderBookings,
      "booking",
    )} still ${
      unnamedPlaceholderBookings === 1 ? "lists" : "list"
    } placeholder guest names ("Guest 2", "School Child 5"), so the chore list and arrival roster would show those instead of real people. Most bookers are chased automatically, but some rows are not — a school list already confirmed with its placeholder names, or a booking still held for approval — so open each booking named below and edit the names, which an admin or Booking Officer can always do. The stay is never held up over this.`,
    details: unnamedPlaceholderList
      ?.slice(0, STUCK_STATE_DETAIL_ROW_CAP)
      .map((booking) =>
        bookingDetailRow(
          booking.id,
          booking,
          `${booking.lodge?.name ?? "Lodge"}; arrives ${formatDateOnly(booking.checkIn)}; ${booking.unnamedGuestCount} unnamed ${plural(booking.unnamedGuestCount, "guest")}.`,
        ),
      ),
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
        take: STUCK_STATE_DETAIL_ROW_CAP,
        select: {
          id: true,
          cause: true,
          openedAt: true,
          evidence: true,
          booking: {
            select: {
              // #3369: the owner may be an Organisation; bookingOwnerName() reads both.
              ...OWNED_BOOKING_SELECT,
              checkIn: true,
              checkOut: true,
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
      booking: OwnedBooking & {
        checkIn: Date;
        checkOut: Date;
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
    return bookingDetailRow(
      incident.id,
      incident.booking,
      `${incident.booking.lodge?.name ?? "Lodge"}; ` +
        `${formatDateOnly(incident.booking.checkIn)} to ${formatDateOnly(incident.booking.checkOut)}; ` +
        `${nights.length} uncovered ${plural(nights.length, "night")}; ` +
        `${describeHostingCoverageIncidentCause(incident.cause)}.`,
    );
  });
  addItem(items, {
    id: "booking-hosting-coverage-incidents",
    domain: "booking",
    title: "Bookings without required adult member cover",
    severity: "critical",
    owner: "Booking Officer",
    count: hostingCoverageIncidents,
    href: `${adminHref("bookings")}#hosting-coverage-incidents`,
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
    // #4162 (`INV-ADDPAY-042`): voided bank refund notes the nightly follow-up
    // could not match to one refund; a person answers each on this page.
    const bankRefundVoidsToAnswer = await deps.countBankRefundVoidsToAnswer();
    addItem(items, {
      id: "xero-bank-refund-voids-to-answer",
      domain: "xero",
      title: "Voided bank refund notes to answer",
      severity: "warning",
      owner: "Finance",
      count: bankRefundVoidsToAnswer,
      href: input?.viewerCanViewFinance ? adminAnchorHref("stuck-states", "bank-refund-voids") : adminHref("xero"),
      summary: `${bankRefundVoidsToAnswer} bank ${plural(bankRefundVoidsToAnswer, "refund")} had ${bankRefundVoidsToAnswer === 1 ? "its" : "their"} Xero credit note voided, and the app could not tell which refund the note recorded (or another note has held it back for over a week). Pick the refund on this page and the app takes it back out of the records for the treasurer to re-confirm.`,
    });
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
