import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

import { stripComments } from "@/lib/__tests__/support/strip-comments";
import { CENSUS_TIMEOUT_MS } from "@/test/census-timeout";

/**
 * `calculateChangeFee` is the tier math. The late-notice gate
 * (`lateNoticeChangeFee`) is its only production caller, so a door cannot
 * charge the fee and forget whether the booking has been paid.
 */
const LEAF = "src/lib/late-notice-change-fee.ts";
const CALL = /(?<!function\s)calculateChangeFee\s*\(/;

function productionSources(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "__tests__" || entry.name === "node_modules") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) productionSources(full, found);
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) found.push(full);
  }
  return found;
}

describe("calculateChangeFee has one production caller", () => {
  it("is called only from the late-notice leaf", () => {
    const callers = productionSources(join(process.cwd(), "src"))
      .filter((file) => CALL.test(stripComments(readFileSync(file, "utf8"))))
      .map((file) => relative(process.cwd(), file).split("\\").join("/"))
      .sort();
    expect(callers).toEqual([LEAF]);
  }, CENSUS_TIMEOUT_MS);
});

/**
 * #5039 (`INV-MOD-042`): the fee an edit charges is added to `Payment.changeFeeCents`
 * once. An ordinary edit's is added by its one payment write
 * (`writeEditOnPayment`, the claim module); a finished-stay correction's by the
 * pair that records it on the amount owed. A new incrementer is a second
 * writer, and the place a fee gets recorded twice or not at all.
 */
const FEE_INCREMENT = /changeFeeCents\s*:\s*\{\s*increment\b/;

describe("the payment's change fee has one writer per kind of edit", () => {
  it("is incremented only by the edit's claim and the finished-stay pair", () => {
    const writers = productionSources(join(process.cwd(), "src"))
      .filter((file) => FEE_INCREMENT.test(stripComments(readFileSync(file, "utf8"))))
      .map((file) => relative(process.cwd(), file).split("\\").join("/"))
      .sort();
    expect(writers).toEqual([
      "src/lib/booking-finished-stay-correction.ts",
      "src/lib/booking-primary-invoice-claim.ts",
      "src/lib/change-fee-owed.ts",
    ]);
  }, CENSUS_TIMEOUT_MS);
});

/**
 * #5039 review (`INV-SSOT`): both fee-charging edit doors clamp credit against
 * the same fee - the payment's before the edit plus this edit's own. The two
 * copies of that sum drifted once (the date door left this edit's fee out), so
 * each door must read the one home rather than add the figures itself.
 */
describe("both edit doors clamp credit against one fee figure", () => {
  it.each([
    "src/lib/booking-modify-settlement.ts",
    "src/lib/booking-date-modification-service.ts",
  ])("%s reads feeOwedAfterEditCents", (file) => {
    const source = stripComments(readFileSync(join(process.cwd(), file), "utf8"));
    expect(source).toMatch(/feeOwedAfterEditCents\(booking\.payment,/);
    expect(source).not.toMatch(/recordedChangeFeeCents\([^)]*\)\s*\+/);
  });
});
