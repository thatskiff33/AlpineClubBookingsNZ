import type { BadgeProps } from "@/components/ui/badge";
import { APP_LOCALE, APP_TIME_ZONE } from "@/config/operational";
import { addDaysDateOnly, formatDateOnly, getTodayDateOnly } from "@/lib/date-only";
import {
  type FinanceAccessMember,
  hasFinanceManagerAccess,
} from "@/lib/finance-auth";
import {
  getFinanceBookingMetrics,
  type FinanceBookingMetricsQuery,
  type FinanceBookingMetricsResult,
} from "@/lib/finance-booking-metrics";
import {
  getFinanceSyncDiagnosticsStatus,
  type FinanceSyncDiagnosticsStatus,
} from "@/lib/finance-sync-diagnostics";
import { formatCents } from "@/lib/utils";

const FINANCE_TIMEZONE = APP_TIME_ZONE;
const FINANCE_LANDING_FORWARD_DAY_COUNT = 90;
const FINANCE_SYNC_STALE_AFTER_MS = 36 * 60 * 60 * 1000;

export interface FinanceLandingWindowSummary {
  label: string;
  from: string;
  to: string;
  detail: string;
}

export interface FinanceLandingMetricCard {
  title: string;
  value: string;
  description: string;
  footnote?: string;
}

export interface FinanceLandingSectionSummary {
  id: string;
  eyebrow: string;
  title: string;
  description: string;
  cards: FinanceLandingMetricCard[];
  error?: string;
}

export interface FinanceLandingSectionLink {
  href: string;
  label: string;
  description: string;
}

export interface FinanceLandingManagerAction {
  kind: "link" | "sync";
  href?: string;
  label: string;
  description: string;
}

export interface FinanceLandingManagerWorkspace {
  eyebrow: string;
  title: string;
  description: string;
  badgeLabel: string;
  badgeVariant: BadgeProps["variant"];
  actions: FinanceLandingManagerAction[];
  technicalActions: FinanceLandingManagerAction[];
}

export interface FinanceLandingPageModel {
  generatedOn: string;
  isManager: boolean;
  windows: {
    realized: FinanceLandingWindowSummary;
    forward: FinanceLandingWindowSummary & {
      asOfDate: string;
    };
  };
  sectionLinks: FinanceLandingSectionLink[];
  sync: FinanceLandingSectionSummary & {
    badgeLabel: string;
    badgeVariant: BadgeProps["variant"];
  };
  realized: FinanceLandingSectionSummary;
  forward: FinanceLandingSectionSummary;
  dataSources: Array<{
    label: string;
    description: string;
  }>;
  managerWorkspace: FinanceLandingManagerWorkspace | null;
}

export function buildFinanceLandingMetricsQuery(today = getTodayDateOnly()) {
  const realizedFrom = new Date(today);
  realizedFrom.setUTCDate(1);

  const realizedTo = new Date(today);
  const forwardFrom = addDaysDateOnly(today, 1);
  const forwardTo = addDaysDateOnly(today, FINANCE_LANDING_FORWARD_DAY_COUNT);

  const realizedFromDate = formatDateOnly(realizedFrom);
  const realizedToDate = formatDateOnly(realizedTo);
  const forwardFromDate = formatDateOnly(forwardFrom);
  const forwardToDate = formatDateOnly(forwardTo);
  const asOfDate = formatDateOnly(today);

  return {
    query: {
      realized: {
        from: realizedFromDate,
        to: realizedToDate,
        cutoffDate: realizedToDate,
      },
      forward: {
        from: forwardFromDate,
        to: forwardToDate,
        asOfDate,
      },
    } satisfies FinanceBookingMetricsQuery,
    windows: {
      realized: {
        label: "Realized month to date",
        from: realizedFromDate,
        to: realizedToDate,
        detail: `${formatDisplayDate(realizedFromDate)} to ${formatDisplayDate(realizedToDate)}`,
      },
      forward: {
        label: "Forward 90-day pipeline",
        from: forwardFromDate,
        to: forwardToDate,
        asOfDate,
        detail: `${formatDisplayDate(forwardFromDate)} to ${formatDisplayDate(forwardToDate)}`,
      },
    },
  };
}

