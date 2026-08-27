import {
  formatDateOnly,
  isDateOnlyString,
  parseDateOnly,
} from "@/lib/date-only";
import {
  financeDashboardDayLabel,
  financeDashboardMonthLabel,
  monthStartString,
} from "@/lib/finance-dashboard-labels";
import { getFinancialYearEndMonth } from "@/lib/financial-year";
import { isMonthKey, shiftMonthKey } from "@/lib/finance-monthly-facts";

// #3123 FINISHED THE FILE. The three `getTodayDateOnly()` reads that chose the
// reporting month became one required `today` parameter. Nothing in this module
// reads a zone any more, which is what its place on the browser graph requires.
//
// The display labels — the long month heading, the short trend-axis month and
// the window-bound day — live in `@/lib/finance-dashboard-labels`, which #3123
// split out and which carries the zone-correction history of each of them. That
// module inherits this one's place on the browser graph.

export const FINANCE_DASHBOARD_VIEWS = [
  "bookings",
  "revenue",
  "costs",
  "ratios",
  "pricing-sensitivity",
  "working-capital",
  "cash",
  "balance-sheet",
  "sync-health",
] as const;

export type FinanceDashboardView = (typeof FINANCE_DASHBOARD_VIEWS)[number];

/**
 * The views whose reads honour the page's Lodge (occupancy) scope (#2919), and
 * therefore the only views that render the lodge selector at all. ONE home for
 * that rule, read by both the client's render gate and the server's seasons
 * scope: a `lodgeId` left in the query string by a previous submit must not
 * scope a view that shows no selector to explain or clear it.
 */
export const FINANCE_DASHBOARD_LODGE_SCOPED_VIEWS: readonly FinanceDashboardView[] =
  ["bookings", "pricing-sensitivity"];

export function financeDashboardViewUsesLodgeScope(
  view: FinanceDashboardView
): boolean {
  return FINANCE_DASHBOARD_LODGE_SCOPED_VIEWS.includes(view);
}

// The dashboard is month-granular by design: every range is a whole-month
// window over the monthly fact table. Day-level detail lives in Xero.
export const FINANCE_DASHBOARD_RANGE_OPTIONS = [
  "last-month",
  "last-3-months",
  "last-6-months",
  "last-12-months",
  "financial-year-to-date",
  "last-financial-year",
  "custom",
] as const;

export type FinanceDashboardRangeOption =
  (typeof FINANCE_DASHBOARD_RANGE_OPTIONS)[number];

export const FINANCE_DASHBOARD_COMPARE_OPTIONS = [
  "previous-period",
  "same-period-last-year",
  "none",
  "custom",
] as const;

export type FinanceDashboardCompareOption =
  (typeof FINANCE_DASHBOARD_COMPARE_OPTIONS)[number];

export const FINANCE_DASHBOARD_FORWARD_OPTIONS = [
  "next-month",
  "next-quarter",
  "next-12-months",
  "rest-of-season",
  "custom",
] as const;

export type FinanceDashboardForwardOption =
  (typeof FINANCE_DASHBOARD_FORWARD_OPTIONS)[number];

export const FINANCE_DASHBOARD_VIEW_LABELS: Record<
  FinanceDashboardView,
  string
> = {
  bookings: "Bookings",
  revenue: "Revenue",
  costs: "Costs",
  ratios: "Ratios",
  "pricing-sensitivity": "Pricing Sensitivity",
  "working-capital": "Working Capital",
  cash: "Cash",
  "balance-sheet": "Balance Sheet",
  "sync-health": "Xero Sync",
};

export const FINANCE_DASHBOARD_RANGE_LABELS: Record<
  FinanceDashboardRangeOption,
  string
> = {
  "last-month": "Last Month",
  "last-3-months": "Last 3 Months",
  "last-6-months": "Last 6 Months",
  "last-12-months": "Last 12 Months",
  "financial-year-to-date": "Financial Year to Date",
  "last-financial-year": "Last Financial Year",
  custom: "Custom",
};

