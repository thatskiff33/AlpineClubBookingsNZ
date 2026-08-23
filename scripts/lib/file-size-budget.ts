/**
 * File-size budget ratchet (#2687; the stored ledger removed by #2979).
 *
 * One place that knows what the documented size budgets are and which files they
 * apply to. Both the advisory report (`scripts/quality-report.ts`) and the
 * blocking CI gate (`scripts/ci/check-file-size-budget.ts`) import from here, so
 * the number the report prints and the number the gate enforces cannot drift
 * apart.
 *
 * What is NOT here any more is where a file's previous length comes from. That
 * used to be a checked-in ledger this module parsed and serialised; #2979
 * replaced it with a read of the base ref, which lives in
 * `scripts/lib/file-size-base.ts`. Classification stayed here because both the
 * gate and the report need it; the comparison moved because only the gate does.
 *
 * Scope, stated once so nothing ever needs a per-issue exemption: the policy
 * covers tracked source under `src/` only, excluding tests, in any of the
 * extensions in `SOURCE_EXTENSIONS`, and a tracked `src/` file carrying an
 * extension the classifier does not recognise fails the check rather than
 * dropping quietly out of scope. Everything
 * outside `src/` — `scripts/`, `prisma/`, `e2e/`, `load/`, `measurement/` — is
 * outside the file-size policy by definition. That is what makes a temporary
 * measurement tree (#2663) a non-event for this gate: it is not in scope when
 * it is added and it is not in scope when it is deleted, so there is nothing to
 * regenerate and nothing to hide.
 *
 * Uses `git ls-files` and `fs` only — no network, no build, no database.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";

/** Budgets, from `docs/MAINTENANCE.md`. */
export const PRODUCTION_LIMIT = 700;
export const ROUTE_HANDLER_LIMIT = 250;
export const ROUTE_PAGE_LIMIT = 500;

/** The command name quoted in every failure message. */
export const CHECK_COMMAND = "npm run quality:budget";

export type BudgetCategory =
  "domain module" | "route handler" | "route page shell";
export type BudgetSlug = "domain-module" | "route-handler" | "route-page-shell";

export type Budget = {
  category: BudgetCategory;
  slug: BudgetSlug;
  limit: number;
};

const BUDGETS: Record<BudgetSlug, Budget> = {
  "domain-module": {
    category: "domain module",
    slug: "domain-module",
    limit: PRODUCTION_LIMIT,
  },
  "route-handler": {
    category: "route handler",
    slug: "route-handler",
    limit: ROUTE_HANDLER_LIMIT,
  },
  "route-page-shell": {
    category: "route page shell",
    slug: "route-page-shell",
    limit: ROUTE_PAGE_LIMIT,
  },
};

export type FileStat = { file: string; lines: number };
export type OversizedFileStat = FileStat & Budget & { overBy: number };

/**
 * Every executable-source extension the budgets apply to.
 *
 * Keyed on `ts|tsx` alone, this classifier had a hole wide enough to drive the
 * whole gate through: `git mv src/lib/audit.ts src/lib/audit.js` took a
 * baselined 745-line file out of scope entirely, and the tool then reported the
 * disappearance as a 45-line *reduction* in accepted debt — one deleted
 * baseline line, which is exactly what `docs/MAINTENANCE.md` teaches reviewers
 * to read as progress. The file could then grow 500 lines with the gate green.
 * It was reachable, not theoretical: Next's default `pageExtensions` is
 * `['tsx','ts','jsx','js']` and `next.config.ts` overrides nothing, so
 * `route.js` and `page.jsx` are served normally; `tsconfig.json` sets
 * `allowJs: true` and its `include` names `.mts` explicitly; and every custom
 * lint rule block is scoped to `.ts`/`.tsx` under `src`, so a `.js` file there
 * was policed by nothing at all — not the ratchet, not the lint rules, not tsc.
 *
 * Widening this set is zero churn today — tracked `src/` is 2500 `.ts`, 874
 * `.tsx`, 2 `.css`, 1 `.md`, 1 `.json` — but the set is still a list, and a
 * list rots. `findUnclassifiedFiles` is what stops it rotting: any tracked
 * `src/` file whose extension appears in neither this set nor
 * `NON_SOURCE_EXTENSIONS` fails the gate rather than slipping silently out of
 * scope.
 */
const SOURCE_EXTENSIONS = [
  "ts",
  "tsx",
  "mts",
  "cts",
  "js",
  "jsx",
  "mjs",
  "cjs",
] as const;

