import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

/**
 * #3123, the SIGNATURE-RESHAPE group: seven modules whose civil-day authority
 * moved from a DEFAULT to a REQUIRED PARAMETER, and the guard that keeps it
 * there.
 *
 * ## Why these seven were not a plain `await`
 *
 * The owner's steer for this migration is to make the wrong thing
 * unrepresentable rather than to police it — a required parameter beats an
 * `await` in the callee, and deleting a default beats a counted census. Each of
 * these sites had a specific reason the in-place read was not merely
 * inelegant but wrong:
 *
 *  - `getBookingEditPolicy` and `bookingStayHasStarted` are SYNCHRONOUS and pure,
 *    called from eleven and two places respectively — one of them inside a
 *    `prisma.$transaction` holding the global cohort key and a lodge capacity
 *    lock, where a `clubTimeSettings` read would take a second pooled connection
 *    (`INV-LOCK-004`). Two callers invoke the policy TWICE and must get one
 *    answer both times.
 *  - `checkInternetBankingLeadTime` is synchronous, decides a SETTLEMENT PATH
 *    (Internet Banking versus Stripe), and quotes its day back to the payer.
 *  - `computePolicyExceptionHoldExpiry` is documented as "pure, deterministic,
 *    and the single definition both the request-creation path and the reaper
 *    use", and the reaper calls it once per candidate row.
 *  - `getEffectiveJoiningFee` / `getEffectiveMembershipAnnualFee` take a
 *    transaction client on the approval path; the same rule
 *    `resolveMemberJoiningFeeClassification`'s `seasonYear` guard already states.
 *  - `findActiveHutLeaderAssignmentByPin` / `verifyHutLeaderPinForAssignment` had
 *    POSITIONAL defaults, which cannot hold an `await` at all — and the kiosk
 *    caller was reaching past one with `undefined` to supply a lodge id, so the
 *    environment's day was being chosen by accident.
 *  - `getSeasonalMembershipChangePreview` is called in a LOOP by all three of its
 *    callers.
 *
 * ## What this file guards, and why it is a source scan
 *
 * The census (`club-time-escape-hatch-census.test.ts`) counts the defaulted
 * calls that remain; its ratchet may only fall. It cannot see the OTHER half of
 * a reshape: that every CALL SITE actually supplies the day. A behavioural suite
 * per site would be the ideal, and four of these seams have one
 * (`club-time-authority` suites beside the payments-options, lodge-instructions
 * preview, joining-fee preview and bulk-seasonal routes). `getBookingEditPolicy`
 * has thirteen call sites spread across React pages, five route handlers, three
 * services and a diagnostics pack, and driving each of them end to end would
 * cost more than it proves — so the guarantee for that seam is stated here,
 * mechanically, over the source.
 *
 * NOTE for whoever trips this: it reads `src/` from disk, so there is no import
 * edge from any changed file to this test and `vitest related` CANNOT select it.
 * That is a known, documented blind spot of the fast local gate
 * (`AGENTS.md` -> "What `test:related` does NOT cover"), and this class is
 * CI-caught by design. If you add a caller, add its day at the same time.
 */

const ROOT = path.resolve(__dirname, "../../..");

/**
 * Source with every comment blanked out, newlines preserved.
 *
 * DUPLICATED FROM `club-time-escape-hatch-census.test.ts` ON PURPOSE, and this
 * is the one place in this migration where a copy beat a reuse. That module
 * exports the function, but it is a TEST FILE: importing it executes its own
 * `describe` blocks inside this file's run, so this guard would report the
 * census's ratchet failures as its own and could not be read.
 *
 * The reason to strip at all is the census's, verbatim: this repository
 * documents each defect at the site where it removed it, so the strings a scan
 * looks for are densest in exactly the files that no longer commit the defect.
 * Newlines are preserved so a reported line still points at the real line;
 * string and template literals are tracked because `"https://x"` contains a
 * `//` that is not a comment.
 */
const NEWLINE = "\n";

