import {
  type FinanceBookingPipelineDailyMetric,
  type FinanceBookingMetricsResult,
  getFinanceBookingMetrics,
} from "@/lib/finance-booking-metrics";
import {
  type FinanceAccessMember,
  hasFinanceManagerAccess,
} from "@/lib/finance-auth";
import { isDateOnlyString, parseDateOnly } from "@/lib/date-only";
import { buildFinanceLandingMetricsQuery } from "@/lib/finance-landing-page";
import { formatCents } from "@/lib/utils";

const FINANCE_TIMEZONE = "Pacific/Auckland";

type FinanceBookingsReportSearchParams = Record<
  string,
  string | string[] | undefined
>;

export interface FinanceBookingsReportFilters {
  realizedFrom: string;
  realizedTo: string;
  realizedCutoff: string;
  forwardFrom: string;
  forwardTo: string;
  forwardAsOf: string;
}

export interface FinanceBookingsReportSummaryCard {
  title: string;
  value: string;
  description: string;
  footnote?: string;
}

export interface FinanceBookingsReportDailyRow {
  date: string;
  bookingCount: string;
  guestNights: string;
  occupiedBeds: string;
  occupancyRate: string;
  bookedRevenue: string;
  committedBookingCount?: string;
  committedGuestNights?: string;
  atRiskBookingCount?: string;
  atRiskGuestNights?: string;
  totalPipelineBookingCount?: string;
  totalPipelineGuestNights?: string;
}

export interface FinanceBookingsReportStatusRow {
  pipeline: string;
  status: string;
  bookingCount: string;
  bookingNights: string;
  guestNights: string;
  bookedRevenue: string;
}

export interface FinanceBookingsReportSection {
  title: string;
  description: string;
  requestedWindow: string;
  effectiveWindow: string;
  cards: FinanceBookingsReportSummaryCard[];
  dailyRows: FinanceBookingsReportDailyRow[];
  statusRows: FinanceBookingsReportStatusRow[];
  emptyMessage?: string;
}

export interface FinanceBookingsReportPageModel {
  generatedOn: string;
  isManager: boolean;
  filters: FinanceBookingsReportFilters;
  reportHref: string;
  rawMetricsHref: string;
  filterWarnings: string[];
  loadError?: string;
  sourceNotes: Array<{
    label: string;
    description: string;
  }>;
  realized: FinanceBookingsReportSection;
  forward: FinanceBookingsReportSection;
}

export function buildDefaultFinanceBookingsReportFilters(today?: Date) {
  const defaults = buildFinanceLandingMetricsQuery(today).query;

  return {
    realizedFrom: defaults.realized!.from,
    realizedTo: defaults.realized!.to,
    realizedCutoff: defaults.realized!.cutoffDate!,
    forwardFrom: defaults.forward!.from,
    forwardTo: defaults.forward!.to,
    forwardAsOf: defaults.forward!.asOfDate!,
  } satisfies FinanceBookingsReportFilters;
}

export function buildFinanceBookingsReportQueryString(
  filters: FinanceBookingsReportFilters
) {
  return new URLSearchParams(Object.entries(filters)).toString();
}

export function buildFinanceBookingsReportHref(
  filters: FinanceBookingsReportFilters
) {
  return `/finance/bookings?${buildFinanceBookingsReportQueryString(filters)}`;
}

