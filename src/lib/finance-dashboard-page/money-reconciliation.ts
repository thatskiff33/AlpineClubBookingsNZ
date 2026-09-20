import type { BookingMoneyReconciliationSummary } from "@/lib/booking-money-reconciliation";
import { BOOKING_MONEY_RECONCILIATION_COPY } from "@/lib/booking-money-reconciliation-audience";
import type { FinanceDashboardStatusPanel } from "@/lib/finance-dashboard-page/model";

type FormatNumber = (value: number) => string;

type ReconciliationScope = {
  label: string;
  summary: BookingMoneyReconciliationSummary;
};

function reconciliationDetail(
  summary: BookingMoneyReconciliationSummary,
  formatNumber: FormatNumber,
) {
  const reasonCounts = Object.entries(summary.byReason)
    .filter(([, count]) => count > 0)
    .map(([reason, count]) => `${reason}: ${formatNumber(count)}`);
  return `${formatNumber(summary.byState.RECONCILED)} reconciled, ${formatNumber(summary.byState.UNRECONCILED)} unreconciled of ${formatNumber(summary.totalBookings)} bookings${reasonCounts.length > 0 ? ` (${reasonCounts.join(", ")})` : ""}.`;
}

/**
 * The finance dashboard's one presentation of the canonical reconciliation
 * summary. The metrics query owns classification and aggregation; dashboard
 * views only carry the derived state, every non-zero reason count, and the
 * warning that stored-money figures need review.
 */
export function appendBookingMoneyReconciliationDashboardState({
  warnings,
  primary,
  comparison,
  affectedMetrics,
  formatNumber,
}: {
  warnings: string[];
  primary: BookingMoneyReconciliationSummary;
  comparison: BookingMoneyReconciliationSummary | null;
  affectedMetrics: string;
  formatNumber: FormatNumber;
}): FinanceDashboardStatusPanel {
  const scopes: ReconciliationScope[] = [
    { label: "Primary", summary: primary },
  ];
  if (comparison) scopes.push({ label: "Comparison", summary: comparison });

  for (const { label, summary } of scopes) {
    if (summary.byState.UNRECONCILED === 0) continue;
    warnings.push(
      `${label} booking money reconciliation needs review: ${reconciliationDetail(summary, formatNumber)} ${affectedMetrics} derived from affected stored booking money must not be treated as trusted until those bookings are reviewed.`,
    );
  }

  return {
    // #3278 (`INV-SSOT`): what this feature is called has one home.
    title: BOOKING_MONEY_RECONCILIATION_COPY.featureName,
    description:
      "Derived reconciliation state for bookings contributing stored-money metrics. Unreconciled amounts remain visible but require review.",
    badgeLabel: scopes.some(({ summary }) => summary.byState.UNRECONCILED > 0)
      ? "Review"
      : BOOKING_MONEY_RECONCILIATION_COPY.stateLabel.RECONCILED,
    badgeTone: scopes.some(({ summary }) => summary.byState.UNRECONCILED > 0)
      ? "warning"
      : "success",
    items: scopes.flatMap(({ label, summary }) => [
      {
        label: `${label} reconciled`,
        value: formatNumber(summary.byState.RECONCILED),
        detail: `Of ${formatNumber(summary.totalBookings)} contributing bookings.`,
      },
      {
        label: `${label} unreconciled`,
        value: formatNumber(summary.byState.UNRECONCILED),
        detail:
          Object.entries(summary.byReason)
            .filter(([, count]) => count > 0)
            .map(([reason, count]) => `${reason}: ${formatNumber(count)}`)
            .join(", ") || "No unreconciled bookings.",
      },
    ]),
  };
}
