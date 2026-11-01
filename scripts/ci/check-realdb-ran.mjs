#!/usr/bin/env node
// Fails the `realdb-all` job when a real-PostgreSQL file it lists did not
// really run (#4458).
//
// A realdb suite skips itself with `describe.skip` when its gate (an env var, a
// database URL) is unset, and Vitest reports that as a green file. Vitest also
// ignores a path that matches nothing, so a listed file can drop out of the run
// without a failure. Either way the job would read green and prove nothing, so
// the run's JSON report is measured against the file list: every listed file
// must be in the report, have at least one passing test, and have no skipped,
// pending or todo test.
//
// Usage: node scripts/ci/check-realdb-ran.mjs <vitest-json-report>
//   (the file list is `scripts/ci/realdb-files.mjs`, the one the job ran)

import { readFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { realdbFilesToRun } from "./realdb-files.mjs";
import { isMainModule } from "../lib/is-main-module.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * One line per listed file that did not really run: absent from the report,
 * zero passing tests, or any test that did not run. Empty means all ran.
 * @param {{ testResults?: Array<{ name: string, assertionResults?: Array<{ status: string }> }> }} report
 * @param {string[]} files repo-relative paths with `/` separators
 */
export function unexercisedRealdbFiles(report, files, repoRoot = REPO_ROOT) {
  const byFile = new Map(
    (report.testResults ?? []).map((result) => [
      relative(repoRoot, result.name).split(sep).join("/"),
      result.assertionResults ?? [],
    ]),
  );
  const problems = [];
  for (const file of files) {
    const tests = byFile.get(file);
    if (tests === undefined) {
      problems.push(`${file}: not in the Vitest report (the run never collected it)`);
      continue;
    }
    const count = (status) => tests.filter((test) => test.status === status).length;
    const notRun = tests.length - count("passed") - count("failed");
    if (count("passed") === 0) {
      problems.push(`${file}: no test passed (${tests.length} reported, ${notRun} not run)`);
    } else if (notRun > 0) {
      problems.push(`${file}: ${notRun} of ${tests.length} tests did not run (skipped or todo)`);
    }
  }
  return problems;
}

function main(reportPath) {
  if (!reportPath) {
    console.error("usage: node scripts/ci/check-realdb-ran.mjs <vitest-json-report>");
    return 2;
  }
  const files = realdbFilesToRun();
  const problems = unexercisedRealdbFiles(JSON.parse(readFileSync(reportPath, "utf8")), files);
  if (problems.length > 0) {
    console.error(
      `${problems.length} of ${files.length} real-PostgreSQL files did not really run. A suite that skips itself reads as green and proves nothing; wire what it needs in the realdb-all job (.github/workflows/ci.yml), or quarantine it in scripts/ci/realdb-quarantine.txt with its issue.`,
    );
    for (const problem of problems) console.error(`  ${problem}`);
    return 1;
  }
  console.log(`All ${files.length} real-PostgreSQL files ran: each has passing tests and none skipped.`);
  return 0;
}

if (isMainModule(import.meta.url)) {
  process.exitCode = main(process.argv[2]);
}
