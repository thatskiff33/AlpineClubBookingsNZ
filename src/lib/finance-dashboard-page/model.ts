// Type-only imports from `components`: erased at compile time, so the view
// model shares the renderer's unions without adding a runtime edge (#3264).
import type { FinanceValueType } from "@/components/finance/charts/finance-chart-theme";
import type { BadgeVariant } from "@/components/ui/badge";
import type { FinanceDashboardSelection } from "@/lib/finance-dashboard-ranges";
import type { FinanceRatioMatrix } from "@/lib/finance-ratio-shared";

export type FinanceDashboardViewModel = Pick<
  FinanceDashboardPageModel,
  | "cards"
  | "trends"
  | "mix"
  | "statusPanels"
  | "costFilters"
  | "sourceNotes"
  | "exportSections"
> & { warnings: string[] };

export interface FinanceDashboardKpiCard {
  title: string;
  value: string;
  description: string;
  footnote?: string;
}

export interface FinanceDashboardTrend {
  title: string;
  description: string;
  variant: "bar" | "area" | "line";
  xKey: string;
  data: Array<Record<string, number | string>>;
  series: Array<{
    key: string;
    name: string;
    color: string;
    valueType: FinanceValueType;
    stackId?: string;
  }>;
}

interface FinanceDashboardMix {
  title: string;
  description: string;
  valueType: FinanceValueType;
  data: Array<{ name: string; value: number }>;
}

export interface FinanceDashboardStatusPanel {
  title: string;
  description: string;
  badgeLabel?: string;
  badgeTone?: BadgeVariant;
  items: Array<{
    label: string;
    value: string;
    detail?: string;
    // Set on subtype sub-heading / sub-total rows so the renderer can emphasise them.
    emphasis?: boolean;
    href?: string;
    linkLabel?: string;
  }>;
}

interface FinanceDashboardExportSection {
  title: string;
  rows: Array<Record<string, string | number>>;
}

interface FinanceDashboardCostFilters {
  categories: Array<{ id: string; label: string }>;
  lines: Array<{ value: string; label: string; categoryId: string }>;
}

export interface FinanceDashboardSyncStatus {
  label: string;
  tone: BadgeVariant;
  detail: string;
  lastSyncedAt: string | null;
}

export interface FinanceDashboardRatioExplorerModel {
  matrix: FinanceRatioMatrix;
  initialNumeratorId: string | null;
  initialDenominatorId: string | null;
  initialRangeKey: string | null;
}

export interface FinanceDashboardPageModel {
  generatedOn: string;
  isManager: boolean;
  selection: FinanceDashboardSelection;
  /** Present only on the Ratios view; drives the client-side explorer. */
  ratios: FinanceDashboardRatioExplorerModel | null;
  selectionLabels: {
    view: string;
    range: string;
    compare: string;
    forward: string;
    primaryWindow: string;
    comparisonWindow: string;
    forwardWindow: string;
  };
  syncStatus: FinanceDashboardSyncStatus;
  warnings: string[];
  cards: FinanceDashboardKpiCard[];
  trends: FinanceDashboardTrend[];
  mix: FinanceDashboardMix | null;
  statusPanels: FinanceDashboardStatusPanel[];
  costFilters: FinanceDashboardCostFilters | null;
  sourceNotes: Array<{
    label: string;
    description: string;
    href?: string;
    linkLabel?: string;
  }>;
  exportSections: FinanceDashboardExportSection[];
  /**
   * Active lodges for the booking-derived reporting scope (occupancy, guest
   * nights, booked revenue). ADR-002: the selector only appears once a second
   * active lodge exists, so a single-lodge club sees an empty list and no
   * selector. Accounting views (P&L, cash, balances) stay club-wide and ignore
   * this scope — including the seasons behind the "Rest of Season" forward
   * window (#2919), which honour it only on the views that render the selector
   * (FINANCE_DASHBOARD_LODGE_SCOPED_VIEWS), never on a lodgeId the query string
   * happens to have carried over.
   */
  lodges: Array<{ id: string; name: string }>;
  /** Selected reporting lodge, or null for all active lodges (summed capacity). */
  selectedLodgeId: string | null;
}

/**
 * A month point on a trend axis; the month still in progress is flagged so a
 * partial bar is never read as a whole one. Shared by the P&L and
 * balance-sheet trends (one home, INV-SSOT-001).
 */
export function monthPointLabel(point: { label: string; isProvisional: boolean }) {
  return point.isProvisional ? `${point.label} (MTD)` : point.label;
}

/** The same flag as an export cell, on every month-keyed export row. */
export function monthToDateCell(point: { isProvisional: boolean }) {
  return point.isProvisional ? "yes" : "";
}

export function cardRows(cards: FinanceDashboardKpiCard[]) {
  return cards.map((card) => ({
    Metric: card.title,
    Value: card.value,
    Description: card.description,
    Footnote: card.footnote ?? "",
  }));
}
