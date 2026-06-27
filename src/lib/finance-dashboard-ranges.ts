import { APP_LOCALE, APP_TIME_ZONE } from "@/config/operational";
import {
  addDaysDateOnly,
  formatDateOnly,
  getTodayDateOnly,
  isDateOnlyString,
  parseDateOnly,
} from "@/lib/date-only";

export const FINANCE_DASHBOARD_VIEWS = [
  "bookings",
  "revenue",
  "costs",
  "pricing-sensitivity",
  "working-capital",
  "cash",
  "balance-sheet",
] as const;

export type FinanceDashboardView = (typeof FINANCE_DASHBOARD_VIEWS)[number];

export const FINANCE_DASHBOARD_RANGE_OPTIONS = [
  "last-month",
  "last-quarter",
  "year-to-date",
  "last-12-months",
  "custom",
] as const;

export type FinanceDashboardRangeOption =
  (typeof FINANCE_DASHBOARD_RANGE_OPTIONS)[number];

export const FINANCE_DASHBOARD_COMPARE_OPTIONS = [
  "previous-month",
  "previous-quarter",
  "previous-year",
  "previous-year-to-date",
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
  "pricing-sensitivity": "Pricing Sensitivity",
  "working-capital": "Working Capital",
  cash: "Cash",
  "balance-sheet": "Balance Sheet",
};

export const FINANCE_DASHBOARD_RANGE_LABELS: Record<
  FinanceDashboardRangeOption,
  string
> = {
  "last-month": "Last Month",
  "last-quarter": "Last Quarter",
  "year-to-date": "Year to Date",
  "last-12-months": "Last 12 Months",
  custom: "Custom",
};

export const FINANCE_DASHBOARD_COMPARE_LABELS: Record<
  FinanceDashboardCompareOption,
  string
> = {
  "previous-month": "Previous Month",
  "previous-quarter": "Previous Quarter",
  "previous-year": "Previous Year",
  "previous-year-to-date": "Previous Year to Date",
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

type SearchParams = Record<string, string | string[] | undefined>;

export interface FinanceDashboardSeasonWindow {
  name: string;
  startDate: Date;
  endDate: Date;
  active: boolean;
}

export interface FinanceDashboardDateWindow {
  from: string;
  to: string;
  label: string;
}

export interface FinanceDashboardForwardWindow {
  from: string | null;
  to: string | null;
  label: string;
  seasonName?: string;
}

export interface FinanceDashboardSelection {
  view: FinanceDashboardView;
  range: FinanceDashboardRangeOption;
  compare: FinanceDashboardCompareOption;
  forward: FinanceDashboardForwardOption;
  primary: FinanceDashboardDateWindow;
  comparison: FinanceDashboardDateWindow;
  forwardWindow: FinanceDashboardForwardWindow;
  expenseCategoryId: string | null;
  expenseLine: string | null;
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

function startOfMonth(date: Date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

function endOfMonth(date: Date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0));
}

function addMonths(date: Date, months: number) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, date.getUTCDate()));
}

function monthWindow(year: number, monthIndex: number): FinanceDashboardDateWindow {
  const start = new Date(Date.UTC(year, monthIndex, 1));
  const end = endOfMonth(start);
  return {
    from: formatDateOnly(start),
    to: formatDateOnly(end),
    label: formatMonthLabel(start),
  };
}

function completedMonthBefore(today: Date, monthsBack = 1) {
  const month = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - monthsBack, 1));
  return monthWindow(month.getUTCFullYear(), month.getUTCMonth());
}

function quarterForMonth(monthIndex: number) {
  return Math.floor(monthIndex / 3);
}

function quarterWindow(year: number, quarterIndex: number): FinanceDashboardDateWindow {
  const start = new Date(Date.UTC(year, quarterIndex * 3, 1));
  const end = new Date(Date.UTC(year, quarterIndex * 3 + 3, 0));
  return {
    from: formatDateOnly(start),
    to: formatDateOnly(end),
    label: `Q${quarterIndex + 1} ${year}`,
  };
}

function previousCompletedQuarter(today: Date) {
  let quarter = quarterForMonth(today.getUTCMonth()) - 1;
  let year = today.getUTCFullYear();
  if (quarter < 0) {
    quarter = 3;
    year -= 1;
  }
  return quarterWindow(year, quarter);
}

function validateCustomWindow(input: {
  from?: string;
  to?: string;
  fallback: FinanceDashboardDateWindow;
  label: string;
  warnings: string[];
}) {
  if (!input.from || !input.to) {
    input.warnings.push(
      `${input.label} custom dates were incomplete. Showing ${input.fallback.label}.`
    );
    return input.fallback;
  }

  if (!isDateOnlyString(input.from) || !isDateOnlyString(input.to)) {
    input.warnings.push(
      `${input.label} custom dates were invalid. Showing ${input.fallback.label}.`
    );
    return input.fallback;
  }

  if (parseDateOnly(input.from) > parseDateOnly(input.to)) {
    input.warnings.push(
      `${input.label} custom end date must be on or after the start date. Showing ${input.fallback.label}.`
    );
    return input.fallback;
  }

  return {
    from: input.from,
    to: input.to,
    label: `${formatDate(input.from)} to ${formatDate(input.to)}`,
  };
}