export const FINANCE_DASHBOARD_COMPARE_LABELS: Record<
  FinanceDashboardCompareOption,
  string
> = {
  "previous-period": "Previous Period",
  "same-period-last-year": "Same Period Last Year",
  none: "None",
  custom: "Custom",
};

export const FINANCE_DASHBOARD_FORWARD_LABELS: Record<
  FinanceDashboardForwardOption,
  string
> = {
  "next-month": "Next Month",
  "next-quarter": "Next Quarter",
  "next-12-months": "Next 12 Months",
  "rest-of-season": "Rest of Season",
  custom: "Custom",
};

// Pre-rebuild option values still arriving from bookmarks map onto their
// closest month-granular equivalent instead of silently falling back.
const LEGACY_RANGE_OPTION_MAP: Record<string, FinanceDashboardRangeOption> = {
  "last-quarter": "last-3-months",
  "year-to-date": "financial-year-to-date",
};

const LEGACY_COMPARE_OPTION_MAP: Record<string, FinanceDashboardCompareOption> =
  {
    "previous-month": "previous-period",
    "previous-quarter": "previous-period",
    "previous-year": "same-period-last-year",
    "previous-year-to-date": "same-period-last-year",
  };

type SearchParams = Record<string, string | string[] | undefined>;

export interface FinanceDashboardSeasonWindow {
  name: string;
  startDate: Date;
  endDate: Date;
  active: boolean;
  /**
   * The lodge this season belongs to (#2919), set only when the dashboard is in
   * All-Lodges mode at a club with more than one lodge — the one case where the
   * seasons on offer come from more than one property and the window label would
   * otherwise name a season without saying whose it is.
   */
  lodgeName?: string | null;
}

export interface FinanceDashboardDateWindow {
  /** First day of fromMonth, date-only. */
  from: string;
  /** Last day of toMonth, date-only. */
  to: string;
  /** Inclusive month-key range ("YYYY-MM") the window covers. */
  fromMonth: string;
  toMonth: string;
  label: string;
}

interface FinanceDashboardForwardWindow {
  from: string | null;
  to: string | null;
  label: string;
  seasonName?: string;
  /**
   * The lodge whose season set this window (#2919) — present ONLY in All-Lodges
   * mode at a club with more than one lodge, which is the one case where the
   * seasons on offer come from more than one property. Everywhere else it is
   * null and the window's wording is exactly what it always was.
   */
  seasonLodgeName?: string | null;
}

export interface FinanceDashboardSelection {
  view: FinanceDashboardView;
  range: FinanceDashboardRangeOption;
  compare: FinanceDashboardCompareOption;
  forward: FinanceDashboardForwardOption;
  primary: FinanceDashboardDateWindow;
  /** Null when compare is "none". */
  comparison: FinanceDashboardDateWindow | null;
  forwardWindow: FinanceDashboardForwardWindow;
  /** Month key of the in-progress month (data for it is provisional). */
  currentMonth: string;
  financialYearEndMonth: number;
  expenseCategoryId: string | null;
  expenseLine: string | null;
  /** Ratios-view explorer selection, for shareable links. */
  ratioNumeratorId: string | null;
  ratioDenominatorId: string | null;
  ratioRangeKey: string | null;
  warnings: string[];
}

function readParam(searchParams: SearchParams | undefined, key: string) {
  const value = searchParams?.[key];
  return Array.isArray(value) ? value.at(-1) : value;
}

function isOneOf<T extends readonly string[]>(
  value: string | undefined,
  options: T
): value is T[number] {
  return Boolean(value && (options as readonly string[]).includes(value));
}

function monthKeyFromDate(date: Date): string {
  return formatDateOnly(date).slice(0, 7);
}

