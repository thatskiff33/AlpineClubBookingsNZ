/**
 * Display formatters for the finance dashboard.
 *
 * Dashboard KPIs, panels, and chart tooltips show whole dollars with
 * thousands separators — cents are visual noise at dashboard altitude. Exact
 * cent-precision strings (reconciliation, CSV/PDF export rows) keep using
 * `formatCents` from utils. Client-safe: no server imports.
 *
 * EVERY FUNCTION HERE TAKES THE CLUB'S RESOLVED `format` (#3565, stage 3 of
 * programme #3205). The four module-level `Intl.NumberFormat` constants this file
 * used to hold were built at import from `APP_LOCALE` / `APP_CURRENCY`, which a
 * persisted, admin-editable setting cannot reach — the whole reason that stage
 * exists. They now come from the one memoised factory in `club-format-intl.ts`,
 * and a caller rendering several of them binds once with `bindClubFormat` rather
 * than repeating the argument. There is no one-argument spelling of any of
 * them: the format is a required parameter, so a caller that forgets it is a
 * compile error rather than a screen quietly rendering in some other currency.
 */

import {
  clubDecimalFormatter,
  clubMoneyFormatter,
  clubNumberFormatter,
} from "@/lib/club-format-intl";

import type { ClubFormat } from "@/lib/club-format";

/** Whole-dollar display value with separators, e.g. 44667484 -> "$446,675". */
export function formatDollarsDisplay(cents: number, format: ClubFormat): string {
  return clubMoneyFormatter(format, "dollars").format(Math.round(cents / 100));
}

/** Signed whole-dollar delta, e.g. "+$1,204" / "-$310"; zero stays "$0". */
export function formatSignedDollarsDisplay(
  cents: number,
  format: ClubFormat,
): string {
  const formatter = clubMoneyFormatter(format, "dollars");
  const rounded = Math.round(cents / 100);
  if (rounded === 0) {
    return formatter.format(0);
  }
  return `${rounded > 0 ? "+" : "-"}${formatter.format(Math.abs(rounded))}`;
}

/**
 * A plain count with the club's grouping, capped at `maximumFractionDigits`.
 *
 * `format` sits BEFORE the digit count, so that every function in this module
 * and in `@/lib/utils` takes it in the same position and a reader never has to
 * check.
 */
export function formatFinanceNumber(
  value: number,
  format: ClubFormat,
  maximumFractionDigits = 0,
): string {
  return clubDecimalFormatter(format, maximumFractionDigits).format(value);
}

export function formatFinanceSignedNumber(
  value: number,
  format: ClubFormat,
): string {
  if (value === 0) return "0";
  return `${value > 0 ? "+" : "-"}${formatFinanceNumber(Math.abs(value), format)}`;
}

export function formatFinancePercent(value: number, format: ClubFormat): string {
  return clubNumberFormatter(format, "percent").format(value);
}

/** Two-decimal ratio, e.g. 1.35 -> "1.35". */
export function formatFinanceRatio(value: number, format: ClubFormat): string {
  return clubNumberFormatter(format, "ratio").format(value);
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
export function formatCompactDollarsDisplay(
  cents: number,
  format: ClubFormat,
): string {
  const dollars = cents / 100;
  const abs = Math.abs(dollars);
  const compact =
    abs >= 1_000_000
      ? `${(dollars / 1_000_000).toFixed(1)}m`
      : abs >= 1_000
        ? `${Math.round(dollars / 1_000)}k`
        : `${Math.round(dollars)}`;
  let placed = false;
  return clubMoneyFormatter(format, "dollars")
    .formatToParts(0)
    .map((part) => {
      if (part.type === "currency" || part.type === "literal") return part.value;
      if (placed) return "";
      placed = true;
      return compact;
    })
    .join("");
}
