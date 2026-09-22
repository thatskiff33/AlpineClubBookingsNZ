import { execSync } from "node:child_process";
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

/**
 * THE THIRD ARM: the hazard the explicit-argument design MOVED rather than removed.
 *
 * `club-time-kernel-census.test.ts` carries a third arm the two above have no
 * equivalent of — "freezes no formatter at module level, in any module" — with
 * the note that re-introducing one "would put the old defect back underneath the
 * new API". This stage retired 5 module-level `Intl.NumberFormat` constants, and
 * the arm above is what stops a sixth. It does not stop this:
 *
 * ```ts
 * const money = bindClubFormat({ currencyCode: "NZD", locale: "en-NZ" });
 * export const line = (cents: number) => money.cents(cents);
 * ```
 *
 * Which is the SAME defect wearing the new API. Walk what sees it: arm 1 is
 * green, because no `Intl.NumberFormat` is written. Arm 2 is green, because it
 * only inspects the declared homes. Both `INV-CONFIG-001` eslint arms are green,
 * because they are structural checks on `Intl.NumberFormat`'s ARGUMENTS and
 * there is no such call here. And #3567's compiler sweep is green, because a
 * two-argument call is exactly what "migrated" looks like. The club's persisted
 * currency is frozen out of that module for the life of the process, and every
 * instrument reports success.
 *
 * So the hazard moved from a guarded CONSTRUCT to an unguarded OBJECT LITERAL,
 * and this arm follows it there. Two halves:
 *
 * - **no `bindClubFormat` at module scope.** A binding is per request, because
 *   the format it closes over is. The detector is the club-time census's own —
 *   a `const`/`let`/`var` initialiser at column zero — with the same known
 *   limit: it sees the shape this codebase actually writes, not every shape.
 * - **no hand-written club format.** `currencyCode` is a REQUIRED field of
 *   `ClubFormat`, so a literal on it is every hand-built format there can be;
 *   `locale` is included because the pair is what a reader recognises.
 *
 * WHY THE TESTS ARE NOT SCANNED, and it matters that this is structural rather
 * than an exemption: `sourceFiles()` skips `__tests__` and `*.test.ts` already,
 * so the four `ClubFormat` literals at the top of THIS file — `NZ`, `CH`, `DE`,
 * `JP` — are outside the population by construction. A test pinning a currency
 * is legitimate and is the only way to prove the argument is load-bearing. The
 * `INV-CONFIG-001` lint message says "there is no legitimate literal locale or
 * currency code in `src/`", and after this file there is one class of them; the
 * message is about `Intl.NumberFormat` arguments in production code, which
 * remains true.
 */

/** Files allowed a literal on one of the two field names, with the reason. */
const LITERAL_FORMAT_EXEMPTIONS = new Map<string, string>([
  [
    path.join("src", "app", "layout.tsx"),
    "NOT A `ClubFormat`. `openGraph.locale` is an Open Graph territory tag in the UNDERSCORE form (`en_NZ`), a Next `Metadata` field consumed by link-preview crawlers — a different grammar from the BCP 47 tag this kernel validates, and nothing renders an amount or a number through it. It is a genuine `INV-CONFIG-001`-shaped hardcode of the same family and it is NOT this stage's to move: the programme's remaining server-reader stage owns it, and an entry here is what makes it visible rather than absent.",
  ],
]);

