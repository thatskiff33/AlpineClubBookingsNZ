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
 * a currency-formatted string in the club's configured locale and currency.
 * Every former stand-alone copy of this — a hand-rolled hard-coded `$`, no
 * thousands grouping, `APP_CURRENCY` ignored — now derives from here, and the
 * exact count is recorded once, in the pull request, not restated here where
 * it would only go stale again.
 *
 * The Internet Banking messages that used to hard-code `NZ$` (the hold-clearing
 * report, the cancel and hold-expiry narratives, the orphaned-credit backfill
 * audit line) render through here too since #3325 decided that prefix was
 * drift, not a deliberate country choice. Do not read the sentence above as
 * covering the roughly thirty other inline `(cents / 100).toFixed(...)`
 * expressions across the tree that #3302's comparison did not touch because
 * none of them share a definition with this one — `formatCents` is the
 * concept "one home for THIS helper's copies", not a claim that no other file
 * ever divides cents by 100. #3302's own review found and fixed several more
 * of the same class; whatever the count is by the time you read this, it is
 * stated in the pull request, once.
 *
 * Guards negative zero (`-0`): a caller that rounds a small negative to zero
 * (`Math.round(-0.4)` is `-0`) must not see `-$0.00` — `formatSignedCents`
 * below already guarded this for its own zero case, and widening this
 * function's callers is the reason to close it here too.
 *
 * For the one genuine second rendering — a bare two-decimal string with no
 * currency symbol or grouping, for an editable dollars input or a report line
 * that already reads as a delta — use `formatCentsPlain`, a separate named
 * function rather than an option on this one, so calling the wrong rendering
 * is a different import, not a different argument silently defaulting to the
 * wrong shape.
 */
export function formatCents(cents: number): string {
  return centsFormatter.format((cents === 0 ? 0 : cents) / 100);
}

/**
 * The bare two-decimal rendering `formatCents` deliberately does not do: no
 * currency symbol, no thousands grouping. For an editable dollars input (the
 * AI assistant and AI Diagnostics spend-cap boxes, which show `"10.00"` not
 * `"$10.00"`) and for a report line that already reads as a delta (the Xero
 * refund-note repair report). Pinned by each caller's own fixture.
 *
 * A separate named function rather than an option on `formatCents` (#3302
 * review): the wrong rendering is then a different import a reviewer sees at
 * the top of the file, not a different argument a reviewer has to notice was
 * left off.
 */
export function formatCentsPlain(cents: number): string {
  return (cents / 100).toFixed(2);
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