export async function buildFinanceLandingPageModel(input: {
  member: FinanceAccessMember;
  today?: Date;
}): Promise<FinanceLandingPageModel> {
  const { member } = input;
  const isManager = hasFinanceManagerAccess(member.financeAccessLevel);
  const { query, windows } = buildFinanceLandingMetricsQuery(input.today);
  const [syncResult, bookingResult] = await Promise.allSettled([
    getFinanceSyncDiagnosticsStatus(),
    getFinanceBookingMetrics(query),
  ]);

  const sync = mapSyncSection(syncResult);
  const realized = mapRealizedSection(windows.realized, bookingResult);
  const forward = mapForwardSection(windows.forward, bookingResult);
  return {
    generatedOn: formatDateTime(new Date().toISOString()),
    isManager,
    windows,
    sectionLinks: [
      {
        href: "#sync-health",
        label: "Sync health",
        description: "Latest finance sync, cron health, and data freshness",
      },
      {
        href: "#realized-bookings",
        label: "Realized stays",
        description: "Current month stay, occupancy, and cash coverage",
      },
      {
        href: "#forward-pipeline",
        label: "Forward pipeline",
        description: "Next 90 days of committed and at-risk booking demand",
      },
    ],
    sync,
    realized,
    forward,
    dataSources: [
      {
        label: "Booking cards",
        description:
          "These figures come from local booking, guest, and payment records.",
      },
      {
        label: "Sync health",
        description:
          "These figures come from finance sync runs and cron monitoring. They show freshness and failures, not accounting balances.",
      },
      ...(isManager
        ? [
            {
              label: "Xero reporting data",
              description:
                "Revenue, costs, and balance figures come from the single Xero connection shared with bookings, payments, and subscriptions. Setup and mappings live in Admin Setup.",
            },
          ]
        : []),
    ],
    managerWorkspace: isManager ? buildFinanceManagerWorkspace() : null,
  };
}

function buildFinanceManagerWorkspace(): FinanceLandingManagerWorkspace {
  return {
    eyebrow: "Manager access",
    title: "Finance data sync",
    description:
      "Finance reports read from stored snapshots from the single Xero connection shared with bookings, payments, and subscriptions. Run a manual sync after large changes.",
    badgeLabel: "Manager tools",
    badgeVariant: "secondary",
    actions: [
      {
        kind: "sync",
        href: "/api/finance/sync/run",
        label: "Run finance sync now",
        description:
          "Trigger a manager-started sync now instead of waiting for the next scheduled cycle.",
      },
    ],
    technicalActions: [
      {
        kind: "link",
        href: "/api/finance/sync/status",
        label: "Open sync diagnostics JSON",
        description:
          "Technical detail for the latest finance sync and recent failures.",
      },
    ],
  };
}

function mapSyncSection(
  result: PromiseSettledResult<FinanceSyncDiagnosticsStatus>
): FinanceLandingPageModel["sync"] {
  if (result.status === "rejected") {
    return {
      id: "sync-health",
      eyebrow: "Finance sync",
      title: "Sync health is temporarily unavailable",
      description:
        "The page could not load finance sync diagnostics right now.",
      badgeLabel: "Unavailable",
      badgeVariant: "destructive",
      cards: [],
      error: readErrorMessage({
        reason: result.reason,
        fallback: "Finance sync diagnostics are temporarily unavailable.",
        logContext: "Failed to load finance sync diagnostics for the landing page",
      }),
    };
  }

  const { latestRun, cron } = result.value;
  const latestCron = cron.latestRun;

  if (!latestRun) {
    return {
      id: "sync-health",
      eyebrow: "Finance sync",
      title: "Finance sync has not completed yet",
      description:
        "No finance sync has completed in this environment yet.",
      badgeLabel: "Not yet synced",
      badgeVariant: "warning",
      cards: [
        {
          title: "Daily schedule",
          value: cron.schedule,
          description: `Configured for ${cron.timezone}.`,
        },
        {
          title: "Latest scheduled check",
          value: latestCron ? humanizeStatus(latestCron.status) : "No cron history",
          description: latestCron
            ? formatRunTimestamp(latestCron.completedAt ?? latestCron.startedAt, "Ran")
            : "No finance cron execution has been recorded yet.",
          footnote: latestCron?.reason ?? undefined,
        },
      ],
    };
  }

  const latestRunCompleted = latestRun.completedAt ?? latestRun.startedAt;
  const failedDatasets = latestRun.failedDatasetCount;
  const latestRunAgeMs = Date.now() - new Date(latestRunCompleted).getTime();
  const isStale =
    latestRun.status === "SUCCEEDED" &&
    latestRun.completedAt !== null &&
    latestRunAgeMs > FINANCE_SYNC_STALE_AFTER_MS;
  const badgeVariant = isStale
    ? "warning"
    : latestRun.status === "SUCCEEDED"
      ? "success"
      : latestRun.status === "PARTIAL"
        ? "warning"
        : latestRun.status === "RUNNING"
          ? "secondary"
          : "destructive";
  const badgeLabel = isStale
    ? "Stale"
    : latestRun.status === "SUCCEEDED"
      ? "Healthy"
      : latestRun.status === "PARTIAL"
        ? "Needs review"
        : latestRun.status === "RUNNING"
          ? "Running"
          : "Failed";

  return {
    id: "sync-health",
    eyebrow: "Finance sync",
    title: "Finance data freshness",
    description: isStale
      ? "The last successful finance sync is older than expected and should be checked."
      : latestRun.status === "SUCCEEDED"
        ? "The most recent finance sync completed successfully."
        : latestRun.status === "PARTIAL"
          ? "The most recent finance sync completed with some dataset failures."
          : latestRun.status === "RUNNING"
            ? "A finance sync is currently in progress."
            : "The most recent finance sync failed and needs manager review.",
    badgeLabel,
    badgeVariant,
    cards: [
      {
        title: "Latest sync run",
        value: humanizeStatus(latestRun.status),
        description: formatRunTimestamp(latestRunCompleted, latestRun.completedAt ? "Completed" : "Started"),
        footnote: latestRun.errorSummary ?? formatSyncFreshnessFootnote(isStale, latestRunCompleted),
      },
      {
        title: "Snapshots stored",
        value: formatWholeNumber(latestRun.snapshotCount),
        description: `${formatWholeNumber(latestRun.datasetCount)} datasets, ${formatWholeNumber(latestRun.totalRowCount)} rows.`,
        footnote:
          failedDatasets > 0
            ? `${formatWholeNumber(failedDatasets)} dataset${failedDatasets === 1 ? "" : "s"} reported failures.`
            : `${formatWholeNumber(latestRun.successfulDatasetCount)} dataset${latestRun.successfulDatasetCount === 1 ? "" : "s"} completed successfully.`,
      },
      {
        title: "Latest scheduled check",
        value: latestCron ? humanizeStatus(latestCron.status) : "No cron history",
        description: latestCron
          ? formatRunTimestamp(latestCron.completedAt ?? latestCron.startedAt, "Ran")
          : `Scheduled daily in ${cron.timezone}.`,
        footnote: latestCron?.reason ?? latestCron?.error ?? `Scheduled daily in ${cron.timezone}.`,
      },
    ],
  };
}

