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
 * So this file asks three questions of the tree itself:
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
 *     remove. "This feature" means the three feature files AND the whole of the
 *     settle screen, minus one published five-line money-display exemption -
 *     see `SCOPED_FILE` for what a marked night-price REGION was measured to be
 *     worth instead.
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
 * the spelling. (The last of those three is what question 3 above closes: the
 * helper can still be written, but it cannot get the target.)
 *
 * So that half is a BEHAVIOUR test and not a regex:
 * `manual-refund-task-queue-financial-review.test.tsx` -> "no control on this
 * screen fills a box in, and nothing it posts carries a night nobody typed".
 * WHAT THAT TEST COVERS, EXACTLY, because an earlier draft of this paragraph
 * overstated it and a review lens disproved it by building the thing and
 * watching it pass: it fills every night but one on the real settle dialog,
 * CLICKS EVERY OTHER BUTTON IN THE DIALOG and re-asserts the boxes, then asserts
 * the confirm control is still disabled and that nothing was posted. So it
 * catches a fill driven by a control whatever that control is CALLED - the
 * earlier version matched button names against a regex, and a button reading
 * "Use the balance" passed both instruments - and it catches a fill that never
 * touches a box at all, by refusing to let the screen settle a set it completed
 * for the officer.
 *
 * WHAT IT STILL DOES NOT COVER, stated rather than left to be found: a fill on a
 * path that is not this dialog. That is what the scans below are for, and why
 * neither instrument can be dropped - this file catches a SECOND WRITER
 * appearing anywhere in the tree, and a reference to the target figure from
 * outside this feature, neither of which any behaviour test can see.
 *
 * `vitest related` cannot reach this file - it reads the tree from disk and has
 * no import edge to what it scans - so it is selected by name.
 */

const SRC = resolve(process.cwd(), "src");

/** The one module allowed to update an existing night row's price in place. */
const REPAIR_WRITER = "lib/stored-night-price-repair-store.ts";

/**
 * The whole of this feature, as files.
 *
 * #3214 ADDED THREE, and the reason each is here rather than merely nearby is
 * worth stating, because an entry nobody can justify is how this list turns into
 * habit:
 *
 *  - the strand-reconcile module is the second caller of the one writer and the
 *    home of the eligibility fence, so it is where a "work the rest out" helper
 *    would be most natural to write;
 *  - the booking-page controls MUST be here. They mirror the settle screen's
 *    unreadable-box branch, which names `unpricedNightTargetCents`, so without
 *    an entry that reference fails the last test in this file by name - and,
 *    more to the point, a "split it evenly" button would sit in this component;
 *  - the route is here by choice rather than by need. Nothing fails without it,
 *    because the route touches no `bookingGuestNight` model call and names no
 *    target figure. It costs one line and the route has to be arithmetic-free
 *    anyway, so the guarantee is extended rather than left to review.
 *
 * #3219 ADDED TWO, and one of them is why a path-hardcoded list is dangerous:
 *
 *  - the QUEUE module is the summary loader that #3219 SPLIT OUT of the repair
 *    store. Those lines were scanned before the split and would have stopped
 *    being scanned after it, with nothing recording the change - which is the
 *    whole failure mode of naming files by path. A move must bring its entry
 *    with it;
 *  - the RE-BASE module writes the booking's four money columns from the
 *    strands. It runs no derivation - all five patterns below were measured
 *    over it at zero hits, and it needs no exemption - and it is the most
 *    natural place in the feature for somebody to "work the rest out" from a
 *    total, so the guarantee is extended over it rather than left to review.
 */
const FEATURE_FILES = [
  "lib/stored-night-price-repair.ts",
  "lib/stored-night-price-repair-store.ts",
  "lib/stored-night-price-repair-queue.ts",
  "lib/stored-night-price-strand-reconcile.ts",
  "lib/booking-review-price-rebase.ts",
  "components/admin/unpriced-night-price-fields.tsx",
  "components/admin/booking-stored-night-price-controls.tsx",
  "app/api/admin/bookings/[id]/stored-night-prices/route.ts",
];

/**
 * The settle screen. IT IS SCANNED WHOLE, minus one published exemption.
 *
 * It cannot simply join `FEATURE_FILES`: it also renders a task's own settled
 * amount as `task.amountCents / 100`, and the division pattern would fail on
 * money arithmetic that has nothing to do with a night price.
 *
 * IT USED TO BE THE OTHER WAY ROUND - a marked night-price REGION, and the
 * patterns run over that region alone - and a review lens measured what that
 * really bought: `const evenNightGuess = (n, d) => Math.round(n / d)` written
 * TWO LINES ABOVE the region marker, in the same component and callable from
 * inside it, passed the scan. A region control that only requires two strings to
 * appear inside it makes a split unwritable in about 70 of this file's 1530
 * lines, which is not what the rule says. So the exclusion is inverted: the
 * WHOLE file is scanned and a five-line exemption is cut out of it, which is a
 * published exclusion in the `INV-SSOT-001` sense and is bounded below.
 *
 * The cost is honest and is the reason the region existed: an unrelated division
 * or rounding added anywhere in this 1530-line component now fails an
 * `INV-MOD-028` census. That friction is the point - whoever adds one has to say
 * here that it is not a night-price derivation - and the failure message says so.
 */