/**
 * Non-source file kinds that legitimately live under `src/`. Deliberately
 * short: anything not listed here and not a source extension fails the scope
 * audit, which forces a decision instead of a silent exemption. `.mdx` is
 * absent on purpose — it can carry components, so it should be classified
 * consciously if one ever lands.
 */
const NON_SOURCE_EXTENSIONS = new Set([
  "avif",
  "css",
  "csv",
  "gif",
  "html",
  "ico",
  "jpeg",
  "jpg",
  "json",
  "md",
  "otf",
  "png",
  "scss",
  "sql",
  "svg",
  "ttf",
  "txt",
  "webp",
  "woff",
  "woff2",
  "yaml",
  "yml",
]);

const EXT = SOURCE_EXTENSIONS.join("|");
const SOURCE_FILE_PATTERN = new RegExp(`\\.(${EXT})$`);
const TEST_FILE_PATTERN = new RegExp(`\\.(test|spec)\\.(${EXT})$`);
// `(.*\/)?` rather than `.*\/`: the latter required at least one directory
// after `src/app/`, so a root-level `src/app/route.ts` silently inherited the
// 700-LOC domain-module budget instead of 250.
const ROUTE_HANDLER_PATTERN = new RegExp(
  `^src\\/app\\/(.*\\/)?route\\.(${EXT})$`,
);
const ROUTE_PAGE_PATTERN = new RegExp(`^src\\/app\\/(.*\\/)?page\\.(${EXT})$`);

