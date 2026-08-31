import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { ESLint } from "eslint";
import { beforeAll, describe, expect, it, vi } from "vitest";

import {
  COMMENT_STRIPPER_ALLOWLIST,
  UNCONVERGED_COMMENT_SCANNERS,
} from "../../../eslint.config.mjs";
import { PRODUCTION_GUARD_ROSTER } from "./support/eslint-guard-coverage";

/**
 * #3164 — the behavioural comment-stripper guard, exercised through the REAL
 * `eslint.config.mjs`.
 *
 * ENFORCES `INV-SSOT-004` (`docs/invariants/single-source-of-truth.md`): there
 * is one comment stripper, `./support/strip-comments`, and a second copy makes
 * the census that owns it go quietly green.
 *
 * WHY THIS SUITE EXISTS AT ALL, given the rule runs in `npm run lint`. Lint
 * proves the tree is clean TODAY. It cannot prove the rule would object to a
 * copy that nobody has written yet, and that is the entire property being
 * bought — #3132 swept seventeen copies by NAME and left seven alive under a
 * second name, so "the tree is clean" was true and worthless. The fixtures below
 * are the copies nobody has written: a two-regex chain under a third name, a
 * hand-written character scanner under a fourth, and the `new RegExp` spelling.
 *
 * It reads the config's own lists rather than keeping a copy of them, because a
 * copy passes happily while the config that ships has dropped an entry — which
 * is `INV-SSOT-004` about this file itself.
 */

const BOOTSTRAP_TIMEOUT_MS = 60_000;
const CASE_TIMEOUT_MS = 20_000;

vi.setConfig({
  testTimeout: CASE_TIMEOUT_MS,
  hookTimeout: BOOTSTRAP_TIMEOUT_MS,
});

const REPO_ROOT = path.resolve(__dirname, "../../..");
const RULE_ID = "ssot/no-local-comment-stripper";
const INVARIANT_ID = "INV-SSOT-004";
const CANONICAL_MODULE = "src/lib/__tests__/support/strip-comments.ts";

/**
 * The two places the importer population is WRITTEN DOWN.
 *
 * Both must say the same number, and it must be the number the tree holds. The
 * pair is the point: `INV-SSOT-004`'s own bullet was "two statements of one
 * fact, and nothing comparing them", and the fact in question was this one.
 */
const POPULATION_PUBLISHERS = [
  CANONICAL_MODULE,
  "docs/invariants/single-source-of-truth.md",
] as const;

/** The published sentence, in the one wording both publishers use. */
// Both publishers say "<n> test files, <a|one> test helper and one CI script
// import". The middle clause is what #2975's helper forced: the KIND of importer
// changed, not just the count, and a regex that only reached the number would
// have gone on matching a sentence that had become false.
const PUBLISHED_POPULATION =
  /(\d+)\s+test files,\s+(?:a|one)\s+test\s+helper and\s+one CI script import\b/;

/*
  HOW AN IMPORTER IS COUNTED, because every previous count of this got it wrong
  in a different way and the counting rule is the whole difficulty.

  The module is reached through at least FOUR path forms — `@/lib/__tests__/
  support/strip-comments`, `./support/strip-comments`, `../support/strip-comments`
  and the CI script's `../../src/lib/__tests__/support/strip-comments.ts` — so a
  grep for any one of them undercounts. Two further files name the path as DATA
  rather than importing it: this file lints the canonical module's own text, and
  `eslint.config.mjs` names it in the rule's message, so a grep for the path
  OVERCOUNTS by two. Matching an import SPECIFIER rather than the path is what
  gets both halves right, and the module never counts itself.

  IT SCANS RAW TEXT, DELIBERATELY. Stripping comments first would be the tidier
  instrument and it is refused here for a specific reason: this file would have
  to import the canonical module to do it, which would make this guard the
  fifty-seventh importer and move the very number it exists to measure. The
  accepted cost is that a specifier written inside a comment would be counted;
  measured across the tree, none is, and the failure message below prints the
  file list so a spurious entry is visible rather than merely arithmetic.
*/
const IMPORT_SPECIFIER =
  /(?:\bfrom\s*|\bimport\s*|\brequire\s*\(\s*)(["'])([^"'\n]+)\1/g;
const CANONICAL_SPECIFIER =
  /(?:^|\/)support\/strip-comments(?:\.(?:ts|tsx|js|jsx|mjs|cjs))?$/;

const SCANNED_EXTENSION = /\.(?:ts|tsx|js|jsx|mjs|cjs)$/;
const UNSCANNED_DIRECTORY = new Set([
  "node_modules",
  ".git",
  ".next",
  ".artifacts",
  "coverage",
  "dist",
  "build",
  "playwright-report",
  "test-results",
  "public",
]);

function scannableFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (UNSCANNED_DIRECTORY.has(entry.name)) continue;
      scannableFiles(path.join(dir, entry.name), found);
    } else if (SCANNED_EXTENSION.test(entry.name)) {
      found.push(path.join(dir, entry.name));
    }
  }
  return found;
}

