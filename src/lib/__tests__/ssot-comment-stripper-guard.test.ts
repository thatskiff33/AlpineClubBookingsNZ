import { readFileSync } from "node:fs";
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
    THE RATCHET, PINNED.

    Four files still walk source with their own comment-aware scanner. Three of
    them report offsets into the ORIGINAL text — a line number, or a slice taken
    from the unstripped source — and `stripComments` preserves newlines but not
    columns while `stripCommentsAndStrings` replaces each string with a
    two-character `""`, so neither can serve a walker without moving what it
    points at. Their remedy is a third form in the canonical module (#3180): a
    blanker that replaces every comment and string with spaces of the SAME
    LENGTH. The fourth, `advisory-lock-guard.test.ts`, is on the list for a
    different reason its own entry states, and the preamble in `eslint.config.mjs`
    says so rather than claiming the property for all four.

    It was five until #3164's fix round converged
    `family-group-role-retirement.test.ts`'s `codeOnly` onto the canonical second
    form. This number may go DOWN and may not go up: a fifth file needing an entry
    here is a fifth copy, which is the thing the rule refuses.
  */
  it("keeps the unconverged list a ratchet", () => {
    expect(
      UNCONVERGED_COMMENT_SCANNERS.length,
      "#3164 left four. If you are adding a fifth, converge it instead: the canonical module is `./support/strip-comments`, it holds three forms, and if what you need is the offset-preserving blanker, add that FORM there (#3180) rather than a private one here.",
    ).toBeLessThanOrEqual(4);
  });
});
