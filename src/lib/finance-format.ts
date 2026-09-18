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

/**
 * Compact whole-dollar chart tick — `$10k`, `$1.2m`, `$450` — in the club's
 * configured currency (#3325). The NUMBER keeps the chart theme's long-standing
 * shape (lowercase `k`/`m`, one decimal for millions, the sign inside the
 * number as before), pinned byte-identical; `Intl`'s own `notation: "compact"`
 * renders `$10K` / `$1.2M` and was measured and rejected for that reason. The
 * currency SYMBOL and where it sits come from the display formatter's parts, so
 * a locale that writes `0 €` gets `10k €` rather than a `$` this codebase used
 * to spell by hand.
 *
 * Stated limit, for adopters: the NUMBER is not localised. `toFixed(1)` and the
 * Latin `k`/`m` suffixes are used whatever the locale, so a de-DE club's axis
 * reads `1.2m €` beside tooltips (`formatDollarsDisplay`) reading
 * `1.234.567 €`. Deliberate: byte-identical for the default configuration,
 * and a localised compact number is a visible change no one has asked for.
 */
export function formatCompactDollarsDisplay(cents: number): string {
  const dollars = cents / 100;
  const abs = Math.abs(dollars);
  const compact =
    abs >= 1_000_000
      ? `${(dollars / 1_000_000).toFixed(1)}m`
      : abs >= 1_000
        ? `${Math.round(dollars / 1_000)}k`
        : `${Math.round(dollars)}`;
  let placed = false;
  return dollarsDisplayFormatter
    .formatToParts(0)
    .map((part) => {
      if (part.type === "currency" || part.type === "literal") return part.value;
      if (placed) return "";
      placed = true;
      return compact;
    })
    .join("");
}
