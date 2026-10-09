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
 * 2. THE WORKFLOW STOPS GATING. `epic-branch-sync.yml` merges immediately only
 *    when the censuses passed on the exact composed tree. An edit that moves
 *    the merge outside that branch, drops `--match-head-commit`, or hands the
 *    job that runs the composed tree's code a write token, is a workflow that
 *    still runs green and no longer does what its header says.
 *
 * Text-level by design: the repository carries no YAML parser, and the checks
 * below are about the order and presence of specific lines, which text answers
 * exactly.
 */
import { execFileSync } from "node:child_process";
import { resolveInvariantBaselineRef } from "./check-doc-index-integrity.mjs";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import {
  FAST_CENSUS_COMMANDS,
  FAST_CENSUS_SUITES,
  failedSuites,
  main,
  commandArgs,
  parseArgs,
} from "./run-fast-censuses.mjs";

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => ({ ...(await importOriginal()), spawnSync: spawn }));

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
      const args = commandArgs(command.name);
      const script = args.find((arg) => arg.startsWith("scripts/"));
      expect(existsSync(path.join(REPO_ROOT, script)), command.name).toBe(true);
      expect(PACKAGE_SCRIPTS[command.name], command.name).toContain(script);
    }
  });

  it("is reachable as pnpm run ci:fast-censuses", () => {
    expect(PACKAGE_SCRIPTS["ci:fast-censuses"]).toBe("node scripts/ci/run-fast-censuses.mjs");
  });
});

