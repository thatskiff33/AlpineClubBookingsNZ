/**
 * `computeAgeTier` is never called without its reference date (CT-4 group F1,
 * #2870, correctness review).
 *
 * ## Why this is a source census and not an ordinary test
 *
 * The parameter is REQUIRED, so the typechecker already refuses a one-argument
 * call — and that means a mutation which makes it optional again cannot be killed
 * by any behavioural test: no caller omits the argument, so the reintroduced
 * fallback is unreachable at runtime. Measured: re-adding the optional parameter
 * SURVIVED every suite. A guarantee whose only enforcement is `npm run typecheck`
 * is a guarantee that disappears the moment somebody widens the signature "just for
 * this one caller", which is precisely how the original default arrived.
 *
 * So the property is checked where it can be seen: over the source.
 *
 * ## What the default cost, which is why it is gone
 *
 * `referenceDate` used to default to the start of the club's CURRENT season, which
 * meant resolving the club's persisted timezone — an uncached `ClubTimeSettings`
 * read on the global Prisma client, behind a dynamic import — from whichever call
 * site omitted it. Three did, and every one was somewhere it should not have been:
 *
 *  - `nomination.ts`'s `computeTier`, inside `approveMemberApplication`'s
 *    transaction, which holds `pg_advisory_xact_lock('member-application:<id>')`
 *    plus one `member-lifecycle:<memberId>` lock per MAP target — and called again
 *    per family member;
 *  - `xero-member-import.ts`'s `resolveNewMemberAgeTier`, inside the import's
 *    nested loops, so a first import of a few hundred contacts made a query per
 *    row;
 *  - `joining-fee.ts`'s input preview, the last one-argument site in the tree.
 *
 * Each of those callers ALREADY held the club's season for something else, so the
 * default was also a straddle: one request could judge an age tier — and therefore
 * a price band — in a different season from the assignment it wrote beside it.
 *
 * ## Its blind spot, stated
 *
 * It reads text, so it cannot see a call assembled through a variable
 * (`const f = computeAgeTier; await f(dob)`) or a re-export under another name.
 * Nothing in this tree does either, and the typechecker covers both; this census
 * exists for the case where the signature itself is widened.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const SRC = path.join(process.cwd(), "src");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
    } else if (/\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * `computeAgeTier(` up to the matching close paren, brace- and paren-balanced, so a
 * multi-line call and a nested call in the first argument both read correctly.
 */
function callArgumentLists(code: string): string[] {
  const calls: string[] = [];
  const needle = "computeAgeTier(";
  let from = 0;
  for (;;) {
    const at = code.indexOf(needle, from);
    if (at === -1) break;
    from = at + needle.length;
    // Skip `computeAgeTierWithSettings(`, a different function with its own rules.
    if (code.startsWith("computeAgeTierWithSettings(", at)) continue;
    // Skip a declaration rather than a call.
    const before = code.slice(Math.max(0, at - 30), at);
    if (/function\s+$/.test(before)) continue;
    let depth = 1;
    let i = from;
    for (; i < code.length && depth > 0; i += 1) {
      const ch = code[i];
      if (ch === "(") depth += 1;
      else if (ch === ")") depth -= 1;
    }
    calls.push(code.slice(from, i - 1));
  }
  return calls;
}

/** Top-level commas only — a nested call's own commas do not separate arguments. */
function countArguments(argumentList: string): number {
  if (argumentList.trim() === "") return 0;
  let depth = 0;
  let count = 1;
  for (const ch of argumentList) {
    if (ch === "(" || ch === "[" || ch === "{") depth += 1;
    else if (ch === ")" || ch === "]" || ch === "}") depth -= 1;
    else if (ch === "," && depth === 0) count += 1;
  }
  return count;
}

describe("computeAgeTier always receives an explicit reference date (#2870)", () => {
  const files = walk(SRC).filter(
    (file) =>
      !file.includes(`${path.sep}__tests__${path.sep}`) &&
      !/\.test\.tsx?$/.test(file) &&
      !file.endsWith(path.join("lib", "age-tier.ts")),
  );

  it("finds no call site that omits it", () => {
    const offenders: string[] = [];
    let callsSeen = 0;

    for (const file of files) {
      const code = readFileSync(file, "utf8");
      if (!code.includes("computeAgeTier(")) continue;
      for (const argumentList of callArgumentLists(code)) {
        callsSeen += 1;
        if (countArguments(argumentList) < 2) {
          offenders.push(
            `${path.relative(process.cwd(), file)}: computeAgeTier(${argumentList.trim().slice(0, 60)})`,
          );
        }
      }
    }

    // NON-VACUOUS. The parser has to have found real calls, or "no offenders" would
    // mean "the scan matched nothing" — which is how a census passes while the rule
    // it protects is broken.
    expect(callsSeen, "the scan found no computeAgeTier calls at all").toBeGreaterThan(5);
    expect(
      offenders,
      "computeAgeTier must be given the season start to judge the date of birth " +
        "against. Omitting it used to resolve the club's timezone from the database " +
        "on the global client — see this file's header for the three places that " +
        "reached it from inside a lock or a loop. Pass " +
        "getSeasonStartDate(seasonYear) from a season the caller resolved once.",
    ).toEqual([]);
  });

  it("no longer reaches a club-zone reader from the age-tier module at all", () => {
    // The other half of the same property: with the default gone, `age-tier.ts` has
    // no business resolving the club's zone, statically or dynamically. Its dynamic
    // `./prisma` import stays — that is the settings read, and it predates this lane.
    const code = readFileSync(path.join(SRC, "lib", "age-tier.ts"), "utf8");
    // The IMPORTS, not the prose: the module still explains in a comment where a
    // caller asking "what season is it now" should go, and it should keep doing so.
    const imports = [...code.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
    expect(imports).not.toContain("@/lib/club-time-zone-runtime");
    expect(imports).not.toContain("./club-time-zone-runtime");
    expect(imports).not.toContain("@/lib/financial-year");
    expect(imports).not.toContain("./financial-year");
    // Non-vacuous: the module is still the one under test, and the scan found its
    // real imports rather than nothing.
    expect(code).toContain("export async function computeAgeTier");
    expect(imports.length).toBeGreaterThan(1);
  });
});
