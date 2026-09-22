import { readFileSync, readdirSync, statSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

import { APP_CURRENCY, APP_LOCALE } from "@/config/operational";
import { bindClubFormat } from "@/lib/club-format-bound";
import { clubMoneyFormatter, clubNumberFormatter } from "@/lib/club-format-intl";
import { transitionalClubFormat } from "@/lib/club-format-transitional";
import {
  formatCompactDollarsDisplay,
  formatDollarsDisplay,
  formatFinanceNumber,
  formatFinancePercent,
  formatFinanceRatio,
  formatFinanceSignedNumber,
  formatSignedDollarsDisplay,
} from "@/lib/finance-format";
import { formatCents, formatCentsPlain, formatSignedCents } from "@/lib/utils";

import { stripComments } from "./support/strip-comments";

import type { ClubFormat } from "@/lib/club-format";

/**
 * The money kernel (#3565, stage 3 of programme #3205). INV-CONFIG-006.
 *
 * Three things are checked, and the first is the one the issue calls
 * non-negotiable.
 *
 * ONE: NIL BEHAVIOUR CHANGE FOR A CLUB ON THE NEW ZEALAND DEFAULTS. Every
 * rendering is compared against a reference formatter transcribed from the
 * module-level constants this change retired — `new Intl.NumberFormat(APP_LOCALE,
 * { style: "currency", currency: APP_CURRENCY })` and the four in
 * `finance-format.ts` — over a spread of amounts chosen to exercise grouping, the
 * sign, rounding at the half, negative zero and the empty case. The reference is
 * built here rather than imported, so it cannot drift with the thing it is
 * checking, and it is built from the SAME identifiers the old constants used
 * rather than from string literals, so it is still a real transcription on a
 * deployment configured for another currency.
 *
 * TWO: THE ARGUMENT IS LOAD-BEARING. A test that only proves nothing changed
 * would pass just as happily if `format` were ignored entirely, which is the
 * failure this whole stage exists to make impossible. So every rendering is also
 * asked for a format that is NOT the default and required to differ.
 *
 * THREE: THE BOUND API IS THE EXPLICIT API. Each method of `bindClubFormat` must
 * equal its explicit counterpart for the same input — the binding is sugar, and
 * a binding that quietly rendered something else would be the worst possible
 * place for a divergence, because the call sites moving onto it are exactly the
 * ones nobody re-reads.
 */

const NZ: ClubFormat = { currencyCode: "NZD", locale: "en-NZ" };
const CH: ClubFormat = { currencyCode: "CHF", locale: "de-CH" };
/** A comma-decimal locale: de-CH writes a decimal POINT, so it proves nothing there. */
const DE: ClubFormat = { currencyCode: "EUR", locale: "de-DE" };
/** A zero-minor-unit currency — the reason `cents` declares no fraction digits. */
const JP: ClubFormat = { currencyCode: "JPY", locale: "ja-JP" };

/**
 * Amounts chosen for what each one can break, not for coverage theatre: zero and
 * negative zero (the `-$0.00` guard `formatCents` has carried since #3264), a
 * sub-unit amount, the thousands and millions boundaries either side, an exact
 * half at the rounding point, and a negative of each shape.
 */
const AMOUNTS_CENTS = [
  0, -0, 1, -1, 50, 99, 100, 999, 1000, 1050, 123456, -123456, 99950, 100000,
  44667484, -44667484, 99999999, 123456789, -1, -50, 250000000,
];

/** The reference formatters, transcribed from the retired module constants. */
const referenceCents = new Intl.NumberFormat(APP_LOCALE, {
  style: "currency",
  currency: APP_CURRENCY,
});
const referenceDollars = new Intl.NumberFormat(APP_LOCALE, {
  style: "currency",
  currency: APP_CURRENCY,
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});
const referencePercent = new Intl.NumberFormat(APP_LOCALE, {
  style: "percent",
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});
const referenceRatio = new Intl.NumberFormat(APP_LOCALE, {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const referenceNumber = (value: number, maximumFractionDigits = 0) =>
  new Intl.NumberFormat(APP_LOCALE, { maximumFractionDigits }).format(value);

describe("#3565 kernel: nil behaviour change on the configured defaults", () => {
  it("renders exact cents exactly as the retired module formatter did", () => {
    for (const cents of AMOUNTS_CENTS) {
      const expected = referenceCents.format((cents === 0 ? 0 : cents) / 100);
      expect(formatCents(cents), `formatCents(${cents}) unmigrated`).toBe(expected);
      expect(
        formatCents(cents, transitionalClubFormat()),
        `formatCents(${cents}) migrated`,
      ).toBe(expected);
    }
  });

  it("keeps the negative-zero guard: a rounded-away small negative is not -$0.00", () => {
    expect(formatCents(Math.round(-0.4))).toBe(formatCents(0));
    expect(formatCents(Math.round(-0.4), NZ)).toBe(formatCents(0, NZ));
    expect(formatCents(-0, NZ)).not.toContain("-");
  });

  it("renders signed cents exactly as before", () => {
    for (const cents of AMOUNTS_CENTS) {
      const expected =
        cents === 0
          ? referenceCents.format(0)
          : `${cents > 0 ? "+" : "-"}${referenceCents.format(Math.abs(cents) / 100)}`;
      expect(formatSignedCents(cents)).toBe(expected);
      expect(formatSignedCents(cents, transitionalClubFormat())).toBe(expected);
    }
  });

  it("renders whole dollars, signed dollars and compact ticks exactly as before", () => {
    for (const cents of AMOUNTS_CENTS) {
      expect(formatDollarsDisplay(cents)).toBe(
        referenceDollars.format(Math.round(cents / 100)),
      );
      expect(formatDollarsDisplay(cents, transitionalClubFormat())).toBe(
        formatDollarsDisplay(cents),
      );

      const rounded = Math.round(cents / 100);
      expect(formatSignedDollarsDisplay(cents)).toBe(
        rounded === 0
          ? referenceDollars.format(0)
          : `${rounded > 0 ? "+" : "-"}${referenceDollars.format(Math.abs(rounded))}`,
      );
      expect(formatSignedDollarsDisplay(cents, transitionalClubFormat())).toBe(
        formatSignedDollarsDisplay(cents),
      );

      expect(formatCompactDollarsDisplay(cents, transitionalClubFormat())).toBe(
        formatCompactDollarsDisplay(cents),
      );
    }
  });

  it("pins the compact tick's published shapes", () => {
    expect(formatCompactDollarsDisplay(1_000_000, NZ)).toBe("$10k");
    expect(formatCompactDollarsDisplay(120_000_000, NZ)).toBe("$1.2m");
    expect(formatCompactDollarsDisplay(45_000, NZ)).toBe("$450");
  });

  it("renders plain numbers, percentages and ratios exactly as before", () => {
    for (const value of [0, 1, 7, 1234, -1234, 1234.567, -0.5]) {
      expect(formatFinanceNumber(value)).toBe(referenceNumber(value));
      expect(formatFinanceNumber(value, 2)).toBe(referenceNumber(value, 2));
      expect(formatFinanceNumber(value, transitionalClubFormat())).toBe(
        referenceNumber(value),
      );
      expect(formatFinanceNumber(value, transitionalClubFormat(), 2)).toBe(
        referenceNumber(value, 2),
      );

      expect(formatFinanceSignedNumber(value)).toBe(
        value === 0
          ? "0"
          : `${value > 0 ? "+" : "-"}${referenceNumber(Math.abs(value))}`,
      );
      expect(formatFinanceSignedNumber(value, transitionalClubFormat())).toBe(
        formatFinanceSignedNumber(value),
      );

      expect(formatFinancePercent(value)).toBe(referencePercent.format(value));
      expect(formatFinancePercent(value, transitionalClubFormat())).toBe(
        referencePercent.format(value),
      );

      expect(formatFinanceRatio(value)).toBe(referenceRatio.format(value));
      expect(formatFinanceRatio(value, transitionalClubFormat())).toBe(
        referenceRatio.format(value),
      );
    }
  });

  it("leaves formatCentsPlain alone — it has no format to take", () => {
    expect(formatCentsPlain(1050)).toBe("10.50");
    expect(formatCentsPlain(-12345)).toBe("-123.45");
  });

  it("resolves the transitional format from the same environment as before", () => {
    expect(transitionalClubFormat().currencyCode).toBe(APP_CURRENCY);
    expect(transitionalClubFormat().locale).toBe(APP_LOCALE);
  });

  it("resolves the transitional format at most once per process", () => {
    /*
      IDENTITY, not equality, and the difference is the whole point. This module
      is on `@/lib/utils`'s import graph, which around 170 modules reach and
      about half of them in the browser, so resolving it at module load put four
      Intl operations on every first render — `normaliseClubCurrencyCode` builds
      an `Intl.NumberFormat`, `normaliseClubLocale` calls `getCanonicalLocales`
      and builds a `NumberFormat` and a `DateTimeFormat`, all discarded after
      `resolvedOptions()`. It is deferred to first use instead. A deep-equality
      assertion would pass just as happily if every call re-resolved, which is
      exactly the regression this guards.
    */
    expect(transitionalClubFormat()).toBe(transitionalClubFormat());
  });
});

describe("#3565 kernel: the format argument is load-bearing", () => {
  it("renders a different club's currency and locale differently", () => {
    expect(formatCents(123456, CH)).not.toBe(formatCents(123456, NZ));
    expect(formatCents(123456, CH)).toContain("CHF");
    expect(formatSignedCents(-123456, CH)).toContain("CHF");
    expect(formatDollarsDisplay(44667484, CH)).not.toBe(
      formatDollarsDisplay(44667484, NZ),
    );
    expect(formatSignedDollarsDisplay(44667484, CH)).not.toBe(
      formatSignedDollarsDisplay(44667484, NZ),
    );
    expect(formatCompactDollarsDisplay(1_000_000, CH)).not.toBe(
      formatCompactDollarsDisplay(1_000_000, NZ),
    );
    expect(formatFinanceNumber(1234567, CH)).not.toBe(
      formatFinanceNumber(1234567, NZ),
    );
    // de-CH writes a DECIMAL POINT like en-NZ and differs only in grouping, so
    // the two shapes with no grouping to show need a comma-decimal locale to
    // prove anything. Asserting against de-CH here would have passed vacuously.
    expect(formatFinanceRatio(1.35, DE)).not.toBe(formatFinanceRatio(1.35, NZ));
    expect(formatFinancePercent(0.125, DE)).not.toBe(
      formatFinancePercent(0.125, NZ),
    );
  });

  it("follows the currency's own minor units rather than a pinned two decimals", () => {
    // 12345 minor units of JPY is 12345 yen, not 123.45: the `cents` shape
    // declares no fraction digits precisely so `Intl` answers this per currency.
    expect(formatCents(12345, JP)).not.toContain(".");
    expect(formatCents(12345, NZ)).toContain("123.45");
  });
});

describe("#3565 kernel: the bound API is the explicit API", () => {
  it("delegates every method to its explicit counterpart", () => {
    for (const format of [NZ, CH, JP]) {
      const bound = bindClubFormat(format);
      expect(bound.format).toBe(format);
      for (const cents of AMOUNTS_CENTS) {
        expect(bound.cents(cents)).toBe(formatCents(cents, format));
        expect(bound.signedCents(cents)).toBe(formatSignedCents(cents, format));
        expect(bound.dollars(cents)).toBe(formatDollarsDisplay(cents, format));
        expect(bound.signedDollars(cents)).toBe(
          formatSignedDollarsDisplay(cents, format),
        );
        expect(bound.compactDollars(cents)).toBe(
          formatCompactDollarsDisplay(cents, format),
        );
      }
      for (const value of [0, 1234.567, -0.5]) {
        expect(bound.number(value)).toBe(formatFinanceNumber(value, format));
        expect(bound.number(value, 2)).toBe(
          formatFinanceNumber(value, format, 2),
        );
        expect(bound.signedNumber(value)).toBe(
          formatFinanceSignedNumber(value, format),
        );
        expect(bound.percent(value)).toBe(formatFinancePercent(value, format));
        expect(bound.ratio(value)).toBe(formatFinanceRatio(value, format));
      }
    }
  });
});

describe("#3565 kernel: the formatter memo", () => {
  it("hands back one instance per format and shape, and a different one per format", () => {
    expect(clubMoneyFormatter(NZ, "cents")).toBe(clubMoneyFormatter(NZ, "cents"));
    expect(clubMoneyFormatter(NZ, "cents")).not.toBe(
      clubMoneyFormatter(NZ, "dollars"),
    );
    expect(clubMoneyFormatter(NZ, "cents")).not.toBe(
      clubMoneyFormatter(CH, "cents"),
    );
    // Same locale, different currency: the key has to carry BOTH, or a club that
    // changed only its currency would keep rendering the old symbol for the life
    // of the process.
    expect(clubMoneyFormatter({ currencyCode: "AUD", locale: "en-NZ" }, "cents")).not.toBe(
      clubMoneyFormatter(NZ, "cents"),
    );
    expect(clubNumberFormatter(NZ, "percent")).toBe(
      clubNumberFormatter(NZ, "percent"),
    );
    expect(clubNumberFormatter(NZ, "percent")).not.toBe(
      clubNumberFormatter(CH, "percent"),
    );
  });
});

/**
 * THE CENSUS: one module builds the money formatters.
 *
 * `club-time/intl.ts` carries the same guard for `Intl.DateTimeFormat` and for
 * the same reason — the moment a second module constructs one, the club's
 * setting has a second authority that nothing routes through the memo, the
 * validators or this suite's byte-identity proof. The `eslint` arms
 * (`INV-CONFIG-001`, #3325) catch a LITERAL locale or currency; they cannot
 * catch a second module that does everything right with variables and is simply
 * not the one home.
 *
 * Comments are stripped before scanning, because this repository documents a
 * defect at the site it removed it: several files above name
 * `Intl.NumberFormat` in prose, and a raw-text scan of them is exactly the
 * false positive `INV-SSOT-004` exists for.
 */
const SRC = path.resolve(process.cwd(), "src");

/** The two modules allowed to construct one, each with what it constructs. */
const NUMBER_FORMAT_HOMES = new Map<string, string>([
  [
    path.join("src", "lib", "club-format-intl.ts"),
    "The one home: the memoised factory every rendering in the tree goes through.",
  ],
  [
    path.join("src", "lib", "club-format.ts"),
    "VALIDATION PROBES, not renderings — #3563's `normaliseClubCurrencyCode` and `normaliseClubLocale` ask the runtime whether it will accept a code or a tag at all. Nothing is formatted and no string is produced; the constructed instance is discarded after `resolvedOptions()`.",
  ],
]);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "__tests__") continue;
      out.push(...sourceFiles(full));
      continue;
    }
    if (!/\.(ts|tsx)$/.test(entry) || /\.test\.tsx?$/.test(entry)) continue;
    out.push(full);
  }
  return out;
}