function mapRealizedSection(
  window: FinanceLandingPageModel["windows"]["realized"],
  result: PromiseSettledResult<FinanceBookingMetricsResult>
): FinanceLandingSectionSummary {
  if (result.status === "rejected") {
    return {
      id: "realized-bookings",
      eyebrow: "Realized stays",
      title: window.label,
      description: `Window: ${window.detail}.`,
      cards: [],
      error: readErrorMessage({
        reason: result.reason,
        fallback: "Finance booking metrics are temporarily unavailable.",
        logContext:
          "Failed to load realized finance booking metrics for the landing page",
      }),
    };
  }

  const realized = result.value.realized;
  const paymentSummary = result.value.paymentSummary;

  if (!realized) {
    return {
      id: "realized-bookings",
      eyebrow: "Realized stays",
      title: window.label,
      description: `Window: ${window.detail}.`,
      cards: [],
      error: "No realized booking metrics were returned for the landing-page window.",
    };
  }

  return {
    id: "realized-bookings",
    eyebrow: "Realized stays",
    title: window.label,
    description: `Window: ${window.detail}.`,
    cards: [
      {
        title: "Guest nights",
        value: formatWholeNumber(realized.totals.guestNights),
        description: `${formatWholeNumber(realized.totals.bookingCount)} booking${realized.totals.bookingCount === 1 ? "" : "s"} contributed to this window.`,
        footnote: `${formatWholeNumber(realized.totals.bookingNights)} booking nights were realized.`,
      },
      {
        title: "Occupancy",
        value: formatPercent(realized.totals.occupancy.occupancyRate),
        description: `${formatWholeNumber(realized.totals.occupancy.occupiedBedNights)} of ${formatWholeNumber(realized.totals.occupancy.capacityBedNights)} available bed nights were occupied.`,
      },
      {
        title: "Booked revenue",
        value: formatCents(realized.totals.bookedRevenueCents),
        description: "Revenue is allocated evenly across realized stay nights.",
        footnote:
          realized.totals.averageNightlyRevenueCents === null
            ? "No realized nightly revenue is available for this window."
            : `${formatCents(realized.totals.averageNightlyRevenueCents)} average nightly revenue.`,
      },
      {
        title: "Net collected cash",
        value: formatCents(paymentSummary.netCollectedCents),
        description: `${formatWholeNumber(paymentSummary.bookingsWithPayment)} of ${formatWholeNumber(paymentSummary.bookingCount)} booking${paymentSummary.bookingCount === 1 ? "" : "s"} across the landing-page windows have payment rows.`,
        footnote:
          paymentSummary.bookingsWithoutPayment > 0
            ? `${formatWholeNumber(paymentSummary.bookingsWithoutPayment)} booking${paymentSummary.bookingsWithoutPayment === 1 ? "" : "s"} have no payment row yet.`
            : "Every contributing booking has a payment row.",
      },
    ],
  };
}