/** Repo-relative paths of every file that IMPORTS the canonical module. */
function measuredImporters(): { tests: string[]; others: string[] } {
  const tests: string[] = [];
  const others: string[] = [];

  for (const absolute of scannableFiles(REPO_ROOT)) {
    const file = path.relative(REPO_ROOT, absolute).split(path.sep).join("/");
    if (file === CANONICAL_MODULE) continue;

    const source = readFileSync(absolute, "utf8");
    IMPORT_SPECIFIER.lastIndex = 0;
    let match: RegExpExecArray | null;
    let imports = false;
    while ((match = IMPORT_SPECIFIER.exec(source)) !== null) {
      if (CANONICAL_SPECIFIER.test(match[2] ?? "")) {
        imports = true;
        break;
      }
    }
    if (!imports) continue;

    if (/\.(?:test|spec)\.(?:ts|tsx|js|jsx|mjs)$/.test(file)) tests.push(file);
    else others.push(file);
  }

  return { tests: tests.sort(), others: others.sort() };
}

/** Where a fixture is pretended to live. Never a real file. */
const FIXTURE_FILE = path.join(
  REPO_ROOT,
  "src/lib/__tests__/comment-stripper-fixture.test.ts",
);

/*
  WHY THIS FILE IS ON `COMMENT_STRIPPER_ALLOWLIST`, and why it did not used to
  need to be.

  Every fixture below is a module-level constant. Until #3164's fix round that
  made the file invisible to its own rule FOR FREE: evidence was recorded against
  the nearest enclosing FUNCTION, and outside every function there was none — so
  a fixture moved inside an `it(...)` callback reported the file and the same
  text at module scope did not. The old note here read that as a tidy invariant
  to preserve. It was an undeclared hole in the rule, and a real stripper written
  beside a census's imports walked through it exactly as easily as a fixture did.

  The rule now reads the module body too (at a higher bar — both block
  delimiters, since one is `diagnostics/tools/define.ts`'s SQL banlist entry), so
  these fixtures ARE seen, and the file is silent because it is LISTED, with the
  reason that a fixture is text handed to ESLint rather than a scanner. That is
  a claim, so it is tested: `reports its own fixture text at any other path`
  below lints this file's real source at a fixture path and requires a report.
  Silent-because-listed and silent-because-unseen look identical from the tree;
  only that pair of cases tells them apart.
*/

/** A copy under a THIRD name, which is the whole point: no name is swept for. */
const TWO_REGEX_COPY = `
export function scrubAnnotations(source: string): string {
  return source
    .replace(/\\/\\*[\\s\\S]*?\\*\\//g, "")
    .replace(/^[ \\t]*\\/\\/.*$/gm, "");
}
`;

/** The hand-written character scanner, under a fourth name. */
const CHARACTER_SCANNER_COPY = `
export function cleanSource(text: string): string {
  let out = "";
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    const next = text[index + 1];
    if (char === "/" && next === "/") {
      const newline = text.indexOf("\\n", index);
      index = newline === -1 ? text.length : newline;
      continue;
    }
    if (char === "/" && next === "*") {
      const close = text.indexOf("*/", index + 2);
      index = close === -1 ? text.length : close + 2;
      continue;
    }
    out += char;
    index += 1;
  }
  return out;
}
`;

