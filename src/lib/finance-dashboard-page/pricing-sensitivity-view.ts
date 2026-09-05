import { getFinanceBookingMetrics } from "@/lib/finance-booking-metrics";
import {
  financeDashboardDateRangeDayCount,
  type FinanceDashboardSelection,
} from "@/lib/finance-dashboard-ranges";
import {
  formatDollarsDisplay,
  formatFinanceNumber as formatNumber,
  formatFinancePercent as formatPercent,
  formatSignedDollarsDisplay,
} from "@/lib/finance-format";
import {
  buildFinanceMonthlyPnlSummary,
} from "@/lib/finance-monthly-pnl";
import { formatCents } from "@/lib/utils";
import {
  cardRows,
  type FinanceDashboardKpiCard,
} from "@/lib/finance-dashboard-page/model";
import { SERIES_COLORS } from "@/lib/finance-dashboard-page/series-colors";

export async function buildPricingSensitivityDashboard(
  selection: FinanceDashboardSelection,
  lodgeId: string | null
) {
  const [costs, metrics] = await Promise.all([
    buildFinanceMonthlyPnlSummary({
      kind: "EXPENSE",
      primary: selection.primary,
      comparison: null,
      currentMonth: selection.currentMonth,
    }),
    getFinanceBookingMetrics({
      realized: {
        from: selection.primary.from,
        to: selection.primary.to,
        cutoffDate: selection.primary.to,
      },
      lodgeId,
    }),
  ]);
  const realized = metrics.realized;
  const guestNights = realized?.totals.guestNights ?? 0;
  const bookedRevenueCents = realized?.totals.bookedRevenueCents ?? 0;
  const realizedRateCents =
    guestNights > 0 ? Math.round(bookedRevenueCents / guestNights) : null;
  const breakEvenRateCents =
    guestNights > 0 ? Math.round(costs.amountCents / guestNights) : null;
  const bookedRevenueLessCostsCents = bookedRevenueCents - costs.amountCents;
  const capacityBedNights =
    realized?.totals.occupancy.capacityBedNights ??
    financeDashboardDateRangeDayCount(selection.primary);
  const assumptions = [0.2, 0.35, 0.5, 0.65, 0.8];
  const scenarioData = assumptions.map((occupancy) => {
    const impliedGuestNights = Math.round(capacityBedNights * occupancy);
    return {
      label: formatPercent(occupancy),
      requiredRate:
        impliedGuestNights > 0
          ? Math.round(costs.amountCents / impliedGuestNights)
          : 0,
      realizedRevenue:
        realizedRateCents === null ? 0 : impliedGuestNights * realizedRateCents,
    };
  });
  // Per-night rates keep cents: they are unit prices where cents are signal.
  const cards: FinanceDashboardKpiCard[] = [
    {
      title: "Break-even revenue / guest night",
      value: breakEvenRateCents === null ? "Unavailable" : formatCents(breakEvenRateCents),
      description: "Selected-period costs divided by realized guest nights.",
    },
    {
      title: "Realized rate",
      value: realizedRateCents === null ? "Unavailable" : formatCents(realizedRateCents),
      description: "Booked revenue divided by realized guest nights.",
    },
    {
      title: "Booked revenue less costs",
      value: formatSignedDollarsDisplay(bookedRevenueLessCostsCents),
      description: "Booking-system revenue less mapped Xero costs.",
    },
    {
      title: "Realized guest nights",
      value: formatNumber(guestNights),
      description: "Demand base used by the break-even calculation.",
    },
  ];

  return {
    cards,
    trends: [
      {
        title: "Occupancy scenario chart",
        description:
          "Required guest-night rate by occupancy assumption, compared with revenue at the realized rate.",
        variant: "bar" as const,
        xKey: "label",
        data: scenarioData,
        series: [
          {
            key: "requiredRate",
            name: "Required rate",
            color: SERIES_COLORS.costs,
            valueType: "currency" as const,
          },
          {
            key: "realizedRevenue",
            name: "Revenue at realized rate",
            color: SERIES_COLORS.revenue,
            valueType: "currency" as const,
          },
        ],
      },
    ],
    mix: null,
    statusPanels: [
      {
        title: "Scenario assumptions",
        description: "Break-even rates are based on mapped selected-period costs.",
        items: scenarioData.map((scenario) => ({
          label: scenario.label,
          value: formatCents(scenario.requiredRate),
          detail: `Revenue at realized rate ${formatDollarsDisplay(scenario.realizedRevenue)}`,
        })),
      },
    ],
    costFilters: null,
    sourceNotes: [
      {
        label: "Cost source",
        description:
          "Costs come from stored monthly Xero account balances and setup mappings.",
      },
      {
        label: "Booking source",
        description: "Guest nights and booked revenue come from local booking metrics.",
      },
    ],
    exportSections: [
      { title: "KPI cards", rows: cardRows(cards) },
      { title: "Scenarios", rows: scenarioData },
    ],
    warnings: costs.warnings,
  };
}