function monthEndString(monthKey: string): string {
  const [year, month] = monthKey.split("-").map(Number);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${monthKey}-${String(lastDay).padStart(2, "0")}`;
}

function monthRangeLabel(fromMonth: string, toMonth: string) {
  return fromMonth === toMonth
    ? financeDashboardMonthLabel(fromMonth)
    : `${financeDashboardMonthLabel(fromMonth)} to ${financeDashboardMonthLabel(toMonth)}`;
}

function monthRangeWindow(
  fromMonth: string,
  toMonth: string,
  label?: string
): FinanceDashboardDateWindow {
  return {
    from: monthStartString(fromMonth),
    to: monthEndString(toMonth),
    fromMonth,
    toMonth,
    label: label ?? monthRangeLabel(fromMonth, toMonth),
  };
}

export function financeDashboardMonthCount(window: {
  fromMonth: string;
  toMonth: string;
}): number {
  const [fromYear, fromMonth] = window.fromMonth.split("-").map(Number);
  const [toYear, toMonth] = window.toMonth.split("-").map(Number);
  return (toYear - fromYear) * 12 + (toMonth - fromMonth) + 1;
}

/**
 * First month of the financial year containing `monthKey`, for a financial
 * year ending in `yearEndMonth` (1-12; March = NZ convention).
 */
function financialYearStartMonth(monthKey: string, yearEndMonth: number): string {
  const [year, month] = monthKey.split("-").map(Number);
  const startMonth = (yearEndMonth % 12) + 1;
  const startYear = month >= startMonth ? year : year - 1;
  return `${startYear}-${String(startMonth).padStart(2, "0")}`;
}

/** NZ convention: the financial year is named for its end year (FY2027 ends 31 Mar 2027). */
function financialYearName(fyStartMonth: string): string {
  const endMonth = shiftMonthKey(fyStartMonth, 11);
  return `FY${endMonth.slice(0, 4)}`;
}

/**
 * Read a custom boundary param as a month key. Accepts "YYYY-MM" (month
 * pickers) and clamps legacy "YYYY-MM-DD" values from old bookmarks to their
 * containing month with a warning.
 */
function readCustomMonthParam(input: {
  value: string | undefined;
  label: string;
  warnings: string[];
}): string | null {
  const value = input.value?.trim();
  if (!value) {
    return null;
  }
  if (isMonthKey(value)) {
    return value;
  }
  if (isDateOnlyString(value)) {
    const monthKey = value.slice(0, 7);
    input.warnings.push(
      `${input.label} now uses whole months; ${value} was read as ${financeDashboardMonthLabel(monthKey)}.`
    );
    return monthKey;
  }
  return null;
}

function resolveCustomMonthWindow(input: {
  fromParam: string | undefined;
  toParam: string | undefined;
  fallback: FinanceDashboardDateWindow;
  label: string;
  warnings: string[];
}): FinanceDashboardDateWindow {
  const fromMonth = readCustomMonthParam({
    value: input.fromParam,
    label: input.label,
    warnings: input.warnings,
  });
  const toMonth = readCustomMonthParam({
    value: input.toParam,
    label: input.label,
    warnings: input.warnings,
  });

  if (!fromMonth || !toMonth) {
    input.warnings.push(
      `${input.label} custom months were incomplete or invalid. Showing ${input.fallback.label}.`
    );
    return input.fallback;
  }

  if (fromMonth > toMonth) {
    input.warnings.push(
      `${input.label} custom end month must be on or after the start month. Showing ${input.fallback.label}.`
    );
    return input.fallback;
  }

  return monthRangeWindow(fromMonth, toMonth);
}

// test seam
export function resolvePrimaryFinanceRange(input: {
  option: FinanceDashboardRangeOption;
  searchParams?: SearchParams;
  /** REQUIRED — see the note on `resolveFinanceDashboardSelection` (#3123). */
  today: Date;
  financialYearEndMonth?: number;
  warnings?: string[];
}): FinanceDashboardDateWindow {
  const today = input.today;
  const warnings = input.warnings ?? [];
  const yearEndMonth = input.financialYearEndMonth ?? getFinancialYearEndMonth();
  const currentMonth = monthKeyFromDate(today);
  const lastCompleted = shiftMonthKey(currentMonth, -1);

  if (input.option === "last-month") {
    return monthRangeWindow(lastCompleted, lastCompleted);
  }

  if (input.option === "last-3-months") {
    return monthRangeWindow(shiftMonthKey(lastCompleted, -2), lastCompleted);
  }

  if (input.option === "last-6-months") {
    return monthRangeWindow(shiftMonthKey(lastCompleted, -5), lastCompleted);
  }

  if (input.option === "last-12-months") {
    return monthRangeWindow(shiftMonthKey(lastCompleted, -11), lastCompleted);
  }

  if (input.option === "financial-year-to-date") {
    // "To date" includes the in-progress month; its figures are provisional
    // month-to-date and flagged as such by the fact-table readers.
    const fyStart = financialYearStartMonth(currentMonth, yearEndMonth);
    return monthRangeWindow(
      fyStart,
      currentMonth,
      `${financialYearName(fyStart)} to date (${monthRangeLabel(fyStart, currentMonth)})`
    );
  }

  if (input.option === "last-financial-year") {
    const currentFyStart = financialYearStartMonth(currentMonth, yearEndMonth);
    const lastFyStart = shiftMonthKey(currentFyStart, -12);
    const lastFyEnd = shiftMonthKey(currentFyStart, -1);
    return monthRangeWindow(
      lastFyStart,
      lastFyEnd,
      `${financialYearName(lastFyStart)} (${monthRangeLabel(lastFyStart, lastFyEnd)})`
    );
  }

  return resolveCustomMonthWindow({
    fromParam: readParam(input.searchParams, "from"),
    toParam: readParam(input.searchParams, "to"),
    fallback: monthRangeWindow(lastCompleted, lastCompleted),
    label: "Primary range",
    warnings,
  });
}

export function resolveComparisonFinanceRange(input: {
  option: FinanceDashboardCompareOption;
  primary: FinanceDashboardDateWindow;
  searchParams?: SearchParams;
  warnings?: string[];
}): FinanceDashboardDateWindow | null {
  const warnings = input.warnings ?? [];

  if (input.option === "none") {
    return null;
  }

  const monthCount = financeDashboardMonthCount(input.primary);
  const previousPeriod = monthRangeWindow(
    shiftMonthKey(input.primary.fromMonth, -monthCount),
    shiftMonthKey(input.primary.fromMonth, -1)
  );

  if (input.option === "previous-period") {
    return previousPeriod;
  }

  if (input.option === "same-period-last-year") {
    return monthRangeWindow(
      shiftMonthKey(input.primary.fromMonth, -12),
      shiftMonthKey(input.primary.toMonth, -12)
    );
  }

  return resolveCustomMonthWindow({
    fromParam: readParam(input.searchParams, "compareFrom"),
    toParam: readParam(input.searchParams, "compareTo"),
    fallback: previousPeriod,
    label: "Comparison range",
    warnings,
  });
}

// test seam
function resolveForwardFinanceWindow(input: {
  option: FinanceDashboardForwardOption;
  searchParams?: SearchParams;
  /** REQUIRED — see the note on `resolveFinanceDashboardSelection` (#3123). */
  today: Date;
  seasons?: FinanceDashboardSeasonWindow[];
  warnings?: string[];
}): FinanceDashboardForwardWindow {
  const today = input.today;
  const warnings = input.warnings ?? [];
  const currentMonth = monthKeyFromDate(today);
  const nextMonth = shiftMonthKey(currentMonth, 1);

  if (input.option === "next-month") {
    const window = monthRangeWindow(nextMonth, nextMonth);
    return { from: window.from, to: window.to, label: window.label };
  }

  if (input.option === "next-quarter") {
    const [year, month] = currentMonth.split("-").map(Number);
    let quarter = Math.floor((month - 1) / 3) + 1;
    let quarterYear = year;
    if (quarter > 3) {
      quarter = 0;
      quarterYear += 1;
    }
    const startMonth = `${quarterYear}-${String(quarter * 3 + 1).padStart(2, "0")}`;
    const window = monthRangeWindow(startMonth, shiftMonthKey(startMonth, 2));
    return {
      from: window.from,
      to: window.to,
      label: `Q${quarter + 1} ${quarterYear}`,
    };
  }

  if (input.option === "next-12-months") {
    const window = monthRangeWindow(nextMonth, shiftMonthKey(nextMonth, 11));
    return { from: window.from, to: window.to, label: window.label };
  }

  if (input.option === "rest-of-season") {
    const candidates = (input.seasons ?? [])
      .filter((season) => season.active && season.endDate >= today)
      .sort((left, right) => left.startDate.getTime() - right.startDate.getTime());
    const activeOrUpcoming = candidates.find((season) => season.endDate >= today);

    if (!activeOrUpcoming) {
      warnings.push(
        "Rest of Season needs an active or upcoming configured season. Configure seasons before using this forward window."
      );
      return {
        from: null,
        to: null,
        label: "Rest of Season unavailable",
      };
    }

    const from =
      activeOrUpcoming.startDate <= today
        ? formatDateOnly(today)
        : formatDateOnly(activeOrUpcoming.startDate);
    const to = formatDateOnly(activeOrUpcoming.endDate);
    // #2919: in All-Lodges mode at a multi-lodge club the seasons come from more
    // than one property, so the season that wins says which lodge it belongs to.
    // Scoped to one lodge (and at a single-lodge club) `lodgeName` is null, the
    // label keeps its pre-existing season-only shape, and nothing on the page
    // gains a lodge name it has no use for.
    const seasonLodgeName = activeOrUpcoming.lodgeName ?? null;
    const seasonLabel = seasonLodgeName
      ? `${seasonLodgeName} — ${activeOrUpcoming.name}`
      : activeOrUpcoming.name;
    return {
      from,
      to,
      label: `${seasonLabel}: ${financeDashboardDayLabel(from)} to ${financeDashboardDayLabel(to)}`,
      seasonName: activeOrUpcoming.name,
      seasonLodgeName,
    };
  }

  const fallback = monthRangeWindow(nextMonth, nextMonth);
  const custom = resolveCustomMonthWindow({
    fromParam: readParam(input.searchParams, "forwardFrom"),
    toParam: readParam(input.searchParams, "forwardTo"),
    fallback,
    label: "Forward window",
    warnings,
  });

  return { from: custom.from, to: custom.to, label: custom.label };
}

/**
 * The requested view, resolved from the query string alone (#2919 review).
 *
 * A pure function of `searchParams`: it reads no seasons and no database, so a
 * caller that must know the view BEFORE it decides how to read seasons can ask
 * for it without a cycle. `resolveFinanceDashboardSelection` calls this too, so
 * the unknown-view fallback rule has exactly one definition.
 */
export function resolveFinanceDashboardView(
  searchParams?: SearchParams
): FinanceDashboardView {
  const requested = readParam(searchParams, "view");
  return isOneOf(requested, FINANCE_DASHBOARD_VIEWS) ? requested : "bookings";
}

/**
 * The whole finance dashboard's range selection, resolved from the URL.
 *
 * ## `today` IS REQUIRED, AND THAT IS THE #3123 FIX
 *
 * It used to default to `getTodayDateOnly()`, which reads `APP_TIME_ZONE` — the
 * container's clock, not the club's configured one. `today` becomes
 * `monthKeyFromDate(today)`, which picks the reporting month and the
 * financial-year bucket, so at a month boundary a wrong day moves a whole
 * finance figure into the wrong period. It is a `@db.Date`-shaped
 * UTC-midnight instant: build it with `dateOnlyInstantOf(club.today())`.
 *
 * THIS MODULE MAY NOT READ THE ZONE ITSELF, so the day arrives as data.
 * `finance-dashboard-client.tsx` is `"use client"` and imports from here, which
 * puts the whole module on the browser graph — where neither the server reader
 * nor the runtime reader exists, and the viewer's own clock is never the answer.
 * `buildFinanceDashboardPageModel` resolves it once at the server boundary and
 * threads it down through the two `resolve*` helpers below, which is why they
 * require it too: a default on either of them is the same defect one layer down.
 */
export function resolveFinanceDashboardSelection(input: {
  searchParams?: SearchParams;
  /** The club's today, as a UTC-midnight date-only instant. See above. */
  today: Date;
  seasons?: FinanceDashboardSeasonWindow[];
  financialYearEndMonth?: number;
}): FinanceDashboardSelection {
  const warnings: string[] = [];
  const today = input.today;
  const financialYearEndMonth =
    input.financialYearEndMonth ?? getFinancialYearEndMonth();
  const requestedRange = readParam(input.searchParams, "range");
  const requestedCompare = readParam(input.searchParams, "compare");
  const requestedForward = readParam(input.searchParams, "forward");
  const view = resolveFinanceDashboardView(input.searchParams);
  const range = isOneOf(requestedRange, FINANCE_DASHBOARD_RANGE_OPTIONS)
    ? requestedRange
    : (requestedRange && LEGACY_RANGE_OPTION_MAP[requestedRange]) || "last-month";
  const compare = isOneOf(requestedCompare, FINANCE_DASHBOARD_COMPARE_OPTIONS)
    ? requestedCompare
    : (requestedCompare && LEGACY_COMPARE_OPTION_MAP[requestedCompare]) ||
      "previous-period";
  const forward = isOneOf(requestedForward, FINANCE_DASHBOARD_FORWARD_OPTIONS)
    ? requestedForward
    : "next-month";
  const primary = resolvePrimaryFinanceRange({
    option: range,
    searchParams: input.searchParams,
    today,
    financialYearEndMonth,
    warnings,
  });
  const comparison = resolveComparisonFinanceRange({
    option: compare,
    primary,
    searchParams: input.searchParams,
    warnings,
  });
  const forwardWindow = resolveForwardFinanceWindow({
    option: forward,
    searchParams: input.searchParams,
    today,
    seasons: input.seasons,
    warnings,
  });

  return {
    view,
    range,
    compare,
    forward,
    primary,
    comparison,
    forwardWindow,
    currentMonth: monthKeyFromDate(today),
    financialYearEndMonth,
    expenseCategoryId: readParam(input.searchParams, "expenseCategoryId") ?? null,
    expenseLine: readParam(input.searchParams, "expenseLine") ?? null,
    ratioNumeratorId: readParam(input.searchParams, "ratioNumerator") ?? null,
    ratioDenominatorId: readParam(input.searchParams, "ratioDenominator") ?? null,
    ratioRangeKey: readParam(input.searchParams, "ratioRange") ?? null,
    warnings,
  };
}

export function financeDashboardDateRangeDayCount(window: {
  from: string;
  to: string;
}) {
  const from = parseDateOnly(window.from);
  const to = parseDateOnly(window.to);
  return Math.round((to.getTime() - from.getTime()) / 86_400_000) + 1;
}

/** Ordered list of month keys covered by a window, oldest first. */
export function financeDashboardWindowMonths(window: {
  fromMonth: string;
  toMonth: string;
}): string[] {
  const count = financeDashboardMonthCount(window);
  return Array.from({ length: Math.max(count, 0) }, (_, index) =>
    shiftMonthKey(window.fromMonth, index)
  );
}
