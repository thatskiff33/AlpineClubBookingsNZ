#!/usr/bin/env node
// The real-PostgreSQL test files the advisory `realdb-all` CI job runs (#4458).
//
// ONE SOURCE (INV-SSOT): this module is both the job's file list and what
// `src/lib/__tests__/realdb-ci-coverage-census.test.ts` measures the job
// against. The job passes the printed paths to one `vitest run`; the census
// walks the tree on its own and fails when a `*.realdb.test.*` file exists
// that neither this list nor `realdb-quarantine.txt` accounts for.
//
// Usage: node scripts/ci/realdb-files.mjs   (one repo-relative path per line)

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "../lib/is-main-module.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const REALDB_FILE = /\.realdb\.test\.[cm]?[jt]sx?$/;
export const QUARANTINE_FILE = "scripts/ci/realdb-quarantine.txt";
// The only place Vitest collects tests from (vitest.config.mts excludes e2e/).
const SEARCH_ROOT = "src";

/** Every `*.realdb.test.ts` under `src/`, repo-relative with `/` separators. */
export function findRealdbFiles(repoRoot = REPO_ROOT) {
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules") walk(full);
      } else if (REALDB_FILE.test(entry.name)) {
        found.push(relative(repoRoot, full).split(sep).join("/"));
      }
    }
  };
  walk(join(repoRoot, SEARCH_ROOT));
  return found.sort();
}

/**
 * Paths named in the quarantine file: one per line, `#` starts a comment.
 * A quarantined suite is red for a reason that has its own issue; put the
 * issue number in the comment.
 */
export function readQuarantine(repoRoot = REPO_ROOT) {
  return readFileSync(join(repoRoot, QUARANTINE_FILE), "utf8")
    .split("\n")
    .map((line) => line.replace(/#.*$/, "").trim())
    .filter(Boolean);
}

/** What the job runs: every realdb file minus the quarantine. */
export function realdbFilesToRun(repoRoot = REPO_ROOT) {
  const quarantined = new Set(readQuarantine(repoRoot));
  return findRealdbFiles(repoRoot).filter((file) => !quarantined.has(file));
}

if (isMainModule(import.meta.url)) {
  process.stdout.write(`${realdbFilesToRun().join("\n")}\n`);
}
