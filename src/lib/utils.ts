import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";
import { APP_CURRENCY, APP_LOCALE } from "@/config/operational";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const centsFormatter = new Intl.NumberFormat(APP_LOCALE, {
  style: "currency",
  currency: APP_CURRENCY,
});

export function formatCents(cents: number): string {
  return centsFormatter.format(cents / 100);
}

// `getSeasonYear(date = new Date())` USED TO LIVE HERE and is deliberately gone
// (CT-4 group F1, #2870). It read its argument with `date.getMonth()` /
// `date.getFullYear()` - the HOST's calendar components - so it answered from the
// server's month for a "now" caller and read a UTC-midnight `@db.Date` a day early
// for every club west of Greenwich. Because it read the ARGUMENT that way, no call
// site could fix itself by passing a better `Date` in: measured, handing it a
// club-derived day made a behind-UTC deployment WORSE. Its two replacements are
// `clubSeasonYear(zone, clock?)` and `seasonYearOfStoredDate(value)` in
// `@/lib/financial-year`, which name which temporal kind the caller holds. Deleting
// the name rather than repairing it is what made the typechecker enumerate every
// call site instead of leaving the wrong ones silently green.
