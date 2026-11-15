import { formatDateOnly, isDateOnlyString, parseDateOnly } from "@/lib/date-only";

const MILLISECONDS_PER_DAY = 86_400_000;

/** A real calendar day as `YYYY-MM-DD`, to its date-only instant; anything else throws. */
export function parseFinanceBookingMetricDate(
  value: string,
  fieldName: string
): Date {
  if (!isDateOnlyString(value)) {
    throw new Error(`${fieldName} must be a real calendar day as YYYY-MM-DD`);
  }
  return parseDateOnly(value);
}

export function addUtcDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * MILLISECONDS_PER_DAY);
}

export function differenceInUtcDays(start: Date, end: Date): number {
  return Math.max(
    Math.round((end.getTime() - start.getTime()) / MILLISECONDS_PER_DAY),
    0
  );
}

export function getFinanceBookingMetricsWindowDayCount(
  from: string,
  to: string
): number {
  const fromDate = parseFinanceBookingMetricDate(from, "from");
  const toDate = parseFinanceBookingMetricDate(to, "to");

  if (fromDate.getTime() > toDate.getTime()) {
    throw new Error("to must be on or after from");
  }

  return differenceInUtcDays(fromDate, addUtcDays(toDate, 1));
}

export function buildIsoDateRange(
  start: Date,
  endInclusive: Date
): string[] {
  const dates: string[] = [];

  for (
    let cursor = start;
    cursor.getTime() <= endInclusive.getTime();
    cursor = addUtcDays(cursor, 1)
  ) {
    dates.push(formatDateOnly(cursor));
  }

  return dates;
}

export function allocateCentsEvenly(
  totalCents: number,
  parts: number
): number[] {
  if (parts <= 0) {
    return [];
  }

  const base = Math.floor(totalCents / parts);
  let remainder = totalCents - base * parts;

  return Array.from({ length: parts }, () => {
    if (remainder > 0) {
      remainder -= 1;
      return base + 1;
    }

    return base;
  });
}
