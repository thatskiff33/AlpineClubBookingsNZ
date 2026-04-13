import {
  addDays,
  addMonths,
  endOfMonth,
  endOfQuarter,
  endOfYear,
  format,
  startOfMonth,
  startOfQuarter,
  startOfYear,
  subDays,
  subMonths,
  subQuarters,
  subYears,
} from "date-fns";

export const CUSTOM_DATE_RANGE_KEY = "custom";

export interface DateRangeValues {
  from: string;
  to: string;
}

export interface DateRangePreset {
  key: string;
  label: string;
  getRange: (today: Date) => DateRangeValues;
}

function toInputDate(date: Date): string {
  return format(date, "yyyy-MM-dd");
}

function makeRange(from: Date, to: Date): DateRangeValues {
  return {
    from: toInputDate(from),
    to: toInputDate(to),
  };
}

const allDatesPreset: DateRangePreset = {
  key: "all_dates",
  label: "All Dates",
  getRange: () => ({ from: "", to: "" }),
};

const last7DaysPreset: DateRangePreset = {
  key: "last_7_days",
  label: "Last 7 Days",
  getRange: (today) => makeRange(subDays(today, 6), today),
};

const last30DaysPreset: DateRangePreset = {
  key: "last_30_days",
  label: "Last 30 Days",
  getRange: (today) => makeRange(subDays(today, 29), today),
};

const thisMonthPreset: DateRangePreset = {
  key: "this_month",
  label: "This Month",
  getRange: (today) => makeRange(startOfMonth(today), endOfMonth(today)),
};

const lastMonthPreset: DateRangePreset = {
  key: "last_month",
  label: "Last Month",
  getRange: (today) => {
    const lastMonth = subMonths(today, 1);
    return makeRange(startOfMonth(lastMonth), endOfMonth(lastMonth));
  },
};

const nextMonthPreset: DateRangePreset = {
  key: "next_month",
  label: "Next Month",
  getRange: (today) => {
    const nextMonth = addMonths(today, 1);
    return makeRange(startOfMonth(nextMonth), endOfMonth(nextMonth));
  },
};

const lastQuarterPreset: DateRangePreset = {
  key: "last_quarter",
  label: "Last Quarter",
  getRange: (today) => {
    const lastQuarter = subQuarters(today, 1);
    return makeRange(startOfQuarter(lastQuarter), endOfQuarter(lastQuarter));
  },
};

const yearToDatePreset: DateRangePreset = {
  key: "year_to_date",
  label: "Year to Date",
  getRange: (today) => makeRange(startOfYear(today), today),
};

const lastYearPreset: DateRangePreset = {
  key: "last_year",
  label: "Last Year",
  getRange: (today) => {
    const lastYear = subYears(today, 1);
    return makeRange(startOfYear(lastYear), endOfYear(lastYear));
  },
};

const next30DaysPreset: DateRangePreset = {
  key: "next_30_days",
  label: "Next 30 Days",
  getRange: (today) => makeRange(today, addDays(today, 29)),
};

const next90DaysPreset: DateRangePreset = {
  key: "next_90_days",
  label: "Next 90 Days",
  getRange: (today) => makeRange(today, addDays(today, 89)),
};

export const auditAndPaymentsDateRangePresets: readonly DateRangePreset[] = [
  allDatesPreset,
  last7DaysPreset,
  last30DaysPreset,
  thisMonthPreset,
  lastMonthPreset,
  lastQuarterPreset,
  yearToDatePreset,
  lastYearPreset,
];

export const bookingFilterDateRangePresets: readonly DateRangePreset[] = [
  allDatesPreset,
  thisMonthPreset,
  lastMonthPreset,
  nextMonthPreset,
  lastQuarterPreset,
  next30DaysPreset,
  next90DaysPreset,
  lastYearPreset,
];

export const reportsDateRangePresets: readonly DateRangePreset[] = [
  thisMonthPreset,
  lastMonthPreset,
  lastQuarterPreset,
  yearToDatePreset,
  lastYearPreset,
];

export function getDateRangeForPreset(
  preset: DateRangePreset,
  today = new Date()
): DateRangeValues {
  return preset.getRange(today);
}

export function findMatchingDateRangePreset(
  from: string,
  to: string,
  presets: readonly DateRangePreset[],
  today = new Date()
): string | null {
  const match = presets.find((preset) => {
    const range = getDateRangeForPreset(preset, today);
    return range.from === from && range.to === to;
  });

  return match?.key ?? null;
}
