import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";
import { clubMoneyFormatter } from "@/lib/club-format-intl";
import { transitionalClubFormat } from "@/lib/club-format-transitional";

import type { ClubFormat } from "@/lib/club-format";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

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
 *
 * THE `format` ARGUMENT IS THE CLUB'S RESOLVED CURRENCY AND LOCALE (#3565), and
 * it is explicit for the reason the club-time kernel gives for its `zone`:
 * explicit is right at a boundary, and a component rendering fifteen amounts
 * binds once with `bindClubFormat` instead of repeating it. A server caller
 * obtains one from `clubFormat()`; a client caller from the format it was handed
 * as data.
 */
export function formatCents(cents: number, format: ClubFormat): string;
/**
 * @deprecated TEMPORARY, AND DUE TO BE DELETED BY #3567 — the last group of
 * stage #3565, which retires `club-format-transitional.ts` and with it this
 * overload. Without a format it renders in the ENVIRONMENT's currency and
 * locale, which is what every call site rendered in before this stage and is NOT
 * the club's persisted setting. Pass the format. `club-format-transitional.ts`
 * states the cost this buys and why the overload exists at all.
 */
export function formatCents(cents: number): string;
export function formatCents(cents: number, format?: ClubFormat): string {
  return clubMoneyFormatter(format ?? transitionalClubFormat(), "cents").format(
    (cents === 0 ? 0 : cents) / 100,
  );
}

/**
 * The bare two-decimal rendering `formatCents` deliberately does not do: no
 * currency symbol, no thousands grouping. For seeding an editable dollars
 * input (`"10.00"`, not `"$10.00"` — nobody types a symbol into an amount box)
 * and for a report line that already reads as a delta. Callers are not listed
 * here — a list drifts the first time one is added; the cents-display lint arm
 * in `eslint.config.mjs` (#3302) is what polices who renders cents, and each
 * caller pins its own rendering.
 *
 * A separate named function rather than an option on `formatCents` (#3302
 * review): the wrong rendering is then a different import a reviewer sees at
 * the top of the file, not a different argument a reviewer has to notice was
 * left off.
 *
 * IT TAKES NO `format`, PERMANENTLY, and that is not an oversight of #3565:
 * there is no currency symbol, no grouping and no locale in `toFixed(2)`, so a
 * club's format has nothing here to change. An editable amount box wants exactly
 * that — a value the browser's number control will accept back — which is why
 * localising it would be a defect rather than an improvement. #3567 leaves this
 * function alone.
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
export function formatSignedCents(cents: number, format: ClubFormat): string;
/**
 * @deprecated TEMPORARY, AND DUE TO BE DELETED BY #3567 — see
 * {@link formatCents}'s one-argument overload, which this one mirrors exactly.
 */
export function formatSignedCents(cents: number): string;
export function formatSignedCents(cents: number, format?: ClubFormat): string {
  const resolved = format ?? transitionalClubFormat();
  if (cents === 0) {
    return formatCents(0, resolved);
  }
  return `${cents > 0 ? "+" : "-"}${formatCents(Math.abs(cents), resolved)}`;
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