function mapForwardSection(
  window: FinanceLandingPageModel["windows"]["forward"],
  result: PromiseSettledResult<FinanceBookingMetricsResult>
): FinanceLandingSectionSummary {
  if (result.status === "rejected") {
    return {
      id: "forward-pipeline",
      eyebrow: "Forward pipeline",
      title: window.label,
      description: `Window: ${window.detail}. As of ${formatDisplayDate(window.asOfDate)}.`,
      cards: [],
      error: readErrorMessage({
        reason: result.reason,
        fallback: "Finance booking metrics are temporarily unavailable.",
        logContext:
          "Failed to load forward finance booking metrics for the landing page",
      }),
    };
  }

  const forward = result.value.forward;

  if (!forward) {
    return {
      id: "forward-pipeline",
      eyebrow: "Forward pipeline",
      title: window.label,
      description: `Window: ${window.detail}. As of ${formatDisplayDate(window.asOfDate)}.`,
      cards: [],
      error: "No forward booking metrics were returned for the landing-page window.",
    };
  }

  return {
    id: "forward-pipeline",
    eyebrow: "Forward pipeline",
    title: window.label,
    description: `Window: ${window.detail}. As of ${formatDisplayDate(window.asOfDate)}.`,
    cards: [
      {
        title: "Committed guest nights",
        value: formatWholeNumber(forward.totals.committed.guestNights),
        description: `${formatWholeNumber(forward.totals.committed.bookingCount)} confirmed or paid booking${forward.totals.committed.bookingCount === 1 ? "" : "s"} are committed in this window.`,
        footnote: formatCents(forward.totals.committed.bookedRevenueCents),
      },
      {
        title: "At-risk guest nights",
        value: formatWholeNumber(forward.totals.atRisk.guestNights),
        description: `${formatWholeNumber(forward.totals.atRisk.bookingCount)} pending booking${forward.totals.atRisk.bookingCount === 1 ? "" : "s"} remain at risk.`,
        footnote: formatCents(forward.totals.atRisk.bookedRevenueCents),
      },
      {
        title: "Total pipeline revenue",
        value: formatCents(forward.totals.totalPipeline.bookedRevenueCents),
        description: `${formatWholeNumber(forward.totals.totalPipeline.bookingCount)} total booking${forward.totals.totalPipeline.bookingCount === 1 ? "" : "s"} contribute to the next 90 days.`,
        footnote: `${formatPercent(forward.totals.totalPipeline.occupancy.occupancyRate)} pipeline occupancy across the selected window.`,
      },
    ],
  };
}

function formatDisplayDate(dateOnly: string): string {
  return new Date(`${dateOnly}T00:00:00.000Z`).toLocaleDateString(APP_LOCALE, {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: FINANCE_TIMEZONE,
  });
}

function formatDateTime(value: string): string {
  return new Date(value).toLocaleString(APP_LOCALE, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: FINANCE_TIMEZONE,
  });
}

function formatRunTimestamp(value: string, prefix: string): string {
  return `${prefix} ${formatDateTime(value)}.`;
}

function formatSyncFreshnessFootnote(isStale: boolean, completedAt: string): string {
  const ageHours = Math.max(
    Math.round((Date.now() - new Date(completedAt).getTime()) / (60 * 60 * 1000)),
    0
  );

  return isStale
    ? `Last successful sync completed about ${ageHours} hour${ageHours === 1 ? "" : "s"} ago.`
    : `Last completed about ${ageHours} hour${ageHours === 1 ? "" : "s"} ago.`;
}

function humanizeStatus(status: string): string {
  return status
    .toLowerCase()
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function formatWholeNumber(value: number): string {
  return new Intl.NumberFormat(APP_LOCALE, { maximumFractionDigits: 0 }).format(
    value
  );
}

function formatPercent(value: number): string {
  return new Intl.NumberFormat(APP_LOCALE, {
    style: "percent",
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(value);
}

function readErrorMessage(input: {
  reason: unknown;
  fallback: string;
  logContext: string;
}): string {
  console.error(input.logContext, input.reason);
  return input.fallback;
}
