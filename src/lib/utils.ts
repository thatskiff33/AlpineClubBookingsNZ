import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";
import { APP_CURRENCY, APP_LOCALE } from "@/config/operational";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatCents(cents: number): string {
  if (APP_CURRENCY === "NZD" && APP_LOCALE === "en-NZ") {
    return `$${(cents / 100).toFixed(2)}`;
  }

  return new Intl.NumberFormat(APP_LOCALE, {
    style: "currency",
    currency: APP_CURRENCY,
  }).format(cents / 100);
}

export function getSeasonYear(date: Date = new Date()): number {
  const month = date.getMonth();
  const year = date.getFullYear();
  return month >= 3 ? year : year - 1;
}
