import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

// `INV-SSOT-004`: the ONE comment/string stripper in the tree, imported rather
// than written again. A local copy that mis-reads a regex literal deletes the
// rest of the line, and a census whose stripper under-reports goes FALSELY GREEN
// - it passes while the thing it exists to catch is sitting in the file (#3164).
import { stripCommentsAndStrings } from "@/lib/__tests__/support/strip-comments";
import { CENSUS_TIMEOUT_MS } from "@/test/census-timeout";

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
 * So this file asks three questions of the tree itself:
 *
 *  1. **Who may fill an existing `BookingGuestNight` row's NULL price?** Only
 *     the repair writer, with the officer's figures (`INV-MOD-036`). That rule
 *     also admits #3794's bounded accepted SCHOOL naming reconciliation: proved,
 *     already-priced held-night IDs only, NULL refusal and exact-count rollback,
 *     and the rate-derived backfill's compare-and-set (#3531 3b), which is
 *     fenced on an integer price and so can never fill a NULL either.
 *     Every other production writer creates rows wholesale from a priced
 *     breakdown - `syncGuestNights` and its siblings, governed by
 *     `nightPriceCentsToWrite` and `required-price-cents.ts`. An unproved in-place
 *     writer fails here with its own file name.
 *  2. **Does this feature contain any arithmetic that could produce an amount?**
 *     A division, a rounding, a split helper, an averaging pass. It should not:
 *     the officer's figures are added up and compared, never derived. A `?? 0` is
 *     included because a defaulted zero is the magic value this epic exists to
 *     remove.
 *  3. **Can anything outside this feature reach the figure a remainder fill
 *     needs?** `unpricedNightTargetCents` is the single definition of what the
 *     blanks must come to, and a module holding that number can subtract the
 *     officer's typing from it. Question 2 stops the arithmetic being lifted one
 *     LINE out of the scanned code; this stops it being lifted one MODULE out.
 *
 * ## Why the source is read with comments and strings STRIPPED
 *
 * This repository documents defects at the site it removed them from, so the
 * modules that describe an even split at length are exactly the ones that must
 * not contain one. A raw-text scanner would misfire worst where the code is
 * cleanest. `stripCommentsAndStrings` is the tree's one stripper and this file
 * imports it (`INV-SSOT-004`).
 *
 * ## WHAT A SOURCE SCAN CANNOT SEE
 *
 * A REMAINDER FILL MATCHES NONE OF THESE PATTERNS. `targetCents - enteredCents`
 * is a subtraction, and a subtraction pattern was rejected on evidence: this
 * feature contains legitimate subtractions (`unpricedNightTargetCents` is
 * `stored + delta - known`). Until #4344 the other half was a behaviour test on
 * the settle dialog that typed into the boxes; that dialog, and the Admin tools
 * card's strand reconcile, were retired with the officer review (wave C1 of
 * #4302), so no screen builds night prices any more. What remains is the
 * completion door, which `stored-night-price-repair.test.ts` drives directly,
 * and question 3 below, which still stops the target figure leaving the feature.
 *
 * `vitest related` cannot reach this file - it reads the tree from disk and has
 * no import edge to what it scans - so it is selected by name.
 */

const SRC = resolve(process.cwd(), "src");

/** The one module allowed to fill an existing night row's unknown price. */
const REPAIR_WRITER = "lib/stored-night-price-repair-store.ts";

/** #3794 reconciles only proven priced held rows; it cannot fill a NULL. */
const PRICED_SCHOOL_WRITER = "lib/school-pending-adult-resolution.ts";

/**
 * #3531 3b: the rate-derived backfill's compare-and-set. Its own module since
 * #4344 moved it out of the retiring review store; it rewrites a PRICED row and
 * is fenced on the integer it was planned from, so it cannot fill a NULL.
 */
const RATE_DERIVED_WRITER = "lib/rate-derived-night-price-store.ts";