describe("runner execution", () => {
  function simulate(vitestStatus = 0) {
    spawn.mockReset();
    spawn.mockImplementation((_node, args) => {
      const output = args.find((arg) => arg.startsWith("--outputFile="));
      if (output) writeFileSync(output.slice("--outputFile=".length), JSON.stringify({
        testResults: FAST_CENSUS_SUITES.map(({ path: suite }) => ({ name: path.join(REPO_ROOT, suite), status: "passed" })),
      }));
      return { status: output ? vitestStatus : 0 };
    });
  }

  it.each([1, null])("fails Vitest process status %s even when every suite reports passed", (status) => {
    simulate(status);
    expect(main([], {})).toEqual({ ok: false, failed: ["vitest process"] });
  });

  it.each(["schedule", "workflow_dispatch"])("uses the exact diagnostic base under %s without changing other child identities", (event) => {
    simulate();
    const exactBase = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
    const inherited = { GITHUB_EVENT_NAME: event, GITHUB_REF: "refs/heads/main", GITHUB_REF_NAME: "main", GITHUB_BASE_REF: "main", PR_BASE_SHA: "inherited-pr", PUSH_BASE_SHA: "inherited-push", DOC_INDEX_BASE_REF: "wrong-base" };
    expect(main(["--base", exactBase], inherited).ok).toBe(true);
    const docCall = spawn.mock.calls.find(([, args]) => args.includes("scripts/ci/check-doc-index-integrity.mjs"));
    expect(docCall[2].env.DOC_INDEX_BASE_REF).toBe(exactBase);
    expect(resolveInvariantBaselineRef(REPO_ROOT, docCall[2].env)).toBe(exactBase);
    for (const key of Object.keys(inherited).filter((key) => key !== "DOC_INDEX_BASE_REF")) expect(docCall[2].env[key], key).toBeUndefined();
    const budget = spawn.mock.calls.find(([, args]) => args.includes("scripts/ci/check-file-size-budget.ts"));
    expect(budget[1].slice(-2)).toEqual(["--base", exactBase]);
    expect(budget[2].env.GITHUB_EVENT_NAME).toBe(event);
    expect(inherited.GITHUB_EVENT_NAME).toBe(event);
  });

  it("preserves ordinary event authority without an explicit diagnostic base", () => {
    simulate();
    main([], { GITHUB_EVENT_NAME: "pull_request", PR_BASE_SHA: "authoritative" });
    const docCall = spawn.mock.calls.find(([, args]) => args.includes("scripts/ci/check-doc-index-integrity.mjs"));
    expect(docCall[2].env.GITHUB_EVENT_NAME).toBe("pull_request");
    expect(docCall[2].env.PR_BASE_SHA).toBe("authoritative");
  });

  it("derives invocation changes from package.json and refuses shell grammar", () => {
    expect(commandArgs("check", { check: "node scripts/changed.mjs --strict" })).toEqual(["scripts/changed.mjs", "--strict"]);
    expect(() => commandArgs("check", { check: "node scripts/check.mjs && echo pass" })).toThrow(/INV-SSOT-001/);
    expect(() => commandArgs("missing", {})).toThrow(/INV-SSOT-001/);
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

describe("epic-branch-sync.yml gates immediate merges on the composed-tree censuses", () => {
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
    const run = censuses.indexOf('pnpm run ci:fast-censuses --base "${epic_sha}" --summary');
    expect(merge).toBeGreaterThan(0);
    expect(install).toBeGreaterThan(merge);
    expect(run).toBeGreaterThan(install);
    expect(censuses).toContain("results: ${{ steps.check.outputs.results }}");
  });

  it("feeds the results to the sync job", () => {
    expect(sync).toMatch(/\n {4}needs: censuses\n/);
    expect(sync).toContain("CENSUS_RESULTS: ${{ needs.censuses.outputs.results }}");
  });

  it("merges only inside the census-passed branch, pinned to the tested head", () => {
    const merges = [...sync.matchAll(/gh pr merge [^\n]*--merge\b[^\n]*/g)];
    expect(merges).toHaveLength(1);
    expect(sync).not.toMatch(/gh pr merge [^\n]*--auto\b/);

    const gate = sync.indexOf('if [ "${census_status}" = "pass" ]');
    const disarm = sync.indexOf("--disable-auto");
    expect(gate).toBeGreaterThan(0);
    for (const merge of merges) {
      expect(merge[0]).toContain('--match-head-commit "${tested_main}"');
      expect(merge.index).toBeGreaterThan(gate);
      expect(disarm).toBeLessThan(gate);
    }
    // The gate compares the tested SHAs with what would land now.
    const condition = sync.slice(gate, merges[0].index);
    expect(condition).toContain('"${head_now}" = "${tested_main}"');
    expect(condition).toContain('"${epic_now}" = "${tested_epic}"');
  });

  it("disarms deferred merges before reading tips and refuses to act if disarming fails", () => {
    expect(sync).toContain('if ! gh pr merge "${existing}" --disable-auto >/dev/null; then');
    const disable = sync.indexOf("--disable-auto");
    const head = sync.indexOf('head_now="$(gh pr view');
    expect(disable).toBeLessThan(head);
    expect(sync.slice(disable, head)).toMatch(/continue\n\s*fi/);
    expect(sync.slice(0, disable)).toContain('if [ "${auto_request}" = "true" ]; then');
  });

  it.each([
    ["false", 0, true, false],
    ["true", 0, true, true],
    ["true", 1, false, true],
    ["query-error", 0, false, false],
    ["", 0, false, false],
    ["null", 0, false, false],
  ])("handles auto-merge state %s and disable exit %s before acting", (state, disableStatus, proceeds, disables) => {
    const block = sync.slice(sync.indexOf('            if ! auto_request='), sync.indexOf('            # THE CENSUS GATE'));
    expect(block).toContain("--jq '.autoMergeRequest != null'");
    const output = execFileSync("bash", [], {
      encoding: "utf8",
      input: `gh() {
        if [ "$2" = "view" ]; then
          [ "$AUTO_STATE" != "query-error" ] || return 1
          printf '%s\\n' "$AUTO_STATE"
        else
          disabled=1
          return "$DISABLE_STATUS"
        fi
      }
      disabled=0
      for branch in epic/test; do
        existing=1
        ${block}
        echo PROCEED
      done
      echo DID_DISABLE=$disabled`,
      env: { ...process.env, AUTO_STATE: state, DISABLE_STATUS: String(disableStatus) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    expect(output.includes("PROCEED")).toBe(proceeds);
    expect(output.includes("DID_DISABLE=1")).toBe(disables);
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