describe("INV-CONFIG-006 / #3565: one module constructs the money formatters", () => {
  it("finds no `new Intl.NumberFormat` outside the declared homes", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const relative = path.relative(process.cwd(), file);
      if (NUMBER_FORMAT_HOMES.has(relative)) continue;
      const code = stripComments(readFileSync(file, "utf8"));
      if (/\bIntl\s*\.\s*NumberFormat\s*\(/.test(code)) offenders.push(relative);
    }

    expect(
      offenders,
      `INV-CONFIG-006: these modules construct an \`Intl.NumberFormat\` of their own. The club's currency and locale are a persisted setting (#3563), and a formatter built anywhere but \`@/lib/club-format-intl\` is a second authority that the memo, the validators and #3565's byte-identity proof all miss. Render money through \`formatCents\` / \`formatSignedCents\` (@/lib/utils) or the \`finance-format\` shapes, passing the club's format; a genuinely new SHAPE is declared in \`club-format-intl.ts\` beside the others. Offenders: ${offenders.join(", ") || "(none)"}`,
    ).toEqual([]);
  });

  it("keeps every declared home real, reasoned, and still constructing one", () => {
    for (const [relative, reason] of NUMBER_FORMAT_HOMES) {
      const code = stripComments(
        readFileSync(path.join(process.cwd(), relative), "utf8"),
      );
      expect(
        /\bIntl\s*\.\s*NumberFormat\s*\(/.test(code),
        `${relative} no longer constructs an Intl.NumberFormat — delete its entry rather than leave a permission nobody needs.`,
      ).toBe(true);
      expect(reason.trim().length).toBeGreaterThanOrEqual(40);
    }
  });
});
