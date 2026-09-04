import { formatClubDayMonth, requireCalendarDate } from "@/lib/club-time";
import {
  getFinanceBookingMetrics,
  type FinanceBookingMetricsResult,
} from "@/lib/finance-booking-metrics";
import type { FinanceDashboardSelection } from "@/lib/finance-dashboard-ranges";
import {
  formatDollarsDisplay,
  formatFinanceNumber as formatNumber,
  formatFinancePercent as formatPercent,
  formatFinanceSignedNumber as formatSignedNumber,
  formatSignedDollarsDisplay,
} from "@/lib/finance-format";
import {
  cardRows,
  type FinanceDashboardKpiCard,
  type FinanceDashboardStatusPanel,
  type FinanceDashboardTrend,
  type FinanceDashboardViewModel,
} from "@/lib/finance-dashboard-page/model";
import { SERIES_COLORS } from "@/lib/finance-dashboard-page/series-colors";

// Compact day+month export label ("14 Jun"), deliberately year-less: it labels
// rows already scoped to one range, and widening it to the shared medium form
// would change an exported report column. That bag is the kernel's `dayMonth`
// shape (F3, #3079), so the local formatter this file kept is gone.
//
// CT-4 (#2870): THIS ALSO CORRECTS THE DAY. Every value reaching it is a
// `yyyy-MM-dd` metric key minted by `buildIsoDateRange`, i.e. a CALENDAR DATE,
// which takes no zone — and the local formatter was still pinned to
// `APP_TIME_ZONE`. That projection cancelled only because New Zealand is east of
// Greenwich; for a club west of it every trend point on the finance dashboard,
// and every exported row label, named the PREVIOUS day (INV-DATE-019).

function formatShortDate(dateOnly: string) {
  return formatClubDayMonth(requireCalendarDate(dateOnly));
}

