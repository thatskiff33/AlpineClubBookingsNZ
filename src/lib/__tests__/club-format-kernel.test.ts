import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

import { APP_CURRENCY, APP_LOCALE } from "@/config/operational";
import { bindClubFormat } from "@/lib/club-format-bound";
import { clubMoneyFormatter, clubNumberFormatter } from "@/lib/club-format-intl";
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

/**
 * The format the retired module constants amounted to, spelled from the SAME
 * identifiers so the comparison below is still a transcription on a deployment
 * configured for another currency. It is what every one-argument call rendered
 * with before this stage, and the required argument is proven against it.
 */
const RETIRED: ClubFormat = { currencyCode: APP_CURRENCY, locale: APP_LOCALE };

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
      expect(formatCents(cents, RETIRED), `formatCents(${cents})`).toBe(expected);
    }
  });

  it("keeps the negative-zero guard: a rounded-away small negative is not -$0.00", () => {
    expect(formatCents(Math.round(-0.4), RETIRED)).toBe(formatCents(0, RETIRED));
    expect(formatCents(Math.round(-0.4), NZ)).toBe(formatCents(0, NZ));
    expect(formatCents(-0, NZ)).not.toContain("-");
  });

  it("renders signed cents exactly as before", () => {
    for (const cents of AMOUNTS_CENTS) {
      const expected =
        cents === 0
          ? referenceCents.format(0)
          : `${cents > 0 ? "+" : "-"}${referenceCents.format(Math.abs(cents) / 100)}`;
      expect(formatSignedCents(cents, RETIRED)).toBe(expected);
    }
  });

  it("renders whole dollars, signed dollars and compact ticks exactly as before", () => {
    for (const cents of AMOUNTS_CENTS) {
      expect(formatDollarsDisplay(cents, RETIRED)).toBe(
        referenceDollars.format(Math.round(cents / 100)),
      );

      const rounded = Math.round(cents / 100);
      expect(formatSignedDollarsDisplay(cents, RETIRED)).toBe(
        rounded === 0
          ? referenceDollars.format(0)
          : `${rounded > 0 ? "+" : "-"}${referenceDollars.format(Math.abs(rounded))}`,
      );

      // The compact tick's NUMBER is hand-built and its symbol comes from the
      // dollars formatter's parts, so the reference is the same two pieces.
      const dollars = cents / 100;
      const abs = Math.abs(dollars);
      const compact =
        abs >= 1_000_000
          ? `${(dollars / 1_000_000).toFixed(1)}m`
          : abs >= 1_000
            ? `${Math.round(dollars / 1_000)}k`
            : `${Math.round(dollars)}`;
      expect(formatCompactDollarsDisplay(cents, RETIRED)).toBe(
        referenceDollars
          .formatToParts(0)
          .map((part) =>
            part.type === "currency" || part.type === "literal"
              ? part.value
              : part.type === "integer"
                ? compact
                : "",
          )
          .join(""),
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
      expect(formatFinanceNumber(value, RETIRED)).toBe(referenceNumber(value));
      expect(formatFinanceNumber(value, RETIRED, 2)).toBe(referenceNumber(value, 2));

      expect(formatFinanceSignedNumber(value, RETIRED)).toBe(
        value === 0
          ? "0"
          : `${value > 0 ? "+" : "-"}${referenceNumber(Math.abs(value))}`,
      );

      expect(formatFinancePercent(value, RETIRED)).toBe(referencePercent.format(value));
      expect(formatFinanceRatio(value, RETIRED)).toBe(referenceRatio.format(value));
    }
  });

  it("leaves formatCentsPlain alone — it has no format to take", () => {
    expect(formatCentsPlain(1050)).toBe("10.50");
    expect(formatCentsPlain(-12345)).toBe("-123.45");
  });
});

/**
 * THE FORMAT IS REQUIRED, AT THE TYPE LEVEL — the owner's decision on #3565
 * (23 Sep 2026): no one-argument overload, no transitional module, no ratchet.
 * The compiler is the census now. Each line below is a call that MUST fail to
 * type-check; `@ts-expect-error` makes the failure the passing state and turns
 * a re-added optional overload into a compile error (TS2578, unused directive)
 * under `tsc -p tsconfig.test.json`, which `npm run typecheck` runs.
 *
 * MUTATION-PROVEN when written: widening `formatCents(cents: number, format:
 * ClubFormat)` to `format?: ClubFormat` (or adding a one-argument overload)
 * made the corresponding directive here report "Unused '@ts-expect-error'
 * directive", and restoring the signature cleared it. That is the whole test:
 * a runtime assertion cannot see a signature, and a scanner counting arities
 * was what the ratchet this replaces had to be.
 *
 * `formatCentsPlain` is deliberately absent: it has no format to take.
 */
describe("#3565: the format argument is required, and the compiler is the census", () => {
  it("refuses every one-argument spelling", () => {
    const calls: Array<() => string> = [
      // @ts-expect-error — formatCents(cents) has no one-argument overload (#3565)
      () => formatCents(123456),
      // @ts-expect-error — formatSignedCents(cents) has no one-argument overload (#3565)
      () => formatSignedCents(123456),
      // @ts-expect-error — formatDollarsDisplay(cents) has no one-argument overload (#3565)
      () => formatDollarsDisplay(123456),
      // @ts-expect-error — formatSignedDollarsDisplay(cents) has no one-argument overload (#3565)
      () => formatSignedDollarsDisplay(123456),
      // @ts-expect-error — formatCompactDollarsDisplay(cents) has no one-argument overload (#3565)
      () => formatCompactDollarsDisplay(123456),
      // @ts-expect-error — formatFinanceNumber(value) has no one-argument overload (#3565)
      () => formatFinanceNumber(1234),
      // @ts-expect-error — formatFinanceNumber(value, digits) is the retired shape; the format is the second argument (#3565)
      () => formatFinanceNumber(1234, 2),
      // @ts-expect-error — formatFinanceSignedNumber(value) has no one-argument overload (#3565)
      () => formatFinanceSignedNumber(1234),
      // @ts-expect-error — formatFinancePercent(value) has no one-argument overload (#3565)
      () => formatFinancePercent(0.5),
      // @ts-expect-error — formatFinanceRatio(value) has no one-argument overload (#3565)
      () => formatFinanceRatio(1.35),
    ];
    // The directives above are the assertion. This keeps the closures from being
    // unused bindings, and never calls them: a call with the argument missing is
    // exactly what the compiler exists to prevent, not something to run.
    expect(calls).toHaveLength(10);
  });

  it("no longer ships the transitional module or an optional format", () => {
    expect(
      existsSync(path.resolve(process.cwd(), "src/lib/club-format-transitional.ts")),
    ).toBe(false);
    for (const relative of ["src/lib/utils.ts", "src/lib/finance-format.ts"]) {
      const code = stripComments(
        readFileSync(path.join(process.cwd(), relative), "utf8"),
      );
      expect(code, `${relative} re-declares an optional format`).not.toMatch(
        /format\?\s*:\s*ClubFormat/,
      );
      expect(code, `${relative} names the deleted module`).not.toContain(
        "club-format-transitional",
      );
    }
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