export function resolvePrimaryFinanceRange(input: {
  option: FinanceDashboardRangeOption;
  searchParams?: SearchParams;
  today?: Date;
  warnings?: string[];
}): FinanceDashboardDateWindow {
  const today = input.today ?? getTodayDateOnly();
  const warnings = input.warnings ?? [];

  if (input.option === "last-month") {
    return completedMonthBefore(today);
  }

  if (input.option === "last-quarter") {
    return previousCompletedQuarter(today);
  }

  if (input.option === "year-to-date") {
    const start = new Date(Date.UTC(today.getUTCFullYear(), 0, 1));
    return {
      from: formatDateOnly(start),
      to: formatDateOnly(today),
      label: `Year to ${formatDate(formatDateOnly(today))}`,
    };
  }

  if (input.option === "last-12-months") {
    const lastMonth = completedMonthBefore(today);
    const end = parseDateOnly(lastMonth.to);
    const start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - 11, 1));
    return {
      from: formatDateOnly(start),
      to: lastMonth.to,
      label: `${formatMonthLabel(start)} to ${lastMonth.label}`,
    };
  }

  return validateCustomWindow({
    from: readParam(input.searchParams, "from"),
    to: readParam(input.searchParams, "to"),
    fallback: completedMonthBefore(today),
    label: "Primary range",
    warnings,
  });
}

export function resolveComparisonFinanceRange(input: {
  option: FinanceDashboardCompareOption;
  primary: FinanceDashboardDateWindow;
  searchParams?: SearchParams;
  today?: Date;
  warnings?: string[];
}): FinanceDashboardDateWindow {
  const today = input.today ?? getTodayDateOnly();
  const warnings = input.warnings ?? [];
  const primaryStart = parseDateOnly(input.primary.from);
  const primaryEnd = parseDateOnly(input.primary.to);

  if (input.option === "previous-month") {
    const startMonth = addMonths(startOfMonth(primaryStart), -1);
    return monthWindow(startMonth.getUTCFullYear(), startMonth.getUTCMonth());
  }

  if (input.option === "previous-quarter") {
    const quarter = quarterForMonth(primaryStart.getUTCMonth()) - 1;
    const year = primaryStart.getUTCFullYear() + (quarter < 0 ? -1 : 0);
    return quarterWindow(year, quarter < 0 ? 3 : quarter);
  }

  if (input.option === "previous-year") {
    const start = new Date(Date.UTC(primaryStart.getUTCFullYear() - 1, primaryStart.getUTCMonth(), primaryStart.getUTCDate()));
    const end = new Date(Date.UTC(primaryEnd.getUTCFullYear() - 1, primaryEnd.getUTCMonth(), primaryEnd.getUTCDate()));
    return {
      from: formatDateOnly(start),
      to: formatDateOnly(end),
      label: `${formatDate(formatDateOnly(start))} to ${formatDate(formatDateOnly(end))}`,
    };
  }

  if (input.option === "previous-year-to-date") {
    const end = new Date(Date.UTC(today.getUTCFullYear() - 1, today.getUTCMonth(), today.getUTCDate()));
    const start = new Date(Date.UTC(end.getUTCFullYear(), 0, 1));
    return {
      from: formatDateOnly(start),
      to: formatDateOnly(end),
      label: `Previous year to ${formatDate(formatDateOnly(end))}`,
    };
  }

  return validateCustomWindow({
    from: readParam(input.searchParams, "compareFrom"),
    to: readParam(input.searchParams, "compareTo"),
    fallback: completedMonthBefore(primaryStart, 1),
    label: "Comparison range",
    warnings,
  });
}

export function resolveForwardFinanceWindow(input: {
  option: FinanceDashboardForwardOption;
  searchParams?: SearchParams;
  today?: Date;
  seasons?: FinanceDashboardSeasonWindow[];
  warnings?: string[];
}): FinanceDashboardForwardWindow {
  const today = input.today ?? getTodayDateOnly();
  const warnings = input.warnings ?? [];
  const nextMonthStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 1));

  if (input.option === "next-month") {
    const window = monthWindow(nextMonthStart.getUTCFullYear(), nextMonthStart.getUTCMonth());
    return { ...window, seasonName: undefined };
  }

  if (input.option === "next-quarter") {
    let quarter = quarterForMonth(today.getUTCMonth()) + 1;
    let year = today.getUTCFullYear();
    if (quarter > 3) {
      quarter = 0;
      year += 1;
    }
    return quarterWindow(year, quarter);
  }

  if (input.option === "next-12-months") {
    const end = endOfMonth(addMonths(nextMonthStart, 11));
    return {
      from: formatDateOnly(nextMonthStart),
      to: formatDateOnly(end),
      label: `${formatMonthLabel(nextMonthStart)} to ${formatMonthLabel(end)}`,
    };
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
    return {
      from,
      to,
      label: `${activeOrUpcoming.name}: ${formatDate(from)} to ${formatDate(to)}`,
      seasonName: activeOrUpcoming.name,
    };
  }

  const custom = validateCustomWindow({
    from: readParam(input.searchParams, "forwardFrom"),
    to: readParam(input.searchParams, "forwardTo"),
    fallback: {
      ...monthWindow(nextMonthStart.getUTCFullYear(), nextMonthStart.getUTCMonth()),
    },
    label: "Forward window",
    warnings,
  });

  return custom;
}

