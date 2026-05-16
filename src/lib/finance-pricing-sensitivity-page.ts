import { FinanceSnapshotType } from "@prisma/client";
import {
  type FinanceAccessMember,
  hasFinanceManagerAccess,
} from "@/lib/finance-auth";
import {
  type FinanceRealizedStayMetrics,
  getFinanceBookingMetrics,
} from "@/lib/finance-booking-metrics";
import {
  parseCostsSnapshot,
  type ParsedCostsSnapshot,
} from "@/lib/finance-costs-report-page";
import {
  buildFinanceSnapshotLoadErrorMessage,
  buildFinanceSnapshotMissingMessage,
} from "@/lib/finance-report-availability";
import {
  DEFAULT_FINANCE_SNAPSHOT_SCOPE,
  listFinanceSnapshots,
} from "@/lib/finance-sync-storage";
import { formatDateOnly, parseDateOnly } from "@/lib/date-only";
import { formatCents } from "@/lib/utils";
import { CLUB_NAME } from "@/config/club-identity";

const FINANCE_TIMEZONE = "Pacific/Auckland";
const DEFAULT_FINANCE_PRICING_SENSITIVITY_PERIODS = 6;
const MAX_FINANCE_PRICING_SENSITIVITY_PERIODS = 24;
const MIN_FINANCE_PRICING_SENSITIVITY_PERIODS = 1;

const PRICING_SENSITIVITY_OCCUPANCY_ASSUMPTIONS = [
  0.2,
  0.35,
  0.5,
  0.65,
  0.8,
] as const;

type FinancePricingSensitivitySearchParams = Record<
  string,
  string | string[] | undefined
>;

interface PricingSensitivityPeriodComparison {
  snapshotId: string;
  periodLabel: string;
  sourceWindow: string;
  totalCostsCents: number;
  guestNights: number;
  occupancyRate: number;
  bookedRevenueCents: number;
  averageRevenuePerGuestNightCents: number | null;
  breakEvenRevenuePerGuestNightCents: number | null;
  bookedRevenueLessCostsCents: number;
  capacityBedNights: number;
}

export interface FinancePricingSensitivityFilters {
  periods: number;
}

export interface FinancePricingSensitivitySummaryCard {
  title: string;
  value: string;
  description: string;
  footnote?: string;
}

export interface FinancePricingSensitivityPeriodRow {
  snapshotId: string;
  periodLabel: string;
  sourceWindow: string;
  totalCosts: string;
  guestNights: string;
  occupancyRate: string;
  averageRevenuePerGuestNight: string;
  breakEvenRevenuePerGuestNight: string;
  bookedRevenueLessCosts: string;
}

export interface FinancePricingSensitivityScenarioRow {
  occupancyAssumption: string;
  impliedGuestNights: string;
  requiredRevenuePerGuestNight: string;
  impliedRevenueAtActualRate: string;
  bookedRevenueLessCosts: string;
}

export interface FinancePricingSensitivityPageModel {
  generatedOn: string;
  isManager: boolean;
  filters: FinancePricingSensitivityFilters;
  reportHref: string;
  filterWarnings: string[];
  loadError?: string;
  coverageSummary: string;
  summaryCards: FinancePricingSensitivitySummaryCard[];
  periodRows: FinancePricingSensitivityPeriodRow[];
  scenarioRows: FinancePricingSensitivityScenarioRow[];
  sourceNotes: Array<{
    label: string;
    description: string;
  }>;
}

export function buildDefaultFinancePricingSensitivityFilters() {
  return {
    periods: DEFAULT_FINANCE_PRICING_SENSITIVITY_PERIODS,
  } satisfies FinancePricingSensitivityFilters;
}

export function buildFinancePricingSensitivityReportQueryString(
  filters: FinancePricingSensitivityFilters
) {
  return new URLSearchParams({
    periods: String(filters.periods),
  }).toString();
}

export function buildFinancePricingSensitivityReportHref(
  filters: FinancePricingSensitivityFilters
) {
  return `/finance/pricing-sensitivity?${buildFinancePricingSensitivityReportQueryString(filters)}`;
}

