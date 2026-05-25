#!/usr/bin/env -S npx tsx
/**
 * Maintainability quality report.
 *
 * Scans tracked production and test files for size and suppression hotspots,
 * then prints a markdown summary. Uses `git ls-files` and `fs` only — no
 * external services, no network, no production build.
 *
 * Tracked budgets (from docs/MAINTENANCE.md):
 *   - route handlers <= 250 LOC
 *   - App Router page shells <= 500 LOC
 *   - new domain modules <= 900 LOC
 *
 * Exit status is always 0 today: this is a warn-and-inform report, not a
 * hard gate.
 */
import { execSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();

const PRODUCTION_LIMIT = 900;
const ROUTE_HANDLER_LIMIT = 250;
const ROUTE_PAGE_LIMIT = 500;

const TOP_N = 10;

function listGitFiles(): string[] {
  const out = execSync("git ls-files", { encoding: "utf8", cwd: ROOT });
  return out.split("\n").filter(Boolean);
}

function isProductionFile(file: string): boolean {
  if (!file.startsWith("src/")) return false;
  if (!/\.(ts|tsx)$/.test(file)) return false;
  if (file.includes("/__tests__/")) return false;
  if (file.endsWith(".test.ts") || file.endsWith(".test.tsx")) return false;
  if (file.endsWith(".spec.ts") || file.endsWith(".spec.tsx")) return false;
  return true;
}

function isTestFile(file: string): boolean {
  if (!file.startsWith("src/")) return false;
  if (!/\.(ts|tsx)$/.test(file)) return false;
  return (
    file.includes("/__tests__/") ||
    file.endsWith(".test.ts") ||
    file.endsWith(".test.tsx") ||
    file.endsWith(".spec.ts") ||
    file.endsWith(".spec.tsx")
  );
}

function isRouteHandler(file: string): boolean {
  return /^src\/app\/.*\/route\.(ts|tsx)$/.test(file);
}

function isRoutePage(file: string): boolean {
  return /^src\/app\/.*\/page\.tsx$/.test(file);
}

type FileStat = { file: string; lines: number };

function countLines(file: string): number {
  try {
    const buf = readFileSync(path.join(ROOT, file), "utf8");
    if (buf.length === 0) return 0;
    let count = 1;
    for (let i = 0; i < buf.length; i += 1) {
      if (buf.charCodeAt(i) === 10) count += 1;
    }
    if (buf.endsWith("\n")) count -= 1;
    return count;
  } catch {
    return 0;
  }
}

function safeExists(file: string): boolean {
  try {
    statSync(path.join(ROOT, file));
    return true;
  } catch {
    return false;
  }
}

function topBy<T>(items: T[], score: (item: T) => number, n: number): T[] {
  return [...items].sort((a, b) => score(b) - score(a)).slice(0, n);
}

type Suppression = {
  file: string;
  line: number;
  snippet: string;
  kind: string;
};

const ANY_PATTERNS: Array<{ kind: string; pattern: RegExp }> = [
  { kind: "as any", pattern: /\bas\s+any\b/ },
  { kind: ": any", pattern: /:\s*any\b/ },
  { kind: "<any>", pattern: /<\s*any\s*>/ },
  { kind: "@ts-ignore", pattern: /@ts-ignore\b/ },
  { kind: "@ts-expect-error", pattern: /@ts-expect-error\b/ },
  { kind: "@ts-nocheck", pattern: /@ts-nocheck\b/ },
];

function scanSuppressions(file: string): {
  any: Suppression[];
  eslintDisable: Suppression[];
} {
  const any: Suppression[] = [];
  const eslintDisable: Suppression[] = [];
  let body: string;
  try {
    body = readFileSync(path.join(ROOT, file), "utf8");
  } catch {
    return { any, eslintDisable };
  }
  const lines = body.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    for (const { kind, pattern } of ANY_PATTERNS) {
      if (pattern.test(line)) {
        any.push({ file, line: i + 1, snippet: line.trim().slice(0, 160), kind });
      }
    }
    if (/eslint-disable\b/.test(line)) {
      eslintDisable.push({
        file,
        line: i + 1,
        snippet: line.trim().slice(0, 160),
        kind: "eslint-disable",
      });
    }
  }
  return { any, eslintDisable };
}

function renderTable(rows: string[][], headers: string[]): string {
  if (rows.length === 0) return "_No entries._";
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)),
  );
  const pad = (cell: string, w: number) => cell.padEnd(w);
  const lines = [
    `| ${headers.map((h, i) => pad(h, widths[i])).join(" | ")} |`,
    `| ${widths.map((w) => "-".repeat(w)).join(" | ")} |`,
    ...rows.map(
      (row) => `| ${row.map((c, i) => pad(c ?? "", widths[i])).join(" | ")} |`,
    ),
  ];
  return lines.join("\n");
}

function renderFlaggedTable(
  stats: FileStat[],
  limit: number,
  budgetName: string,
): string {
  const rows = stats.map((s) => [
    s.file,
    String(s.lines),
    s.lines > limit ? "yes" : "no",
  ]);
  return [
    `Budget: <= ${limit} LOC (${budgetName})`,
    "",
    renderTable(rows, ["File", "LOC", "Over budget"]),
  ].join("\n");
}