const SCOPED_FILE = "components/admin/manual-refund-task-queue.tsx";
const EXEMPT_START = "MONEY-DISPLAY EXEMPTION START (stored-night-price-repair-census)";
const EXEMPT_END = "MONEY-DISPLAY EXEMPTION END (stored-night-price-repair-census)";

/**
 * How many lines of `SCOPED_FILE` may sit outside the scan, in total.
 *
 * A CAP RATHER THAN A LIST, so the exemption cannot quietly grow back into the
 * region it replaced. Five today; the ceiling leaves room for one more genuine
 * money-display conversion and nothing like room for a helper.
 */
const EXEMPT_LINE_BUDGET = 12;

/**
 * Is this line ENTIRELY a comment that also closes on it?
 *
 * Asked of the canonical stripper rather than by matching delimiters here, and
 * for two reasons. `INV-SSOT-004` bans a second scanner that reads comment
 * delimiters, which is what a regex for them would be. And the stripper's answer
 * is the one that matters: what this really needs to know is whether removing
 * the line can change how the REST of the file is read, and the only authority
 * on that is the thing that reads it.
 *
 * The sentinel is what makes an unterminated opener visible. A line holding one
 * blanks itself either way; it is the line BELOW that tells the two apart,
 * because an opener that never closes swallows it too.
 */
function isWholeCommentLine(line: string): boolean {
  const sentinel = "exemptionMarkerProbe";
  const [first, second] = stripCommentsAndStrings(`${line}\n${sentinel}`)
    .split("\n")
    .map((part) => part.trim());
  return first === "" && second === sentinel;
}

/**
 * `source` with the exempt regions removed, then stripped.
 *
 * The markers are COMMENTS, so they are found on the raw source and the result
 * is stripped afterwards - the other way round there would be nothing left to
 * find. WHOLE LINES go, from the line holding a START marker through the line
 * holding its END, and each marker is required to be a whole comment on a line
 * of its own: cutting the middle out of a block comment would leave its opener
 * behind and blank every line below it, which is the vacuous scan this census
 * exists to avoid. Blank lines replace what is removed so a reported line number
 * still points at the real line.
 *
 * Throws rather than returning nothing when the pairing is broken, for the same
 * reason.
 */