export function resolveFinanceBookingsReportFilters(input: {
  searchParams?: FinanceBookingsReportSearchParams;
  today?: Date;
}) {
  const defaults = buildDefaultFinanceBookingsReportFilters(input.today);
  const warnings: string[] = [];
  const filters: FinanceBookingsReportFilters = { ...defaults };

  const realizedParams = {
    from: readSearchParam(input.searchParams, "realizedFrom"),
    to: readSearchParam(input.searchParams, "realizedTo"),
    cutoff: readSearchParam(input.searchParams, "realizedCutoff"),
  };
  const forwardParams = {
    from: readSearchParam(input.searchParams, "forwardFrom"),
    to: readSearchParam(input.searchParams, "forwardTo"),
    asOf: readSearchParam(input.searchParams, "forwardAsOf"),
  };

  const hasRealizedInput = Object.values(realizedParams).some(Boolean);
  const hasForwardInput = Object.values(forwardParams).some(Boolean);

  if (hasRealizedInput) {
    if (!realizedParams.from || !realizedParams.to) {
      warnings.push(
        "Realized filters were incomplete. Showing the default month-to-date window."
      );
    } else if (
      !isDateOnlyString(realizedParams.from) ||
      !isDateOnlyString(realizedParams.to)
    ) {
      warnings.push(
        "Realized filters used an invalid date. Showing the default month-to-date window."
      );
    } else if (
      parseDateOnly(realizedParams.from).getTime() >
      parseDateOnly(realizedParams.to).getTime()
    ) {
      warnings.push(
        "Realized filters must end on or after the start date. Showing the default month-to-date window."
      );
    } else {
      filters.realizedFrom = realizedParams.from;
      filters.realizedTo = realizedParams.to;

      if (!realizedParams.cutoff) {
        filters.realizedCutoff = realizedParams.to;
      } else if (!isDateOnlyString(realizedParams.cutoff)) {
        warnings.push(
          "Realized cutoff used an invalid date. Using the realized end date instead."
        );
        filters.realizedCutoff = realizedParams.to;
      } else {
        filters.realizedCutoff = realizedParams.cutoff;
      }
    }
  }

  if (hasForwardInput) {
    if (!forwardParams.from || !forwardParams.to) {
      warnings.push(
        "Forward filters were incomplete. Showing the default next-90-days window."
      );
    } else if (
      !isDateOnlyString(forwardParams.from) ||
      !isDateOnlyString(forwardParams.to)
    ) {
      warnings.push(
        "Forward filters used an invalid date. Showing the default next-90-days window."
      );
    } else if (
      parseDateOnly(forwardParams.from).getTime() >
      parseDateOnly(forwardParams.to).getTime()
    ) {
      warnings.push(
        "Forward filters must end on or after the start date. Showing the default next-90-days window."
      );
    } else {
      filters.forwardFrom = forwardParams.from;
      filters.forwardTo = forwardParams.to;

      if (!forwardParams.asOf) {
        filters.forwardAsOf = defaults.forwardAsOf;
      } else if (!isDateOnlyString(forwardParams.asOf)) {
        warnings.push(
          "Forward as-of date was invalid. Using today's New Zealand date instead."
        );
        filters.forwardAsOf = defaults.forwardAsOf;
      } else {
        filters.forwardAsOf = forwardParams.asOf;
      }
    }
  }

  return { filters, warnings };
}

export async function buildFinanceBookingsReportPageModel(input: {
  member: FinanceAccessMember;
  searchParams?: FinanceBookingsReportSearchParams;
  today?: Date;
}): Promise<FinanceBookingsReportPageModel> {
  const { filters, warnings } = resolveFinanceBookingsReportFilters({
    searchParams: input.searchParams,
    today: input.today,
  });

  const queryString = buildFinanceBookingsReportQueryString(filters);
  const isManager = hasFinanceManagerAccess(input.member.financeAccessLevel);

  try {
    const metrics = await getFinanceBookingMetrics({
      realized: {
        from: filters.realizedFrom,
        to: filters.realizedTo,
        cutoffDate: filters.realizedCutoff,
      },
      forward: {
        from: filters.forwardFrom,
        to: filters.forwardTo,
        asOfDate: filters.forwardAsOf,
      },
    });

    return {
      generatedOn: formatDateTime(metrics.generatedAt),
      isManager,
      filters,
      reportHref: buildFinanceBookingsReportHref(filters),
      rawMetricsHref: `/api/finance/bookings/metrics?${queryString}`,
      filterWarnings: warnings,
      sourceNotes: buildSourceNotes(),
      realized: mapRealizedSection(metrics),
      forward: mapForwardSection(metrics),
    };
  } catch (error) {
    console.error("Failed to load finance bookings report metrics", error);

    return {
      generatedOn: formatDateTime(new Date().toISOString()),
      isManager,
      filters,
      reportHref: buildFinanceBookingsReportHref(filters),
      rawMetricsHref: `/api/finance/bookings/metrics?${queryString}`,
      filterWarnings: warnings,
      loadError:
        "Finance booking metrics are temporarily unavailable. Try again shortly or use the raw metrics endpoint once the finance booking boundary recovers.",
      sourceNotes: buildSourceNotes(),
      realized: buildUnavailableSection({
        title: "Realized stay detail",
        description:
          "This section uses TACBookings booking and payment rows for realized stays, occupancy, booked revenue, and payment coverage.",
      }),
      forward: buildUnavailableSection({
        title: "Forward pipeline detail",
        description:
          "This section uses TACBookings booking rows for committed and at-risk future stay demand.",
      }),
    };
  }
}