/** The same defect through `new RegExp`, where the delimiter is a STRING. */
const CONSTRUCTED_REGEX_COPY = `
export function tidy(source: string): string {
  const block = new RegExp("\\\\/\\\\*[\\\\s\\\\S]*?\\\\*\\\\/", "g");
  return source.replace(block, "");
}
`;

/**
 * A stripper written at MODULE TOP LEVEL, outside every function.
 *
 * Byte-for-byte the chain in `TWO_REGEX_COPY`, moved one scope out. Before
 * #3164's fix round the first was reported and this one was silent, which is
 * the whole reason the rule now reads the module body.
 */
const MODULE_LEVEL_COPY = `
const RAW = "";
export const CODE = RAW
  .replace(/\\/\\*[\\s\\S]*?\\*\\//g, "")
  .replace(/^[ \\t]*\\/\\/.*$/gm, "");
`;

/*
  THE MEASURED FALSE POSITIVES, kept as fixtures so the narrowing that closed
  them cannot be undone by a later widening without this file going red. Each
  is real code from this tree, reduced.
*/

/**
 * `diagnostics/tools/define.ts`'s SQL banlist: a module-level regex naming ONE
 * escaped block delimiter, because a comment would break the executor's LIMIT
 * wrapper. It is why the module-scope bar is the PAIR rather than either half —
 * measured over the tree, it is the only module-level literal that names one.
 */
const MODULE_LEVEL_SQL_BANLIST = `
export const BANNED_SQL_FRAGMENTS = [
  /\\bdrop\\b/i,
  /\\bgrant\\b/i,
  /--/,
  /\\/\\*/,
];
`;

/** `clubPostHtmlToText` / `htmlToLineText`: a quantifier before an escaped slash. */
const HTML_TO_TEXT = `
export function htmlToText(html: string): string {
  return html
    .replace(/<\\/(p|div|h1|li)>/gi, "\\n")
    .replace(/<br\\s*\\/?>/gi, "\\n");
}
`;

/**
 * `globToRegExp` in `diagnostics/knowledge/allowlist.ts`, a glob suffix test,
 * and `matchScore` from `help/match.ts`.
 *
 * THE MARGIN IS ONE COMPARISON WIDE, and `matchScore` is the narrowest of the
 * three, which is why its real shape is pinned here rather than described. The
 * rule wants two slashes AND two stars; `matchScore` names a slash three times
 * — once in `"/*"`, twice more through the `` `${base}/` `` templates, which is
 * also the only case here that exercises the rule's TemplateElement path — and a
 * star exactly once. One more star comparison in that function and it reports.
 * That is the cost of the narrowing the fixtures above bought, stated where
 * anybody widening the rule will trip over it.
 */
const GLOB_HANDLING = `
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "/") re += "(?:[^/]+/)*";
      else re += "[^/]*";
    } else {
      re += c;
    }
  }
  return new RegExp(re);
}

export function matchesPrefix(entryPath: string, pathname: string): boolean {
  if (!entryPath.endsWith("/*")) return false;
  return pathname.startsWith(entryPath.slice(0, -2) + "/");
}

export function matchScore(pathname: string, entryPath: string): number {
  if (entryPath.endsWith("/*")) {
    const base = entryPath.slice(0, -2);
    if (pathname === base) return -1;
    if (pathname.startsWith(\`\${base}/\`)) return base.length + 0.5;
    return -1;
  }
  return pathname === entryPath ? entryPath.length : -1;
}
`;

/** A protocol-relative href check and a URL matcher, which name `\\/\\/` only. */
const URL_PATTERNS = `
export function isExternal(href: string): boolean {
  if (/^\\/\\//.test(href)) return true;
  return /^https?:\\/\\//i.test(href);
}
`;

/** Nothing to report at all — the non-vacuity control. */
const INERT = `
export const answer = 42;
`;

let eslint: ESLint;

