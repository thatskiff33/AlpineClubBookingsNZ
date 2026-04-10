const DATE_ONLY_REGEX = /^\d{4}-\d{2}-\d{2}$/;

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

export function addDaysDateOnly(date: Date, days: number): Date {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
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
