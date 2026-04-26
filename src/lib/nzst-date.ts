export const NZ_TIME_ZONE = "Pacific/Auckland";

const NZ_DATE_FORMATTER = new Intl.DateTimeFormat("en-NZ", {
  timeZone: NZ_TIME_ZONE,
  dateStyle: "medium",
});

const NZ_DATE_TIME_FORMATTER = new Intl.DateTimeFormat("en-NZ", {
  timeZone: NZ_TIME_ZONE,
  dateStyle: "medium",
  timeStyle: "short",
});

export function formatNZDate(date: Date): string {
  return NZ_DATE_FORMATTER.format(date);
}

export function formatNZDateTime(date: Date): string {
  return NZ_DATE_TIME_FORMATTER.format(date);
}

/**
 * Get today's date in Pacific/Auckland timezone as a Date object at midnight UTC.
 * Used by cron jobs that need NZ-local date boundaries.
 */
export function getNZSTToday(): Date {
  const nzFormatter = new Intl.DateTimeFormat("en-NZ", {
    timeZone: NZ_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });

  const parts = nzFormatter.formatToParts(new Date());
  const year = parts.find((p) => p.type === "year")!.value;
  const month = parts.find((p) => p.type === "month")!.value;
  const day = parts.find((p) => p.type === "day")!.value;

  return new Date(`${year}-${month}-${day}T00:00:00`);
}

/**
 * Get tomorrow's date in Pacific/Auckland timezone.
 */
export function getNZSTTomorrow(): Date {
  const today = getNZSTToday();
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  return tomorrow;
}