function stripComments(source: string): string {
  let out = "";
  let index = 0;
  type Mode = "code" | "line" | "block" | "single" | "double" | "template";
  let mode: Mode = "code";

  while (index < source.length) {
    const character = source[index];
    const next = source[index + 1];

    if (mode === "code") {
      if (character === "/" && next === "/") {
        mode = "line";
        index += 2;
        continue;
      }
      if (character === "/" && next === "*") {
        mode = "block";
        index += 2;
        continue;
      }
      if (character === "'") mode = "single";
      else if (character === '"') mode = "double";
      else if (character === "`") mode = "template";
      out += character;
      index += 1;
      continue;
    }

    if (mode === "line") {
      if (character === NEWLINE) {
        mode = "code";
        out += character;
      }
      index += 1;
      continue;
    }

    if (mode === "block") {
      if (character === "*" && next === "/") {
        mode = "code";
        index += 2;
        continue;
      }
      if (character === NEWLINE) out += character;
      index += 1;
      continue;
    }

    // Inside a literal: copy through, honouring escapes, until it closes.
    out += character;
    if (character === "\\") {
      const following = source[index + 1];
      if (following !== undefined) out += following;
      index += 2;
      continue;
    }
    if (
      (mode === "single" && character === "'") ||
      (mode === "double" && character === '"') ||
      (mode === "template" && character === "`")
    ) {
      mode = "code";
    }
    index += 1;
  }

  return out;
}

/** The seven modules whose defaults this issue deleted. */
const RESHAPED_MODULES = [
  "src/lib/authoritative-fees.ts",
  "src/lib/booking-edit-policy.ts",
  "src/lib/booking-exception-requests.ts",
  "src/lib/internet-banking-settings.ts",
  "src/lib/joining-fee.ts",
  "src/lib/lodge-pin-session.ts",
  "src/lib/seasonal-membership-assignments.ts",
] as const;

/**
 * The zone-defaulting `date-only` helpers. Named without their parentheses so
 * this file cannot trip a scanner of its own — the mistake PR #2813 shipped,
 * where a comment naming a banned symbol tripped a contract test that matched
 * on `name(`.
 */
const ZONE_DEFAULTING_HELPERS = [
  "getTodayDateOnly",
  "todayDateOnlyForTimeZone",
  "normalizeDateOnlyForTimeZone",
  "startOfDateOnlyForTimeZone",
  "endOfDateOnlyForTimeZone",
  "formatDateOnlyForTimeZone",
] as const;

/**
 * Each reshaped seam: the exported name, and what a call site must show.
 *
 * `keys` is satisfied by any named property in the call's arguments; `minArgs`
 * by a positional count. A seam lists whichever applies to its own shape.
 */
const SEAMS: ReadonlyArray<{
  name: string;
  keys?: readonly string[];
  minArgs?: number;
  /** Files allowed to name it without calling it (its own definition). */
  home: string;
}> = [
  { name: "getBookingEditPolicy", keys: ["today"], home: "src/lib/booking-edit-policy.ts" },
  { name: "bookingStayHasStarted", minArgs: 2, home: "src/lib/booking-edit-policy.ts" },
  {
    name: "checkInternetBankingLeadTime",
    keys: ["today"],
    home: "src/lib/internet-banking-settings.ts",
  },
  {
    name: "buildInternetBankingPaymentOptionState",
    keys: ["today"],
    home: "src/lib/internet-banking-settings.ts",
  },
  {
    name: "computePolicyExceptionHoldExpiry",
    keys: ["zone"],
    home: "src/lib/booking-exception-requests.ts",
  },
  {
    name: "findActiveHutLeaderAssignmentByPin",
    minArgs: 2,
    home: "src/lib/lodge-pin-session.ts",
  },
  {
    name: "verifyHutLeaderPinForAssignment",
    minArgs: 3,
    home: "src/lib/lodge-pin-session.ts",
  },
  { name: "getEffectiveJoiningFee", minArgs: 2, home: "src/lib/authoritative-fees.ts" },
  {
    name: "getEffectiveMembershipAnnualFee",
    minArgs: 2,
    home: "src/lib/authoritative-fees.ts",
  },
  { name: "getJoiningFeePreviewForMember", minArgs: 2, home: "src/lib/joining-fee.ts" },
  { name: "getJoiningFeePreviewForInputs", minArgs: 2, home: "src/lib/joining-fee.ts" },
  {
    name: "getSeasonalMembershipChangePreview",
    keys: ["now", "clubCurrentSeasonYear"],
    home: "src/lib/seasonal-membership-assignments.ts",
  },
];

/** Tracked, non-test TypeScript under `src/`, exactly as the censuses select it. */
function productionSources(): string[] {
  return execFileSync("git", ["ls-files", "src"], { cwd: ROOT, encoding: "utf8" })
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((file) => /\.tsx?$/.test(file))
    .filter((file) => !file.includes("__tests__"))
    .filter((file) => !/\.(test|spec)\.tsx?$/.test(file))
    // `git ls-files` still lists a file another lane has deleted but not yet
    // staged, so existence is checked rather than assumed.
    .filter((file) => fs.existsSync(path.join(ROOT, file)));
}