function buildSourceNotes() {
  return [
    {
      label: "Booked revenue",
      description:
        "Booked revenue on this page comes from TACBookings Booking.finalPriceCents allocated evenly across stay nights. It is not a Xero snapshot figure.",
    },
    {
      label: "Net collected cash",
      description:
        "Net collected cash comes from TACBookings Payment rows and stays separate from booked revenue so cash and revenue are not conflated.",
    },
    {
      label: "Scope boundary",
      description:
        "This report is bookings-only. It does not include finance snapshot-backed revenue, costs, cash, or balance-sheet reporting.",
    },
  ];
}

function mapRealizedSection(
  metrics: FinanceBookingMetricsResult
): FinanceBookingsReportSection {
  const realized = metrics.realized;

  if (!realized) {
    return buildUnavailableSection({
      title: "Realized stay detail",
      description:
        "This section uses TACBookings booking and payment rows for realized stays, occupancy, booked revenue, and payment coverage.",
    });
  }

  return {
    title: "Realized stay detail",
    description:
      "Realized stays count TACBookings guest nights through the selected cutoff date and keep booked revenue separate from payment-derived cash.",
    requestedWindow: `${formatDisplayDate(realized.window.from)} to ${formatDisplayDate(realized.window.to)}`,
    effectiveWindow: readEffectiveWindowLabel(
      realized.window.effectiveFrom,
      realized.window.effectiveTo,
      `Through cutoff ${formatDisplayDate(realized.window.cutoffDate)}`
    ),
    cards: [
      {
        title: "Guest nights",
        value: formatWholeNumber(realized.totals.guestNights),
        description: `${formatWholeNumber(realized.totals.bookingCount)} realized booking${realized.totals.bookingCount === 1 ? "" : "s"} contributed to this window.`,
        footnote: `${formatWholeNumber(realized.totals.bookingNights)} booking nights were realized.`,
      },
      {
        title: "Occupancy",
        value: formatPercent(realized.totals.occupancy.occupancyRate),
        description: `${formatWholeNumber(realized.totals.occupancy.occupiedBedNights)} occupied bed nights across ${formatWholeNumber(realized.totals.occupancy.capacityBedNights)} available bed nights.`,
      },
      {
        title: "Booked revenue",
        value: formatCents(realized.totals.bookedRevenueCents),
        description:
          "Revenue is allocated evenly across realized stay nights from TACBookings booking totals.",
        footnote:
          realized.totals.averageNightlyRevenueCents === null
            ? "No nightly revenue is available for this realized window."
            : `${formatCents(realized.totals.averageNightlyRevenueCents)} average nightly revenue.`,
      },
      {
        title: "Net collected cash",
        value: formatCents(metrics.paymentSummary.netCollectedCents),
        description: `${formatWholeNumber(metrics.paymentSummary.bookingsWithPayment)} of ${formatWholeNumber(metrics.paymentSummary.bookingCount)} contributing booking${metrics.paymentSummary.bookingCount === 1 ? "" : "s"} have payment rows.`,
        footnote:
          metrics.paymentSummary.bookingsWithoutPayment > 0
            ? `${formatWholeNumber(metrics.paymentSummary.bookingsWithoutPayment)} booking${metrics.paymentSummary.bookingsWithoutPayment === 1 ? "" : "s"} ${metrics.paymentSummary.bookingsWithoutPayment === 1 ? "has" : "have"} no payment row yet.`
            : "Every contributing booking has a payment row.",
      },
    ],
    dailyRows: realized.byDate.map((row) => ({
      date: formatTableDate(row.date),
      bookingCount: formatWholeNumber(row.bookingCount),
      guestNights: formatWholeNumber(row.guestNights),
      occupiedBeds: `${formatWholeNumber(row.occupiedBeds)} / ${formatWholeNumber(
        row.occupiedBeds + row.availableBeds
      )}`,
      occupancyRate: formatPercent(row.occupancyRate),
      bookedRevenue: formatCents(row.bookedRevenueCents),
    })),
    statusRows: Object.entries(realized.statusBreakdown).map(
      ([status, summary]) => ({
        pipeline: "Realized",
        status: humanizeStatus(status),
        bookingCount: formatWholeNumber(summary.bookingCount),
        bookingNights: formatWholeNumber(summary.bookingNights),
        guestNights: formatWholeNumber(summary.guestNights),
        bookedRevenue: formatCents(summary.bookedRevenueCents),
      })
    ),
    emptyMessage:
      realized.byDate.length === 0
        ? "No realized stay dates fall inside the selected window after applying the cutoff."
        : undefined,
  };
}