export function resolveFinancePricingSensitivityFilters(input: {
  searchParams?: FinancePricingSensitivitySearchParams;
}) {
  const filters = buildDefaultFinancePricingSensitivityFilters();
  const warnings: string[] = [];
  const requestedPeriods = readSearchParam(input.searchParams, "periods");

  if (!requestedPeriods) {
    return { filters, warnings };
  }

  const normalizedPeriods = requestedPeriods.trim();

  if (!/^\d+$/.test(normalizedPeriods)) {
    warnings.push(
      `Pricing-sensitivity periods must be a whole number between ${MIN_FINANCE_PRICING_SENSITIVITY_PERIODS} and ${MAX_FINANCE_PRICING_SENSITIVITY_PERIODS}. Showing the default ${DEFAULT_FINANCE_PRICING_SENSITIVITY_PERIODS}-period window.`
    );
    return { filters, warnings };
  }

  const parsedPeriods = Number(normalizedPeriods);

  if (
    !Number.isInteger(parsedPeriods) ||
    parsedPeriods < MIN_FINANCE_PRICING_SENSITIVITY_PERIODS ||
    parsedPeriods > MAX_FINANCE_PRICING_SENSITIVITY_PERIODS
  ) {
    warnings.push(
      `Pricing-sensitivity periods must be a whole number between ${MIN_FINANCE_PRICING_SENSITIVITY_PERIODS} and ${MAX_FINANCE_PRICING_SENSITIVITY_PERIODS}. Showing the default ${DEFAULT_FINANCE_PRICING_SENSITIVITY_PERIODS}-period window.`
    );
    return { filters, warnings };
  }

  filters.periods = parsedPeriods;
  return { filters, warnings };
}

