import {
  addDaysDateOnly,
  addMonthsDateOnly,
  dateOnlyFromParts,
  formatDateOnly,
} from "@/lib/date-only";

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

// Shared with the rest of the app's date-only arithmetic so the legacy
// two-digit-year rule in Date.UTC (years 0-99 → 1900-1999) cannot creep back in
// here. Month-stepping is the shared addMonthsDateOnly (#2251) — this module
// used to carry a byte-identical private copy.
const dateOnly = dateOnlyFromParts;

function startOfMonthDateOnly(date: Date): Date {
  return dateOnly(date.getUTCFullYear(), date.getUTCMonth(), 1);
}

function endOfMonthDateOnly(date: Date): Date {
  return dateOnly(date.getUTCFullYear(), date.getUTCMonth() + 1, 0);
}

function startOfQuarterDateOnly(date: Date): Date {
  const quarterStartMonth = Math.floor(date.getUTCMonth() / 3) * 3;
  return dateOnly(date.getUTCFullYear(), quarterStartMonth, 1);
}

function endOfQuarterDateOnly(date: Date): Date {
  const quarterStartMonth = Math.floor(date.getUTCMonth() / 3) * 3;
  return dateOnly(date.getUTCFullYear(), quarterStartMonth + 3, 0);
}

function startOfYearDateOnly(date: Date): Date {
  return dateOnly(date.getUTCFullYear(), 0, 1);
}

function endOfYearDateOnly(date: Date): Date {
  return dateOnly(date.getUTCFullYear(), 11, 31);
}

function toInputDate(date: Date): string {
  return formatDateOnly(date);
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
  getRange: (today) => makeRange(addDaysDateOnly(today, -6), today),
};

const last30DaysPreset: DateRangePreset = {
  key: "last_30_days",
  label: "Last 30 Days",
  getRange: (today) => makeRange(addDaysDateOnly(today, -29), today),
};

const thisMonthPreset: DateRangePreset = {
  key: "this_month",
  label: "This Month",
  getRange: (today) => makeRange(startOfMonthDateOnly(today), endOfMonthDateOnly(today)),
};

const lastMonthPreset: DateRangePreset = {
  key: "last_month",
  label: "Last Month",
  getRange: (today) => {
    const lastMonth = addMonthsDateOnly(today, -1);
    return makeRange(startOfMonthDateOnly(lastMonth), endOfMonthDateOnly(lastMonth));
  },
};

const nextMonthPreset: DateRangePreset = {
  key: "next_month",
  label: "Next Month",
  getRange: (today) => {
    const nextMonth = addMonthsDateOnly(today, 1);
    return makeRange(startOfMonthDateOnly(nextMonth), endOfMonthDateOnly(nextMonth));
  },
};

const lastQuarterPreset: DateRangePreset = {
  key: "last_quarter",
  label: "Last Quarter",
  getRange: (today) => {
    const lastQuarter = addMonthsDateOnly(today, -3);
    return makeRange(startOfQuarterDateOnly(lastQuarter), endOfQuarterDateOnly(lastQuarter));
  },
};

const yearToDatePreset: DateRangePreset = {
  key: "year_to_date",
  label: "Year to Date",
  getRange: (today) => makeRange(startOfYearDateOnly(today), today),
};

const lastYearPreset: DateRangePreset = {
  key: "last_year",
  label: "Last Year",
  getRange: (today) => {
    const lastYear = dateOnly(today.getUTCFullYear() - 1, today.getUTCMonth(), today.getUTCDate());
    return makeRange(startOfYearDateOnly(lastYear), endOfYearDateOnly(lastYear));
  },
};

const next30DaysPreset: DateRangePreset = {
  key: "next_30_days",
  label: "Next 30 Days",
  getRange: (today) => makeRange(today, addDaysDateOnly(today, 29)),
};

const next90DaysPreset: DateRangePreset = {
  key: "next_90_days",
  label: "Next 90 Days",
  getRange: (today) => makeRange(today, addDaysDateOnly(today, 89)),
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
  nextMonthPreset,
  lastQuarterPreset,
  yearToDatePreset,
  lastYearPreset,
];

/**
 * THE `today` ARGUMENT IS REQUIRED, AND ITS DEFAULT WAS DELETED (#3123).
 *
 * Every preset here is relative to a day — "This Month", "Next 90 Days" — and
 * the default used to be `getTodayDateOnly()`, which reads `APP_TIME_ZONE`. This
 * module is only ever reached from the BROWSER (`date-range-controls.tsx` is its
 * one caller and is `"use client"`), so that constant was `NEXT_PUBLIC_TZ` as it
 * stood when the bundle was built — not the club's persisted zone, and not even
 * the container's. Neither reader can be imported here: `@/lib/club-time/server`
 * is a bare throw in the browser and `club-time-zone-runtime` pulls Prisma. So
 * the day has to arrive as data, and the default was deleted rather than
 * policed so that no future caller can silently reacquire the environment's
 * answer.
 *
 * The encoding is the `@db.Date` UTC-midnight `Date` the presets already work
 * in — `dateOnlyInstantOf(useClubTime().today())` at the call site — so the
 * arithmetic below is unchanged.
 */
export function getDateRangeForPreset(
  preset: DateRangePreset,
  today: Date
): DateRangeValues {
  return preset.getRange(today);
}

/**
 * Which preset label describes an already-chosen from/to pair. `today` is
 * required for the same reason as above, and note this one is a DISPLAY
 * heuristic: it decides which name the dropdown shows, not which range is
 * applied. It is still wrong to answer it from the browser's build-time zone,
 * because a user whose club has rolled over to a new month would see "Custom"
 * where the label should read "This Month".
 */
export function findMatchingDateRangePreset(
  from: string,
  to: string,
  presets: readonly DateRangePreset[],
  today: Date
): string | null {
  const match = presets.find((preset) => {
    const range = getDateRangeForPreset(preset, today);
    return range.from === from && range.to === to;
  });

  return match?.key ?? null;
}