function mapForwardSection(
  metrics: FinanceBookingMetricsResult
): FinanceBookingsReportSection {
  const forward = metrics.forward;

  if (!forward) {
    return buildUnavailableSection({
      title: "Forward pipeline detail",
      description:
        "This section uses TACBookings booking rows for committed and at-risk future stay demand.",
    });
  }

  const statusRows: FinanceBookingsReportStatusRow[] = [
    ...Object.entries(forward.totals.committed.statusBreakdown).map(
      ([status, summary]) => ({
        pipeline: "Committed",
        status: humanizeStatus(status),
        bookingCount: formatWholeNumber(summary.bookingCount),
        bookingNights: formatWholeNumber(summary.bookingNights),
        guestNights: formatWholeNumber(summary.guestNights),
        bookedRevenue: formatCents(summary.bookedRevenueCents),
      })
    ),
    ...Object.entries(forward.totals.atRisk.statusBreakdown).map(
      ([status, summary]) => ({
        pipeline: "At risk",
        status: humanizeStatus(status),
        bookingCount: formatWholeNumber(summary.bookingCount),
        bookingNights: formatWholeNumber(summary.bookingNights),
        guestNights: formatWholeNumber(summary.guestNights),
        bookedRevenue: formatCents(summary.bookedRevenueCents),
      })
    ),
  ];

  return {
    title: "Forward pipeline detail",
    description:
      "Forward pipeline counts future TACBookings stay dates strictly after the selected as-of date and separates committed demand from pending demand.",
    requestedWindow: `${formatDisplayDate(forward.window.from)} to ${formatDisplayDate(forward.window.to)}`,
    effectiveWindow: readEffectiveWindowLabel(
      forward.window.effectiveFrom,
      forward.window.effectiveTo,
      `As of ${formatDisplayDate(forward.window.asOfDate)}`
    ),
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
        description: `${formatWholeNumber(forward.totals.atRisk.bookingCount)} pending booking${forward.totals.atRisk.bookingCount === 1 ? "" : "s"} ${forward.totals.atRisk.bookingCount === 1 ? "remains" : "remain"} at risk.`,
        footnote: formatCents(forward.totals.atRisk.bookedRevenueCents),
      },
      {
        title: "Total pipeline revenue",
        value: formatCents(forward.totals.totalPipeline.bookedRevenueCents),
        description: `${formatWholeNumber(forward.totals.totalPipeline.bookingCount)} total booking${forward.totals.totalPipeline.bookingCount === 1 ? "" : "s"} contribute to this window.`,
      },
      {
        title: "Pipeline occupancy",
        value: formatPercent(forward.totals.totalPipeline.occupancy.occupancyRate),
        description: `${formatWholeNumber(forward.totals.totalPipeline.guestNights)} guest nights across ${formatWholeNumber(forward.totals.totalPipeline.occupancy.capacityBedNights)} available bed nights.`,
      },
    ],
    dailyRows: forward.byDate.map((row) => mapForwardDailyRow(row)),
    statusRows,
    emptyMessage:
      forward.byDate.length === 0
        ? "No future stay dates fall strictly after the selected as-of date for this window."
        : undefined,
  };
}

