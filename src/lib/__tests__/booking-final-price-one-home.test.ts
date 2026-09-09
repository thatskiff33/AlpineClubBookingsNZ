import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

// `INV-SSOT-004`: the ONE comment/string stripper in the tree, imported rather
// than written again. This repository documents defects at the site it removed
// them from, so the modules that describe this relation at length are exactly
// the ones a raw-text scanner would misfire on.
import { stripCommentsAndStrings } from "@/lib/__tests__/support/strip-comments";

/**
 * #3260 (`INV-SSOT-001`): a booking's final price is its total plus its signed
 * promotional adjustment, and that sentence has ONE home -
 * `bookingFinalPriceCents` in `src/lib/booking-final-price.ts`.
 *
 * ## Why a source census rather than only behaviour tests
 *
 * The relation was written out inline at TWELVE sites when #3260 measured it,
 * nine of which write the result to a booking row. Nothing was wrong: the twelve
 * agreed. A behaviour test can prove that today's writers agree; it cannot stop
 * a thirteenth being written next year, and the failure mode is a booking whose
 * stored final price disagrees with its own total, surfacing in reporting and
 * reconciliation long after the change that caused it.
 *
 * ## The thing a careless sweep would break, pinned here
 *
 * FOUR of the sites are ternaries whose PARKED branch writes the booking's
 * STORED final price back rather than recomputing it, and each carries a comment
 * saying why deriving there would be wrong: `priceDiffCents` is the number every
 * settlement decision reads, and on a parked edit it must be zero because the
 * booking did not move, not because two expressions happened to cancel. #3260
 * measured three; `src/app/api/bookings/[id]/guests/route.ts` became the fourth
 * when #3166 parked the add path, which is why this test counts them from the
 * tree instead of restating a number.
 *
 * Converting those branches would be the contortion `INV-SSOT-001` warns
 * against. The second test below is what refuses it.
 */

const SRC_ROOT = resolve(__dirname, "..", "..");

/**
 * The relation's one home. It is the only file allowed to spell the addition
 * out, because it IS the spelling.
 */
const ONE_HOME = "lib/booking-final-price.ts";

/**
 * `x*TotalPriceCents + y*PromoAdjustmentCents`, in either order, with any
 * amount of whitespace (including newlines) between the parts - the tree writes
 * this relation broken across lines as often as on one.
 */
const TOTAL = String.raw`[A-Za-z0-9_.]*[tT]otalPriceCents`;
const ADJUSTMENT = String.raw`[A-Za-z0-9_.]*(?:[pP]romoAdjustmentCents|[pP]riceAdjustmentCents)`;
const INLINE_RELATION = new RegExp(
  String.raw`(?:${TOTAL}\s*\+\s*${ADJUSTMENT})|(?:${ADJUSTMENT}\s*\+\s*${TOTAL})`,
  "g",
);

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "node_modules") continue;
      found.push(...sourceFiles(full));
      continue;
    }
    if (!/\.tsx?$/.test(entry.name)) continue;
    if (/\.test\.tsx?$/.test(entry.name)) continue;
    found.push(full);
  }
  return found;
}

describe("INV-SSOT-001: one home for a booking's final-price relation", () => {
  it("nothing outside booking-final-price.ts spells the relation out inline", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC_ROOT)) {
      const rel = relative(SRC_ROOT, file).replaceAll("\\", "/");
      if (rel === ONE_HOME) continue;
      const code = stripCommentsAndStrings(readFileSync(file, "utf8"));
      for (const match of code.matchAll(INLINE_RELATION)) {
        offenders.push(`src/${rel}: ${match[0].replace(/\s+/g, " ")}`);
      }
    }
    expect(
      offenders,
      [
        "INV-SSOT-001: a booking's final price is its total plus its signed",
        "promotional adjustment, and that relation has ONE home -",
        "`bookingFinalPriceCents` in src/lib/booking-final-price.ts. Call it",
        "instead of writing the addition out again. If your site deliberately",
        "writes the booking's STORED figure back on a parked branch, keep that",
        "branch exactly as it is and call the helper on the computed branch only.",
        "",
        "WHAT THIS CENSUS CANNOT SEE, said here so a green run is not read as",
        "more than it is (`INV-SSOT-004`): it matches the two column names in",
        "ONE expression, so a relation assembled through local `const`s, a Prisma",
        "`{ increment }`, or any other indirection passes it. It reads `src/`",
        "only - `scripts/` and `prisma/` are outside it entirely. A green run",
        "means no INLINE thirteenth spelling, not that the relation has one home.",
        "",
        "Found:",
        ...offenders,
      ].join("\n"),
    ).toEqual([]);
  });

  it("the parked-branch ternaries still write the booking's stored figure back", () => {
    // Each of these composes the two halves the helper must NOT swallow: one
    // branch calls `bookingFinalPriceCents`, the other hands back
    // `booking.finalPriceCents` as stored. A sweep that "finished the job" by
    // converting the second half would make `priceDiffCents` non-zero on a
    // parked edit, which is the whole reason those branches exist.
    const parkedTernaries = [
      "app/api/bookings/[id]/guests/route.ts",
      "lib/booking-batch-modification-service.ts",
      "lib/booking-date-modification-service.ts",
      "lib/booking-guest-removal-service.ts",
    ];
    for (const rel of parkedTernaries) {
      const code = stripCommentsAndStrings(
        readFileSync(join(SRC_ROOT, rel), "utf8"),
      );
      const ternary = new RegExp(
        String.raw`newFinalPriceCents\s*=\s*[^;]*\?[^;]*:[^;]*;`,
      ).exec(code);
      expect(
        ternary,
        `src/${rel} no longer computes newFinalPriceCents through a ternary; the parked branch must still exist (INV-SSOT-001, #3260)`,
      ).not.toBeNull();
      const expression = ternary![0];
      expect(
        expression.includes("booking.finalPriceCents"),
        `src/${rel} must still write the booking's STORED finalPriceCents on its parked branch — see src/lib/booking-final-price.ts (#3260)`,
      ).toBe(true);
      expect(
        expression.includes("bookingFinalPriceCents("),
        `src/${rel} must compute its other branch through bookingFinalPriceCents (INV-SSOT-001, #3260)`,
      ).toBe(true);
    }
  });
});
