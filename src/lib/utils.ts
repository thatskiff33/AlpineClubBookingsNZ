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

/**
 * The one home (#3302, `INV-SSOT-001`) for turning an integer-cent amount into
 * a string. Eight copies existed beneath `formatSignedCents` (#3264), and four
 * had drifted in the same way #3264 already found: a hard-coded `$`, no
 * thousands grouping, `APP_CURRENCY` ignored. Every caller now derives from
 * here.
 *
 * `{ style: "plain" }` is the one genuine second rendering: a bare two-decimal
 * string with no currency symbol or grouping, for an editable dollars input
 * (the AI assistant and diagnostics spend-cap boxes) and a report line that
 * already reads as a delta without one (the Xero refund-note repair report).
 * Both are pinned by existing fixtures. It is still ONE formatter — the option
 * is the difference, not a second copy of the cents-to-string arithmetic.
 */
export function formatCents(
  cents: number,
  options?: { style?: "plain" }
): string {
  if (options?.style === "plain") {
    return (cents / 100).toFixed(2);
  }
  return centsFormatter.format(cents / 100);
}

/**
 * Exact-cent amount with an explicit sign, for a delta or an adjustment line:
 * `+$25.00`, `-$1,234.56`, and `$0.00` for zero. Whole-dollar dashboard deltas
 * use `formatSignedDollarsDisplay` in `@/lib/finance-format` instead.
 *
 * The one home (#3264, `INV-SSOT-001`). Seven copies existed, and they had
 * already drifted: three rendered zero as `-$0.00`, and the promo-code input
 * spelt the currency symbol by hand with `toFixed(2)`, so it dropped the
 * locale's thousands separator and ignored `APP_CURRENCY`. Every caller now
 * derives from `formatCents`, which is where the locale and currency live.
 */
export function formatSignedCents(cents: number): string {
  if (cents === 0) {
    return formatCents(0);
  }
  return `${cents > 0 ? "+" : "-"}${formatCents(Math.abs(cents))}`;
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
