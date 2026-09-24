/**
 * The one place in the money kernel that constructs an `Intl.NumberFormat`
 * (stage 3 of programme #3205, #3565). INV-CONFIG-006.
 *
 * WHY THE FORMATTER CANNOT BE A MODULE CONSTANT ANY MORE. `src/lib/utils.ts`
 * built one `Intl.NumberFormat` at MODULE LOAD from `APP_LOCALE` and
 * `APP_CURRENCY`, and it backed `formatCents` — the one home (`INV-SSOT-001`,
 * #3302) for turning integer cents into a currency string, imported by more than
 * a hundred non-test files, about half of them `"use client"`.
 * `src/lib/finance-format.ts` had the same shape with four more. After #3563 the
 * club's currency and locale are an asynchronous, `server-only` database read, so
 * a module-level `const` cannot await them and a browser cannot reach them. The
 * format has to arrive as an ARGUMENT and the formatter has to be looked up
 * rather than frozen.
 *
 * That is the identical problem `src/lib/club-time/intl.ts` solved for the
 * timezone, down to the sentence above, and this module is deliberately its
 * mirror rather than a fresh invention. It records a measurement worth
 * transferring: over 20 000 iterations on Node 24.15.0, constructing a formatter
 * per call cost 42.25 us, a memo lookup 0.76 us, and the frozen module constant
 * it replaced 0.75 us. Nine nanoseconds against the one strategy that is
 * genuinely expensive. The same shape of map, for the same measured reason.
 *
 * NO EVICTION, DELIBERATELY. One installation is one club, one currency and one
 * locale, so the map holds one entry per shape — a handful — plus whatever a
 * test pins. An LRU here would be complexity guarding against nothing.
 *
 * THE LINT ARM IS SATISFIED BY CONSTRUCTION, NOT BY EXEMPTION. `INV-CONFIG-001`
 * (#3325) bans `Intl.NumberFormat(<literal locale>, { style: "currency" })` and
 * a literal `currency:` code anywhere in `src/`, with no exemption list and no
 * `eslint-disable`. Both arms are structural checks on the arguments, and the
 * two constructions below pass variables for both — `format.locale` and
 * `format.currencyCode`, off the club's resolved setting. The `style` and
 * `currency` properties are added by the factory rather than by a caller's
 * options object, so a shape declared in this file cannot carry a literal
 * currency code even by accident.
 */

import type { ClubFormat } from "@/lib/club-format";

/**
 * The currency shapes the house renders money in, declared once.
 *
 * `cents` DELIBERATELY DECLARES NO FRACTION DIGITS. `Intl` then uses the
 * currency's own minor-unit count — two for `NZD`, zero for `JPY`, three for
 * `KWD` — which is the correct answer for every club and is what the retired
 * module-level `centsFormatter` did. Pinning two here would have been invisible
 * on the New Zealand defaults and wrong for the first club that is not.
 *
 * `dollars` pins zero, because the finance dashboard's KPIs, panels and chart
 * tooltips show whole units on purpose: cents are visual noise at dashboard
 * altitude, and an exact cent-precision string is a different question answered
 * by `cents`.
 */
const MONEY_SHAPES = {
  /** Exact amount in the currency's own minor units, e.g. `$1,234.56`. */
  cents: {},
  /** Whole units with separators, e.g. `$446,675`. */
  dollars: { minimumFractionDigits: 0, maximumFractionDigits: 0 },
} as const satisfies Record<string, Intl.NumberFormatOptions>;

export type MoneyShape = keyof typeof MONEY_SHAPES;

/**
 * The non-currency shapes: a locale question with no currency in it at all.
 *
 * They take the club's locale for the same reason the currency shapes do — a
 * `de-CH` club groups thousands with an apostrophe and writes a decimal comma —
 * and they take no currency because none is rendered. Keeping them here rather
 * than in `finance-format.ts` means one module answers "which `Intl.NumberFormat`
 * does this tree build?", which is what makes the lint arm above checkable by
 * reading one file.
 */
const NUMBER_SHAPES = {
  /** One decimal place, percent style, e.g. `12.5%`. */
  percent: { style: "percent", minimumFractionDigits: 1, maximumFractionDigits: 1 },
  /** Two decimal places, e.g. `1.35` — a ratio is not an integer. */
  ratio: { minimumFractionDigits: 2, maximumFractionDigits: 2 },
} as const satisfies Record<string, Intl.NumberFormatOptions>;

export type NumberShape = keyof typeof NUMBER_SHAPES;

const formatters = new Map<string, Intl.NumberFormat>();

/**
 * A format that is not one is refused, not rendered (#3565 review). Without
 * this, `{ currencyCode: "NZD" }` — a partial object that type-checks through a
 * cast or a stale fixture — would build a formatter in the HOST's locale and
 * memoise it under a key with an empty locale, and every later caller with the
 * same defect would share that wrong instance. INV-CONFIG-006 is that the club's
 * setting is the only authority; a silent fallback to the machine is the exact
 * failure the kernel exists to remove, so it throws before the memo is touched.
 */
function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(
      `INV-CONFIG-006: a ClubFormat needs a non-empty \`${field}\`; got ${JSON.stringify(value)}. ` +
        "Pass the club's resolved format — clubFormatValues() on the server, useClubFormat() in the browser.",
    );
  }
  return value;
}

function formatterFor(
  key: string,
  locale: string,
  options: Intl.NumberFormatOptions,
): Intl.NumberFormat {
  requireNonEmptyString(locale, "locale");
  const existing = formatters.get(key);
  if (existing) return existing;
  const created = new Intl.NumberFormat(locale, options);
  formatters.set(key, created);
  return created;
}

/**
 * A currency formatter in the club's locale and currency.
 *
 * The key carries both fields because both change the output, and a `\u0000`
 * separator because neither a BCP 47 tag nor an ISO 4217 code can contain one —
 * so two different formats can never collide on one key.
 */
export function clubMoneyFormatter(
  format: ClubFormat,
  shape: MoneyShape,
): Intl.NumberFormat {
  requireNonEmptyString(format.currencyCode, "currencyCode");
  return formatterFor(
    `${shape}\u0000${format.locale}\u0000${format.currencyCode}`,
    format.locale,
    {
      style: "currency",
      currency: format.currencyCode,
      ...MONEY_SHAPES[shape],
    },
  );
}

/** A non-currency formatter in the club's locale. */
export function clubNumberFormatter(
  format: ClubFormat,
  shape: NumberShape,
): Intl.NumberFormat {
  return formatterFor(
    `${shape}\u0000${format.locale}`,
    format.locale,
    NUMBER_SHAPES[shape],
  );
}

/**
 * A plain decimal formatter capped at `maximumFractionDigits`.
 *
 * Separate from {@link NUMBER_SHAPES} because the digit count is a per-call
 * argument rather than a declared house shape — `formatFinanceNumber` takes it
 * from its caller. It was constructing a formatter on EVERY call before this
 * change, so routing it through the memo is a strict improvement rather than a
 * cost, and the rendered string is unchanged: the options are the same options.
 */
export function clubDecimalFormatter(
  format: ClubFormat,
  maximumFractionDigits: number,
): Intl.NumberFormat {
  return formatterFor(
    `decimal:${maximumFractionDigits}\u0000${format.locale}`,
    format.locale,
    { maximumFractionDigits },
  );
}