function extensionOf(file: string): string | null {
  const base = file.slice(file.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return null;
  return base.slice(dot + 1).toLowerCase();
}

export function isProductionFile(file: string): boolean {
  if (!file.startsWith("src/")) return false;
  if (!SOURCE_FILE_PATTERN.test(file)) return false;
  if (isRatchetExcludedTestFile(file)) return false;
  return true;
}

/** Test-path source files excluded from production debt and importable by app roots. */
export function isRatchetExcludedTestFile(file: string): boolean {
  if (!file.startsWith("src/") && !file.startsWith("scripts/")) return false;
  if (!SOURCE_FILE_PATTERN.test(file)) return false;
  return file.includes("/__tests__/") || TEST_FILE_PATTERN.test(file);
}

export function isRouteHandler(file: string): boolean {
  return ROUTE_HANDLER_PATTERN.test(file);
}

export function isRoutePage(file: string): boolean {
  return ROUTE_PAGE_PATTERN.test(file);
}

/**
 * Why this path cannot be reported on reliably, or null when it can.
 *
 * Spaces are fine and always were. A tab or a newline is not: those characters
 * survive a NUL-separated `git ls-files -z` read but not the line-oriented
 * output a human or a log reads it back out of, so such a path is reported as a
 * scope problem rather than measured and printed as something nothing can
 * unambiguously refer to again.
 */
function pathProblem(file: string): string | null {
  // Backslash first: a Windows-style path should be told to use forward
  // slashes, not that it is outside src/ — which it also is, less usefully.
  if (file.includes("\\")) return "path must use forward slashes";
  if (!file.startsWith("src/")) {
    return "path must be a repo-relative path under src/";
  }
  if (/[\t\r\n]/.test(file)) {
    return "path contains a tab or newline, which no line-based report can refer to unambiguously";
  }
  if (file.endsWith("/")) return "path must name a file, not a directory";
  if (file.includes("//") || file.split("/").includes("..")) {
    return "path must be normalised";
  }
  return null;
}

/**
 * Tracked `src/` files the classifier does not recognise — neither source it
 * budgets nor a declared non-source kind — plus any whose path cannot be
 * reported unambiguously. Both are scope holes, and a scope hole in a gate reads
 * exactly like a clean pass.
 */
export function findUnclassifiedFiles(
  trackedFiles: readonly string[],
): Array<{ file: string; reason: string }> {
  const out: Array<{ file: string; reason: string }> = [];
  for (const file of trackedFiles) {
    if (!file.startsWith("src/")) continue;
    const extension = extensionOf(file);
    if (extension === null) {
      out.push({
        file,
        reason:
          "no file extension, so the classifier cannot tell source from asset",
      });
      continue;
    }
    if (SOURCE_FILE_PATTERN.test(file)) {
      const problem = pathProblem(file);
      if (problem) out.push({ file, reason: problem });
      continue;
    }
    if (NON_SOURCE_EXTENSIONS.has(extension)) continue;
    out.push({
      file,
      reason: `unrecognised extension .${extension} — it is in no budget, so nothing measures it`,
    });
  }
  return out.sort((a, b) => compare(a.file, b.file));
}

/**
 * Which budget applies to a path. Derived from the path every time, and never
 * recorded anywhere: there is nothing to hand-edit into a laxer category,
 * because there is nothing written down to edit.
 */
export function budgetForFile(file: string): Budget {
  if (isRouteHandler(file)) return BUDGETS["route-handler"];
  if (isRoutePage(file)) return BUDGETS["route-page-shell"];
  return BUDGETS["domain-module"];
}

export function describeBudget(budget: Budget): string {
  return `${budget.category}, <= ${budget.limit} LOC`;
}

/**
 * Physical lines in a file. Counts `\n` bytes, so a CRLF working tree on
 * Windows and an LF one on Linux CI agree (#2399 taught this repository what
 * happens when they do not).
 */
export function countLines(root: string, file: string): number {
  let buf: Buffer;
  try {
    buf = readFileSync(path.join(root, file));
  } catch {
    return 0;
  }
  if (buf.length === 0) return 0;
  let count = 0;
  for (let i = 0; i < buf.length; i += 1) {
    if (buf[i] === 0x0a) count += 1;
  }
  if (buf[buf.length - 1] !== 0x0a) count += 1;
  return count;
}

/** Tracked files, NUL-separated so a path needing quoting cannot be misread. */
function listTrackedFiles(root: string): string[] {
  const out = execFileSync("git", ["ls-files", "-z"], {
    encoding: "utf8",
    cwd: root,
    maxBuffer: 128 * 1024 * 1024,
  });
  return out.split("\0").filter(Boolean);
}

function existsInTree(root: string, file: string): boolean {
  try {
    statSync(path.join(root, file));
    return true;
  } catch {
    return false;
  }
}

export type RepositoryScan = {
  trackedFiles: string[];
  productionStats: FileStat[];
  unclassified: Array<{ file: string; reason: string }>;
  /** Why `git ls-files` could not be run, or null when it ran. */
  gitError: string | null;
};

/**
 * One `git ls-files` call, everything derived from it.
 *
 * A failed git invocation is caught rather than thrown: run outside a checkout,
 * this used to die with an unhandled `fatal: not a git repository` stack trace.
 * That was still fail-closed, but "gate crashed" and "gate found a problem"
 * should not look different to whoever reads the log.
 */
export function scanRepository(root: string): RepositoryScan {
  let trackedFiles: string[];
  try {
    trackedFiles = listTrackedFiles(root);
  } catch (error) {
    return {
      trackedFiles: [],
      productionStats: [],
      unclassified: [],
      gitError: error instanceof Error ? error.message.trim() : String(error),
    };
  }
  const productionStats = trackedFiles
    .filter(isProductionFile)
    .filter((file) => existsInTree(root, file))
    .map((file) => ({ file, lines: countLines(root, file) }))
    .sort(byPath);
  return {
    trackedFiles,
    productionStats,
    unclassified: findUnclassifiedFiles(trackedFiles),
    gitError: null,
  };
}

export function findOversizedProductionFiles(
  stats: FileStat[],
): OversizedFileStat[] {
  return stats
    .map((stat) => {
      const budget = budgetForFile(stat.file);
      return { ...stat, ...budget, overBy: stat.lines - budget.limit };
    })
    .filter((stat) => stat.overBy > 0)
    .sort(
      (a, b) =>
        b.overBy - a.overBy || b.lines - a.lines || compare(a.file, b.file),
    );
}

/**
 * The whole tree's size debt, in one shape both readers agree on.
 *
 * This is the figure the deleted ledger used to give away as a side effect of
 * existing, and it is the one thing worth keeping from it: a number to point at
 * and watch shrink. It is now COMPUTED ON DEMAND rather than committed, which is
 * the whole change — `npm run quality:budget -- --report` prints it and
 * `npm run quality:report` embeds it, and neither writes anything down for the
 * next branch to conflict on.
 *
 * Both callers come through here for the same reason the classifier is shared
 * (#2687): an advisory report that could disagree with the blocking gate about
 * which files are over budget is how the old nine-entry allow-list came to
 * understate the real population by a factor of thirty.
 */
export function summariseSizeDebt(stats: FileStat[]): {
  oversized: OversizedFileStat[];
  scannedFiles: number;
  oversizedFiles: number;
  /** Sum of (LOC - budget) over every over-budget file. */
  debt: number;
} {
  const oversized = findOversizedProductionFiles(stats);
  return {
    oversized,
    scannedFiles: stats.length,
    oversizedFiles: oversized.length,
    debt: oversized.reduce((sum, stat) => sum + stat.overBy, 0),
  };
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function byPath(a: { file: string }, b: { file: string }): number {
  return compare(a.file, b.file);
}
