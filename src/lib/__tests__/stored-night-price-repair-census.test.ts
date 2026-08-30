import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * #3191 (epic #2797): the census behind `INV-MOD-028`'s hardest clause - "a
 * blank may only be filled in by a person supplying the amount".
 *
 * ## Why a source census and not another behaviour test
 *
 * The behaviour tests in `stored-night-price-repair.test.ts` prove that THIS
 * writer refuses to invent a number. They cannot prove anything about the writer
 * somebody adds next year, and that is the risk the issue names: the repair path
 * is "the one place where a number CAN legitimately be written onto a night that
 * has none, so it is precisely where an accidental reconstruction would undo the
 * epic".
 *
 * So this file asks two questions of the tree itself:
 *
 *  1. **Who may turn an existing `BookingGuestNight` row's price into a
 *     number?** Exactly one module. Every other production writer of that table
 *     creates rows wholesale from a priced breakdown - `syncGuestNights` and its
 *     siblings, governed by `nightPriceCentsToWrite` and `required-price-cents.ts`
 *     - and an in-place `update` of a price is a different act with a different
 *     rule. Measured from the source, so a second one fails here with its own
 *     file name.
 *  2. **Does this feature contain any arithmetic that could produce an amount?**
 *     A division, a rounding, a split helper, an averaging pass. It should not:
 *     the officer's figures are added up and compared, never derived. A `?? 0` is
 *     included because a defaulted zero is the magic value this epic exists to
 *     remove.
 *
 * ## Why the source is read with comments and strings STRIPPED
 *
 * This repository documents defects at the site it removed them from, so the
 * modules that describe an even split at length are exactly the ones that must
 * not contain one. A raw-text scanner would misfire worst where the code is
 * cleanest. The stripper below is deliberately small and its limits are stated
 * where it is defined.
 *
 * `vitest related` cannot reach this file - it reads the tree from disk and has
 * no import edge to what it scans - so it is selected by name.
 */

const SRC = resolve(process.cwd(), "src");

/** The one module allowed to update an existing night row's price in place. */
const REPAIR_WRITER = "lib/stored-night-price-repair-store.ts";

/** The whole of this feature, as files. */
const FEATURE_FILES = [
  "lib/stored-night-price-repair.ts",
  "lib/stored-night-price-repair-store.ts",
  "components/admin/unpriced-night-price-fields.tsx",
];

function sourceFiles(): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "__tests__" || entry.name === "node_modules") continue;
        walk(full);
        continue;
      }
      if (!/\.tsx?$/.test(entry.name)) continue;
      if (/\.test\.tsx?$/.test(entry.name)) continue;
      found.push(full);
    }
  };
  walk(SRC);
  return found;
}

/**
 * Source with comments and string/template literals blanked out.
 *
 * LIMITS, stated rather than discovered: it does not understand regex literals
 * (this feature contains none) and it blanks the CONTENTS of a template literal
 * including any `${}` inside it, which is why nothing below looks for an
 * identifier that only appears inside one. What it buys is the thing that
 * matters here - a docblock explaining why an even split is forbidden cannot be
 * read as an even split.
 */
function stripCommentsAndStrings(source: string): string {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const two = source.slice(i, i + 2);
    if (two === "//") {
      const end = source.indexOf("\n", i);
      i = end === -1 ? source.length : end;
      continue;
    }
    if (two === "/*") {
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? source.length : end + 2;
      continue;
    }
    const ch = source[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      i += 1;
      while (i < source.length) {
        if (source[i] === "\\") {
          i += 2;
          continue;
        }
        if (source[i] === ch) {
          i += 1;
          break;
        }
        i += 1;
      }
      out += '""';
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

describe("only one module may fill in a blank night price", () => {
  it("is the repair writer, and nothing else updates a night row in place", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      const code = stripCommentsAndStrings(readFileSync(file, "utf8"));
      // `bookingGuestNight.update`, `.updateMany` and `.upsert` - every way an
      // EXISTING row's price can be rewritten. `createMany` is not one of them:
      // those writers compose a whole night set from a priced breakdown and are
      // governed by `nightPriceCentsToWrite` and `required-price-cents.ts`.
      if (!/bookingGuestNight\s*\.\s*(update|updateMany|upsert)\b/.test(code)) {
        continue;
      }
      const rel = relative(SRC, file).split("\\").join("/");
      if (rel === REPAIR_WRITER) continue;
      offenders.push(rel);
    }
    expect(
      offenders,
      `INV-MOD-028: a NULL BookingGuestNight.priceCents may only be filled in by a person supplying the amount, and ${REPAIR_WRITER} is the only writer that does. These modules also rewrite an existing night row's price in place: ${offenders.join(", ")}`,
    ).toEqual([]);
  });

  it("the repair writer really is one of the files on disk", () => {
    // THE CONTROL for the assertion above. An allowlist naming a file that has
    // been renamed away would make that census pass by having nothing to find.
    const all = sourceFiles().map((file) =>
      relative(SRC, file).split("\\").join("/"),
    );
    for (const file of FEATURE_FILES) expect(all).toContain(file);
    const code = stripCommentsAndStrings(
      readFileSync(join(SRC, REPAIR_WRITER), "utf8"),
    );
    expect(code).toMatch(/bookingGuestNight\s*\.\s*updateMany\b/);
  });
});

describe("nothing in this feature can derive an amount", () => {
  /**
   * Each pattern is a way a per-night figure could be produced rather than read:
   * a division (an even split), a rounding of one, a shared split helper, an
   * averaging pass, or a defaulted zero.
   */
  const DERIVATIONS: ReadonlyArray<{ what: string; pattern: RegExp }> = [
    // A `/` that is not a JSX closing tag (`</fieldset>`), not a comment (those
    // are stripped) and not a self-closing tag (`/>`), followed by something a
    // divisor can start with.
    { what: "a division", pattern: /(?<!<)\/(?!\/)\s*[A-Za-z0-9_(]/ },
    { what: "a rounding", pattern: /Math\s*\.\s*(round|floor|ceil|trunc)\b/ },
    { what: "a split helper", pattern: /\bsplit[A-Z]\w*/ },
    { what: "an averaging pass", pattern: /\baverage\b/i },
    { what: "a defaulted zero", pattern: /\?\?\s*0\b/ },
  ];

  for (const file of FEATURE_FILES) {
    it(`${file} contains none`, () => {
      const code = stripCommentsAndStrings(
        readFileSync(join(SRC, file), "utf8"),
      );
      for (const { what, pattern } of DERIVATIONS) {
        expect(
          pattern.test(code),
          `INV-MOD-028: ${file} appears to contain ${what}. Nothing in this feature may produce a per-night amount - the officer types every figure and this code only adds them up and compares them.`,
        ).toBe(false);
      }
    });
  }

  it("the stripper does not blind the patterns to real code", () => {
    // THE CONTROL. A stripper that returned an empty string would make every
    // assertion above pass, which is the vacuous-guard failure this repository
    // has shipped before.
    const stripped = stripCommentsAndStrings(
      [
        "// an even split: total / nights.length",
        "/* Math.round(total / n) */",
        'const message = "split evenly across the nights";',
        "const real = total / nights.length;",
      ].join("\n"),
    );
    expect(stripped).toContain("const real = total");
    expect(DERIVATIONS[0].pattern.test(stripped)).toBe(true);
    expect(stripped).not.toContain("nights.length;\nconst message");
    expect(/Math\s*\.\s*round/.test(stripped)).toBe(false);
  });
});