function scannedSource(source: string): { code: string; exemptLines: number } {
  const lines = source.split("\n");
  const kept: string[] = [];
  let exemptLines = 0;
  let inside = false;
  for (const [index, line] of lines.entries()) {
    const hasStart = line.includes(EXEMPT_START);
    const hasEnd = line.includes(EXEMPT_END);
    if (hasStart || hasEnd) {
      if (!isWholeCommentLine(line)) {
        throw new Error(
          `${SCOPED_FILE}:${index + 1}: a night-price census exemption marker must be a WHOLE comment on a line of its own. Cutting the middle out of a block comment leaves its opener behind and blanks the rest of the file, which passes this census by having nothing to scan.`,
        );
      }
    }
    if (hasStart) {
      if (inside) {
        throw new Error(
          `${SCOPED_FILE}:${index + 1}: a second ${EXEMPT_START} inside an open one. The night-price census cannot tell what it is meant to skip.`,
        );
      }
      inside = true;
    }
    if (inside) {
      exemptLines += 1;
      kept.push("");
    } else {
      kept.push(line);
    }
    if (hasEnd) {
      if (!inside) {
        throw new Error(
          `${SCOPED_FILE}:${index + 1}: an ${EXEMPT_END} with no matching START.`,
        );
      }
      inside = false;
    }
  }
  if (inside) {
    throw new Error(
      `${SCOPED_FILE}: an ${EXEMPT_START} marker has no matching END. The night-price census cannot tell what it is meant to skip.`,
    );
  }
  return { code: stripCommentsAndStrings(kept.join("\n")), exemptLines };
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
      // EXISTING row's price can be rewritten - and the SINGULAR `.create`,
      // which #3214 made a first-class way to put a number on a night: the
      // strand reconcile creates the row for a night the strand holds only
      // through its stay envelope. Until that arm existed every create in the
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
      offenders.push(rel);
    }
    expect(
      offenders,
      `INV-MOD-028: a NULL BookingGuestNight.priceCents may only be filled in by a person supplying the amount, and ${REPAIR_WRITER} is the only writer that does. These modules also put a price on a night row one at a time - rewriting an existing row, or creating one: ${offenders.join(", ")}`,
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
    // The create arm as well, so a census widened to see singular creates
    // cannot be left pointing at a writer that no longer has one - which would
    // make the widening pass by having nothing to find, exactly as a stale
    // allowlist entry would.
    expect(code).toMatch(/bookingGuestNight\s*\.\s*create\b/);
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

  it(`the whole of ${SCOPED_FILE} contains none either`, () => {
    const { code } = scannedSource(readFileSync(join(SRC, SCOPED_FILE), "utf8"));
    for (const { what, pattern } of DERIVATIONS) {
      expect(
        pattern.test(code),
        `INV-MOD-028: ${SCOPED_FILE} appears to contain ${what}. This file builds the entries posted to the server out of the officer's boxes, so it is where a "split it evenly" control would go - and nothing in it may produce a per-night amount, however far from the night-price code it is written. If this really is money arithmetic that no night price passes through, move it inside the published MONEY-DISPLAY EXEMPTION region and say there why.`,
      ).toBe(false);
    }
  });

  it("scans the whole file apart from a small, load-bearing exemption", () => {
    /*
      THE CONTROL, and it has four halves because the scoping can fail in four
      directions.

      An exemption that had SWALLOWED the file would pass the assertion above by
      having nothing left to scan, so the night-price code must still be in what
      is scanned and the exempt line count is capped. An exemption that excluded
      NOTHING would be habit rather than need, so what it removes has to be
      something the patterns would otherwise fire on. And the scan has to reach
      the END of the file: a cut that left a half-open comment delimiter behind
      would blank every line below it, which is the vacuous scan this census
      exists to avoid.
    */
    const raw = readFileSync(join(SRC, SCOPED_FILE), "utf8");
    const { code, exemptLines } = scannedSource(raw);
    expect(code).toContain("nightPriceEntries");
    expect(code).toContain("nightPricesBlocked");
    // Rendered six hundred lines below the night-price code, on the file's last
    // element: if the scan stops early, this is what says so. An identifier
    // rather than a `data-testid`, because the stripper blanks string contents.
    expect(code).toContain("<AutomaticRefundNoticesCard notices={autoRefunded}");
    expect(
      exemptLines,
      `INV-SSOT-001: ${SCOPED_FILE}'s night-price exemption may not grow past ${EXEMPT_LINE_BUDGET} lines. An exclusion that keeps widening is how a scan ends up aimed one file to the left of the risk.`,
    ).toBeLessThanOrEqual(EXEMPT_LINE_BUDGET);
    expect(exemptLines).toBeGreaterThan(0);
    // What is exempt really is something the patterns would fire on, so the
    // exclusion is load-bearing rather than habit.
    const whole = stripCommentsAndStrings(raw);
    expect(whole).toMatch(/amountCents\s*\/\s*100/);
    expect(code).not.toMatch(/amountCents\s*\/\s*100/);
  });

  it("refuses a region whose markers are not whole comments on their own lines", () => {
    // THE CONTROL for the delimiter rule. Removing whole lines out of the middle
    // of a block comment leaves its opener behind, and the stripper then blanks
    // everything below - a census that would pass by having nothing to read.
    expect(() =>
      scannedSource(
        [
          "const a = 1;",
          `  /* ${EXEMPT_START}`,
          "  const b = 2;",
          `  ${EXEMPT_END} */`,
        ].join("\n"),
      ),
    ).toThrow(/WHOLE comment on a line of its own/);
    expect(() =>
      scannedSource(`  /* ${EXEMPT_START} */\nconst a = 1;`),
    ).toThrow(/has no matching END/);
  });

  it("lets only this feature reach the figure a remainder fill would need", () => {
    /*
      THE OTHER HALF OF THE INVERTED SCAN, and the reason the file boundary is
      not the whole answer. Scanning this file whole stops the arithmetic being
      lifted one line out of a region; it does not stop it being lifted one
      MODULE out. A remainder fill needs exactly one value - what the blanks have
      to come to - and `unpricedNightTargetCents` is the single definition of it
      (there is no second one: this census's division pattern would fail on a
      re-derivation written inside the feature).

      So the reference itself is fenced. A helper in a new module cannot get the
      target without naming this function, and naming it outside the four files
      below fails here with its own file name.
    */
    const allowed = new Set([...FEATURE_FILES, SCOPED_FILE]);
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
      stripCommentsAndStrings(readFileSync(join(SRC, SCOPED_FILE), "utf8")),
    ).toMatch(/\bunpricedNightTargetCents\b/);
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
