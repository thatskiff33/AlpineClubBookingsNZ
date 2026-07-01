import type { FeatureFlags } from "@/config/schema";
import {
  addDaysDateOnly,
  formatDateOnly,
  getTodayDateOnly,
} from "@/lib/date-only";
import { getAdminAlertDeliveryEscalations } from "@/lib/email-admin-alert-escalation";
import { getExhaustedEmailFailureReviewQueue } from "@/lib/email-failure-review";
import { getEmailDeliverabilityTelemetry } from "@/lib/email-suppression";
import { getUnassignedHutLeaderDates } from "@/lib/hut-leader-coverage";
import { loadHutLeaderLookaheadDays } from "@/lib/lodge-settings";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";
import { MAX_PAYMENT_RECOVERY_ATTEMPTS } from "@/lib/payment-recovery-constants";
import { prisma } from "@/lib/prisma";
import {
  getBedAllocationDashboard,
  parseBedAllocationDateRange,
} from "@/lib/admin-bed-allocation";
import { getTokenEmailRecoveryQueue } from "@/lib/token-email-recovery";
import { getWaitlistOfferEmailDeliveries } from "@/lib/waitlist-offer-email-visibility";
import {
  getXeroAdminHealthSnapshot,
  type XeroAdminHealthSnapshot,
} from "@/lib/xero-admin-health";

const PAYMENT_PROCESSING_STALE_MINUTES = 30;
const PAYMENT_PENDING_OVERDUE_MINUTES = 15;
const BED_ALLOCATION_LOOKAHEAD_DAYS = 7;

export type StuckStateSeverity = "critical" | "warning" | "info";

export type StuckStateDomain =
  | "payment"
  | "xero"
  | "email"
  | "waitlist"
  | "bed_allocation"
  | "lodge";

export type StuckStateOwner = "Admin" | "Finance" | "Lodge" | "System";

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
}

export interface StuckStateDomainSummary {
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
  booking: FindManyDelegate;
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
  getWaitlistOfferEmailDeliveries: typeof getWaitlistOfferEmailDeliveries;
  getBedAllocationDashboard: typeof getBedAllocationDashboard;
  getUnassignedHutLeaderDates: typeof getUnassignedHutLeaderDates;
  loadHutLeaderLookaheadDays: typeof loadHutLeaderLookaheadDays;
}

const DOMAIN_LABELS: Record<StuckStateDomain, string> = {
  payment: "Payment recovery",
  xero: "Xero",
  email: "Email",
  waitlist: "Waitlist",
  bed_allocation: "Bed allocation",
  lodge: "Lodge operations",
};

const DOMAIN_ORDER: StuckStateDomain[] = [
  "payment",
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
  getWaitlistOfferEmailDeliveries,
  getBedAllocationDashboard,
  getUnassignedHutLeaderDates,
  loadHutLeaderLookaheadDays,
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
}) {
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
) {
  const [
    deliverability,
    exhaustedFailures,
    adminAlertDelivery,
    tokenRecovery,
  ] = await Promise.all([
    deps.getEmailDeliverabilityTelemetry(),
    deps.getExhaustedEmailFailureReviewQueue(),
    deps.getAdminAlertDeliveryEscalations(),
    deps.getTokenEmailRecoveryQueue(),
  ]);

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
    select: {
      id: true,
      status: true,
      waitlistOfferedAt: true,
      waitlistOfferExpiresAt: true,
      member: {
        select: {
          email: true,
        },
      },
    },
    orderBy: [{ waitlistOfferExpiresAt: "asc" }, { createdAt: "asc" }],
    take: 500,
  })) as WaitlistOfferBooking[];
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
    )} have missing, bounced, or exhausted offer-email delivery.`,
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
  const today = getTodayDateOnly();
  const range = parseBedAllocationDateRange({
    from: formatDateOnly(today),
    to: formatDateOnly(addDaysDateOnly(today, BED_ALLOCATION_LOOKAHEAD_DAYS)),
  });
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
  const [hutLeaderLookaheadDays, openIssueReports] = await Promise.all([
    deps.loadHutLeaderLookaheadDays(),
    deps.db.issueReport.count({
      where: {
        resolvedAt: null,
      },
    }),
  ]);
  const unassignedDates = await deps.getUnassignedHutLeaderDates({
    lookAheadDays: hutLeaderLookaheadDays,
  });

  addItem(items, {
    id: "lodge-unassigned-hut-leaders",
    domain: "lodge",
    title: "Unassigned hut leader dates",
    severity: "warning",
    owner: "Lodge",
    count: unassignedDates.length,
    href: "/admin/hut-leaders",
    summary: `${unassignedDates.length} upcoming lodge ${plural(
      unassignedDates.length,
      "date",
    )} in the next ${hutLeaderLookaheadDays} days with bookings have no hut leader assigned.`,
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

  const [exhaustedFailed, staleProcessing, overduePending] = await Promise.all([
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
  ]);

  return { exhaustedFailed, staleProcessing, overduePending };
}

function isModuleEnabled(modules: FeatureFlags, key: keyof FeatureFlags) {
  return Boolean(modules[key]);
}

export async function getStuckStateDashboard(input?: {
  deps?: Partial<StuckStateDashboardDependencies>;
  now?: Date;
}): Promise<StuckStateDashboard> {
  const deps = {
    ...defaultDependencies,
    ...input?.deps,
  };
  const now = input?.now ?? new Date();
  const items: StuckStateItem[] = [];

  const [modules, paymentCounts] = await Promise.all([
    deps.loadEffectiveModuleFlags(),
    getPaymentCounts(deps, now),
  ]);

  buildPaymentItems(items, paymentCounts);

  await addEmailItems(items, deps);

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