function main() {
  const files = listGitFiles().filter(safeExists);

  const productionStats: FileStat[] = files
    .filter(isProductionFile)
    .map((file) => ({ file, lines: countLines(file) }));
  const testStats: FileStat[] = files
    .filter(isTestFile)
    .map((file) => ({ file, lines: countLines(file) }));
  const routeHandlerStats: FileStat[] = productionStats.filter((s) =>
    isRouteHandler(s.file),
  );
  const routePageStats: FileStat[] = productionStats.filter((s) =>
    isRoutePage(s.file),
  );

  const allAny: Suppression[] = [];
  const allEslintDisable: Suppression[] = [];
  let testAnyCount = 0;

  for (const file of files) {
    if (!isProductionFile(file) && !isTestFile(file)) continue;
    const { any, eslintDisable } = scanSuppressions(file);
    if (isProductionFile(file)) {
      allAny.push(...any);
      allEslintDisable.push(...eslintDisable);
    } else {
      testAnyCount += any.filter((a) => a.kind === "as any").length;
    }
  }

  const totalProdLoc = productionStats.reduce((sum, s) => sum + s.lines, 0);
  const totalTestLoc = testStats.reduce((sum, s) => sum + s.lines, 0);
  const overBudgetModules = productionStats.filter(
    (s) => s.lines > PRODUCTION_LIMIT && !isRouteHandler(s.file) && !isRoutePage(s.file),
  );
  const overBudgetHandlers = routeHandlerStats.filter(
    (s) => s.lines > ROUTE_HANDLER_LIMIT,
  );
  const overBudgetPages = routePageStats.filter(
    (s) => s.lines > ROUTE_PAGE_LIMIT,
  );

  const lines: string[] = [];
  lines.push("# Quality report");
  lines.push("");
  lines.push(
    `_Generated from \`git ls-files\` — no external services, no network._`,
  );
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(
    renderTable(
      [
        ["Production files (src/)", String(productionStats.length)],
        ["Production LOC (src/)", String(totalProdLoc)],
        ["Test files (src/)", String(testStats.length)],
        ["Test LOC (src/)", String(totalTestLoc)],
        ["Route handlers", String(routeHandlerStats.length)],
        ["App Router pages", String(routePageStats.length)],
        ["Production `any` / type suppressions", String(allAny.length)],
        ["Production `eslint-disable` lines", String(allEslintDisable.length)],
        ["Test `as any` occurrences", String(testAnyCount)],
        [`Modules over ${PRODUCTION_LIMIT} LOC budget`, String(overBudgetModules.length)],
        [`Route handlers over ${ROUTE_HANDLER_LIMIT} LOC budget`, String(overBudgetHandlers.length)],
        [`Pages over ${ROUTE_PAGE_LIMIT} LOC budget`, String(overBudgetPages.length)],
      ],
      ["Metric", "Value"],
    ),
  );
  lines.push("");

  lines.push("## Largest production files");
  lines.push("");
  lines.push(
    renderFlaggedTable(
      topBy(productionStats, (s) => s.lines, TOP_N),
      PRODUCTION_LIMIT,
      "domain module",
    ),
  );
  lines.push("");

  lines.push("## Largest route handlers");
  lines.push("");
  lines.push(
    renderFlaggedTable(
      topBy(routeHandlerStats, (s) => s.lines, TOP_N),
      ROUTE_HANDLER_LIMIT,
      "route handler",
    ),
  );
  lines.push("");

  lines.push("## Largest App Router pages");
  lines.push("");
  lines.push(
    renderFlaggedTable(
      topBy(routePageStats, (s) => s.lines, TOP_N),
      ROUTE_PAGE_LIMIT,
      "route page shell",
    ),
  );
  lines.push("");

  lines.push("## Largest test files");
  lines.push("");
  lines.push(
    renderTable(
      topBy(testStats, (s) => s.lines, TOP_N).map((s) => [s.file, String(s.lines)]),
      ["File", "LOC"],
    ),
  );
  lines.push("");

  lines.push("## Production `any` / type suppression hotspots");
  lines.push("");
  const anyByFile = new Map<string, number>();
  for (const item of allAny) {
    anyByFile.set(item.file, (anyByFile.get(item.file) ?? 0) + 1);
  }
  const anyTopFiles = [...anyByFile.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP_N);
  lines.push(
    renderTable(
      anyTopFiles.map(([file, count]) => [file, String(count)]),
      ["File", "Suppressions"],
    ),
  );
  lines.push("");

  lines.push("## Production `eslint-disable` hotspots");
  lines.push("");
  const eslintByFile = new Map<string, number>();
  for (const item of allEslintDisable) {
    eslintByFile.set(item.file, (eslintByFile.get(item.file) ?? 0) + 1);
  }
  const eslintTopFiles = [...eslintByFile.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP_N);
  lines.push(
    renderTable(
      eslintTopFiles.map(([file, count]) => [file, String(count)]),
      ["File", "Disables"],
    ),
  );
  lines.push("");

  lines.push("## Notes");
  lines.push("");
  lines.push(
    "- Budgets are advisory at this stage. Treat them as review prompts, not CI gates.",
  );
  lines.push(
    "- New production code should not add `any` or `eslint-disable` without a local justification comment.",
  );
  lines.push(
    "- For oversized files, prefer extracting cohesive helpers into `src/lib` modules before adding new functionality.",
  );

  process.stdout.write(lines.join("\n") + "\n");
}

main();