export function resolveFinanceDashboardSelection(input: {
  searchParams?: SearchParams;
  today?: Date;
  seasons?: FinanceDashboardSeasonWindow[];
}): FinanceDashboardSelection {
  const warnings: string[] = [];
  const requestedView = readParam(input.searchParams, "view");
  const requestedRange = readParam(input.searchParams, "range");
  const requestedCompare = readParam(input.searchParams, "compare");
  const requestedForward = readParam(input.searchParams, "forward");
  const view = isOneOf(requestedView, FINANCE_DASHBOARD_VIEWS)
    ? requestedView
    : "bookings";
  const range = isOneOf(requestedRange, FINANCE_DASHBOARD_RANGE_OPTIONS)
    ? requestedRange
    : "last-month";
  const compare = isOneOf(requestedCompare, FINANCE_DASHBOARD_COMPARE_OPTIONS)
    ? requestedCompare
    : "previous-month";
  const forward = isOneOf(requestedForward, FINANCE_DASHBOARD_FORWARD_OPTIONS)
    ? requestedForward
    : "next-month";
  const primary = resolvePrimaryFinanceRange({
    option: range,
    searchParams: input.searchParams,
    today: input.today,
    warnings,
  });
  const comparison = resolveComparisonFinanceRange({
    option: compare,
    primary,
    searchParams: input.searchParams,
    today: input.today,
    warnings,
  });
  const forwardWindow = resolveForwardFinanceWindow({
    option: forward,
    searchParams: input.searchParams,
    today: input.today,
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
    expenseCategoryId: readParam(input.searchParams, "expenseCategoryId") ?? null,
    expenseLine: readParam(input.searchParams, "expenseLine") ?? null,
    warnings,
  };
}

export function buildFinanceDashboardQueryString(
  selection: Pick<
    FinanceDashboardSelection,
    | "view"
    | "range"
    | "compare"
    | "forward"
    | "expenseCategoryId"
    | "expenseLine"
  > & {
    primary?: Partial<FinanceDashboardDateWindow>;
    comparison?: Partial<FinanceDashboardDateWindow>;
    forwardWindow?: Partial<FinanceDashboardForwardWindow>;
  }
) {
  const params = new URLSearchParams({
    view: selection.view,
    range: selection.range,
    compare: selection.compare,
    forward: selection.forward,
  });

  if (selection.range === "custom") {
    if (selection.primary?.from) params.set("from", selection.primary.from);
    if (selection.primary?.to) params.set("to", selection.primary.to);
  }
  if (selection.compare === "custom") {
    if (selection.comparison?.from) params.set("compareFrom", selection.comparison.from);
    if (selection.comparison?.to) params.set("compareTo", selection.comparison.to);
  }
  if (selection.forward === "custom") {
    if (selection.forwardWindow?.from) params.set("forwardFrom", selection.forwardWindow.from);
    if (selection.forwardWindow?.to) params.set("forwardTo", selection.forwardWindow.to);
  }
  if (selection.expenseCategoryId) {
    params.set("expenseCategoryId", selection.expenseCategoryId);
  }
  if (selection.expenseLine) {
    params.set("expenseLine", selection.expenseLine);
  }

  return params.toString();
}

function formatMonthLabel(date: Date) {
  return date.toLocaleDateString(APP_LOCALE, {
    month: "long",
    year: "numeric",
    timeZone: APP_TIME_ZONE,
  });
}

function formatDate(dateOnly: string) {
  return parseDateOnly(dateOnly).toLocaleDateString(APP_LOCALE, {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: APP_TIME_ZONE,
  });
}

export function financeDashboardWindowDetail(window: {
  from: string | null;
  to: string | null;
}) {
  if (!window.from || !window.to) {
    return "Unavailable";
  }
  return `${formatDate(window.from)} to ${formatDate(window.to)}`;
}

export function financeDashboardDateRangeDayCount(window: {
  from: string;
  to: string;
}) {
  const from = parseDateOnly(window.from);
  const to = parseDateOnly(window.to);
  return Math.round((to.getTime() - from.getTime()) / 86_400_000) + 1;
}

export function nextDateOnly(dateOnlyValue: string) {
  return formatDateOnly(addDaysDateOnly(parseDateOnly(dateOnlyValue), 1));
}
