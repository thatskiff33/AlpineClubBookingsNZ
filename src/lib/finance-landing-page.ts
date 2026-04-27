import type { BadgeProps } from "@/components/ui/badge";
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
import { getFinanceXeroRouteStatus } from "@/lib/finance-xero";
import { formatCents } from "@/lib/utils";

const FINANCE_TIMEZONE = "Pacific/Auckland";
const FINANCE_LANDING_FORWARD_DAY_COUNT = 90;

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
  kind: "link" | "connect" | "disconnect";
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
  cards: FinanceLandingMetricCard[];
  configIssues: string[];
  tokenStorageIssues: string[];
  actions: FinanceLandingManagerAction[];
  error?: string;
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
  const [syncResult, bookingResult, xeroResult] = await Promise.allSettled([
    getFinanceSyncDiagnosticsStatus(),
    getFinanceBookingMetrics(query),
    isManager ? getFinanceXeroRouteStatus() : Promise.resolve(null),
  ]);

  const sync = mapSyncSection(syncResult);
  const realized = mapRealizedSection(windows.realized, bookingResult);
  const forward = mapForwardSection(windows.forward, bookingResult);
  const queryString = new URLSearchParams({
    realizedFrom: query.realized!.from,
    realizedTo: query.realized!.to,
    realizedCutoff: query.realized!.cutoffDate!,
    forwardFrom: query.forward!.from,
    forwardTo: query.forward!.to,
    forwardAsOf: query.forward!.asOfDate!,
  }).toString();

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
          "These figures come from booking, guest, and payment records in TACBookings.",
      },
      {
        label: "Sync health",
        description:
          "These figures come from finance sync runs and cron monitoring. They show freshness and failures, not accounting balances.",
      },
      ...(isManager
        ? [
            {
              label: "Finance Xero connection",
              description:
                "Finance reporting uses its own Xero connection so it stays separate from the operational Xero setup.",
            },
          ]
        : []),
    ],
    managerWorkspace: isManager
      ? mapManagerWorkspace(
          xeroResult as PromiseSettledResult<
            Awaited<ReturnType<typeof getFinanceXeroRouteStatus>> | null
          >,
          queryString
        )
      : null,
  };
}

