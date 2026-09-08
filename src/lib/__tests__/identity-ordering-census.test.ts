import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { stripComments, stripCommentsAndStrings } from "./support/strip-comments";

/**
 * #3252 — an order that is part of an IDENTITY is ordered by code unit, in one
 * place, and never by `localeCompare`.
 *
 * ENFORCES `INV-SSOT-001` and `INV-EXCEPT-036`.
 *
 * ## Why a census and not review
 *
 * Both halves of this rule are invisible in a diff. A reviewer reading
 * `a.lastName.localeCompare(b.lastName)` sees ordinary, idiomatic code — it IS
 * ordinary and idiomatic everywhere a person reads the result — and the defect
 * is entirely in which side of the boundary the call sits on. And the rule was
 * already known here: three modules had each hand-rolled the ordinal comparator
 * with a docblock explaining why locale-aware comparison was wrong there, while
 * the proposal hash two files away still used `localeCompare`. Three correct
 * explanations and no shared helper is how that happens.
 *
 * ## READS `src/` FROM DISK, so `vitest related` cannot reach it
 *
 * There is no import edge from this file to the files it scans, so the module
 * graph cannot select it and a lane's targeted local run will not include it.
 * CI owns it. Run it by name (`npm run test:named`) when you touch a comparator
 * or an identity module.
 *
 * ## It STRIPS COMMENTS AND STRINGS BEFORE MATCHING, and must
 *
 * This repository documents a defect at the site it removed it, so every
 * docblock that forbids `localeCompare` says the word `localeCompare`. Matching
 * raw text would fire hardest on the files that are most correct. Strings are
 * blanked too, so a message or a fixture naming the symbol cannot trip it. The
 * stripper is the tree's ONE stripper (`INV-SSOT-004`); do not write a second
 * one here.
 *
 * ## What this census does NOT catch, stated rather than implied
 *
 * It matches the THREE-WAY comparator shape that `compareOrdinal` replaces. A
 * two-way form which never returns 0 is a different and separately dubious
 * construct, and several live in the tree on display paths; they are out of
 * scope here rather than silently covered. So this guard proves there is no
 * second copy of the comparator and no `localeCompare` inside a listed identity
 * module. It does not prove a NEW identity module gets added to the list — that
 * is on the author, and the list below is deliberately short enough to read.
 */

const REPO_ROOT = path.resolve(__dirname, "../../..");
const CANONICAL_MODULE = "src/lib/ordinal-order.ts";
const CANONICAL_SPECIFIER = "@/lib/ordinal-order";

/**
 * Every module whose sort order feeds a value that is STORED, HASHED, or
 * RE-DERIVED LATER AND COMPARED — plus one whose order is a lock-acquisition
 * sequence, where two writers disagreeing deadlock rather than mismatch.
 *
 * A path that does not exist FAILS the census rather than being skipped. That is
 * the fail-closed half: splitting or renaming a file is exactly how a
 * path-keyed guard goes quietly green (`docs/TESTING.md`).
 */
const IDENTITY_MODULES = [
  // The proposal fingerprint #3252 was filed about, and the frozen evidence and
  // violation orders that approval re-derives and compares.
  "src/lib/booking-exception-requests.ts",
  "src/lib/booking-policy-exceptions.ts",
  "src/lib/policies/adult-member-hosting.ts",
  "src/lib/adult-member-hosting-same-owner.ts",
  // The browser-side mutation signature, which is why the comparator lives in a
  // module that imports nothing.
  "src/lib/hosting-coverage-override-client.ts",
  // Xero member grouping: a stored dry-run digest, and the resume CURSOR, where
  // two chunks ordering differently would skip or reprocess members.
  "src/lib/xero-member-grouping-resync.ts",
  // Cross-request confirm tokens and plan digests.
  "src/lib/membership-subscription-billing.ts",
  "src/lib/induction-baseline.ts",
  "src/lib/admin-roster-service.ts",
  // The knowledge bundle's integrity digest, compared against bytes on disk.
  "src/lib/diagnostics/knowledge/generate.ts",
  // Advisory-lock acquisition ORDER.
  "src/lib/roster-lock.ts",
  // An API response order, and a pattern also written into migration SQL.
  "src/lib/hut-leader-coverage.ts",
  "src/lib/email-message-token-contract.ts",
] as const;

/** The three-way ordinal comparator, in any spacing, on any operands. */
const HAND_ROLLED_ORDINAL = /\?\s*-\s*1\s*:[\s\S]{0,120}?\?\s*1\s*:\s*0/;

