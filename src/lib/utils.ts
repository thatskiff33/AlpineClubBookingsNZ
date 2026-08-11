import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";
import { APP_CURRENCY, APP_LOCALE } from "@/config/operational";
import {
  getFinancialYearEndMonth,
  getSeasonYearForYearEndMonth,
} from "@/lib/financial-year";

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

/**
 * Map a calendar date to its membership season year. The season starts on the
 * first of the month after the club's financial year-end (April for the default
 * 31 March year-end), so a date in or after the start month belongs to the
 * current calendar year, otherwise the previous one.
 */
export function getSeasonYear(date: Date = new Date()): number {
  return getSeasonYearForYearEndMonth(date, getFinancialYearEndMonth());
}
