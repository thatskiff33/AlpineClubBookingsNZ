/**
 * Every test file that reads the whole source tree states a budget (#5439).
 *
 * Reading and comment-stripping every file under `src/` is seconds of
 * synchronous work, more on a loaded CI runner, and vitest's 5,000 ms default
 * is not a budget for it (PR #5429 failed a shard on fine code this way). The
 * budget is the shared constant in `src/test/census-timeout.ts`.
 *
 * This census finds the test files that reach a known whole-tree reader:
 *   - a source-reader helper in `src/lib/__tests__/support/` that walks `src`,
 *     `src/app` or the repository, or `scanRepository()` in
 *     `scripts/lib/file-size-budget.ts` and the quality report's `main()`,
 *     which walk the whole repository (READER_HELPERS below);
 *   - `scanAuditWriterCensus()`, the full AST parse of `src`, `scripts` and
 *     `prisma`;
 *   - a direct walker in the test file: `git ls-files src` (or `src/lib`,
 *     `src/app`), a `src/**` glob, or a recursive `readdirSync` rooted at one
 *     of those directories.
 * Each such file must import `CENSUS_TIMEOUT_MS` or `AST_CENSUS_TIMEOUT_MS`
 * from the shared module. A `vi.setConfig({ testTimeout })` counts only when
 * it sets one of those constants (which needs the import); a file-wide local
 * literal is not a budget. It does not prove every case uses the constant; it
 * catches the file that forgot the shared budget altogether.
 *
 * The scan is plain text and import matching, not an AST parse, so it stays
 * fast. See docs/TESTING.md "A test that reads the whole tree needs its own
 * budget too (#5439)".
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { escapeRegExp } from "@/lib/escape-regexp";
import { CENSUS_TIMEOUT_MS } from "@/test/census-timeout";

const ROOT = process.cwd();
const TIMEOUT_MODULE = "src/test/census-timeout";

/** Repo path (no extension) of a module, and the exports of it that walk the tree. */
const READER_HELPERS: Readonly<Record<string, readonly string[]>> = {
  "src/lib/__tests__/support/advisory-lock-source": ["lockCensusSources"],
  "src/lib/__tests__/support/booking-guest-night-writer-scan": ["sourceFiles", "discoveredWriterSiteCounts"],
  "src/lib/__tests__/support/booking-money-writer-scan": [
    "discoveredBookingMoneyWriterSites",
    "discoveredBookingMoneyWriterEscapes",
    "discoveredBookingMoneyWriterEqualityEscapes",
    "discoveredBookingMoneyRawSqlEscapes",
  ],
  "src/lib/__tests__/support/live-doc-surfaces": ["liveDocSurfaces"],
  "src/lib/__tests__/support/money-number-input-scan": ["jsxSourceFiles", "scanTreeForMoneyNumberInputs"],
  "src/lib/__tests__/support/password-hash-writer-scan": ["passwordHashScanFiles", "scanRepositoryPasswordHashWriters"],
  "src/lib/__tests__/support/prisma-delegate-read-scan": ["productionSourceFiles"],
  "src/lib/__tests__/support/provider-mount-census": [
    "walk",
    "pagesInRouteGroups",
    "mountingLayoutDirectories",
    "pagesWithoutMountingLayout",
    "surfacesOutsideMountingLayouts",
  ],
  "src/lib/__tests__/support/static-import-graph": ["productionSourceFiles", "buildImportGraph"],
  "scripts/audit/audit-writer-census": ["scanAuditWriterCensus"],
  "scripts/lib/file-size-budget": ["scanRepository"],
  // Scans the real repository root through scanRepository().
  "scripts/quality-report": ["main"],
};

/** The shared budgets a reader may state (src/test/census-timeout.ts). */
const BUDGET_NAMES: readonly string[] = ["CENSUS_TIMEOUT_MS", "AST_CENSUS_TIMEOUT_MS"];

/**
 * Test files the matchers name that need no test budget: they reach a reader
 * only while vitest collects them (module or `describe` scope, which has no
 * timeout), or only over a temporary fixture rather than the real tree. Keep
 * this short: a new entry needs its reason, and a test-body read of the real
 * tree needs the budget instead.
 */