/*
  THE CANARY. Most cases below assert "no report", so anything that makes ESLint
  return nothing at all — a fixture that will not parse, a path that turns out to
  be ignored, a config bootstrap that silently produced no rules — would pass
  every one of them vacuously while reading as a partial flake. The hook lints a
  known violation and THROWS unless it produces exactly one report, so a broken
  run fails loudly before a single vacuous green is printed.
*/
beforeAll(async () => {
  eslint = new ESLint({ cwd: REPO_ROOT, warnIgnored: false });
  const reports = await reportsFor(TWO_REGEX_COPY, FIXTURE_FILE);
  if (reports.length !== 1) {
    throw new Error(
      `${INVARIANT_ID} canary produced ${reports.length} report(s), expected exactly 1. The rule is not running against ${FIXTURE_FILE}, so every negative case below would have passed vacuously.`,
    );
  }
}, BOOTSTRAP_TIMEOUT_MS);

async function reportsFor(code: string, filePath: string) {
  const results = await eslint.lintText(code, { filePath });
  const messages = results.flatMap((result) => result.messages);

  const fatal = messages.filter((message) => message.fatal);
  if (fatal.length > 0) {
    throw new Error(`fixture did not parse: ${fatal[0]?.message ?? "unknown"}`);
  }

  return messages.filter((message) => message.ruleId === RULE_ID);
}

describe("INV-SSOT-004: the comment-stripper guard fires on BEHAVIOUR", () => {
  it.each([
    ["a two-regex copy under a third name", TWO_REGEX_COPY],
    ["a hand-written character scanner", CHARACTER_SCANNER_COPY],
    ["the same delimiter through new RegExp", CONSTRUCTED_REGEX_COPY],
    ["the same chain written at MODULE top level", MODULE_LEVEL_COPY],
  ])("reports %s", async (_label, code) => {
    const reports = await reportsFor(code, FIXTURE_FILE);

    expect(
      reports.length,
      "A local comment stripper must be reported however it is spelled and whatever it is called. #3132 swept by NAME and left seven copies alive under a second one.",
    ).toBe(1);
    expect(reports[0]?.severity, "a warning blocks nothing").toBe(2);
    expect(reports[0]?.message).toContain(INVARIANT_ID);
    expect(reports[0]?.message).toContain(
      "src/lib/__tests__/support/strip-comments.ts",
    );
  });

  it.each([
    ["an HTML-to-text converter", HTML_TO_TEXT],
    ["glob compilation and a glob suffix test", GLOB_HANDLING],
    ["URL and protocol-relative patterns", URL_PATTERNS],
    ["a module-level SQL banlist naming one delimiter", MODULE_LEVEL_SQL_BANLIST],
    ["a file with nothing in it", INERT],
  ])("does not report %s", async (_label, code) => {
    const reports = await reportsFor(code, FIXTURE_FILE);

    expect(
      reports.map((report) => report.message.slice(0, 80)),
      "Each of these was a MEASURED false positive of a wider first cut (#3164): a quantifier before an escaped slash, a single slash/star pair, a line delimiter that is really a URL, and `diagnostics/tools/define.ts`'s module-level SQL banlist, which is why the module-scope bar is BOTH block delimiters. A rule that is wrong whenever it fires teaches its reader to switch it off.",
    ).toEqual([]);
  });

  /*
    THE ALLOWLIST IS WHAT SILENCES THE CANONICAL HELPER, not something about the
    helper's own shape. Linting its real text at a fixture path must report it;
    linting the same text at its real path must not. Together those two say the
    rule can see it and the list is what stops it, which neither says alone.
  */
  it.each(
    COMMENT_STRIPPER_ALLOWLIST.concat(UNCONVERGED_COMMENT_SCANNERS).map(
      (entry) => entry.file,
    ),
  )("is silent on %s and only because it is listed", async (file) => {
    const source = readFileSync(path.join(REPO_ROOT, file), "utf8");

    expect(
      (await reportsFor(source, path.join(REPO_ROOT, file))).length,
      `${file} is on one of the config's two lists, so the rule must not fire there`,
    ).toBe(0);
  });

  it("reports the canonical helper's own text at any other path", async () => {
    const canonical = readFileSync(
      path.join(REPO_ROOT, "src/lib/__tests__/support/strip-comments.ts"),
      "utf8",
    );

    expect(
      (await reportsFor(canonical, FIXTURE_FILE)).length,
      "If this is 0 the previous case proves nothing: the rule would be silent on the canonical helper for some reason of its own, and the allowlist would be doing no work.",
    ).toBeGreaterThan(0);
  });

  /*
    THE SAME QUESTION ASKED OF THIS FILE, which is the one the rule's own suite
    got wrong. Until #3164's fix round this file was silent under `npm run lint`
    because the rule read nothing at module scope, and every fixture here is a
    module-level constant — so the suite passed, and the file's silence proved
    nothing about the allowlist. Now the module body IS read and the entry in
    `COMMENT_STRIPPER_ALLOWLIST` is what silences it. This case is the difference
    between those two worlds: if it ever returns 0, the entry has stopped doing
    work and something else is keeping the file quiet.
  */
  it("reports its own fixture text at any other path", async () => {
    const ownSource = readFileSync(
      path.join(REPO_ROOT, "src/lib/__tests__/ssot-comment-stripper-guard.test.ts"),
      "utf8",
    );

    expect(
      (await reportsFor(ownSource, FIXTURE_FILE)).length,
      "This suite's fixtures are module-level constants naming both block delimiters. The rule must see them, so that the allowlist entry for this file is what makes `npm run lint` quiet here — not a hole in the rule.",
    ).toBeGreaterThan(0);
  });
});

