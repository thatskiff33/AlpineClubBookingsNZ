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
    valueType: "currency" | "count" | "percent" | "ratio";
    stackId?: string;
  }>;
}

interface FinanceDashboardMix {
  title: string;
  description: string;
  valueType: "currency" | "count" | "percent" | "ratio";
  data: Array<{ name: string; value: number }>;
}

export interface FinanceDashboardStatusPanel {
  title: string;
  description: string;
  badgeLabel?: string;
  badgeTone?: "success" | "warning" | "destructive" | "secondary";
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
  tone: "success" | "warning" | "destructive" | "secondary";
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

export function cardRows(cards: FinanceDashboardKpiCard[]) {
  return cards.map((card) => ({
    Metric: card.title,
    Value: card.value,
    Description: card.description,
    Footnote: card.footnote ?? "",
  }));
}
