// #2779 — the Playwright suite's stay-window allocation, checked by machine
// instead of by comment.
//
// WHY THIS EXISTS. `e2e/locked-out-pickup-and-pay.spec.ts` shipped claiming base
// index 10 was "disjoint from every other stayWindow spec". It was not: 10 is
// already `COMPLIANT_WINDOW_INDEX` in `member-policy-exception-requests.spec.ts`,
// and its retry-1 index 26 is also reached by
// `multi-lodge/policy-exception-second-lodge.spec.ts`. Nothing failed, because
// `playwright.config.ts` runs one worker with `fullyParallel: false` and the two
// specs book different members — but that is exactly the shape of #1703 and
// #2625, where a "harmless" reserved-window collision cost a full CI cycle to
// diagnose. The real defect is that the CLAIM was hand-checked: the next agent
// reading it trusts the sentence rather than re-deriving the set.
//
// Scoped deliberately to ONE spec's band rather than asserting global pairwise
// disjointness. Some existing overlaps are load-bearing or benign in ways this
// file has no business ruling on (`policy-exception-approval` base 21 versus
// `multi-lodge/member-guest-edit-path`'s 19 + retry × 2, which run in different
// Playwright projects against different lodges). Widening this into a tree-wide
// rule is a separate piece of work with its own owner decision; what it does
// today is make the one spec that states a disjointness claim actually hold it.
//
// Lives under src/ because vitest.config.mts excludes `e2e/**` from collection.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Comments are stripped before the census below. Load-bearing here, not
// tidiness: several specs discuss window indexes in prose ("indexes 0–4 are
// taken by other specs"), and a census that counted those would claim occupancy
// that does not exist — and would have "passed" this file's own motivating bug
// for the wrong reason.
import { stripComments } from "./support/strip-comments";

const SPEC_UNDER_CONTRACT = "e2e/locked-out-pickup-and-pay.spec.ts";
const STAY_DATES_HELPER = "e2e/helpers/stay-dates.ts";
const MAX_PLAYWRIGHT_RETRY = 2;

function repoRelative(absolute: string): string {
  return path.relative(process.cwd(), absolute).split(path.sep).join("/");
}

function readRepoFile(relativePath: string): string {
  // Test helper: fixed repo paths under process.cwd(), never user input.
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
  return fs.readFileSync(path.resolve(process.cwd(), relativePath), "utf8");
}

/** Every Playwright spec in the e2e tree, as repo-relative POSIX paths. */
function specFiles(): string[] {
  const root = path.resolve(process.cwd(), "e2e");
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(".spec.ts")) {
        found.push(repoRelative(full));
      }
    }
  };
  walk(root);
  return found.sort();
}

/** The first argument of the call whose `(` sits at `openParen`. */
function firstArgument(source: string, openParen: number): string {
  let depth = 0;
  for (let i = openParen; i < source.length; i++) {
    const c = source[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      depth--;
      if (depth === 0) return source.slice(openParen + 1, i).trim();
    } else if (c === "," && depth === 1) {
      return source.slice(openParen + 1, i).trim();
    }
  }
  throw new Error("unterminated call argument list");
}

/** `const NAME = 10;` declarations in one file, for index constants. */
function integerConstants(source: string): Map<string, number> {
  const constants = new Map<string, number>();
  const pattern = /const\s+([A-Za-z_$][\w$]*)\s*(?::\s*number\s*)?=\s*(\d+)\s*;/g;
  for (const match of source.matchAll(pattern)) {
    constants.set(match[1], Number(match[2]));
  }
  return constants;
}

const RETRY_TOKEN = String.raw`(?:retry|testInfo\.retry|test\.info\(\)\.retry)`;

/**
 * Every stay-window index a call can produce across attempts 0..2.
 *
 * Throws on an argument shape it does not recognise rather than returning an
 * empty set: an unreadable call must break this census loudly, because silently
 * skipping one is how a collision gets declared absent.
 */
function reachableIndexes(
  callee: "stayWindow" | "stayWindowForAttempt",
  argument: string,
  constants: Map<string, number>,
  stride: number,
  where: string,
): number[] {
  const resolved = constants.get(argument);
  const base =
    resolved ??
    (/^\d+$/.test(argument) ? Number(argument) : undefined);

  if (base !== undefined) {
    if (callee === "stayWindowForAttempt") {
      return [0, 1, 2].map((retry) => base + retry * stride);
    }
    return [base];
  }

  if (callee === "stayWindowForAttempt") {
    throw new Error(
      `${where}: stayWindowForAttempt(${argument}) — unrecognised base index. ` +
        `Give it an integer literal or a file-local integer const so the ` +
        `window census can read it.`,
    );
  }

  const strided = new RegExp(`^(\\d+)\\s*\\+\\s*${RETRY_TOKEN}\\s*\\*\\s*(\\d+)$`).exec(
    argument,
  );
  if (strided) {
    const start = Number(strided[1]);
    const step = Number(strided[2]);
    return Array.from(
      { length: MAX_PLAYWRIGHT_RETRY + 1 },
      (_, retry) => start + retry * step,
    );
  }

  const unitStride = new RegExp(`^(\\d+)\\s*\\+\\s*${RETRY_TOKEN}$`).exec(argument);
  if (unitStride) {
    const start = Number(unitStride[1]);
    return Array.from(
      { length: MAX_PLAYWRIGHT_RETRY + 1 },
      (_, retry) => start + retry,
    );
  }

  throw new Error(
    `${where}: stayWindow(${argument}) — unrecognised index expression. Extend ` +
      `this census (src/lib/__tests__/e2e-stay-window-disjointness.test.ts) ` +
      `before introducing a new shape, or the disjointness claim goes blind.`,
  );
}