export async function buildFinancePricingSensitivityPageModel(input: {
  member: FinanceAccessMember;
  searchParams?: FinancePricingSensitivitySearchParams;
}): Promise<FinancePricingSensitivityPageModel> {
  const { filters, warnings } = resolveFinancePricingSensitivityFilters({
    searchParams: input.searchParams,
  });
  const reportHref = buildFinancePricingSensitivityReportHref(filters);
  const isManager = hasFinanceManagerAccess(input.member.financeAccessLevel);

  try {
    const snapshots = await listFinanceSnapshots({
      snapshotType: FinanceSnapshotType.PROFIT_AND_LOSS_MONTHLY,
      scope: DEFAULT_FINANCE_SNAPSHOT_SCOPE,
      limit: filters.periods,
    });
    const parsedSnapshots = snapshots
      .map((snapshot) => parseCostsSnapshot(snapshot))
      .filter((snapshot): snapshot is ParsedCostsSnapshot => snapshot !== null);
    const skippedSnapshotCount = snapshots.length - parsedSnapshots.length;

    if (snapshots.length === 0) {
      return buildUnavailablePricingSensitivityModel({
        filters,
        reportHref,
        isManager,
        warnings,
        loadError: await buildFinanceSnapshotMissingMessage({
          member: input.member,
          reportTitle: "This pricing report",
          dataLabel: "monthly cost snapshots",
        }),
      });
    }

    if (skippedSnapshotCount > 0) {
      warnings.push(
        `${skippedSnapshotCount} stored costs snapshot${skippedSnapshotCount === 1 ? "" : "s"} could not be parsed and ${skippedSnapshotCount === 1 ? "was" : "were"} ignored.`
      );
    }

    const periodComparisons: PricingSensitivityPeriodComparison[] = [];

    for (const snapshot of parsedSnapshots) {
      const metricWindow = resolveSnapshotMetricsWindow(snapshot);

      if (!metricWindow) {
        warnings.push(
          `${snapshot.periodLabel} could not be matched to a valid realized booking window and was ignored.`
        );
        continue;
      }

      try {
        const metrics = await getFinanceBookingMetrics({
          realized: {
            from: metricWindow.from,
            to: metricWindow.to,
            cutoffDate: metricWindow.to,
          },
        });
        const realized = metrics.realized;

        if (!realized) {
          warnings.push(
            `${snapshot.periodLabel} did not return realized booking metrics and was ignored.`
          );
          continue;
        }

        periodComparisons.push(
          buildPeriodComparison({
            snapshot,
            realized,
          })
        );
      } catch (error) {
        console.error(
          `Failed to load pricing sensitivity booking metrics for ${snapshot.periodLabel}`,
          error
        );
        warnings.push(
          `Realized booking metrics for ${snapshot.periodLabel} could not be loaded and that period was ignored.`
        );
      }
    }

    if (periodComparisons.length === 0) {
      return buildUnavailablePricingSensitivityModel({
        filters,
        reportHref,
        isManager,
        warnings,
        loadError:
          "Pricing sensitivity could not be calculated because the selected finance periods could not be matched to realized booking activity.",
      });
    }

    const periodCount = periodComparisons.length;
    const totalCostsCents = periodComparisons.reduce(
      (total, comparison) => total + comparison.totalCostsCents,
      0
    );
    const totalGuestNights = periodComparisons.reduce(
      (total, comparison) => total + comparison.guestNights,
      0
    );
    const totalBookedRevenueCents = periodComparisons.reduce(
      (total, comparison) => total + comparison.bookedRevenueCents,
      0
    );
    const totalCapacityBedNights = periodComparisons.reduce(
      (total, comparison) => total + comparison.capacityBedNights,
      0
    );
    const averageMonthlyCostsCents = Math.round(totalCostsCents / periodCount);
    const averageGuestNights = totalGuestNights / periodCount;
    const averageOccupancyRate =
      totalCapacityBedNights > 0 ? totalGuestNights / totalCapacityBedNights : 0;
    const averageRevenuePerGuestNightCents =
      totalGuestNights > 0
        ? Math.round(totalBookedRevenueCents / totalGuestNights)
        : null;
    const averageBookedRevenueLessCostsCents = Math.round(
      (totalBookedRevenueCents - totalCostsCents) / periodCount
    );
    const averageCapacityBedNights = totalCapacityBedNights / periodCount;
    const scenarioRows = buildScenarioRows({
      averageCapacityBedNights,
      averageMonthlyCostsCents,
      actualAverageRevenuePerGuestNightCents:
        averageRevenuePerGuestNightCents,
    });

    return {
      generatedOn: formatDateTime(new Date().toISOString()),
      isManager,
      filters,
      reportHref,
      filterWarnings: warnings,
      coverageSummary: `Showing ${periodCount} stored monthly pricing-sensitivity period${periodCount === 1 ? "" : "s"} from ${periodComparisons[0]?.periodLabel ?? "the latest costs snapshot"} backwards.`,
      summaryCards: [
        {
          title: "Average monthly costs",
          value: formatFinanceAmount(averageMonthlyCostsCents),
          description:
            "Average stored monthly expense total across the selected profit-and-loss finance snapshots.",
          footnote: `${formatNumber(periodCount)} matched month${periodCount === 1 ? "" : "s"} included in this report.`,
        },
        {
          title: "Average realized guest nights",
          value: formatDecimal(averageGuestNights),
          description:
            `Average ${CLUB_NAME} guest nights across the same selected monthly windows.`,
          footnote: `Average realized occupancy ${formatOccupancyRate(averageOccupancyRate)}.`,
        },
        {
          title: "Average realized revenue / guest night",
          value:
            averageRevenuePerGuestNightCents === null
              ? "Unavailable"
              : formatFinanceAmount(averageRevenuePerGuestNightCents),
          description:
            `Booked revenue per guest night from ${CLUB_NAME} booking metrics, not payment-derived cash.`,
          footnote:
            averageRevenuePerGuestNightCents === null
              ? "No guest nights were present in the selected realized booking windows."
              : "Used as the reference rate for the scenario table below.",
        },
        {
          title: "Average booked revenue less costs",
          value: formatSignedFinanceAmount(averageBookedRevenueLessCostsCents),
          description:
            "Average monthly booked revenue minus stored monthly costs across the selected periods.",
          footnote:
            totalGuestNights > 0
              ? `Break-even at realized demand: ${formatFinanceAmount(
                  Math.round(totalCostsCents / totalGuestNights)
                )} per guest night.`
              : "Break-even at realized demand is unavailable because no guest nights were recorded.",
        },
      ],
      periodRows: periodComparisons.map((comparison) => ({
        snapshotId: comparison.snapshotId,
        periodLabel: comparison.periodLabel,
        sourceWindow: comparison.sourceWindow,
        totalCosts: formatFinanceAmount(comparison.totalCostsCents),
        guestNights: formatNumber(comparison.guestNights),
        occupancyRate: formatOccupancyRate(comparison.occupancyRate),
        averageRevenuePerGuestNight:
          comparison.averageRevenuePerGuestNightCents === null
            ? "—"
            : formatFinanceAmount(comparison.averageRevenuePerGuestNightCents),
        breakEvenRevenuePerGuestNight:
          comparison.breakEvenRevenuePerGuestNightCents === null
            ? "—"
            : formatFinanceAmount(comparison.breakEvenRevenuePerGuestNightCents),
        bookedRevenueLessCosts: formatSignedFinanceAmount(
          comparison.bookedRevenueLessCostsCents
        ),
      })),
      scenarioRows,
      sourceNotes: buildPricingSensitivitySourceNotes(),
    };
  } catch (error) {
    console.error("Failed to load finance pricing sensitivity report", error);

    return buildUnavailablePricingSensitivityModel({
      filters,
      reportHref,
      isManager,
      warnings,
      loadError: await buildFinanceSnapshotLoadErrorMessage({
        member: input.member,
        reportTitle: "This pricing report",
        dataLabel: "monthly cost snapshots",
      }),
    });
  }
}