describe("INV-SSOT-004: the guard reaches every surface", () => {
  /*
    ASKED OF ESLINT, NOT OF THE GLOB TEXT, for the reason
    `support/eslint-guard-coverage.ts` records: a string test on a pattern misses
    a block with no `files` key, a glob that does not start with `src/`, and a
    severity downgrade. The test paths matter most here — they are where every
    source-scanning census lives, and where `no-restricted-syntax` is switched
    off entirely, which is why this guard could not be another arm on it.
  */
  const ROSTER = [
    ...PRODUCTION_GUARD_ROSTER.map((entry) => entry.file),
    "src/lib/__tests__/some-census.test.ts",
    "src/lib/club-time/__tests__/some-census.test.ts",
    "src/components/admin/__tests__/some-contract.test.tsx",
    "src/app/api/bookings/__tests__/some-census.test.ts",
    "prisma/migration-verification/some-check.ts",
    "e2e/some-spec.ts",
    "scripts/ci/some-check.mjs",
  ];

  it.each(ROSTER)("is error severity at %s", async (file) => {
    const config = (await eslint.calculateConfigForFile(
      path.join(REPO_ROOT, file),
    )) as { rules?: Record<string, unknown> } | null;

    const option = config?.rules?.[RULE_ID];
    const severity = Array.isArray(option) ? option[0] : option;

    expect(
      severity,
      `${file} does not carry ${RULE_ID}. A guard that does not reach the test tree guards nothing: that is where every source-scanning census lives.`,
    ).toBe(2);
  });
});

describe("INV-SSOT-004: the two lists say what they are", () => {
  it("names real files, with a real reason, and no file on both lists", () => {
    const everyEntry = [
      ...COMMENT_STRIPPER_ALLOWLIST,
      ...UNCONVERGED_COMMENT_SCANNERS,
    ];

    for (const entry of everyEntry) {
      expect(() =>
        readFileSync(path.join(REPO_ROOT, entry.file), "utf8"),
      ).not.toThrow();
      expect(
        entry.reason.trim().length,
        `${entry.file} must say WHY it cannot be the canonical helper`,
      ).toBeGreaterThanOrEqual(40);
    }

    const files = everyEntry.map((entry) => entry.file);
    expect(new Set(files).size, "a file is a permanent exception or a ratchet entry, not both").toBe(
      files.length,
    );
  });

  /*
    THE RATCHET, PINNED — AND IT IS NOW EMPTY.

    Zero is the finished state, so the assertion is an equality rather than a
    ceiling: there is nothing left to converge, and the only way this list moves
    is somebody adding a copy. It was five. #3164's fix round converged
    `family-group-role-retirement.test.ts` onto the canonical second form; #3180
    added `blankLiterals` — every comment and every literal's contents replaced
    by spaces of the SAME LENGTH, so offsets, columns and line numbers all
    survive — and converged the three walkers waiting on it; #3196 added
    `blankLiteralsWithSpans`, which reports the runs it blanked, and took the
    last entry, `advisory-lock-guard.test.ts`. That one needed the spans because
    it hunts raw SQL, which lives inside string literals, while the prose it
    must ignore lives inside string literals too — so it restores the literals
    it can name as statements and the SQL policy stays at that one caller
    instead of becoming a rule inside a general-purpose helper.

    AN EMPTY LIST STILL DOES WORK, which is the thing to understand before
    deleting it. It is what makes "there is no second scanner" a checked fact
    rather than a claim, and it is where a reviewer looks first when somebody
    proposes one. A file that needs an entry here is a second copy: converge it,
    or — if it is genuinely a different CONCEPT rather than the same one done
    again — argue that on `COMMENT_STRIPPER_ALLOWLIST`, where the bar is
    permanent and the reason has to say why the canonical helper can never
    express it.
  */
  it("keeps the unconverged list a ratchet", () => {
    expect(
      UNCONVERGED_COMMENT_SCANNERS.length,
      "#3196 took this to zero, and zero is where it stays. If you are adding an entry, converge instead: the canonical module is `./support/strip-comments`, it holds FIVE forms, and the two that exist for a walker are `blankLiterals` (offsets preserved) and `blankLiteralsWithSpans` (offsets preserved, plus the runs it blanked, for a caller that must restore some of them). If yours is a different CONCEPT rather than the same scanner again, it belongs on COMMENT_STRIPPER_ALLOWLIST with a reason that says why.",
    ).toBe(0);
  });
});

