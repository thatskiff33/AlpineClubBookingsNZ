import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

// `INV-SSOT-004`: the ONE comment/string stripper in the tree, imported rather
// than written again. A local copy that mis-reads a regex literal deletes the
// rest of the line, and a census whose stripper under-reports goes FALSELY GREEN
// - it passes while the thing it exists to catch is sitting in the file (#3164).
import { stripCommentsAndStrings } from "@/lib/__tests__/support/strip-comments";

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
 * cleanest. `stripCommentsAndStrings` is the tree's one stripper and this file
 * imports it (`INV-SSOT-004`).
 *
 * ## WHAT A SOURCE SCAN CANNOT SEE, AND WHERE THAT HALF LIVES
 *
 * A REMAINDER FILL MATCHES NONE OF THESE PATTERNS. `targetCents - enteredCents`
 * is a subtraction; `entries.push({ date: last, priceCents: targetCents - sum })`
 * is a subtraction and an assignment; `total >> 1` is neither. All three are
 * exactly the derivation `unpriced-night-price-fields.tsx` says must never
 * happen - "showing only the remainder would hand the officer the last night's
 * price" - and the server cannot catch any of them either, because a remainder
 * fill posts a COMPLETE, reconciling vector that `checkStoredNightPriceRepair`
 * is obliged to accept.
 *
 * A SUBTRACTION PATTERN WAS CONSIDERED AND REJECTED, on evidence rather than on
 * effort: this feature contains two legitimate subtractions already
 * (`unpricedNightTargetCents` is `stored + delta - known`, and
 * `settlementDeltaCents` negates a magnitude), so the rule would ship needing
 * exemptions on day one, and an exemption list for an operator is the shape
 * that rots fastest. It would also be trivially evaded - `>>`, a `reduce`, a
 * helper one module away - because the property is about the RESULT, not about
 * the spelling.
 *
 * So that half is a BEHAVIOUR test and not a regex:
 * `manual-refund-task-queue-financial-review.test.tsx` -> "no box is ever filled
 * in by the screen, however many of the others are" fills every night but one on
 * the real screen and asserts the last stays empty. It is immune to how a
 * derivation is written, and it fails on one wherever in the two components it
 * is added. Neither instrument covers the other: this file catches a SECOND
 * WRITER appearing anywhere in the tree, which no behaviour test can see.
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

/**
 * The settle screen, which is not a feature file and cannot be scanned whole.
 *
 * IT IS WHERE THE ENTRIES ARE BUILT FROM THE BOXES, and therefore the natural
 * home for the "split it evenly" button this census exists to make unwritable -
 * so leaving it out would aim the whole check one file to the left of the
 * risk. It cannot simply join `FEATURE_FILES`: it also renders a task's amount
 * as `task.amountCents / 100`, and the division pattern would fail on money
 * arithmetic that has nothing to do with a night price.
 *
 * `INV-SSOT-001` requires a per-site exclusion to be published with what makes
 * it shrink, so the exclusion is SCOPED rather than silent: the file marks the
 * region that belongs to this feature, and the patterns run over that region
 * alone. The marker pair is what shrinks it - delete the night-price code and
 * the markers go with it.
 */
const SCOPED_FILE = "components/admin/manual-refund-task-queue.tsx";
const REGION_START = "NIGHT-PRICE REGION START (stored-night-price-repair-census)";
const REGION_END = "NIGHT-PRICE REGION END (stored-night-price-repair-census)";

/**
 * The marked regions of a file, joined.
 *
 * The markers are COMMENTS, so they are located on the raw source and each
 * region is stripped afterwards - the other way round there would be nothing
 * left to find. Each marker sits on a line of its own and the region is the
 * WHOLE LINES between them, so no half of a comment delimiter can be carried
 * into the stripper. Throws rather than returning nothing when the pairing is
 * broken: a census that silently scans an empty string is the vacuous guard
 * this repository has shipped before.
 */
function markedRegions(source: string): string {
  const regions: string[] = [];
  let cursor = 0;
  for (;;) {
    const start = source.indexOf(REGION_START, cursor);
    if (start === -1) break;
    const end = source.indexOf(REGION_END, start);
    if (end === -1) {
      throw new Error(
        `${SCOPED_FILE}: a ${REGION_START} marker has no matching END. The night-price census cannot tell what it is meant to scan.`,
      );
    }
    const bodyStart = source.indexOf("\n", start);
    const bodyEnd = source.lastIndexOf("\n", end);
    if (bodyStart === -1 || bodyEnd <= bodyStart) {
      throw new Error(
        `${SCOPED_FILE}: the night-price census markers must each sit on a line of their own.`,
      );
    }
    regions.push(source.slice(bodyStart, bodyEnd));
    cursor = end + REGION_END.length;
  }
  if (regions.length === 0) {
    throw new Error(
      `${SCOPED_FILE}: no ${REGION_START} marker. Either the night-price code left this file - in which case remove this scoped scan - or somebody deleted the markers, in which case the derivation check has been silently switched off.`,
    );
  }
  return regions.map((region) => stripCommentsAndStrings(region)).join("\n");
}

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
    for (const file of [...FEATURE_FILES, SCOPED_FILE]) {
      expect(all).toContain(file);
    }
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

  it(`${SCOPED_FILE}'s night-price region contains none either`, () => {
    const code = markedRegions(readFileSync(join(SRC, SCOPED_FILE), "utf8"));
    for (const { what, pattern } of DERIVATIONS) {
      expect(
        pattern.test(code),
        `INV-MOD-028: the night-price region of ${SCOPED_FILE} appears to contain ${what}. This is where the entries posted to the server are built from the officer's boxes, so it is where a "split it evenly" control would go - and nothing on this path may produce a per-night amount.`,
      ).toBe(false);
    }
  });

  it("the scoped region is real code, and does not cover the whole file", () => {
    // THE CONTROL, and it has two halves because the scoping can fail in two
    // directions. A region that had shrunk to nothing would pass the assertion
    // above by having nothing to scan; a region that had swallowed the file
    // would fail it on `task.amountCents / 100`, which is the money arithmetic
    // the exclusion exists for and has nothing to do with a night price.
    const raw = readFileSync(join(SRC, SCOPED_FILE), "utf8");
    const code = markedRegions(raw);
    expect(code).toContain("nightPriceEntries");
    expect(code).toContain("nightPricesBlocked");
    expect(code.length).toBeLessThan(raw.length / 2);
    // The excluded remainder really does hold the division that made a
    // whole-file scan impossible, so this exclusion is load-bearing rather
    // than habit.
    expect(stripCommentsAndStrings(raw)).toMatch(/amountCents\s*\/\s*100/);
    expect(code).not.toMatch(/amountCents\s*\/\s*100/);
  });

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
