import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";

import {
  QUARANTINE_FILE,
  readQuarantine,
  realdbFilesToRun,
} from "../../../scripts/ci/realdb-files.mjs";
import { jobBlock, stepBlock } from "./helpers/ci-workflow";

/**
 * #4458: every real-PostgreSQL suite runs in CI, or is named in the quarantine.
 *
 * A `*.realdb.test.ts` file skips itself without `RUN_CONCURRENCY_RACE_TESTS=1`,
 * so a file no CI job runs is green and proves nothing. The advisory
 * `realdb-all` job runs `scripts/ci/realdb-files.mjs`; this census measures that
 * list against the tree with a walk of its own, and pins the job's wiring (a
 * text slice of `ci.yml`, like the other CI-wiring guards in this directory).
 */
const REPO_ROOT = resolve(__dirname, "../../..");
const JOB = "realdb-all";
const workflowDir = join(REPO_ROOT, ".github/workflows");

// Deliberately wider than the script's pattern's intent: any `x.realdb.test.*`
// file, so a new extension the script does not match is a failure, not a gap.
function realdbFilesOnDisk(): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules") walk(full);
      } else if (/\.realdb\.test\./.test(entry.name)) {
        found.push(relative(REPO_ROOT, full).split(sep).join("/"));
      }
    }
  };
  walk(join(REPO_ROOT, "src"));
  return found.sort();
}

/** YAML with whole-line comments removed, so a comment cannot satisfy or trip a check. */
const withoutComments = (yaml: string) =>
  yaml
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");

const ci = readFileSync(join(workflowDir, "ci.yml"), "utf8");
const job = withoutComments(jobBlock(ci, JOB));

describe("every real-PostgreSQL suite runs in CI (#4458)", () => {
  it("finds the realdb files (the walk is not vacuous)", () => {
    expect(realdbFilesOnDisk().length).toBeGreaterThan(50);
  });

  it("runs every realdb file on disk, or names it in the quarantine", () => {
    const covered = new Set([...realdbFilesToRun(), ...readQuarantine()]);
    const missing = realdbFilesOnDisk().filter((file) => !covered.has(file));
    expect(
      missing,
      `These realdb files are not run by the ${JOB} job (scripts/ci/realdb-files.mjs) and are not in ${QUARANTINE_FILE}. A realdb file that no job runs is green in CI and proves nothing; fix scripts/ci/realdb-files.mjs, or quarantine the file with its issue.`,
    ).toEqual([]);
  });

  it("only quarantines files that exist, and never runs a quarantined file", () => {
    const onDisk = new Set(realdbFilesOnDisk());
    const quarantined = readQuarantine();
    expect(quarantined.filter((file) => !onDisk.has(file)), "stale quarantine entries").toEqual([]);
    const toRun = new Set(realdbFilesToRun());
    expect(quarantined.filter((file) => toRun.has(file))).toEqual([]);
  });

  it("has a job that sets RUN_CONCURRENCY_RACE_TESTS=1 and a database", () => {
    expect(job, `ci.yml has no \`${JOB}\` job`).not.toBe("");
    expect(job).toMatch(/\n {6}RUN_CONCURRENCY_RACE_TESTS: "1"\n/);
    expect(job).toContain("concurrency-race-postgres:");
    expect(job).toContain("CONCURRENCY_RACE_DATABASE_URL");
    expect(job).toContain("pnpm exec prisma migrate deploy");
    // Measured at 9m02s in PR CI (#4476); a hung run must not hold a runner for 45.
    expect(job).toMatch(/\n {4}timeout-minutes: 20\n/);
  });

  it("runs the files the script lists, in one vitest process, without skipping", () => {
    const step = stepBlock(job, "Run every real-PostgreSQL suite");
    // The list is captured with a failing command and checked for empty: a
    // `mapfile < <(node ...)` hides the script's exit status, and `vitest run`
    // with no paths runs the whole unit suite instead of failing.
    expect(step).toContain("set -euo pipefail");
    expect(step).toContain("files_text=$(node scripts/ci/realdb-files.mjs)");
    expect(step).not.toContain("< <(");
    const emptyGuard = step.indexOf('if [ -z "$files_text" ]; then');
    expect(emptyGuard, "an empty file list must stop the step").toBeGreaterThan(
      step.indexOf("files_text=$(node"),
    );
    expect(step.indexOf("exit 1", emptyGuard)).toBeLessThan(step.indexOf("pnpm exec vitest run"));
    expect(step).toContain('mapfile -t files <<< "$files_text"');
    expect(step).toMatch(/pnpm exec vitest run [^\n]*--reporter=json [^\n]*"\$\{files\[@\]\}"/);
    expect(step).not.toMatch(/\n\s+if:/);
    expect(job).not.toMatch(/continue-on-error:/);
    expect(job).not.toMatch(/\n {4}if:/);
  });

  it("fails the job when a listed suite skipped itself or never ran", () => {
    const run = stepBlock(job, "Run every real-PostgreSQL suite");
    const report = run.match(/--outputFile\.json="([^"]+)"/)?.[1];
    expect(report, "the run writes a JSON report").toBeTruthy();
    const check = stepBlock(job, "Require every listed suite to have really run");
    expect(check).toContain(`node scripts/ci/check-realdb-ran.mjs "${report}"`);
    expect(check).not.toMatch(/\n\s+if:/);
    expect(job.indexOf("Require every listed suite")).toBeGreaterThan(
      job.indexOf("Run every real-PostgreSQL suite"),
    );
  });

  it("points the three data-migration suites at the race database", () => {
    // They skip without this URL and each creates scratch databases of its own;
    // the zero-skip check above would fail the job if it were dropped.
    const endpoint = stepBlock(job, "Resolve dedicated race database endpoint");
    expect(endpoint).toContain(
      "printf 'DATA_MIGRATION_VERIFICATION_DATABASE_URL=%s\\n' \"$CONCURRENCY_RACE_DATABASE_URL\" >> \"$GITHUB_ENV\"",
    );
  });

  it("stays advisory: no workflow job depends on it or names it", () => {
    // `needs:`, `needs.realdb-all.result`, a gate step's `--job`: any mention
    // outside the job itself would let a failure here block, or a skip here
    // pass, a required check (owner ruling, 1 Sep 2026).
    for (const file of readdirSync(workflowDir).filter((f) => /\.ya?ml$/.test(f))) {
      const text = readFileSync(join(workflowDir, file), "utf8");
      const rest = withoutComments(text.replace(jobBlock(text, JOB), ""));
      expect(rest, `${file} mentions ${JOB} outside its own job`).not.toContain(JOB);
    }
  });
});
