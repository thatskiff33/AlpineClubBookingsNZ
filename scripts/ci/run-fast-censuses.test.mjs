/**
 * The fast tree-wide censuses and the epic sync that gates on them (#3513).
 *
 * Two things can quietly disarm the owner's "Cheap narrow check" without a
 * single red test anywhere else, and this file is where each one fails:
 *
 * 1. THE LIST ROTS. A suite in `FAST_CENSUS_SUITES` is renamed or deleted, and
 *    the runner keeps passing over a smaller set. Every entry must exist, and
 *    the two script checks must still be what `package.json` runs under their
 *    names.
 * 2. THE WORKFLOW STOPS GATING. `epic-branch-sync.yml` arms auto-merge only
 *    when the censuses passed on the exact composed tree. An edit that moves
 *    the arm outside that branch, drops `--match-head-commit`, or hands the
 *    job that runs the composed tree's code a write token, is a workflow that
 *    still runs green and no longer does what its header says.
 *
 * Text-level by design: the repository carries no YAML parser, and the checks
 * below are about the order and presence of specific lines, which text answers
 * exactly.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  FAST_CENSUS_COMMANDS,
  FAST_CENSUS_SUITES,
  failedSuites,
  parseArgs,
} from "./run-fast-censuses.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (relative) => readFileSync(path.join(REPO_ROOT, relative), "utf8");
const WORKFLOW = read(".github/workflows/epic-branch-sync.yml");
const PACKAGE_SCRIPTS = JSON.parse(read("package.json")).scripts;

/** The text of one job under `jobs:`, from its key to the next job's key. */
function jobBlock(name) {
  const jobs = WORKFLOW.slice(WORKFLOW.indexOf("\njobs:\n"));
  const start = jobs.indexOf(`\n  ${name}:\n`);
  if (start < 0) throw new Error(`no job named ${name}`);
  const rest = jobs.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[A-Za-z][\w-]*:\n/);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

describe("the fast census list", () => {
  it("names suites that exist, once each", () => {
    const paths = FAST_CENSUS_SUITES.map((suite) => suite.path);
    expect(paths.length).toBeGreaterThan(0);
    expect(new Set(paths).size).toBe(paths.length);
    for (const suitePath of paths) {
      expect(suitePath, suitePath).toMatch(/\.test\.tsx?$/);
      expect(existsSync(path.join(REPO_ROOT, suitePath)), suitePath).toBe(true);
    }
  });

  it("gives every entry a reason, so the list stays reviewable", () => {
    for (const entry of [...FAST_CENSUS_SUITES, ...FAST_CENSUS_COMMANDS]) {
      expect(entry.why?.trim().length ?? 0, JSON.stringify(entry)).toBeGreaterThan(10);
    }
  });

  it("leaves out every suite docs/TESTING.md lists as timing out under load", () => {
    const testing = read("docs/TESTING.md");
    const section = testing.slice(
      testing.indexOf("### Suites that time out under load and pass alone"),
      testing.indexOf("## Mocking a money seam"),
    );
    const loadSensitive = [...section.matchAll(/\]\(\.\.\/(src\/[^)]+\.test\.tsx?)\)/g)].map(
      (match) => match[1],
    );
    expect(loadSensitive.length).toBeGreaterThan(0);
    const listed = FAST_CENSUS_SUITES.map((suite) => suite.path);
    for (const suitePath of loadSensitive) expect(listed, suitePath).not.toContain(suitePath);
  });

  it("runs each script check exactly as its package.json script does", () => {
    for (const command of FAST_CENSUS_COMMANDS) {
      expect(existsSync(path.join(REPO_ROOT, command.script)), command.script).toBe(true);
      expect(PACKAGE_SCRIPTS[command.name], command.name).toBe(`${command.runner} ${command.script}`);
    }
  });

  it("is reachable as pnpm run ci:fast-censuses", () => {
    expect(PACKAGE_SCRIPTS["ci:fast-censuses"]).toBe("node scripts/ci/run-fast-censuses.mjs");
  });
});

