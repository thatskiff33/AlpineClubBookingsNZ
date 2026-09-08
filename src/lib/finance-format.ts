/**
 * Display formatters for the finance dashboard.
 *
 * Dashboard KPIs, panels, and chart tooltips show whole dollars with
 * thousands separators — cents are visual noise at dashboard altitude. Exact
 * cent-precision strings (reconciliation, CSV/PDF export rows) keep using
 * `formatCents` from utils. Client-safe: no server imports.
 */

import { APP_CURRENCY, APP_LOCALE } from "@/config/operational";

const dollarsDisplayFormatter = new Intl.NumberFormat(APP_LOCALE, {
  style: "currency",
  currency: APP_CURRENCY,
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

const percentFormatter = new Intl.NumberFormat(APP_LOCALE, {
  style: "percent",
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

// Ratios (the current ratio, for one) are not integers; two decimal places so
// 1.35 is not rounded to "1". Lives here rather than in the chart theme so the
// dashboard has one home for every number shape it renders (#3325).
const ratioFormatter = new Intl.NumberFormat(APP_LOCALE, {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** Whole-dollar display value with separators, e.g. 44667484 -> "$446,675". */
export function formatDollarsDisplay(cents: number): string {
  return dollarsDisplayFormatter.format(Math.round(cents / 100));
}

/** Signed whole-dollar delta, e.g. "+$1,204" / "-$310"; zero stays "$0". */
export function formatSignedDollarsDisplay(cents: number): string {
  const rounded = Math.round(cents / 100);
  if (rounded === 0) {
    return dollarsDisplayFormatter.format(0);
  }
  return `${rounded > 0 ? "+" : "-"}${dollarsDisplayFormatter.format(Math.abs(rounded))}`;
}

export function formatFinanceNumber(
  value: number,
  maximumFractionDigits = 0
): string {
  return new Intl.NumberFormat(APP_LOCALE, {
    maximumFractionDigits,
  }).format(value);
}

export function formatFinanceSignedNumber(value: number): string {
  if (value === 0) return "0";
  return `${value > 0 ? "+" : "-"}${formatFinanceNumber(Math.abs(value))}`;
}

export function formatFinancePercent(value: number): string {
  return percentFormatter.format(value);
}

/** Two-decimal ratio, e.g. 1.35 -> "1.35". */
export function formatFinanceRatio(value: number): string {
  return ratioFormatter.format(value);
}
