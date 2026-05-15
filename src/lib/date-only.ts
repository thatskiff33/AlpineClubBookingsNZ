const DATE_ONLY_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_DATE_ONLY_TIME_ZONE = "Pacific/Auckland";

function buildDateOnly(dateStr: string): Date {
  return new Date(`${dateStr}T00:00:00.000Z`);
}

export function isDateOnlyString(dateStr: string): boolean {
  if (!DATE_ONLY_REGEX.test(dateStr)) {
    return false;
  }

  const parsed = buildDateOnly(dateStr);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === dateStr;
}

export function parseDateOnly(dateStr: string): Date {
  return isDateOnlyString(dateStr) ? buildDateOnly(dateStr) : new Date(NaN);
}

export function formatDateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function formatLocalDateOnly(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function formatDateOnlyForTimeZone(
  date: Date,
  timeZone = DEFAULT_DATE_ONLY_TIME_ZONE
): string {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });

  const parts = formatter.formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;

  if (!year || !month || !day) {
    throw new Error(`Unable to derive date-only value for timezone ${timeZone}`);
  }

  return `${year}-${month}-${day}`;
}

export function normalizeDateOnlyForTimeZone(
  date: Date,
  timeZone = DEFAULT_DATE_ONLY_TIME_ZONE
): Date {
  const normalized = parseDateOnly(formatDateOnlyForTimeZone(date, timeZone));

  if (Number.isNaN(normalized.getTime())) {
    throw new Error(`Invalid date-only value: ${date.toISOString()}`);
  }

  return normalized;
}

export function addDaysDateOnly(date: Date, days: number): Date {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

export function eachDateOnlyInRange(startInclusive: Date, endExclusive: Date): Date[] {
  const dates: Date[] = [];

  for (
    let current = new Date(startInclusive);
    current < endExclusive;
    current = addDaysDateOnly(current, 1)
  ) {
    dates.push(current);
  }

  return dates;
}

export function getTodayDateOnly(timeZone = "Pacific/Auckland"): Date {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });

  const parts = formatter.formatToParts(new Date());
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;

  if (!year || !month || !day) {
    throw new Error(`Unable to derive current date for timezone ${timeZone}`);
  }

  const today = parseDateOnly(`${year}-${month}-${day}`);
  if (Number.isNaN(today.getTime())) {
    throw new Error(`Unable to derive current date for timezone ${timeZone}`);
  }

  return today;
}
