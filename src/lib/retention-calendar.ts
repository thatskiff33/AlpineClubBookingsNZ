/** Calendar-year retention anniversaries in UTC; clamp leap day towards keeping. */
export function addUtcYears(date: Date, years: number): Date {
  const next = new Date(date);
  const month = next.getUTCMonth();
  next.setUTCFullYear(next.getUTCFullYear() + years);
  if (next.getUTCMonth() !== month) next.setUTCDate(0);
  return next;
}