export async function buildBookingsDashboard(
  selection: FinanceDashboardSelection,
  lodgeId: string | null
): Promise<FinanceDashboardViewModel> {
  const warnings: string[] = [];
  const query = {
    realized: {
      from: selection.primary.from,
      to: selection.primary.to,
      cutoffDate: selection.primary.to,
    },
    ...(selection.forwardWindow.from && selection.forwardWindow.to
      ? {
          forward: {
            from: selection.forwardWindow.from,
            to: selection.forwardWindow.to,
            asOfDate: selection.primary.to,
          },
        }
      : {}),
    lodgeId,
  };
  const [metrics, comparison] = await Promise.all([
    getFinanceBookingMetrics(query),
    selection.comparison
      ? getFinanceBookingMetrics({
          realized: {
            from: selection.comparison.from,
            to: selection.comparison.to,
            cutoffDate: selection.comparison.to,
          },
          lodgeId,
        })
      : Promise.resolve(null),
  ]);
  const realized = metrics.realized;
  const compareRealized = comparison?.realized ?? null;

  if (!realized) {
    warnings.push("Realized booking metrics were unavailable for the selected range.");
  }

  // #2408. Net collected cash is the gross captured figure from the payment
  // rows, which contains a collected price increase because the payment ledger
  // put it there. A payment that says its increase was collected without a
  // ledger row to prove it is the one shape where that is not true, so the card
  // below would understate the cash. Say so where the treasurer reads the
  // number, and say by how much, rather than publishing a figure that is
  // quietly short.
  const ledgerGapBookings =
    metrics.paymentSummary.additionalLedgerGapBookings;
  if (ledgerGapBookings > 0) {
    warnings.push(
      `Net collected cash may understate by ${formatDollarsDisplay(metrics.paymentSummary.additionalLedgerGapCents)}: ${formatNumber(ledgerGapBookings)} booking${ledgerGapBookings === 1 ? "" : "s"} in this range record an extra payment as collected without a matching payment record behind it. Ask a developer to re-check those payments before reconciling this figure.`
    );
  }

  const realizedTotals = realized?.totals;
  const compareTotals = compareRealized?.totals;
  const cards: FinanceDashboardKpiCard[] = [
    {
      title: "Realized guest nights",
      value: formatNumber(realizedTotals?.guestNights ?? 0),
      description: "Guest nights stayed in the selected period.",
      footnote: compareTotals
        ? `${formatSignedNumber((realizedTotals?.guestNights ?? 0) - compareTotals.guestNights)} vs comparison.`
        : undefined,
    },
    {
      title: "Occupancy",
      value: formatPercent(realizedTotals?.occupancy.occupancyRate ?? 0),
      description: "Occupied bed nights divided by available bed nights.",
      footnote: compareTotals
        ? `${formatPercent(compareTotals.occupancy.occupancyRate)} in comparison.`
        : undefined,
    },
    {
      title: "Booked revenue",
      value: formatDollarsDisplay(realizedTotals?.bookedRevenueCents ?? 0),
      description: "Booking-system revenue allocated across realized stay nights.",
      footnote: compareTotals
        ? `${formatSignedDollarsDisplay((realizedTotals?.bookedRevenueCents ?? 0) - compareTotals.bookedRevenueCents)} vs comparison.`
        : undefined,
    },
    {
      title: "Net collected cash",
      value: formatDollarsDisplay(metrics.paymentSummary.netCollectedCents),
      // #2408: one figure, counted once. The captured amount on a payment row
      // already includes any later price increase that was collected, so this
      // is the whole of the cash and not a part of it.
      description:
        "Captured payments less refunds from local payment rows, including any collected price increase.",
      footnote:
        ledgerGapBookings > 0
          ? `May understate by ${formatDollarsDisplay(metrics.paymentSummary.additionalLedgerGapCents)} - see the warning above. Cash is local payment-derived and separate from Xero revenue.`
          : "Cash is local payment-derived and separate from Xero revenue.",
    },
    {
      title: "Forward demand",
      value: formatNumber(metrics.forward?.totals.totalPipeline.guestNights ?? 0),
      description: "Committed plus at-risk future guest nights in the forward window.",
      footnote: selection.forwardWindow.from
        ? selection.forwardWindow.label
        : "Forward window unavailable.",
    },
    {
      // #2350: the payment summary has always counted these; nothing rendered
      // them, so an upward booking change whose extra was never collected was
      // invisible on every finance surface.
      title: "Outstanding additional payments",
      value: formatDollarsDisplay(
        metrics.paymentSummary.outstandingAdditionalCents,
      ),
      description:
        "Extra owed after an upward booking change and not yet collected, for bookings in the selected range.",
      // Window-scoped, unlike the admin dashboard card and sidebar badge (which
      // count every owing booking, whenever it stays) and the reports summary
      // (which counts the report's own date range). Say so, or the three
      // numbers look like a contradiction rather than three questions.
      footnote: `${formatNumber(metrics.paymentSummary.outstandingAdditionalBookings)} booking${metrics.paymentSummary.outstandingAdditionalBookings === 1 ? "" : "s"} awaiting or failed payment in this range.`,
    },
  ];

  const trends: FinanceDashboardTrend[] = [];
  if (realized) {
    trends.push({
      title: "Occupancy and guest-night trend",
      description: "Daily realized occupancy and guest nights for the selected range.",
      variant: "line",
      xKey: "label",
      data: realized.byDate.map((entry) => ({
        label: formatShortDate(entry.date),
        occupancy: entry.occupancyRate,
        guestNights: entry.guestNights,
      })),
      series: [
        {
          key: "occupancy",
          name: "Occupancy",
          color: SERIES_COLORS.revenue,
          valueType: "percent",
        },
        {
          key: "guestNights",
          name: "Guest nights",
          color: SERIES_COLORS.bookings,
          valueType: "count",
        },
      ],
    });
  }
  if (metrics.forward) {
    trends.push({
      title: "Forward committed and at-risk demand",
      description: "Future pipeline split between paid committed stays and at-risk bookings.",
      variant: "area",
      xKey: "label",
      data: metrics.forward.byDate.map((entry) => ({
        label: formatShortDate(entry.date),
        committed: entry.committed.guestNights,
        atRisk: entry.atRisk.guestNights,
      })),
      series: [
        {
          key: "committed",
          name: "Committed",
          color: SERIES_COLORS.positive,
          valueType: "count",
          stackId: "pipeline",
        },
        {
          key: "atRisk",
          name: "At risk",
          color: SERIES_COLORS.costs,
          valueType: "count",
          stackId: "pipeline",
        },
      ],
    });
  }

  const statusPanels = buildBookingStatusPanels(metrics);
  return {
    cards,
    trends,
    mix: null,
    statusPanels,
    costFilters: null,
    sourceNotes: [
      {
        label: "Booking metrics",
        description:
          "Guest nights, occupancy, and booked revenue come from local booking and guest-night rows.",
      },
      {
        label: "Payment cash",
        description:
          "Net collected cash comes from local payment rows and remains separate from Xero revenue recognition.",
      },
    ],
    exportSections: [
      { title: "KPI cards", rows: cardRows(cards) },
      {
        title: "Forward status",
        rows: statusPanels.flatMap((panel) =>
          panel.items.map((item) => ({
            Panel: panel.title,
            Label: item.label,
            Value: item.value,
            Detail: item.detail ?? "",
          }))
        ),
      },
    ],
    warnings,
  };
}

