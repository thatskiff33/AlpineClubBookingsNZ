/**
 * Get today's date in Pacific/Auckland timezone as a Date object at midnight UTC.
 * Used by cron jobs that need NZ-local date boundaries.
 */
export function getNZSTToday(): Date {
  const nzFormatter = new Intl.DateTimeFormat("en-NZ", {
    timeZone: "Pacific/Auckland",
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