function trackedSources(): string[] {
  return execFileSync("git", ["ls-files", "src"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  })
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.endsWith(".ts") || line.endsWith(".tsx"))
    .filter(
      (file) =>
        !file.includes("/__tests__/") &&
        !file.endsWith(".test.ts") &&
        !file.endsWith(".test.tsx"),
    );
}

function code(file: string): string {
  return stripCommentsAndStrings(
    readFileSync(path.join(REPO_ROOT, file), "utf8"),
  );
}

/**
 * Comments removed, STRINGS KEPT. Needed for the one check whose subject IS a
 * string literal — an import specifier. `code()` above blanks string contents,
 * which is right for every symbol check and useless for this one.
 */
function codeWithStrings(file: string): string {
  return stripComments(readFileSync(path.join(REPO_ROOT, file), "utf8"));
}

describe("identity ordering census (#3252)", () => {
  const sources = trackedSources();

  it("scans a real, non-trivial share of the tree", () => {
    // A census that silently scanned nothing would pass every assertion below.
    expect(sources.length).toBeGreaterThan(300);
    expect(sources).toContain(CANONICAL_MODULE);
  });

  it("holds ONE hand-rolled ordinal comparator, in its one home", () => {
    const offenders = sources.filter(
      (file) =>
        file !== CANONICAL_MODULE && HAND_ROLLED_ORDINAL.test(code(file)),
    );
    expect(
      offenders,
      "INV-SSOT-001: these files spell out the ordinal comparator instead of " +
        "importing compareOrdinal from " +
        CANONICAL_SPECIFIER +
        ". Three copies of this rule, each with its own docblock, is what " +
        "#3252 found.",
    ).toEqual([]);
    // And the home really contains it, so the assertion above is not vacuous.
    expect(HAND_ROLLED_ORDINAL.test(code(CANONICAL_MODULE))).toBe(true);
  });

  it("has no bare localeCompare in any identity module", () => {
    const missing = IDENTITY_MODULES.filter(
      (file) => !existsSync(path.join(REPO_ROOT, file)),
    );
    expect(
      missing,
      "This census is keyed on paths. A moved or split file must be re-listed " +
        "here, not dropped — a path that no longer exists is how a guard goes " +
        "quietly green.",
    ).toEqual([]);

    const offenders = IDENTITY_MODULES.filter((file) =>
      code(file).includes("localeCompare"),
    );
    expect(
      offenders,
      "INV-EXCEPT-036: a sort whose order becomes part of a stored or " +
        "re-derived identity must use compareOrdinal. localeCompare resolves " +
        "its collation from the environment, and production already runs a " +
        "different ICU build from a development machine.",
    ).toEqual([]);
  });

  it("reaches the comparator by ONE import specifier", () => {
    // A re-export from `stable-digest.ts` would give the same symbol two names,
    // and a census grepping for one of them would miss the other.
    const wrongSpecifier = sources.filter((file) => {
      if (file === CANONICAL_MODULE) return false;
      const text = codeWithStrings(file);
      if (!/import[\s\S]{0,200}?compareOrdinal/.test(text)) return false;
      return !text.includes(CANONICAL_SPECIFIER);
    });
    expect(wrongSpecifier).toEqual([]);
    // The home exports it and imports nothing at all, which is what lets a
    // browser-graph module share it (`INV-OPS-013`).
    const home = code(CANONICAL_MODULE);
    expect(home).toContain("export function compareOrdinal");
    expect(home).not.toMatch(/^\s*import\s/m);
    // Somebody really imports it, so the check above is not vacuous.
    expect(
      sources.filter((file) =>
        codeWithStrings(file).includes(CANONICAL_SPECIFIER),
      ).length,
    ).toBeGreaterThan(5);
  });

  it("keeps the buildXeroPayloadHash exclusion written down", () => {
    // Raw source on purpose: the record IS a comment, so stripping comments
    // would remove the very thing being checked. Unifying that hash would
    // re-derive every stored Xero idempotency key, and a replay would then emit
    // a duplicate financial document, so the note is load-bearing.
    const raw = readFileSync(
      path.join(REPO_ROOT, "src/lib/xero-sync.ts"),
      "utf8",
    );
    expect(raw).toContain("Deliberately NOT routed through `stableDigest`");
    expect(code("src/lib/xero-sync.ts")).not.toContain("stableDigest");
  });
});