function indexesUsedBy(file: string, stride: number): number[] {
  const source = stripComments(readRepoFile(file));
  const constants = integerConstants(source);
  const indexes: number[] = [];
  for (const callee of ["stayWindowForAttempt", "stayWindow"] as const) {
    // Negative lookbehind keeps `pastStayWindowForAttempt(` (the retroactive
    // helper, a different date space entirely) out of the census.
    const pattern = new RegExp(`(?<![\\w$])${callee}\\(`, "g");
    for (const match of source.matchAll(pattern)) {
      const openParen = match.index + match[0].length - 1;
      const argument = firstArgument(source, openParen);
      indexes.push(
        ...reachableIndexes(callee, argument, constants, stride, file),
      );
    }
  }
  return indexes;
}

/**
 * `RETRY_WINDOW_STRIDE`, read from the helper rather than hardcoded here — the
 * band arithmetic below is only correct for the stride the helper actually uses.
 */
function retryWindowStride(): number {
  const source = readRepoFile(STAY_DATES_HELPER);
  const match = /const RETRY_WINDOW_STRIDE = (\d+);/.exec(source);
  if (!match) {
    throw new Error(
      `${STAY_DATES_HELPER}: RETRY_WINDOW_STRIDE not found. The stay-window ` +
        `census cannot compute retry bands without it.`,
    );
  }
  return Number(match[1]);
}

describe("#2779 stay-window allocation is machine-checked, not hand-checked", () => {
  const stride = retryWindowStride();

  it("the locked-out pick-up-and-pay band collides with no other spec", () => {
    const ours = indexesUsedBy(SPEC_UNDER_CONTRACT, stride);
    expect(ours.length, SPEC_UNDER_CONTRACT).toBeGreaterThan(0);

    const theirs = new Map<number, string[]>();
    for (const file of specFiles()) {
      if (file === SPEC_UNDER_CONTRACT) continue;
      for (const index of indexesUsedBy(file, stride)) {
        theirs.set(index, [...(theirs.get(index) ?? []), file]);
      }
    }

    const collisions = ours
      .filter((index) => theirs.has(index))
      .map((index) => `${index} (also ${theirs.get(index)!.join(", ")})`);

    expect(
      collisions,
      `${SPEC_UNDER_CONTRACT} states that its stay windows are disjoint from ` +
        `every other spec's. They are not — reserved-window collisions are how ` +
        `#1703 and #2625 both burned a CI cycle. Move the base index to one ` +
        `whose whole retry band (base, base + ${stride}, base + ${2 * stride}) ` +
        `is free, and update the WINDOW comment to match.`,
    ).toEqual([]);
  });

  it("the WINDOW comment states the band the code actually uses", () => {
    // The original defect was a FALSE COMMENT, not a broken test — so the
    // comment is part of the contract. A future agent reading "base index 28"
    // is entitled to rely on it.
    const raw = readRepoFile(SPEC_UNDER_CONTRACT);
    const claim = /WINDOW: base index (\d+) — attempts land on ([\d\s/]+?)\./.exec(
      raw,
    );
    expect(
      claim,
      `${SPEC_UNDER_CONTRACT}: expected a header comment of the form ` +
        `"WINDOW: base index N — attempts land on A / B / C."`,
    ).not.toBeNull();

    const claimedBase = Number(claim![1]);
    const claimedBand = claim![2]
      .split("/")
      .map((part) => Number(part.trim()));

    const actual = indexesUsedBy(SPEC_UNDER_CONTRACT, stride);
    expect(actual).toEqual([
      claimedBase,
      claimedBase + stride,
      claimedBase + 2 * stride,
    ]);
    expect(claimedBand).toEqual(actual);
  });

  it("reads a strided plain stayWindow call, so no spec is silently skipped", () => {
    // Guards the census itself. `stayWindow(13 + retry * 2)` is the shape that
    // a naive integer-literal scan would read as index 13 alone, missing 15 and
    // 17 — and missing exactly the kind of index a later spec would then be
    // told was free.
    const constants = new Map<string, number>();
    expect(
      reachableIndexes("stayWindow", "13 + retry * 2", constants, stride, "t"),
    ).toEqual([13, 15, 17]);
    expect(
      reachableIndexes("stayWindow", "25 + testInfo.retry", constants, stride, "t"),
    ).toEqual([25, 26, 27]);
    expect(
      reachableIndexes(
        "stayWindowForAttempt",
        "COMPLIANT_WINDOW_INDEX",
        new Map([["COMPLIANT_WINDOW_INDEX", 10]]),
        stride,
        "t",
      ),
    ).toEqual([10, 10 + stride, 10 + 2 * stride]);
    expect(() =>
      reachableIndexes("stayWindow", "someHelper(retry)", constants, stride, "t"),
    ).toThrow(/unrecognised index expression/);
  });
});