function codeOf(file: string): string {
  return stripComments(fs.readFileSync(path.join(ROOT, file), "utf8"));
}

/** The argument text of every call of `name(` in `code`, paren-balanced. */
function callArguments(code: string, name: string): string[] {
  const out: string[] = [];
  const needle = `${name}(`;
  let from = 0;
  for (;;) {
    const at = code.indexOf(needle, from);
    if (at === -1) return out;
    // Not a call if the character before is an identifier character — that would
    // be a longer name ending in this one.
    const before = at > 0 ? code[at - 1] : " ";
    if (/[A-Za-z0-9_$]/.test(before)) {
      from = at + needle.length;
      continue;
    }
    let depth = 0;
    let index = at + needle.length - 1;
    for (; index < code.length; index += 1) {
      if (code[index] === "(") depth += 1;
      else if (code[index] === ")") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    out.push(code.slice(at + needle.length, index));
    from = index + 1;
  }
}

/** Top-level (depth-zero) comma count + 1, or 0 for an empty argument list. */
function argumentCount(args: string): number {
  if (args.trim() === "") return 0;
  let depth = 0;
  let count = 1;
  for (const character of args) {
    if ("([{".includes(character)) depth += 1;
    else if (")]}".includes(character)) depth -= 1;
    else if (character === "," && depth === 0) count += 1;
  }
  return count;
}

describe("#3123 reshaped seams keep their required club day", () => {
  it("no reshaped module reads a zone-defaulting date-only helper any more", () => {
    const offenders: string[] = [];
    for (const file of RESHAPED_MODULES) {
      const code = codeOf(file);
      for (const helper of ZONE_DEFAULTING_HELPERS) {
        // Reconstructed at runtime so this file never contains the banned text.
        if (code.includes(`${helper}${"("}`)) offenders.push(`${file}: ${helper}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("every call site of every reshaped seam supplies the day or zone", () => {
    const sources = productionSources();
    // A guard that scanned nothing would pass, so prove the corpus is real.
    expect(sources.length).toBeGreaterThan(500);

    const offenders: string[] = [];
    const seen = new Map<string, number>();

    for (const file of sources) {
      const code = codeOf(file);
      for (const seam of SEAMS) {
        if (!code.includes(seam.name)) continue;
        for (const args of callArguments(code, seam.name)) {
          // The definition itself is `export function name(` — its "arguments"
          // are the parameter list, which is not a call site.
          if (file === seam.home && /^\s*(?:params|input|args|pin|memberId|assignmentId|checkIn|inputs|store)?\s*:/.test(args)) {
            continue;
          }
          if (file === seam.home && args.includes(":")) continue;
          seen.set(seam.name, (seen.get(seam.name) ?? 0) + 1);
          const satisfied = seam.keys
            ? seam.keys.every((key) => new RegExp(`(^|[\\s,{])${key}\\s*[,:}]`).test(args))
            : argumentCount(args) >= (seam.minArgs ?? 1);
          if (!satisfied) offenders.push(`${file}: ${seam.name}(${args.trim().slice(0, 60)})`);
        }
      }
    }

    expect(offenders).toEqual([]);
    // And every seam really was exercised by the scan: a typo in a seam name
    // would otherwise make its whole row vacuous.
    for (const seam of SEAMS) {
      expect(seen.get(seam.name) ?? 0).toBeGreaterThan(0);
    }
  });

  it("the booking edit policy still has the call sites this migration threaded", () => {
    // The widest cascade in the group, pinned as a COUNT so a new caller cannot
    // be added without this file being read. Eleven `getBookingEditPolicy` calls
    // and two `bookingStayHasStarted` calls, measured on the migrated tree.
    const sources = productionSources();
    let policyCalls = 0;
    let startedCalls = 0;
    for (const file of sources) {
      if (file === "src/lib/booking-edit-policy.ts") continue;
      const code = codeOf(file);
      policyCalls += callArguments(code, "getBookingEditPolicy").length;
      startedCalls += callArguments(code, "bookingStayHasStarted").length;
    }
    expect(policyCalls).toBe(11);
    expect(startedCalls).toBe(2);
  });
});