/** `const money = bindClubFormat(...)` at column zero — a frozen binding. */
export function findModuleScopeBindings(source: string): number {
  return (
    source.match(
      /^(?:export\s+)?(?:const|let|var)\s+\w+\s*(?::[^=\n]+)?=\s*bindClubFormat\s*\(/gm,
    ) ?? []
  ).length;
}

/** A string literal on either `ClubFormat` field name. */
export function findLiteralFormatFields(source: string): string[] {
  return [...source.matchAll(/\b(currencyCode|locale)\s*:\s*["'`]/g)].map(
    (match) => match[1],
  );
}

describe("INV-CONFIG-006 / #3565: no module freezes the club's format", () => {
  it("counts the shapes it claims to, and not their near misses", () => {
    expect(
      findModuleScopeBindings('const money = bindClubFormat({ currencyCode: "NZD", locale: "en-NZ" });'),
    ).toBe(1);
    expect(
      findModuleScopeBindings("export const money = bindClubFormat(format);"),
    ).toBe(1);
    expect(
      findModuleScopeBindings("let money: BoundClubFormat = bindClubFormat(f);"),
    ).toBe(1);
    // Inside a function, which is where a binding belongs: indented, so not at
    // column zero. This is the limit the club-time census states for its own
    // twin, carried over rather than quietly widened.
    expect(
      findModuleScopeBindings("function render() {\n  const money = bindClubFormat(format);\n}"),
    ).toBe(0);
    expect(findLiteralFormatFields('{ currencyCode: "NZD" }')).toEqual([
      "currencyCode",
    ]);
    expect(findLiteralFormatFields("{ locale: 'de-CH' }")).toEqual(["locale"]);
    // A field READ, a variable and a type are not a hardcoded format.
    expect(findLiteralFormatFields("format.currencyCode")).toEqual([]);
    expect(findLiteralFormatFields("{ currencyCode: code }")).toEqual([]);
    expect(findLiteralFormatFields("interface X { locale: string }")).toEqual([]);
  });

  it("finds no module-scope binding and no hand-written format", () => {
    const boundAtModuleScope: string[] = [];
    const handWritten: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const relative = path.relative(process.cwd(), file);
      const code = stripComments(readFileSync(file, "utf8"));
      if (findModuleScopeBindings(code) > 0) boundAtModuleScope.push(relative);
      if (
        findLiteralFormatFields(code).length > 0 &&
        !LITERAL_FORMAT_EXEMPTIONS.has(relative)
      ) {
        handWritten.push(relative);
      }
    }

    expect(
      boundAtModuleScope,
      `INV-CONFIG-006: these modules call \`bindClubFormat\` at module scope, which freezes the club's currency and locale for the life of the process — the exact defect #3565 retired five \`Intl.NumberFormat\` constants to remove, rebuilt on top of the new API. Bind inside the request: \`const money = await clubFormat()\` in a server component or handler, or \`bindClubFormat(props.clubFormat)\` inside a client component. Offenders: ${boundAtModuleScope.join(", ") || "(none)"}`,
    ).toEqual([]);

    expect(
      handWritten,
      `INV-CONFIG-006: these modules write a currency code or a locale tag as a literal into an object. The club's format is a persisted setting (#3563) and reaches a renderer as DATA — \`clubFormat()\` / \`clubFormatValues()\` on the server, \`useClubFormat()\` in the browser. A hand-written one is a second authority that the eslint arms cannot see, because they check \`Intl.NumberFormat\`'s arguments and this constructs nothing. If it is genuinely not a \`ClubFormat\`, add it to LITERAL_FORMAT_EXEMPTIONS with the reason. Offenders: ${handWritten.join(", ") || "(none)"}`,
    ).toEqual([]);
  });

  it("keeps every exemption real and reasoned", () => {
    for (const [relative, reason] of LITERAL_FORMAT_EXEMPTIONS) {
      const code = stripComments(
        readFileSync(path.join(process.cwd(), relative), "utf8"),
      );
      expect(
        findLiteralFormatFields(code).length,
        `${relative} no longer writes a literal currency code or locale — delete its exemption rather than leave a permission nobody needs.`,
      ).toBeGreaterThan(0);
      expect(reason.trim().length).toBeGreaterThanOrEqual(40);
    }
  });
});

/**
 * THE ONE-ARGUMENT CENSUS, AS A RATCHET — because "temporary" was asserted and
 * nothing checked it.
 *
 * The decision recorded on #3565 took the deprecated one-argument overload over
 * the required argument, so that each group could ship green and small, and
 * bounded it by "removed in the last group". Nothing enforced that. The
 * `@deprecated` tag is a documentation annotation; no `no-deprecated` lint rule
 * is configured in this repository, so it produces no diagnostic anywhere — and
 * a NEW one-argument call site landed on `main` after the decision was taken,
 * `src/lib/audit-metadata-amounts.ts` from #3533, with nothing to notice it.
 *
 * A NUMBER is the instrument, for the reason
 * `club-time-escape-hatch-census.test.ts` gives for its twin: the migrated and
 * the unmigrated spelling are the same call with a different arity, so no
 * selector separates them, and the remaining population is far too large for a
 * readable exemption list. So it is counted, and the count MAY ONLY FALL.
 *
 * `toBe`, NOT `toBeLessThanOrEqual`, and that is the mechanism rather than a
 * style: slack is headroom in which the count can silently regrow, which is the
 * measured lesson of the club-time ratchet. A count that went DOWN failing is
 * the pleasant kind of failure, takes one line to resolve, and is the only
 * signal that a migration group has landed. When #3567 deletes
 * `club-format-transitional.ts` these numbers are zero and the COMPILER, not
 * this scanner, is what a new one-argument call runs into first. At that point
 * delete the overloads, not the ceiling — a type signature can be widened back
 * to optional by one small edit that reads as a convenience, and a defaulted
 * CALL is what this scanner sees while a defaulted SIGNATURE is what the
 * compiler sees. Neither instrument sees both.
 */
const UNMIGRATED_CEILING = {
  /**
   * One-argument calls of a rendering that now takes the club's format.
   *
   * MEASURED, NEVER INCREMENTED. Both numbers equal the live count on the
   * composed tree at the commit that last touched them; there is no slack, no
   * rounding and no allowance for work in flight. A sync from `main` is not a
   * no-op for this file — `main` can add a call site of its own, as #3533 did —
   * so re-measure after one rather than assuming the number survived it.
   */
  calls: 528,
  /** Production files containing at least one. */
  files: 119,
};

/**
 * The renderings that kept a deprecated one-argument overload.
 *
 * `formatCentsPlain` is deliberately absent: it renders `(cents / 100)
 * .toFixed(2)`, has no format to take, and #3567 does not touch it. Counting it
 * would make this ratchet un-zeroable.
 */
const ONE_ARGUMENT_RENDERINGS = [
  "formatCents",
  "formatSignedCents",
  "formatDollarsDisplay",
  "formatSignedDollarsDisplay",
  "formatCompactDollarsDisplay",
  "formatFinanceNumber",
  "formatFinanceSignedNumber",
  "formatFinancePercent",
  "formatFinanceRatio",
] as const;

/**
 * Every call of one of those that did NOT pass the club's format.
 *
 * ARGUMENTS ARE COUNTED BY WALKING THE PARENTHESES and splitting on TOP-LEVEL
 * commas, never by a regular expression. `formatCents(pick(row, "cents"))`
 * contains a comma that is not an argument separator, and a regex counting
 * commas would report that unmigrated call as done. That is the direction of
 * error which HIDES work, so it is the one worth paying for — the same
 * reasoning and the same walker as `findDefaultedZoneCalls`.
 *
 * `formatFinanceNumber` is the one arity alone cannot judge, because its
 * deprecated shape is `(value, digits?)` and its migrated shape is
 * `(value, format, digits?)`. A numeric second argument is the old digit count;
 * anything else is the format. That mirrors the runtime discriminator the
 * implementation itself uses (`typeof formatOrDigits === "object"`).
 */
export function findUnmigratedRenderCalls(source: string): string[] {
  const found: string[] = [];
  for (const name of ONE_ARGUMENT_RENDERINGS) {
    const pattern = new RegExp(String.raw`\b${name}\s*\(`, "g");
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source)) !== null) {
      const before = source.slice(Math.max(0, match.index - 60), match.index);
      // A declaration, an overload signature or an import mention is not a call.
      if (/\b(function|import|export)\s[^\n]*$/.test(before)) continue;
      // `money.cents(...)` and friends are the BOUND API, already migrated.
      if (/\.\s*$/.test(before)) continue;

      let index = match.index + match[0].length;
      let depth = 1;
      let current = "";
      const parts: string[] = [];
      while (index < source.length && depth > 0) {
        const character = source[index];
        if ("([{".includes(character)) depth++;
        else if (")]}".includes(character)) {
          depth--;
          if (depth === 0) break;
        }
        if (character === "," && depth === 1) {
          parts.push(current);
          current = "";
        } else current += character;
        index++;
      }
      if (current.trim() !== "") parts.push(current);
      const args = parts.map((part) => part.trim()).filter((part) => part !== "");

      const formatGiven =
        name === "formatFinanceNumber"
          ? args.length >= 2 && !/^-?\d+$/.test(args[1])
          : args.length >= 2;
      if (!formatGiven) found.push(name);
    }
  }
  return found;
}

