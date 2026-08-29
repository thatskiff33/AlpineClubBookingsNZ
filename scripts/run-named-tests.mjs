#!/usr/bin/env node
/**
 * Fail-closed wrapper for running vitest suites by explicit path (#3120).
 *
 * `npx vitest run <path1> <path2>` silently DROPS a path that matches no test
 * file as long as at least one other named path matches — it still exits 0
 * and reports a "passed" count with nothing in the output naming what was
 * skipped. Measured on vitest 4.1.10:
 *
 *   npx vitest run real.test.ts DOES-NOT-EXIST.test.ts
 *   -> Test Files  1 passed (1)
 *   -> exit 0
 *
 * `AGENTS.md` requires a lane to run disk-scanning census/contract suites by
 * name, precisely because `npm run test:related` cannot reach them through
 * the module graph. That is exactly the invocation shape this vitest defect
 * corrupts: a mistyped, renamed, or stale path is silently skipped and the
 * lane reports a count that looks correct and is not (found on epic #2988,
 * where two of twelve named paths were absent and ten ran with no complaint).
 *
 * This wrapper refuses to run anything until every named path clears TWO
 * checks, and names every offending path — never just the first:
 *
 *   1. The path exists on disk at all (a `[ -f "$f" ]`-equivalent pre-check —
 *      cheap, and gives the best message for the common mistyped/deleted case).
 *   2. `vitest list --filesOnly` actually matches it to a collected test file
 *      (catches the rarer case a disk check cannot: a path that exists but
 *      matches no test — e.g. it doesn't satisfy vitest's own `test.include`
 *      glob, or a suite was gutted to zero tests).
 *
 * Deliberately never passes `--passWithNoTests` to vitest anywhere in this
 * file: that flag makes vitest's own zero-match case exit 0 too, which is the
 * opposite of fail-closed.
 *
 * Usage:
 *   npm run test:named -- <path> [<path> ...]
 *   node scripts/run-named-tests.mjs <path> [<path> ...]
 *
 * Exit codes: 1 for a bad invocation or a refused (unresolved-path) run, and
 * whatever `vitest run` itself exits with once every path has cleared both
 * checks.
 */
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

const require = createRequire(import.meta.url);

/**
 * Resolve vitest's own CLI entry script and run it with `process.execPath`,
 * rather than shelling out to `npx vitest` or `node_modules/.bin/vitest`.
 * Spawning the `.cmd` shim without a shell fails on Windows with
 * `spawnSync ...vitest.cmd EINVAL` (Node's .cmd/.bat spawn restriction), and
 * `shell: true` would then need argument quoting to be right on both
 * platforms. Resolving the package's declared bin avoids both, exactly as
 * `scripts/rehearse-epic-deploy.ts` already does for the Prisma CLI.
 */
function resolveVitestBin() {
  const vitestPkgPath = require.resolve("vitest/package.json");
  const vitestPkg = require(vitestPkgPath);
  const binRel =
    typeof vitestPkg.bin === "string" ? vitestPkg.bin : vitestPkg.bin.vitest;
  return path.join(path.dirname(vitestPkgPath), binRel);
}

function runVitest(vitestBin, args) {
  return spawnSync(process.execPath, [vitestBin, ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
}

function fail(lines) {
  for (const line of lines) process.stderr.write(`${line}\n`);
  process.exit(1);
}

const paths = process.argv.slice(2);

if (paths.length === 0) {
  fail([
    "usage: node scripts/run-named-tests.mjs <path> [<path> ...]",
    "  (or: npm run test:named -- <path> [<path> ...])",
  ]);
}

if (paths.includes("--passWithNoTests")) {
  fail([
    "refusing: --passWithNoTests is not allowed through this wrapper — it " +
      "makes vitest's zero-match case exit 0 too, which defeats the point.",
  ]);
}

// 1. Disk pre-check, before anything else runs. Names EVERY absent path.
const missing = paths.filter((p) => !existsSync(p));
if (missing.length > 0) {
  fail([
    `refusing to run: ${missing.length} named path(s) do not exist:`,
    ...missing.map((p) => `  MISSING: ${p}`),
  ]);
}

const vitestBin = resolveVitestBin();

// 2. Ask vitest which of these paths it actually collects as test files, and
//    diff asked-against-matched. Catches a path that exists on disk but is
//    not a test vitest recognises — the class the disk check above cannot see.
const listResult = runVitest(vitestBin, ["list", ...paths, "--filesOnly"]);

if (listResult.error) {
  fail([`refusing to run: could not launch vitest — ${listResult.error.message}`]);
}
if (listResult.status !== 0) {
  fail([
    "refusing to run: `vitest list` could not enumerate the named paths " +
      `(exit ${listResult.status}). Its output:`,
    listResult.stdout,
    listResult.stderr,
  ]);
}

const matched = listResult.stdout
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter(Boolean)
  .map((line) => line.replace(/\\/g, "/"));

const unmatched = paths.filter((p) => {
  const normalized = p.replace(/\\/g, "/");
  return !matched.some((m) => m === normalized || m.endsWith(`/${normalized}`));
});

if (unmatched.length > 0) {
  fail([
    `refusing to run: asked ${paths.length} path(s), matched ${matched.length}. ` +
      `${unmatched.length} named path(s) matched no test:`,
    ...unmatched.map((p) => `  NO MATCH: ${p}`),
  ]);
}

// 3. Every path exists and is a real, collected test file. Run them for real.
const runResult = spawnSync(process.execPath, [vitestBin, "run", ...paths], {
  cwd: process.cwd(),
  stdio: "inherit",
});

if (runResult.error) {
  fail([`could not launch vitest run — ${runResult.error.message}`]);
}

process.exit(runResult.status ?? 1);
