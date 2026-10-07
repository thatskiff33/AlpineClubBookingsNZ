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

  it("restores no dependency cache, so epic code never writes main's cache scope", () => {
    expect(censuses).not.toMatch(/^\s*cache:/m);
    expect(censuses).not.toContain("actions/cache");
  });

  it("runs every command from the composed tree with the runner's command files unset", () => {
    expect(censuses).toContain(
      'env -u GITHUB_OUTPUT -u GITHUB_ENV -u GITHUB_PATH -u GITHUB_STEP_SUMMARY "$@"',
    );
    const pnpmLines = censuses.split("\n").filter((line) => /\bpnpm (install|run|exec)\b/.test(line));
    expect(pnpmLines.length).toBeGreaterThanOrEqual(2);
    for (const line of pnpmLines) expect(line, line).toMatch(/\buntrusted pnpm /);
  });

  it("starts every branch from a fully clean tree and fails closed when it cannot", () => {
    expect(censuses).toContain(
      'if ! git checkout --quiet --force --detach "${epic_sha}" || ! git clean -ffdxq; then\n              status="error"',
    );
  });

  it("re-checks once in the same run when main or the epic moved", () => {
    const fetch = censuses.indexOf("git fetch --quiet origin");
    const recheck = censuses.indexOf('check_branch "${branch}" "${new_main}"');
    expect(fetch).toBeGreaterThan(0);
    expect(recheck).toBeGreaterThan(fetch);
    expect(censuses.indexOf('echo "results=${results}" >> "${GITHUB_OUTPUT}"')).toBeGreaterThan(recheck);
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

  it("merges or arms only inside the census-passed branch, pinned to the tested head", () => {
    const merges = [...sync.matchAll(/gh pr merge [^\n]*--merge\b[^\n]*/g)];
    // One immediate merge (already CLEAN) and one auto-merge arm, nothing else.
    expect(merges).toHaveLength(2);
    expect(merges.filter((m) => /--auto\b/.test(m[0]))).toHaveLength(1);

    const gate = sync.indexOf('if [ "${census_status}" = "pass" ]');
    const disarm = sync.indexOf("--disable-auto");
    expect(gate).toBeGreaterThan(0);
    for (const merge of merges) {
      expect(merge[0]).toContain('--match-head-commit "${tested_main}"');
      expect(merge.index).toBeGreaterThan(gate);
      expect(disarm).toBeGreaterThan(merge.index);
    }
    // The gate compares the tested SHAs with what would land now.
    const condition = sync.slice(gate, merges[0].index);
    expect(condition).toContain('"${head_now}" = "${tested_main}"');
    expect(condition).toContain('"${epic_now}" = "${tested_epic}"');
  });

  it("re-reads the epic tip from the remote right before the gate, since the head pin cannot cover it", () => {
    const reread = sync.indexOf('epic_now="$(git ls-remote origin "refs/heads/${branch}" | cut -f1)"');
    const gate = sync.indexOf('if [ "${census_status}" = "pass" ]');
    expect(reread).toBeGreaterThan(0);
    expect(gate).toBeGreaterThan(reread);
    // Nothing between the re-read and the gate re-assigns it from a stale ref.
    expect(sync.slice(sync.indexOf("\n", reread), gate)).not.toMatch(/\bepic_now="\$\(/);
  });

  it("merges at once only when GitHub reports the pull request CLEAN", () => {
    const direct = [...sync.matchAll(/gh pr merge [^\n]*--merge\b[^\n]*/g)].find(
      (m) => !/--auto\b/.test(m[0]),
    );
    expect(direct).toBeDefined();
    const before = sync.slice(0, direct.index);
    const clean = before.lastIndexOf('if [ "${merge_state}" = "CLEAN" ]; then');
    expect(clean).toBeGreaterThan(0);
    expect(sync.slice(clean, direct.index)).not.toMatch(/\n\s*(else|fi)\b/);
  });

  it("treats a branch with no census result as unchecked, never as a pass", () => {
    expect(sync).toContain(`'.[$b].status // "unchecked"'`);
  });

  it("treats a branch that already contained the tested main as waiting, not unchecked", () => {
    expect(censuses).toContain("record \"${branch}\" current");
    expect(sync).toMatch(/\n\s*pass\|current\)\n/);
  });

  it("checks the epic-branch name in sync before touching GitHub for it", () => {
    const loop = sync.indexOf('for branch in ${branches}; do');
    const nameCheck = sync.indexOf("grep -Eq '^epic/[A-Za-z0-9._/-]+$'", loop);
    const firstGh = sync.indexOf("gh pr ", loop);
    expect(nameCheck).toBeGreaterThan(loop);
    expect(firstGh).toBeGreaterThan(nameCheck);
  });

  it("counts only this workflow's own comments when looking for the marker", () => {
    const read = sync.slice(sync.indexOf('comments="$(gh api --paginate'));
    const call = read.slice(0, read.indexOf(')"; then'));
    expect(call).toContain(`--jq '.[] | select(.user.login == "github-actions[bot]") | .body'`);
  });

  it("caps the untrusted failure list before it reaches --argjson, and keeps results when a record fails", () => {
    expect(censuses).toContain(`failed="$(jq -c '.failed[:20] | map(tostring | .[:200])' "\${summary}")"`);
    expect(censuses).not.toMatch(/jq -c '\.failed(?!\[:20\])/);
    const record = censuses.slice(censuses.indexOf("record() {"), censuses.indexOf("check_branch() {"));
    // Each new value (the full record, then the list-less fallback) is assigned
    // only after jq succeeded AND produced output.
    const assignments = record.match(/results="\$\{updated\}"/g) ?? [];
    const guarded = record.match(/&& \[ -n "\$\{updated\}" \]; then\n\s*results="\$\{updated\}"/g) ?? [];
    expect(assignments).toHaveLength(2);
    expect(guarded).toHaveLength(2);
    expect(record).not.toMatch(/^\s*results="\$\(jq/m);
  });

  it("reads every comment into a variable before looking for the marker", () => {
    expect(sync).toContain('comments="$(gh api --paginate');
    expect(sync).toContain('grep -qF -- "${marker}" <<<"${comments}"');
    expect(sync).not.toMatch(/gh pr view [^\n]*--json comments/);
  });

  it("pastes failing names only sanitised, capped and fenced", () => {
    expect(sync).toContain('gsub("[`\\u0000-\\u001f\\u007f]"; "")');
    expect(sync).toContain("$f[:10][]");
    expect(sync).toContain(".[:200]");
    const fenceOpen = sync.indexOf('"${fence}text"');
    const list = sync.indexOf('"${failed_list}"', fenceOpen);
    const fenceClose = sync.indexOf('"${fence}"', list);
    expect(fenceOpen).toBeGreaterThan(0);
    expect(list).toBeGreaterThan(fenceOpen);
    expect(fenceClose).toBeGreaterThan(list);
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