describe("#3565: the one-argument overload is counted, and may only shrink", () => {
  it("counts what it claims to count, and not its near misses", () => {
    expect(findUnmigratedRenderCalls("formatCents(booking.priceCents)")).toEqual([
      "formatCents",
    ]);
    expect(findUnmigratedRenderCalls("formatCents(cents, money.format)")).toEqual([]);
    // The near miss that matters: a comma inside a nested call. A regex would
    // read two arguments here and report an unmigrated call as done.
    expect(findUnmigratedRenderCalls('formatCents(pick(row, "cents"))')).toHaveLength(1);
    expect(findUnmigratedRenderCalls("formatCents({ a: 1, b: 2 }.a)")).toHaveLength(1);
    // `formatFinanceNumber`'s two shapes, which arity alone cannot separate.
    expect(findUnmigratedRenderCalls("formatFinanceNumber(value, 2)")).toEqual([
      "formatFinanceNumber",
    ]);
    expect(findUnmigratedRenderCalls("formatFinanceNumber(value, format)")).toEqual([]);
    expect(findUnmigratedRenderCalls("formatFinanceNumber(value, format, 2)")).toEqual([]);
    // Declarations, overload signatures, imports and the bound API are not calls.
    expect(
      findUnmigratedRenderCalls("export function formatCents(cents: number): string;"),
    ).toEqual([]);
    expect(
      findUnmigratedRenderCalls('import { formatCents } from "@/lib/utils";'),
    ).toEqual([]);
    expect(findUnmigratedRenderCalls("money.formatCents(n)")).toEqual([]);
    // Prose naming a call is stripped before the scanner sees it.
    expect(
      findUnmigratedRenderCalls(stripComments("// formatCents(n)\n/* formatCents(n) */")),
    ).toEqual([]);
    // `formatCentsPlain` is a different function with no format to take, and a
    // prefix match would sweep it in and make this ratchet un-zeroable.
    expect(findUnmigratedRenderCalls("formatCentsPlain(cents)")).toEqual([]);
  });

  it("enumerates exactly what git says is there", () => {
    /*
      THE PREMISE FOR THE COUNT BELOW, checked against an instrument that shares
      no code with the walker. A ceiling measured over a population that
      silently lost a subtree is a comfortable number meaning nothing;
      `git ls-files` reads the index rather than the filesystem, so the two can
      only agree by both being right.
    */
    const tracked = execSync("git ls-files src", {
      cwd: process.cwd(),
      encoding: "utf8",
    })
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .filter(
        (file) =>
          /\.(ts|tsx)$/.test(file) &&
          !/\.(test|spec)\.(ts|tsx)$/.test(file) &&
          !file.includes("/__tests__/"),
      )
      .map((file) => path.normalize(file))
      .sort();

    const walked = sourceFiles(SRC)
      .map((file) => path.relative(process.cwd(), file))
      .sort();

    expect(walked).toEqual(tracked);
    // And the filters really excluded something, so the equality above is not
    // two empty lists agreeing with each other.
    expect(walked).toContain(path.join("src", "lib", "utils.ts"));
    expect(walked).not.toContain(
      path.join("src", "lib", "__tests__", "club-format-kernel.test.ts"),
    );
  });

  it("holds the remaining one-argument call sites at their measured count", () => {
    const perFile = new Map<string, number>();
    let calls = 0;
    for (const file of sourceFiles(SRC)) {
      const found = findUnmigratedRenderCalls(
        stripComments(readFileSync(file, "utf8")),
      );
      if (found.length === 0) continue;
      perFile.set(path.relative(process.cwd(), file), found.length);
      calls += found.length;
    }

    const worst = [...perFile.entries()]
      .sort((left, right) => right[1] - left[1])
      .slice(0, 5)
      .map(([file, count]) => `${file} (${count})`)
      .join(", ");

    expect(
      { calls, files: perFile.size },
      `#3565/#3567: this is a RATCHET and it may only fall. Going UP means a new one-argument call site: pass the club's format — \`const money = await clubFormat()\` on the server, \`bindClubFormat\` on a format the browser seam delivered in a client component. Going DOWN means a migration group landed, and its ceiling belongs in the same commit. Largest remaining: ${worst || "(none)"}.`,
    ).toEqual(UNMIGRATED_CEILING);
  });
});