/*
  THE PUBLISHED POPULATION IS THE MEASURED ONE — the pin the bullet above did not
  have, which is why the number has now drifted THREE times.

  It was published as 48 while the module's docblock said 53 and the tree said
  53; #3180 re-measured it; and #3196 then INCREMENTED it — added one to the
  inherited figure for the one file it converged — while its own commit message
  said it had measured. That the inherited figure was itself one high, so the
  increment landed one high too, is not a coincidence worth relying on.

  A reviewer caught each of those. A reviewer is not an instrument, and the
  bullet being drifted from is the one that says two statements of a fact with
  nothing comparing them IS the defect. This suite is the comparison.
*/
describe("INV-SSOT-004: the published importer count is measured, not inherited", () => {
  it("agrees with the tree, and both publishers agree with each other", () => {
    const { tests, others } = measuredImporters();

    expect(
      tests.length,
      "No file imports the canonical stripper. Either the scan is broken or the module has moved, and every assertion here would otherwise pass vacuously.",
    ).toBeGreaterThan(0);

    expect(
      others,
      `The published sentence names these non-test importers and no others. Measured, they are: ${others.join(", ") || "(none)"}. If one has genuinely been added, name it in the sentence in ${POPULATION_PUBLISHERS.join(" and ")} AND here — do not widen this assertion to a length check or a prefix match to hide it.`,
    ).toEqual([
      // The one CI script, and one test helper. The helper arrived from `main`
      // (#2975) while this epic was in flight, which is exactly the shape this
      // assertion exists to surface: it is not a count moving, it is the KIND of
      // importer changing, and a sentence saying "one CI script" would have gone
      // on being false while every number in it stayed right.
      "scripts/ci/check-website-render-modes.mjs",
      "src/lib/__tests__/helpers/admin-route-explicit-permissions.ts",
    ]);

    for (const publisher of POPULATION_PUBLISHERS) {
      const published = PUBLISHED_POPULATION.exec(
        readFileSync(path.join(REPO_ROOT, publisher), "utf8"),
      );

      expect(
        published,
        `${publisher} no longer contains the sentence "<n> test files and one CI script import…". It is one of the two places ${INVARIANT_ID} publishes this population; if the wording changed, change ${PUBLISHED_POPULATION} with it rather than letting this comparison quietly stop happening.`,
      ).not.toBeNull();

      expect(
        Number(published?.[1]),
        `${publisher} publishes ${published?.[1]} test files; the tree holds ${tests.length}. MEASURE the number, do not increment it: the module is imported through four different path forms, and two further files name the path as data without importing it. This has drifted three times. The other publisher is ${POPULATION_PUBLISHERS.filter((other) => other !== publisher).join(", ")}.`,
      ).toBe(tests.length);
    }
  });
});
