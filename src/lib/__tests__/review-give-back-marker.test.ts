/**
 * The census tells a review's give-back from every other applied-credit row by
 * ONE marker: a `BOOKING_APPLIED` row that names its booking as
 * `sourceBookingId` (#3791's `reviewGiveBackRowsWhere`, read by
 * `booking-ledger-projection-census-review-adjustments.ts`, #3583). The
 * clamp's give-back goes through the same `giveBackAppliedCredit` without it.
 * A writer that set the marker on another applied row would make the census
 * count that row as a review's give-back, so every place one could is pinned
 * here: a source scan of each `memberCredit` write and `giveBackAppliedCredit`
 * call whose arguments mention both, named by the function it sits in. A
 * write that builds its `type` from a variable is outside what a scan can see.
 *
 * #3835 added the third (#3907): `giveBackCancelledShareCredit`, the credit
 * part of a review completed after a cancellation on a captured payment. Its
 * rows ARE a review's give-back, and the census reads them so: on a cancelled
 * booking a stand-in is made of its task's own refund (card debt or
 * hand-back) plus a give-back row and any credit minted beside it, each row
 * used once (`booking-ledger-projection-census-review-adjustments.ts`).
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

import { balancedBrackets } from "./support/balanced-brackets";
import { blankLiterals } from "./support/strip-comments";

const ROOT = join(__dirname, "..", "..", "..");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "__tests__" ? [] : sourceFiles(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

/** The name of the last function declared before `index`: the one a call sits in. */
function enclosingFunction(text: string, index: number): string {
  const declared = [...text.slice(0, index).matchAll(/function (\w+)/g)];
  return declared[declared.length - 1]?.[1] ?? "(top level)";
}

/** The balanced `( … )` that opens at `start`. */
function argumentsAt(text: string, start: number, structure: string): string {
  return balancedBrackets(text, start, structure).text;
}

describe("only a review's give-back marks an applied-credit row with its source booking (#3791, #3583)", () => {
  it("is set by the give-back writer for the review route alone", () => {
    const marked: string[] = [];
    for (const file of sourceFiles(join(ROOT, "src"))) {
      const text = readFileSync(file, "utf8");
      if (!text.includes("memberCredit.") && !text.includes("giveBackAppliedCredit")) continue;
      // Call sites are found over masked text: one named in a comment or string
      // is not a call and has no opening bracket to read.
      const structure = blankLiterals(text);
      for (const match of structure.matchAll(/(?<!function )(memberCredit\.(?:create|createMany|upsert|update|updateMany)|giveBackAppliedCredit)\s*\(/g)) {
        const args = argumentsAt(text, (match.index ?? 0) + match[0].length - 1, structure);
        const write = match[1] ?? "";
        if (args.includes("sourceBookingId") && (write === "giveBackAppliedCredit" || args.includes("BOOKING_APPLIED"))) {
          marked.push(`${relative(ROOT, file)} ${enclosingFunction(text, match.index ?? 0)} ${write}`);
        }
      }
    }
    expect(marked.sort()).toEqual([
      // #3835: the credit part of a captured payment's share after a cancellation.
      "src/lib/edit-financial-review-account-credit.ts giveBackCancelledShareCredit giveBackAppliedCredit",
      // #3791: the account-credit route's give-back.
      "src/lib/edit-financial-review-account-credit.ts writeEditReviewAccountCredit giveBackAppliedCredit",
      // The give-back writer itself, which sets it only when handed one.
      "src/lib/member-credit.ts giveBackAppliedCredit memberCredit.create",
    ]);
  });
});