const NEEDS_NO_BUDGET: Readonly<Record<string, string>> = {
  // Calls scanAuditWriterCensus(root) only on mkdtemp fixture trees it writes.
  "src/lib/__tests__/audit-writer-census-scanner.test.ts": "fixture trees only",
  // readdirSync(..., { recursive: true }) walks a temporary fixture repository.
  "scripts/ci/pr-body-file.test.mjs": "fixture repository only",
  // Its "src" walks are of temporary fixture lanes; its vi.setConfig covers git and pnpm calls.
  "scripts/remove-worktree.test.mjs": "fixture lanes only",
};

/** A `git ls-files` call naming `src`, `src/lib` or `src/app`. */
const LS_FILES_SRC = /ls-files[^\n]*?[\s"',](?:src(?:\/(?:lib|app))?)["'\s\]]/;
/** A glob rooted at one of those directories, recursing. */
const GLOB_SRC = /glob(?:Sync)?\(\s*\[?\s*["'`]src(?:\/(?:lib|app))?\/\*\*/;
/** A directory read. */
const READDIR = /\b(?:readdirSync|readdir|opendirSync)\(/;
/** The read recurses: the recursive option, or a walker that calls itself. */
const RECURSIVE_OPTION = /recursive:\s*true/;
/** A root of `src`, `src/lib` or `src/app` and nothing deeper. */
/** A file-wide `vi.setConfig` testTimeout, capturing its value (for the failure message). */
const SET_CONFIG_TEST_TIMEOUT = /vi\.setConfig\(\s*\{[^}]*?\btestTimeout\s*:\s*([^,}\s]+)/g;
const SRC_ROOT = /["'`]src(?:\/(?:lib|app))?\/?["'`]\s*[)\]]|["'`]src["'`]\s*,\s*["'`](?:lib|app)["'`]\s*\)/;

function testFiles(dir: string): string[] {
  return readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return entry.name === "node_modules" || entry.name.startsWith(".") ? [] : testFiles(rel);
    return /\.test\.(?:ts|tsx|mts|mjs)$/.test(entry.name) ? [rel] : [];
  });
}

/** Repo path, without extension, that an import specifier names; null for a package. */
function resolveSpecifier(fromFile: string, specifier: string): string | null {
  let target: string;
  if (specifier.startsWith("@/")) target = `src/${specifier.slice(2)}`;
  else if (specifier.startsWith(".")) target = path.posix.join(path.posix.dirname(fromFile), specifier);
  else return null;
  return target.replace(/\.(?:ts|tsx|mts|mjs|js)$/, "");
}

type Import = { module: string; names: readonly string[] | "*" };

function importsOf(file: string, text: string): Import[] {
  const out: Import[] = [];
  const named = /import\s+(?:type\s+)?(?:[\w$]+\s*,\s*)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/g;
  for (const match of text.matchAll(named)) {
    const target = resolveSpecifier(file, match[2]!);
    if (!target) continue;
    const names = match[1]!
      .split(",")
      .map((part) => part.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]!.trim())
      .filter(Boolean);
    out.push({ module: target, names });
  }
  for (const match of text.matchAll(/import\s+\*\s+as\s+[\w$]+\s+from\s*["']([^"']+)["']/g)) {
    const target = resolveSpecifier(file, match[1]!);
    if (target) out.push({ module: target, names: "*" });
  }
  return out;
}

/** Why a file counts as a whole-tree reader, or null. */
function readerReason(file: string, text: string): string | null {
  for (const { module, names } of importsOf(file, text)) {
    const readers = READER_HELPERS[module];
    if (!readers) continue;
    const used = names === "*" ? readers : readers.filter((name) => names.includes(name));
    if (used.length > 0) return `${module}: ${used.join(", ")}`;
  }
  if (LS_FILES_SRC.test(text)) return "git ls-files over src";
  if (GLOB_SRC.test(text)) return "src/** glob";
  if (READDIR.test(text) && SRC_ROOT.test(text) && (RECURSIVE_OPTION.test(text) || selfRecursiveReaddir(text))) {
    return "recursive directory read rooted at src";
  }
  return null;
}

/** A named function or arrow whose body reads a directory and calls itself. */
function selfRecursiveReaddir(text: string): boolean {
  const definition = /(?:function\s+([\w$]+)\s*\(|(?:const|let)\s+([\w$]+)\s*=\s*(?:\([^)]*\)|[\w$]+)\s*(?::[^=]+)?=>)/g;
  for (const match of text.matchAll(definition)) {
    const name = match[1] ?? match[2]!;
    // The walker's body: up to the next top-level definition, bounded.
    const body = text.slice(match.index! + match[0].length, match.index! + match[0].length + 1500);
    if (READDIR.test(body) && new RegExp(`\\b${escapeRegExp(name)}\\(`).test(body)) return true;
  }
  return false;
}

/** A shared budget name, bare or through a namespace import (`budgets.CENSUS_TIMEOUT_MS`). */
function isBudgetName(value: string): boolean {
  return BUDGET_NAMES.includes(value.replace(/^[\w$]+\./, ""));
}

/**
 * What is wrong with a reader's budget, or null when it imports a shared one.
 * Only the import counts: `vi.setConfig({ testTimeout: CENSUS_TIMEOUT_MS })`
 * has it, and a local literal such as `vi.setConfig({ testTimeout: 60_000 })`
 * does not, whatever its size (docs/TESTING.md: "never a local literal").
 */
function budgetProblem(file: string, text: string): string | null {
  const imported = importsOf(file, text).some(
    ({ module, names }) => module === TIMEOUT_MODULE && (names === "*" || names.some(isBudgetName)),
  );
  if (imported) return null;
  const literals = [...text.matchAll(SET_CONFIG_TEST_TIMEOUT)].map((match) => match[1]!).filter((value) => !isBudgetName(value));
  return literals.length > 0
    ? `vi.setConfig testTimeout ${literals.join(", ")} is a local literal, not a shared budget`
    : "no shared budget imported";
}

describe("every whole-tree reader states a test budget (#5439)", { timeout: CENSUS_TIMEOUT_MS }, () => {
  const files = [...testFiles("src"), ...testFiles("scripts")].sort();
  const readers = files.flatMap((file) => {
    const text = readFileSync(path.join(ROOT, file), "utf8");
    const reason = readerReason(file, text);
    if (!reason) return [];
    const problem = budgetProblem(file, text);
    return [{ file, reason, problem, budgeted: problem === null }];
  });

  it("finds the readers it is meant to police, so an empty census is not a silent pass", () => {
    expect(files.length).toBeGreaterThan(1000);
    expect(readers.length).toBeGreaterThan(50);
    // One of each kind of reader, named, so a broken matcher fails here.
    const reasons = new Map(readers.map((reader) => [reader.file, reader.reason]));
    expect(reasons.get("src/lib/__tests__/advisory-lock-isolation-census.test.ts")).toMatch(/lockCensusSources/);
    expect(reasons.get("src/lib/__tests__/audit-legacy-filter-exact-prefix.test.ts")).toMatch(/scanAuditWriterCensus/);
    expect(reasons.get("src/lib/__tests__/identity-ordering-census.test.ts")).toBe("git ls-files over src");
  });

  it("finds no reader without the shared budget, outside the no-budget list", () => {
    const missing = readers
      .filter((reader) => !reader.budgeted && !(reader.file in NEEDS_NO_BUDGET))
      .map((reader) => `${reader.file} (${reader.reason}; ${reader.problem})`);
    expect(
      missing,
      "These test files read the whole source tree but do not import CENSUS_TIMEOUT_MS / " +
        "AST_CENSUS_TIMEOUT_MS from src/test/census-timeout.ts, or set vi.setConfig({ testTimeout }) " +
        "to a local literal rather than one of those constants. Budget each case that can make the " +
        "first read, or its describe or file (docs/TESTING.md, #5439).",
    ).toEqual([]);
  });

  it("keeps every no-budget entry a live reader that still has no budget", () => {
    const byFile = new Map(readers.map((reader) => [reader.file, reader]));
    const stale = Object.keys(NEEDS_NO_BUDGET).filter((file) => {
      const reader = byFile.get(file);
      return !reader || reader.budgeted;
    });
    expect(stale, "remove these entries: the file no longer reads the tree, or now has the budget").toEqual([]);
  });

  it("knows each reader helper it names still exists and still exports it", () => {
    const gone: string[] = [];
    for (const [module, names] of Object.entries(READER_HELPERS)) {
      const text = readFileSync(path.join(ROOT, `${module}.ts`), "utf8");
      for (const name of names) {
        if (!new RegExp(`export (?:async )?(?:function|const) ${name}\\b`).test(text)) gone.push(`${module}: ${name}`);
      }
    }
    expect(gone).toEqual([]);
  });
});