function buildUnavailablePricingSensitivityModel(input: {
  filters: FinancePricingSensitivityFilters;
  reportHref: string;
  isManager: boolean;
  warnings: string[];
  loadError: string;
}): FinancePricingSensitivityPageModel {
  return {
    generatedOn: formatDateTime(new Date().toISOString()),
    isManager: input.isManager,
    filters: input.filters,
    reportHref: input.reportHref,
    filterWarnings: input.warnings,
    loadError: input.loadError,
    coverageSummary: "Pricing sensitivity unavailable",
    summaryCards: [],
    periodRows: [],
    scenarioRows: [],
    sourceNotes: buildPricingSensitivitySourceNotes(),
  };
}

function buildPricingSensitivitySourceNotes() {
  return [
    {
      label: "Cost source",
      description:
        "Monthly costs on this page come from finance profit and loss snapshots synced from Xero.",
    },
    {
      label: "Booking source",
      description:
        "Guest nights and booked revenue come from TACBookings booking activity for the same monthly windows. Booked revenue is based on bookings, not payment cash.",
    },
    {
      label: "Scenario method",
      description:
        "Required revenue per guest night is calculated from average monthly costs and the implied guest nights at each occupancy assumption.",
    },
    {
      label: "What is not included",
      description:
        "This page does not call Xero live, and it does not include cash-flow or working-capital analysis.",
    },
  ];
}

function buildPeriodComparison(input: {
  snapshot: ParsedCostsSnapshot;
  realized: FinanceRealizedStayMetrics;
}): PricingSensitivityPeriodComparison {
  const totals = input.realized.totals;

  return {
    snapshotId: input.snapshot.snapshotId,
    periodLabel: input.snapshot.periodLabel,
    sourceWindow: formatSnapshotWindowFromDateOnly(
      input.realized.window.effectiveFrom ?? input.realized.window.from,
      input.realized.window.effectiveTo ?? input.realized.window.to
    ),
    totalCostsCents: input.snapshot.totalCostsCents,
    guestNights: totals.guestNights,
    occupancyRate: totals.occupancy.occupancyRate,
    bookedRevenueCents: totals.bookedRevenueCents,
    averageRevenuePerGuestNightCents:
      totals.guestNights > 0
        ? Math.round(totals.bookedRevenueCents / totals.guestNights)
        : null,
    breakEvenRevenuePerGuestNightCents:
      totals.guestNights > 0
        ? Math.round(input.snapshot.totalCostsCents / totals.guestNights)
        : null,
    bookedRevenueLessCostsCents:
      totals.bookedRevenueCents - input.snapshot.totalCostsCents,
    capacityBedNights: totals.occupancy.capacityBedNights,
  };
}