function isPricedRateDerivedNightWriter(code: string): boolean {
  const writes = code.match(/bookingGuestNight\s*\.\s*(update|updateMany|upsert|create)\b/g) ?? [];
  return writes.length === 1 &&
    /bookingGuestNight\.updateMany\(\{\s*where:\s*\{\s*id:\s*night\.id,\s*bookingGuestId:\s*strand\.bookingGuestId,\s*priceCents:\s*night\.fromPriceCents,\s*priceSource:\s*night\.fromSource,?\s*\},/.test(code) &&
    /if\s*\(written\.count\s*!==\s*1\)\s*\{\s*throw\s+new\s+RateDerivedBackfillRacedError\(/.test(code);
}

function isPricedSchoolNightWriter(code: string): boolean {
  const writes = code.match(/bookingGuestNight\s*\.\s*(update|updateMany|upsert|create)\b/g) ?? [];
  return writes.length === 1 &&
    /const\s+updated\s*=\s*await\s+tx\.bookingGuestNight\.updateMany\(\{\s*where:\s*\{\s*id:\s*\{\s*in:\s*group\.ids\s*\},\s*priceCents:\s*\{\s*not:\s*null\s*\}\s*\},\s*data:/.test(code) &&
    /if\s*\(updated\.count\s*!==\s*group\.ids\.length\)\s*\{\s*throw\s+new\s+BookingRequestError\(/.test(code);
}

/**
 * The whole of this feature, as files.
 *
 * #4344 RETIRED FIVE: the settle screen's unpriced-night fields, #3214's
 * booking-page controls, its route and its strand-reconcile module, and the
 * queue loader that fed the settle screen. They were deleted with the officer
 * review (wave C1 of #4302); `retired-edit-review-screens-census.test.ts` keeps
 * them gone. What is left is the rule, its plan and its writer - which the
 * completion door still runs until wave C3 - and the re-base module, which is
 * the most natural place to "work the rest out" from a total.
 */
const FEATURE_FILES = [
  "lib/stored-night-price-repair.ts",
  "lib/stored-night-price-repair-store.ts",
  // #3498: the reads and the checks moved here when one work item started
  // covering the whole parked edit. It is where "which strands may be filled in"
  // now lives, so it is exactly where a "work the rest out" branch would go.
  "lib/stored-night-price-repair-plan.ts",
  "lib/booking-review-price-rebase.ts",
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

describe("only one module may fill in a blank night price", () => {
  it("permits only the repair writer or the proven priced-only school and rate-derived updates", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      const code = stripCommentsAndStrings(readFileSync(file, "utf8"));
      // `bookingGuestNight.update`, `.updateMany` and `.upsert` - every way an
      // EXISTING row's price can be rewritten - and the SINGULAR `.create`,
      // which #3214 made a first-class way to put a number on a night: its
      // strand reconcile created the row for a night the strand held only
      // through its stay envelope (retired by #4344; the writer keeps the arm). Until that arm existed every create in the
      // tree was a `createMany`, so excluding creates wholesale was sound. It is
      // not any more, and a scan that cannot see the new shape stays green while
      // the rule is broken - a new module could write
      // `bookingGuestNight.create({ data: { priceCents: <derived> } })` in a
      // file that is not in `FEATURE_FILES`, so neither census would see it.
      //
      // `createMany` is still excluded, and the trailing `\b` is what keeps the
      // two apart: those writers compose a whole night set from a priced
      // breakdown and are governed by `nightPriceCentsToWrite` and
      // `required-price-cents.ts`. Singular `bookingGuestNight.create` appears
      // in exactly one non-test file today - the repair writer - so widening
      // this needs no exemption.
      if (
        !/bookingGuestNight\s*\.\s*(update|updateMany|upsert|create)\b/.test(
          code,
        )
      ) {
        continue;
      }
      const rel = relative(SRC, file).split("\\").join("/");
      if (rel === REPAIR_WRITER) continue;
      if (rel === PRICED_SCHOOL_WRITER && isPricedSchoolNightWriter(code)) continue;
      if (rel === RATE_DERIVED_WRITER && isPricedRateDerivedNightWriter(code)) continue;
      offenders.push(rel);
    }
    expect(
      offenders,
      `INV-MOD-028: a NULL BookingGuestNight.priceCents may only be filled in by a person supplying the amount, and ${REPAIR_WRITER} is the only writer that does. These modules also put a price on a night row one at a time - rewriting an existing row, or creating one: ${offenders.join(", ")}`,
    ).toEqual([]);
  }, CENSUS_TIMEOUT_MS);

  it("mutation-proves the school exception requires exact ids, non-NULL prices and full-count rollback", () => {
    const code = stripCommentsAndStrings(readFileSync(join(SRC, PRICED_SCHOOL_WRITER), "utf8"));
    expect(isPricedSchoolNightWriter(code)).toBe(true);
    expect(isPricedSchoolNightWriter(code.replace("priceCents: { not: null }", "priceCents: null"))).toBe(false);
    expect(isPricedSchoolNightWriter(code.replace("id: { in: group.ids }", "id: { not: null }"))).toBe(false);
    expect(isPricedSchoolNightWriter(code.replace("updated.count !== group.ids.length", "false"))).toBe(false);
    expect(isPricedSchoolNightWriter(`${code}\nawait tx.bookingGuestNight.update({});`)).toBe(false);
  });

  it("mutation-proves the rate-derived exception requires the price fence and the race refusal", () => {
    const code = stripCommentsAndStrings(readFileSync(join(SRC, RATE_DERIVED_WRITER), "utf8"));
    expect(isPricedRateDerivedNightWriter(code)).toBe(true);
    // A fence on `null` - or no price fence at all - would let it fill a blank.
    expect(isPricedRateDerivedNightWriter(code.replace("priceCents: night.fromPriceCents", "priceCents: null"))).toBe(false);
    expect(isPricedRateDerivedNightWriter(code.replace("priceCents: night.fromPriceCents,", ""))).toBe(false);
    expect(isPricedRateDerivedNightWriter(code.replace("written.count !== 1", "false"))).toBe(false);
    expect(isPricedRateDerivedNightWriter(`${code}\nawait store.bookingGuestNight.create({});`)).toBe(false);
  });

  it("the repair writer really is one of the files on disk", () => {
    // THE CONTROL for the assertion above. An allowlist naming a file that has
    // been renamed away would make that census pass by having nothing to find.
    const all = sourceFiles().map((file) =>
      relative(SRC, file).split("\\").join("/"),
    );
    for (const file of [...FEATURE_FILES, RATE_DERIVED_WRITER]) {
      expect(all).toContain(file);
    }
    const code = stripCommentsAndStrings(
      readFileSync(join(SRC, REPAIR_WRITER), "utf8"),
    );
    expect(code).toMatch(/bookingGuestNight\s*\.\s*updateMany\b/);
    // The create arm as well, so a census widened to see singular creates
    // cannot be left pointing at a writer that no longer has one - which would
    // make the widening pass by having nothing to find, exactly as a stale
    // allowlist entry would.
    expect(code).toMatch(/bookingGuestNight\s*\.\s*create\b/);
  }, CENSUS_TIMEOUT_MS);
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

  it("lets only this feature reach the figure a remainder fill would need", () => {
    /*
      THE MODULE-BOUNDARY HALF, and the reason the file boundary is not the
      whole answer. Scanning this file whole stops arithmetic being added
      anywhere inside it; it does not stop it being lifted one MODULE out.
      A remainder fill needs exactly one value - what the blanks have
      to come to - and `unpricedNightTargetCents` is the single definition of it
      (there is no second one: this census's division pattern would fail on a
      re-derivation written inside the feature).

      So the reference itself is fenced. A helper in a new module cannot get the
      target without naming this function, and naming it outside the feature files
      below fails here with its own file name.
    */
    const allowed = new Set(FEATURE_FILES);
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      const code = stripCommentsAndStrings(readFileSync(file, "utf8"));
      if (!/\bunpricedNightTargetCents\b/.test(code)) continue;
      const rel = relative(SRC, file).split("\\").join("/");
      if (allowed.has(rel)) continue;
      offenders.push(rel);
    }
    expect(
      offenders,
      `INV-MOD-028: only this feature may read what the unpriced nights have to come to. A module that knows that figure can subtract the officer's typing from it and fill the last box in, which is the derivation no source pattern here can see. These modules reference it: ${offenders.join(", ")}`,
    ).toEqual([]);
    // THE CONTROL for the allowlist: the feature really does reference it, so a
    // rename that emptied the scan would fail here rather than pass quietly.
    expect(
      stripCommentsAndStrings(
        readFileSync(join(SRC, "lib/stored-night-price-repair.ts"), "utf8"),
      ),
    ).toMatch(/\bunpricedNightTargetCents\b/);
  }, CENSUS_TIMEOUT_MS);

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