function mapManagerWorkspace(
  result: PromiseSettledResult<
    Awaited<ReturnType<typeof getFinanceXeroRouteStatus>> | null
  >,
  bookingMetricsQueryString: string
): FinanceLandingManagerWorkspace {
  const fallbackActions: FinanceLandingManagerAction[] = [
    {
      kind: "link",
      href: "/api/finance/sync/status",
      label: "View sync diagnostics",
      description:
        "Technical detail for the latest finance sync and recent failures.",
    },
    {
      kind: "link",
      href: "/api/finance/xero/status",
      label: "View Xero connection details",
      description:
        "Technical detail for the finance reporting Xero connection.",
    },
    {
      kind: "link",
      href: `/api/finance/bookings/metrics?${bookingMetricsQueryString}`,
      label: "View raw booking metrics",
      description:
        "Raw booking metrics for the same date ranges shown on this page.",
    },
  ];

  if (result.status === "rejected") {
    return {
      eyebrow: "Manager tools",
      title: "Manager tools are temporarily unavailable",
      description:
        "The page could not load the finance Xero manager tools right now.",
      badgeLabel: "Unavailable",
      badgeVariant: "destructive",
      cards: [],
      configIssues: [],
      tokenStorageIssues: [],
      actions: fallbackActions,
      error: readErrorMessage({
        reason: result.reason,
        fallback: "Finance Xero manager tools are temporarily unavailable.",
        logContext:
          "Failed to load finance Xero status for the landing page manager workspace",
      }),
    };
  }

  const status = result.value;
  if (!status) {
    return {
      eyebrow: "Manager tools",
      title: "Finance manager operations",
      description:
        "Connection and setup tools are only shown to finance managers.",
      badgeLabel: "Hidden",
      badgeVariant: "secondary",
      cards: [],
      configIssues: [],
      tokenStorageIssues: [],
      actions: [],
    };
  }

  const badgeVariant = status.connected
    ? "success"
    : status.canConnect
      ? "warning"
      : "destructive";
  const badgeLabel = status.connected
    ? "Connected"
    : status.canConnect
      ? "Ready to connect"
      : "Config required";
  const connectionActions: FinanceLandingManagerAction[] = status.connected
    ? [
        {
          kind: "connect",
          href: "/api/finance/xero/connect",
          label: "Reconnect finance Xero",
          description:
            "Start the Xero sign-in flow again if the finance connection needs refreshing.",
        },
        {
          kind: "disconnect",
          label: "Disconnect finance Xero",
          description:
            "Clear the saved finance tokens and revoke them in Xero when possible.",
        },
      ]
    : status.canConnect
      ? [
          {
            kind: "connect",
            href: "/api/finance/xero/connect",
            label: "Connect finance Xero",
            description:
              "Sign in to Xero so finance sync can store fresh reporting data.",
          },
        ]
      : [];

  return {
    eyebrow: "Manager tools",
    title: "Finance manager operations",
    description: status.connected
      ? "The finance Xero connection is ready to use."
      : status.canConnect
        ? "This environment is ready, but no finance Xero tenant is connected yet."
        : "The finance Xero connection is blocked by missing or invalid setup.",
    badgeLabel,
    badgeVariant,
    cards: [
      {
        title: "Finance Xero",
        value: status.connected
          ? "Connected"
          : status.canConnect
            ? "Ready to connect"
            : "Blocked",
        description: status.connected
          ? "Finance reporting is connected to its own saved Xero login."
          : status.canConnect
            ? "Connect the finance Xero tenant before relying on fresh synced finance data."
            : "Fix the setup issues below before connecting finance Xero.",
        footnote: status.connected
          ? buildConnectionFootnote(status.tenantId, status.tokenExpiresAt)
          : "No finance Xero token record is stored yet.",
      },
      {
        title: "OAuth config",
        value: status.oauthConfigured ? "Ready" : "Action required",
        description: status.oauthConfigured
          ? "The finance Xero app credentials and callback URL are configured."
          : "Finance OAuth settings are incomplete for this environment.",
        footnote: status.configIssues.length
          ? formatIssueList(status.configIssues)
          : "No finance OAuth configuration issues detected.",
      },
      {
        title: "Token storage",
        value: status.tokenStorageConfigured ? "Ready" : "Action required",
        description: status.tokenStorageConfigured
          ? "Encrypted storage for finance Xero tokens is configured."
          : "Finance token encryption must be fixed before saving tokens from Xero.",
        footnote: status.tokenStorageIssues.length
          ? formatIssueList(status.tokenStorageIssues)
          : "No finance token-storage issues detected.",
      },
    ],
    configIssues: status.configIssues,
    tokenStorageIssues: status.tokenStorageIssues,
    actions: [...connectionActions, ...fallbackActions],
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
      title: "Waiting for the first durable finance sync",
      description:
        "Finance access is live, but no completed finance sync has been recorded yet.",
      badgeLabel: "Not yet synced",
      badgeVariant: "warning",
      cards: [
        {
          title: "Daily schedule",
          value: cron.schedule,
          description: `Configured for ${cron.timezone}.`,
        },
        {
          title: "Latest cron run",
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
  const badgeVariant =
    latestRun.status === "SUCCEEDED"
      ? "success"
      : latestRun.status === "PARTIAL"
        ? "warning"
        : latestRun.status === "RUNNING"
          ? "secondary"
          : "destructive";
  const badgeLabel =
    latestRun.status === "SUCCEEDED"
      ? "Healthy"
      : latestRun.status === "PARTIAL"
        ? "Attention needed"
        : latestRun.status === "RUNNING"
          ? "Running"
          : "Failed";

  return {
    id: "sync-health",
    eyebrow: "Finance sync",
    title: "Finance data freshness",
    description:
      latestRun.status === "SUCCEEDED"
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
        title: "Latest durable run",
        value: humanizeStatus(latestRun.status),
        description: formatRunTimestamp(latestRunCompleted, latestRun.completedAt ? "Completed" : "Started"),
        footnote: latestRun.errorSummary ?? undefined,
      },
      {
        title: "Snapshots persisted",
        value: formatWholeNumber(latestRun.snapshotCount),
        description: `${formatWholeNumber(latestRun.datasetCount)} datasets, ${formatWholeNumber(latestRun.totalRowCount)} rows.`,
        footnote:
          failedDatasets > 0
            ? `${formatWholeNumber(failedDatasets)} dataset${failedDatasets === 1 ? "" : "s"} reported failures.`
            : `${formatWholeNumber(latestRun.successfulDatasetCount)} dataset${latestRun.successfulDatasetCount === 1 ? "" : "s"} completed successfully.`,
      },
      {
        title: "Latest cron check",
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
  return new Date(`${dateOnly}T00:00:00.000Z`).toLocaleDateString("en-NZ", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: FINANCE_TIMEZONE,
  });
}

function formatDateTime(value: string): string {
  return new Date(value).toLocaleString("en-NZ", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: FINANCE_TIMEZONE,
  });
}

function formatRunTimestamp(value: string, prefix: string): string {
  return `${prefix} ${formatDateTime(value)}.`;
}

function humanizeStatus(status: string): string {
  return status
    .toLowerCase()
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function formatWholeNumber(value: number): string {
  return new Intl.NumberFormat("en-NZ", { maximumFractionDigits: 0 }).format(
    value
  );
}

function formatPercent(value: number): string {
  return new Intl.NumberFormat("en-NZ", {
    style: "percent",
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(value);
}

function buildConnectionFootnote(
  tenantId: string | null,
  tokenExpiresAt: Date | null
): string {
  const details: string[] = [];

  if (tenantId) {
    details.push(`Tenant ${tenantId}.`);
  }

  if (tokenExpiresAt) {
    details.push(`Token expires ${formatDateTime(tokenExpiresAt.toISOString())}.`);
  }

  return details.length > 0
    ? details.join(" ")
    : "Connected without a stored tenant or expiry detail.";
}

function formatIssueList(issues: string[]): string {
  return issues.join(" ");
}

function readErrorMessage(input: {
  reason: unknown;
  fallback: string;
  logContext: string;
}): string {
  console.error(input.logContext, input.reason);
  return input.fallback;
}
