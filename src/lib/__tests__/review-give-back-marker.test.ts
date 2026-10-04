/**
 * The census tells a review's give-back from every other applied-credit row by
 * ONE marker: a `BOOKING_APPLIED` row that names its booking as
 * `sourceBookingId` (#3791's `reviewGiveBackRowsWhere`, read by
 * `booking-ledger-projection-census-review-adjustments.ts`, #3583). The
 * clamp's give-back goes through the same `giveBackAppliedCredit` without it.
 * A writer that set the marker on another applied row would make the census
 * count that row as a review's give-back, so every place one could is pinned
 * here: a source scan of each `memberCredit` write and `giveBackAppliedCredit`
 * call whose arguments mention both. A write that builds its `type` from a
 * variable is outside what a scan can see.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..", "..");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "__tests__" ? [] : sourceFiles(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

/** The balanced `( … )` that opens at `start`. */
function argumentsAt(text: string, start: number): string {
  let depth = 0;
  for (let index = start; index < text.length; index += 1) {
    if (text[index] === "(") depth += 1;
    else if (text[index] === ")" && (depth -= 1) === 0) return text.slice(start, index + 1);
  }
  return text.slice(start);
}

describe("only a review's give-back marks an applied-credit row with its source booking (#3791, #3583)", () => {
  it("is set by the give-back writer for the review route alone", () => {
    const marked: string[] = [];
    for (const file of sourceFiles(join(ROOT, "src"))) {
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(/(?<!function )(memberCredit\.(?:create|createMany|upsert|update|updateMany)|giveBackAppliedCredit)\s*\(/g)) {
        const args = argumentsAt(text, (match.index ?? 0) + match[0].length - 1);
        const write = match[1] ?? "";
        if (args.includes("sourceBookingId") && (write === "giveBackAppliedCredit" || args.includes("BOOKING_APPLIED"))) {
          marked.push(`${relative(ROOT, file)} ${write}`);
        }
      }
    }
    expect(marked.sort()).toEqual([
      // The review route's call (`writeEditReviewAccountCredit`).
      "src/lib/edit-financial-review-account-credit.ts giveBackAppliedCredit",
      // The give-back writer itself, which sets it only when handed one.
      "src/lib/member-credit.ts memberCredit.create",
    ]);
  });
});