function mapForwardDailyRow(
  row: FinanceBookingPipelineDailyMetric
): FinanceBookingsReportDailyRow {
  return {
    date: formatTableDate(row.date),
    bookingCount: formatWholeNumber(row.totalPipeline.bookingCount),
    guestNights: formatWholeNumber(row.totalPipeline.guestNights),
    occupiedBeds: `${formatWholeNumber(row.totalPipeline.occupiedBeds)} / ${formatWholeNumber(
      row.totalPipeline.occupiedBeds + row.totalPipeline.availableBeds
    )}`,
    occupancyRate: formatPercent(row.totalPipeline.occupancyRate),
    bookedRevenue: formatCents(row.totalPipeline.bookedRevenueCents),
    committedBookingCount: formatWholeNumber(row.committed.bookingCount),
    committedGuestNights: formatWholeNumber(row.committed.guestNights),
    atRiskBookingCount: formatWholeNumber(row.atRisk.bookingCount),
    atRiskGuestNights: formatWholeNumber(row.atRisk.guestNights),
    totalPipelineBookingCount: formatWholeNumber(row.totalPipeline.bookingCount),
    totalPipelineGuestNights: formatWholeNumber(row.totalPipeline.guestNights),
  };
}

function buildUnavailableSection(input: {
  title: string;
  description: string;
}): FinanceBookingsReportSection {
  return {
    title: input.title,
    description: input.description,
    requestedWindow: "Unavailable",
    effectiveWindow: "Unavailable",
    cards: [],
    dailyRows: [],
    statusRows: [],
  };
}

function readEffectiveWindowLabel(
  effectiveFrom: string | null,
  effectiveTo: string | null,
  detail: string
) {
  if (!effectiveFrom || !effectiveTo) {
    return `${detail}. No stay dates contribute to the effective window.`;
  }

  return `${formatDisplayDate(effectiveFrom)} to ${formatDisplayDate(
    effectiveTo
  )}. ${detail}.`;
}

function readSearchParam(
  searchParams: FinanceBookingsReportSearchParams | undefined,
  key: string
) {
  const value = searchParams?.[key];
  return Array.isArray(value) ? value[0] : value;
}

function formatDateTime(value: string) {
  return new Date(value).toLocaleString("en-NZ", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: FINANCE_TIMEZONE,
  });
}

function formatDisplayDate(dateOnly: string) {
  return new Date(`${dateOnly}T00:00:00.000Z`).toLocaleDateString("en-NZ", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: FINANCE_TIMEZONE,
  });
}

function formatTableDate(dateOnly: string) {
  return new Date(`${dateOnly}T00:00:00.000Z`).toLocaleDateString("en-NZ", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: FINANCE_TIMEZONE,
  });
}

function formatWholeNumber(value: number) {
  return new Intl.NumberFormat("en-NZ", {
    maximumFractionDigits: 0,
  }).format(value);
}

function formatPercent(value: number) {
  return new Intl.NumberFormat("en-NZ", {
    style: "percent",
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(value);
}

function humanizeStatus(status: string) {
  return status
    .toLowerCase()
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