function buildBookingStatusPanels(
  metrics: FinanceBookingMetricsResult
): FinanceDashboardStatusPanel[] {
  const panels: FinanceDashboardStatusPanel[] = [];
  if (metrics.realized) {
    panels.push({
      title: "Realized status mix",
      description: "Booking statuses contributing to realized guest nights.",
      items: Object.entries(metrics.realized.statusBreakdown).map(
        ([status, summary]) => ({
          label: status,
          value: formatNumber(summary.guestNights),
          detail: `${formatNumber(summary.bookingCount)} bookings, ${formatDollarsDisplay(summary.bookedRevenueCents)}`,
        })
      ),
    });
  }
  // #2350: the additional-payment status split, alongside the existing
  // realized/forward panels. Rendered only when something is actually
  // outstanding — an all-clear panel of zeroes is noise on a busy dashboard.
  const additionalBreakdown =
    metrics.paymentSummary.additionalPaymentStatusBreakdown;
  if (metrics.paymentSummary.outstandingAdditionalBookings > 0) {
    panels.push({
      title: "Outstanding additional payments",
      description:
        "Bookings whose price went up after payment, with the extra still uncollected.",
      badgeLabel: "Owing",
      badgeTone: "secondary",
      items: [
        {
          label: "Awaiting payment",
          value: formatNumber(additionalBreakdown.PENDING),
          detail: "Charge not yet completed by the member.",
        },
        {
          label: "Payment failed",
          value: formatNumber(additionalBreakdown.FAILED),
          detail: "The last attempt to charge the card did not succeed.",
        },
        {
          label: "Total outstanding",
          value: formatDollarsDisplay(
            metrics.paymentSummary.outstandingAdditionalCents
          ),
          detail: `Across ${formatNumber(metrics.paymentSummary.outstandingAdditionalBookings)} booking${metrics.paymentSummary.outstandingAdditionalBookings === 1 ? "" : "s"}.`,
        },
      ],
    });
  }
  if (metrics.forward) {
    panels.push({
      title: "Forward pipeline split",
      description: "Committed demand is paid; at-risk demand still needs settlement or review.",
      badgeLabel: "Forward",
      badgeTone: "secondary",
      items: [
        {
          label: "Committed",
          value: formatNumber(metrics.forward.totals.committed.guestNights),
          detail: formatDollarsDisplay(
            metrics.forward.totals.committed.bookedRevenueCents
          ),
        },
        {
          label: "At risk",
          value: formatNumber(metrics.forward.totals.atRisk.guestNights),
          detail: formatDollarsDisplay(
            metrics.forward.totals.atRisk.bookedRevenueCents
          ),
        },
      ],
    });
  }
  return panels;
}
