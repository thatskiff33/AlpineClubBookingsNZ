import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Comments are stripped before the scan, in both directions: a docblock that
// QUOTES the rule in prose — several of them do, and should — must not be read
// as a second implementation, and no wording may hide a real one.
import { stripComments } from "./support/strip-comments";

/**
 * Census: "which membership types carry their own hut rates" is written once
 * (`INV-MOD-007`, `INV-SSOT-001`, #2933).
 *
 * The rule has one exception and that is the whole trouble with it. Rate-bearing
 * means `bookingBehavior === "MEMBER_RATE"` **or** the built-in `NON_MEMBER`
 * key, because `NON_MEMBER` carries `NON_MEMBER_RATE` like `ASSOCIATE` and
 * `SCHOOL` do and is nonetheless the type every non-member guest prices from. A
 * reader who drops the exception gets a rule that is right about six of the
 * eight built-in types, and wrong about the one an ordinary public booking hits.
 *
 * That is not hypothetical. Before #2933 the setup-readiness snapshot asked the
 * database for `MEMBER_RATE` types alone, so a season with no Non-Member rates
 * raised no warning anywhere — the club found out when a booking was refused.
 * Seven copies of one sentence, and the copy furthest from the others was the
 * one that had drifted.
 *
 * ## What this census holds, and what it does not
 *
 * It is a SOURCE-TEXT scan over `src/`, excluding `__tests__`, over
 * comment-stripped source. It fails any production file outside the canonical
 * module that spells the disjunction inline — the exact shape every one of the
 * seven copies had. That is the shape a reader reaches for when they want the
 * rule and do not know there is a function for it.
 *
 * It does NOT prove the rule is asked correctly wherever it is asked. A Prisma
 * `where` clause naming `bookingBehavior: "MEMBER_RATE"` and omitting the
 * exception is exactly the defect this issue fixed, and it matches no pattern
 * here because a filter that simply LEAVES OUT the exception looks like any
 * other narrow query. Nor can a text scan follow a boolean computed in one file
 * and passed through three others. It closes the copy-the-sentence door; the
 * function's own tests, in `membership-type-rate-coverage.test.ts`, are what say
 * the rule is right.
 *
 * `prisma/seed.ts` is deliberately not converted and deliberately not scanned.
 * Its fan-out asks a DIFFERENT question — not "does this type owe rows" but
 * "which of the two seeded rate sets does it get" — and is written as an
 * `if (MEMBER_RATE) … else if (NON_MEMBER) …` dispatch. Routing it through the
 * predicate would collapse a two-way choice into a boolean and lose the answer.
 */

const SRC_ROOT = path.resolve(process.cwd(), "src");

/** The one module allowed to spell the rule. */
const CANONICAL_MODULE = "src/lib/membership-type-rate-coverage.ts";

/**
 * The inline disjunction, in either order, tolerant of whitespace and of the
 * few characters that separated the two halves at the sites that had it:
 * `type.bookingBehavior === "MEMBER_RATE" || type.key === "NON_MEMBER"`, and
 * the `membershipTypeKey === "NON_MEMBER"` spelling two config-transfer
 * categories used. The bounded gap is what keeps it a scan for ONE expression
 * rather than for two unrelated comparisons that happen to share a file.
 */
const INLINE_RULE_PATTERNS = [
  /===\s*"MEMBER_RATE"\s*\|\|[^;{}]{0,120}?===\s*"NON_MEMBER"/,
  /===\s*"NON_MEMBER"\s*\|\|[^;{}]{0,120}?===\s*"MEMBER_RATE"/,
];

function allSourceFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "__tests__" ? [] : allSourceFiles(absolute);
    }
    return /\.(ts|tsx)$/.test(entry.name) ? [absolute] : [];
  });
}

function repoRelative(absolute: string): string {
  return path.relative(process.cwd(), absolute).split(path.sep).join("/");
}

describe("INV-MOD-007: the rate-bearing rule is spelled once (#2933)", () => {
  it("finds the canonical module, so the scan cannot pass vacuously", () => {
    // Without this, moving or renaming the module would leave every assertion
    // below trivially green: nothing spells the rule inline, because nothing
    // spells it at all.
    const source = fs.readFileSync(
      path.resolve(process.cwd(), CANONICAL_MODULE),
      "utf8",
    );
    expect(
      source.includes("export function isRateBearingMembershipType"),
      `${CANONICAL_MODULE} no longer exports isRateBearingMembershipType. It is the one home of INV-MOD-007; if it moved, move this census with it rather than letting the comparison quietly stop happening.`,
    ).toBe(true);
  });

  it("finds no inline copy of it anywhere else under src/", () => {
    const offenders = allSourceFiles(SRC_ROOT)
      .map(repoRelative)
      .filter((file) => file !== CANONICAL_MODULE)
      .filter((file) => {
        const source = stripComments(
          fs.readFileSync(path.resolve(process.cwd(), file), "utf8"),
        );
        return INLINE_RULE_PATTERNS.some((pattern) => pattern.test(source));
      });

    expect(
      offenders,
      `These files spell "which membership types carry their own hut rates" themselves. That rule is INV-MOD-007 and it has ONE home: import isRateBearingMembershipType, requiresHutRates or selectTypesRequiringHutRates from "@/lib/membership-type-rate-coverage". Seven copies of this sentence existed before #2933 and the one furthest from the others had already dropped the NON_MEMBER exception, which is the type every non-member guest prices from. Offenders: ${offenders.join(", ")}`,
    ).toEqual([]);
  });
});