describe("failedSuites", () => {
  const root = "/repo";
  const report = {
    testResults: [
      { name: "/repo/src/a.test.ts", status: "passed" },
      { name: "/repo/src/b.test.ts", status: "failed" },
    ],
  };

  it("reports a failed suite and passes a passed one", () => {
    expect(failedSuites(report, ["src/a.test.ts", "src/b.test.ts"], root)).toEqual(["src/b.test.ts"]);
  });

  it("counts a suite vitest never reported as failed, not as passed", () => {
    expect(failedSuites(report, ["src/a.test.ts", "src/c.test.ts"], root)).toEqual(["src/c.test.ts"]);
  });

  it("fails every suite when there is no report at all", () => {
    expect(failedSuites(null, ["src/a.test.ts"], root)).toEqual(["src/a.test.ts"]);
  });
});

describe("parseArgs", () => {
  it("reads --base and --summary", () => {
    expect(parseArgs(["--base", "origin/epic/1-x", "--summary", "out.json"])).toEqual({
      base: "origin/epic/1-x",
      summary: "out.json",
    });
  });

  it("refuses an unknown argument or a missing value rather than ignoring it", () => {
    expect(() => parseArgs(["--bsae", "x"])).toThrow(/unknown argument/);
    expect(() => parseArgs(["--base"])).toThrow(/needs a value/);
  });
});

describe("epic-branch-sync.yml gates auto-merge on the composed-tree censuses", () => {
  const censuses = jobBlock("censuses");
  const sync = jobBlock("sync");

  it("grants no write permission at the workflow level", () => {
    const header = WORKFLOW.slice(0, WORKFLOW.indexOf("\njobs:\n"));
    expect(header).toMatch(/\npermissions:\n {2}contents: read\n/);
    expect(header).not.toMatch(/^ {2}[\w-]+: write$/m);
  });

  it("runs the composed tree's code with a read-only token and no persisted credentials", () => {
    expect(censuses).toMatch(/\n {4}permissions:\n {6}contents: read\n/);
    expect(censuses).not.toMatch(/: write\b/);
    expect(censuses).toContain("persist-credentials: false");
    expect(censuses).not.toContain("secrets.");
    expect(censuses).not.toMatch(/\bgit push\b|\bgh /);
  });

  it("merges main into the epic locally and runs pnpm run ci:fast-censuses on it", () => {
    const merge = censuses.indexOf('merge --no-edit --quiet "${main_sha}"');
    const install = censuses.indexOf("pnpm install --frozen-lockfile");
    const run = censuses.indexOf("pnpm run ci:fast-censuses --summary");
    expect(merge).toBeGreaterThan(0);
    expect(install).toBeGreaterThan(merge);
    expect(run).toBeGreaterThan(install);
    expect(censuses).toContain("results: ${{ steps.check.outputs.results }}");
  });

  it("feeds the results to the sync job", () => {
    expect(sync).toMatch(/\n {4}needs: censuses\n/);
    expect(sync).toContain("CENSUS_RESULTS: ${{ needs.censuses.outputs.results }}");
  });

  it("arms auto-merge only inside the census-passed branch, pinned to the tested head", () => {
    const arms = [...sync.matchAll(/gh pr merge [^\n]*--auto\b[^\n]*/g)];
    expect(arms).toHaveLength(1);
    const arm = arms[0];
    expect(arm[0]).toContain('--match-head-commit "${tested_main}"');
    expect(arm[0]).toContain("--merge");

    const gate = sync.indexOf('if [ "${census_status}" = "pass" ]');
    const disarm = sync.indexOf("--disable-auto");
    expect(gate).toBeGreaterThan(0);
    expect(arm.index).toBeGreaterThan(gate);
    expect(disarm).toBeGreaterThan(arm.index);
    // The gate compares the tested SHAs with what would land now.
    const condition = sync.slice(gate, arm.index);
    expect(condition).toContain('"${head_now}" = "${tested_main}"');
    expect(condition).toContain('"${epic_now}" = "${tested_epic}"');
  });

  it("treats a branch with no census result as unchecked, never as a pass", () => {
    expect(sync).toContain(`'.[$b].status // "unchecked"'`);
  });

  it("never force-pushes and never pushes", () => {
    expect(WORKFLOW).not.toMatch(/\bgit push\b|--force-with-lease|push --force/);
  });
});

describe("the documentation names the command", () => {
  it.each(["docs/TESTING.md", "docs/agents/EPIC_PLAYBOOK.md"])("%s", (doc) => {
    expect(read(doc)).toContain("pnpm run ci:fast-censuses");
  });
});