function buildScenarioRows(input: {
  averageCapacityBedNights: number;
  averageMonthlyCostsCents: number;
  actualAverageRevenuePerGuestNightCents: number | null;
}): FinancePricingSensitivityScenarioRow[] {
  return PRICING_SENSITIVITY_OCCUPANCY_ASSUMPTIONS.map((occupancyRate) => {
    const impliedGuestNights = input.averageCapacityBedNights * occupancyRate;
    const requiredRevenuePerGuestNightCents =
      impliedGuestNights > 0
        ? Math.round(input.averageMonthlyCostsCents / impliedGuestNights)
        : null;
    const impliedRevenueAtActualRateCents =
      input.actualAverageRevenuePerGuestNightCents === null
        ? null
        : Math.round(
            impliedGuestNights * input.actualAverageRevenuePerGuestNightCents
          );
    const bookedRevenueLessCostsCents =
      impliedRevenueAtActualRateCents === null
        ? null
        : impliedRevenueAtActualRateCents - input.averageMonthlyCostsCents;

    return {
      occupancyAssumption: formatOccupancyRate(occupancyRate),
      impliedGuestNights: formatDecimal(impliedGuestNights),
      requiredRevenuePerGuestNight:
        requiredRevenuePerGuestNightCents === null
          ? "—"
          : formatFinanceAmount(requiredRevenuePerGuestNightCents),
      impliedRevenueAtActualRate:
        impliedRevenueAtActualRateCents === null
          ? "—"
          : formatFinanceAmount(impliedRevenueAtActualRateCents),
      bookedRevenueLessCosts:
        bookedRevenueLessCostsCents === null
          ? "—"
          : formatSignedFinanceAmount(bookedRevenueLessCostsCents),
    };
  });
}

function resolveSnapshotMetricsWindow(snapshot: ParsedCostsSnapshot) {
  if (!snapshot.periodStart) {
    return null;
  }

  const fromDate = parseDateOnly(snapshot.periodStart);
  const periodEndDate = snapshot.periodEnd
    ? parseDateOnly(snapshot.periodEnd)
    : parseDateOnly(snapshot.asOfDate);
  const asOfDate = parseDateOnly(snapshot.asOfDate);

  if (
    Number.isNaN(fromDate.getTime()) ||
    Number.isNaN(periodEndDate.getTime()) ||
    Number.isNaN(asOfDate.getTime())
  ) {
    return null;
  }

  const toDate =
    periodEndDate.getTime() <= asOfDate.getTime() ? periodEndDate : asOfDate;

  if (fromDate.getTime() > toDate.getTime()) {
    return null;
  }

  return {
    from: formatDateOnly(fromDate),
    to: formatDateOnly(toDate),
  };
}

function readSearchParam(
  searchParams: FinancePricingSensitivitySearchParams | undefined,
  key: string
) {
  const value = searchParams?.[key];

  if (Array.isArray(value)) {
    return value[0];
  }

  return value;
}

function formatFinanceAmount(cents: number) {
  return formatCents(cents);
}

function formatSignedFinanceAmount(cents: number) {
  if (cents === 0) {
    return formatFinanceAmount(0);
  }

  const sign = cents > 0 ? "+" : "-";
  return `${sign}${formatFinanceAmount(Math.abs(cents))}`;
}

function formatDateTime(value: string) {
  return new Date(value).toLocaleString("en-NZ", {
    timeZone: FINANCE_TIMEZONE,
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function formatDisplayDate(value: string) {
  return new Date(`${value}T00:00:00.000Z`).toLocaleDateString("en-NZ", {
    timeZone: FINANCE_TIMEZONE,
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function formatSnapshotWindowFromDateOnly(from: string, to: string) {
  return `${formatDisplayDate(from)} to ${formatDisplayDate(to)}`;
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("en-NZ", {
    maximumFractionDigits: 0,
  }).format(value);
}

function formatDecimal(value: number) {
  return new Intl.NumberFormat("en-NZ", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(value);
}

function formatOccupancyRate(rate: number) {
  return `${(rate * 100).toFixed(1)}%`;
}
