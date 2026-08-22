import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  auditWorkflows,
  checkWorkingTree,
  classifyRunScript,
  parseWorkflowYaml,
  readsRepositoryHistory,
  SUITE_HISTORY_EXPLANATION,
  tokenizeShellCommands,
} from "./check-workflow-suite-checkout-depth.mjs";

/*
  HEADROOM, NOT COVER FOR A SLOW TEST.

  Several cases here spawn the checker as a child process, and the
  real-repository cases parse every workflow and read every test file a targeted
  invocation names. Under vitest's 5-second default that work does not reliably
  finish on a busy runner, and a *different* case loses each time — the exact
  shape #2909's own thread reports for
  `scripts/ci/check-doc-index-integrity.test.mjs`, where 1481 of 1482 suites
  passed alongside one `Test timed out in 5000ms`. Same treatment, same
  reasoning. If a case here ever genuinely needs a minute that is a real
  regression worth looking at; this only stops the clock deciding which
  assertion runs.
*/
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
const CHECKER_PATH = path.join(
  REPO_ROOT,
  "scripts",
  "ci",
  "check-workflow-suite-checkout-depth.mjs",
);

const TEMP_ROOTS = new Set();

afterEach(() => {
  for (const root of TEMP_ROOTS) rmSync(root, { force: true, recursive: true });
  TEMP_ROOTS.clear();
});

/** A throwaway repository root holding only `.github/workflows/<name>` files. */
function fixtureRepo(workflows) {
  const root = mkdtempSync(path.join(tmpdir(), "workflow-depth-"));
  TEMP_ROOTS.add(root);
  mkdirSync(path.join(root, ".github", "workflows"), { recursive: true });
  for (const [name, source] of Object.entries(workflows)) {
    writeFileSync(path.join(root, ".github", "workflows", name), source, "utf8");
  }
  return root;
}

function writeFixtureFile(root, relativePath, contents) {
  const absolute = path.join(root, relativePath);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, contents, "utf8");
}

function audit(workflows, files = {}) {
  return auditWorkflows({
    workflows: Object.entries(workflows).map(([name, source]) => ({
      path: `.github/workflows/${name}`,
      source,
    })),
    readSourceFile: (relativePath) => files[relativePath],
  });
}

/** A job that runs the whole suite, parameterised on its checkout inputs. */
function suiteWorkflow({ checkoutWith = "", run = "npm test" } = {}) {
  return [
    "name: Fixture",
    "on:",
    "  push:",
    "    branches:",
    "      - main",
    "jobs:",
    "  unit:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - name: Check out repository",
    "        uses: actions/checkout@v7",
    ...(checkoutWith ? ["        with:", `          ${checkoutWith}`] : []),
    "",
    "      - name: Run the suite",
    `        run: ${run}`,
    "",
  ].join("\n");
}

describe("the YAML reader", () => {
  it("reads jobs, steps, block scalars and sha-pinned actions", () => {
    const document = parseWorkflowYaml(
      [
        "name: Fixture",
        "# a comment nobody should see in the tree",
        "on:",
        "  push:",
        "    branches:",
        "      - main",
        "env:",
        "  NEXTAUTH_URL: http://localhost:3000",
        '  AUTH_TRUST_HOST: "false"',
        "jobs:",
        "  unit:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - name: Check out repository",
        "        uses: actions/checkout@9c091bb # v7",
        "        with:",
        "          fetch-depth: 0",
        "",
        "      - name: Multi-line",
        "        run: |",
        "          echo one # not a yaml comment",
        "",
        "          npm test",
        "      - name: After the block",
        "        run: npm run lint",
        "",
      ].join("\n"),
    );

    expect(document.name).toBe("Fixture");
    expect(document.on.push.branches).toEqual(["main"]);
    // A URL's colon must not be read as a key separator.
    expect(document.env.NEXTAUTH_URL).toBe("http://localhost:3000");
    expect(document.env.AUTH_TRUST_HOST).toBe("false");

    const steps = document.jobs.unit.steps;
    expect(steps).toHaveLength(3);
    // A trailing `# v7` on a sha-pinned action is a comment, not part of the ref.
    expect(steps[0].uses).toBe("actions/checkout@9c091bb");
    expect(steps[0].with["fetch-depth"]).toBe("0");
    // A `#` inside a block scalar is shell, and the blank line inside it is kept.
    expect(steps[1].run).toBe("echo one # not a yaml comment\n\nnpm test");
    expect(steps[2].run).toBe("npm run lint");
  });

  it("folds a `>` block scalar and keeps a `|` one line-separated", () => {
    const document = parseWorkflowYaml(
      [
        "jobs:",
        "  unit:",
        "    steps:",
        "      - run: >",
        "          echo a",
        "          echo b",
        "      - run: |-",
        "          echo a",
        "          echo b",
        "",
      ].join("\n"),
    );

    expect(document.jobs.unit.steps[0].run).toBe("echo a echo b");
    expect(document.jobs.unit.steps[1].run).toBe("echo a\necho b");
  });

  it("reports a workflow it cannot read as a problem instead of passing it", () => {
    const { problems } = audit({
      "broken.yml": ["jobs:", "  unit:", "      bogus indentation", ""].join("\n"),
    });

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("could not be parsed");
    // The remedy must point at widening the reader, not at deleting the gate.
    expect(problems[0]).toContain("widen the reader");
  });
});

describe("classifying a `run:` script", () => {
  it("finds the faketime-wrapped whole-suite invocation the canary really uses", () => {
    // Verbatim from .github/workflows/clock-rollover-canary.yml. This is the one
    // line #2909 says a check MUST match: a gate that misses it is worse than no
    // gate, because it certifies the job it was written for.
    const line =
      "faketime -f '${{ matrix.offset }}' npm test -- --testTimeout=30000 --hookTimeout=30000 --retry=2";

    expect(classifyRunScript(line)).toEqual([
      {
        command:
          "npm test -- --testTimeout=30000 --hookTimeout=30000 --retry=2",
        selectors: [],
        kind: "full-suite",
      },
    ]);
  });

  it.each([
    ["npm test", "npm test"],
    ["npm run test", "npm run test"],
    ["npm t", "npm t"],
    ["an environment prefix", "CI=true NODE_ENV=test npm test"],
    ["a time wrapper", "time npm run test"],
    ["npx vitest with only flags", "npx vitest run --testTimeout=30000"],
    ["bare vitest", "npx vitest"],
    ["the local binary", "./node_modules/.bin/vitest run"],
    ["a && chain", "npm run db:generate && npm test"],
    ["a multi-line block", "npm ci\nnpm run lint\nnpm test\n"],
    ["a line continuation", "npm test \\\n  --retry=2"],
    // A space-separated flag value must not read as a file selector and quietly
    // demote a whole-suite run to a targeted one.
    ["a space-separated flag value", "npm test -- --retry 2"],
  ])("treats %s as the whole suite", (_label, script) => {
    const invocations = classifyRunScript(script);
    expect(invocations.map((invocation) => invocation.kind)).toContain("full-suite");
  });

  it.each([
    ["npx vitest run src/lib/__tests__/a.realdb.test.ts"],
    ["npx vitest run --testTimeout=30000 src/lib/__tests__/a.realdb.test.ts"],
    ["npx vitest related --run src/lib/thing.ts"],
  ])("treats %s as targeted", (script) => {
    const invocations = classifyRunScript(script);
    expect(invocations).toHaveLength(1);
    expect(invocations[0].kind).toBe("targeted");
  });

  it("collects the paths a targeted invocation names", () => {
    expect(
      classifyRunScript("npx vitest run src/a.test.ts src/b.test.ts")[0].selectors,
    ).toEqual(["src/a.test.ts", "src/b.test.ts"]);
  });

  it.each([
    ["npm ci"],
    ["npm run lint"],
    ["npm run build"],
    ["npm run test:policy"],
    ["npx playwright test"],
    // The canary's own failure-explainer echoes the invocation into the job
    // summary. A gate that counted that would be reporting on documentation.
    ['echo "  npm test -- --testTimeout=30000 --retry=2"'],
    // Quoting is what separates a command from a mention of one, even when the
    // quoted text is a bare runner name.
    ['echo "npm" test'],
    ["# npm test"],
  ])("finds no suite invocation in %s", (script) => {
    expect(classifyRunScript(script)).toEqual([]);
  });

  it("marks a quoted token so it cannot be read as a command", () => {
    const [command] = tokenizeShellCommands('echo "npm" test');
    expect(command[1]).toEqual({ text: "npm", quoted: true });
  });
});

describe("deciding whether a targeted test reads this repository's history", () => {
  it("says yes when git is driven against a repository-root anchor", () => {
    expect(
      readsRepositoryHistory(
        [
          'const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");',
          'function repoRevision(revision) { return git(REPO_ROOT, "rev-parse", revision); }',
          'repoRevision("HEAD^1");',
        ].join("\n"),
      ),
    ).toBe(true);
  });

  it("says no for a test that git-inits a throwaway repository in a temp dir", () => {
    expect(
      readsRepositoryHistory(
        [
          'const root = mkdtempSync(path.join(tmpdir(), "fixture-"));',
          'execFileSync("git", ["init"], { cwd: root });',
          'execFileSync("git", ["rev-parse", "HEAD"], { cwd: root });',
        ].join("\n"),
      ),
    ).toBe(false);
  });

  it("says no when there is no history-bearing revision at all", () => {
    expect(
      readsRepositoryHistory('execFileSync("git", ["status"], { cwd: REPO_ROOT });'),
    ).toBe(false);
  });

  it("agrees with the real files on both sides of the distinction", () => {
    // The suite member that actually needs history…
    expect(
      readsRepositoryHistory(
        readFileSync(
          path.join(REPO_ROOT, "scripts", "ci", "check-doc-index-integrity.test.mjs"),
          "utf8",
        ),
      ),
    ).toBe(true);
    // …and one that only ever drives a throwaway repository.
    expect(
      readsRepositoryHistory(
        readFileSync(
          path.join(REPO_ROOT, "scripts", "ci", "check-pr-changelog-fragment.test.mjs"),
          "utf8",
        ),
      ),
    ).toBe(false);
  });
});

describe("auditing workflows", () => {
  it("passes a whole-suite job that checks out full history", () => {
    expect(audit({ "ci.yml": suiteWorkflow({ checkoutWith: "fetch-depth: 0" }) })).toMatchObject({
      problems: [],
      fullSuiteJobs: 1,
    });
  });

  it("fails a whole-suite job with a default-depth checkout, naming job and step", () => {
    const { problems } = audit({ "ci.yml": suiteWorkflow() });

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(".github/workflows/ci.yml");
    expect(problems[0]).toContain("job `unit`");
    expect(problems[0]).toContain('step 2 "Run the suite"');
    expect(problems[0]).toContain("fetch-depth: 0");
  });

  it.each([["fetch-depth: 1"], ['fetch-depth: "1"'], ["ref: main"]])(
    "fails a whole-suite job whose checkout says %s",
    (checkoutWith) => {
      expect(audit({ "ci.yml": suiteWorkflow({ checkoutWith }) }).problems).toHaveLength(1);
    },
  );

  it('accepts fetch-depth given as the string "0"', () => {
    expect(
      audit({ "ci.yml": suiteWorkflow({ checkoutWith: 'fetch-depth: "0"' }) }).problems,
    ).toEqual([]);
  });

  it("fails a whole-suite job that never checks out at all", () => {
    const { problems } = audit({
      "ci.yml": [
        "jobs:",
        "  unit:",
        "    steps:",
        "      - name: Run the suite",
        "        run: npm test",
        "",
      ].join("\n"),
    });

    expect(problems).toHaveLength(1);
  });

  it("fails the faketime-wrapped canary job when its fetch-depth is removed", () => {
    const { problems } = audit({
      "clock-rollover-canary.yml": suiteWorkflow({
        run: "faketime -f '${{ matrix.offset }}' npm test -- --testTimeout=30000 --retry=2",
      }),
    });

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("runs the whole unit suite");
  });

  it("leaves a targeted job alone when the named file touches no git", () => {
    const { problems } = audit(
      {
        "ci.yml": [
          "jobs:",
          "  migration-drift:",
          "    steps:",
          "      - uses: actions/checkout@v7",
          "      - name: Test against PostgreSQL",
          "        run: npx vitest run src/lib/__tests__/a.realdb.test.ts",
          "",
        ].join("\n"),
      },
      { "src/lib/__tests__/a.realdb.test.ts": "it('works', () => {});" },
    );

    expect(problems).toEqual([]);
  });

  it("fails a targeted job whose named file drives git against this repository", () => {
    const { problems } = audit(
      {
        "ci.yml": [
          "jobs:",
          "  historical:",
          "    steps:",
          "      - uses: actions/checkout@v7",
          "      - name: Test the doc index CLI",
          "        run: npx vitest run scripts/ci/check-doc-index-integrity.test.mjs",
          "",
        ].join("\n"),
      },
      {
        "scripts/ci/check-doc-index-integrity.test.mjs":
          'const REPO_ROOT = "..";\ngit(REPO_ROOT, "rev-parse", "HEAD^1");',
      },
    );

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("drives git against this repository's own commits");
  });

  it("does not fail a targeted job whose named file cannot be read", () => {
    const { problems } = audit({
      "ci.yml": [
        "jobs:",
        "  targeted:",
        "    steps:",
        "      - uses: actions/checkout@v7",
        "      - run: npx vitest run src/lib/__tests__/*.realdb.test.ts",
        "",
      ].join("\n"),
    });

    expect(problems).toEqual([]);
  });

  it("ignores a workflow with no jobs of its own", () => {
    expect(audit({ "wiki.yml": "name: Wiki\non:\n  push:\n" }).problems).toEqual([]);
  });
});

describe("the failure message", () => {
  it("explains the cause, the symptom and the fix", () => {
    for (const fragment of [
      "HEAD^1",
      "origin/main",
      "fatal: ambiguous argument",
      "depth 1 by default",
      "fetch-depth: 0",
      "#2907",
      // The rejected alternative, stated so nobody reaches for it again.
      "NOT making the test skip",
    ]) {
      expect(SUITE_HISTORY_EXPLANATION).toContain(fragment);
    }
  });
});

describe("this repository", () => {
  it("passes its own gate", () => {
    const { problems, workflowCount, fullSuiteJobs } = checkWorkingTree(REPO_ROOT);

    expect(problems).toEqual([]);
    expect(workflowCount).toBeGreaterThan(0);
    // `verify` and the clock-rollover canary. If this number moves, a workflow
    // started or stopped running the suite and that is worth a deliberate look.
    expect(fullSuiteJobs).toBe(2);
  });

  it("sees the whole suite in ci.yml's `verify` and in the canary", () => {
    const read = (name) =>
      readFileSync(path.join(REPO_ROOT, ".github", "workflows", name), "utf8");

    const verify = parseWorkflowYaml(read("ci.yml")).jobs.verify;
    expect(
      verify.steps
        .filter((step) => typeof step.run === "string")
        .flatMap((step) => classifyRunScript(step.run))
        .map((invocation) => invocation.kind),
    ).toContain("full-suite");

    const canary = parseWorkflowYaml(read("clock-rollover-canary.yml")).jobs[
      "wound-forward-suite"
    ];
    expect(
      canary.steps
        .filter((step) => typeof step.run === "string")
        .flatMap((step) => classifyRunScript(step.run))
        .map((invocation) => invocation.kind),
    ).toContain("full-suite");
  });

  it("leaves the realdb jobs, which run targeted files, passing — and only ONE of them still checks out shallow", () => {
    const jobs = parseWorkflowYaml(
      readFileSync(path.join(REPO_ROOT, ".github", "workflows", "ci.yml"), "utf8"),
    ).jobs;

    const checkoutOf = (job) =>
      job.steps.find((step) => String(step.uses ?? "").startsWith("actions/checkout"));

    /*
      This assertion used to cover both jobs with one loop and one reason:
      "correct as they stand: shallow, and no git anywhere". Half of that stopped
      being true in #3002.

      `migration-drift` now runs a ledger-coverage check that resolves a MERGE
      BASE to find the migrations a change adds, so it shells out to git against
      this repository's own commits — which is the same reason this whole gate
      exists, arriving at a job that previously had none. It therefore needs
      `fetch-depth: 0`, and the danger of leaving it shallow is the sharper
      version of #2909's: `git merge-base` on a depth-1 clone does not fail, it
      returns HEAD, so the added-migration set comes back EMPTY and the check
      passes over the very pair it exists to catch. The check refuses a shallow
      clone outright for that reason; the full checkout is what stops it refusing
      on every run.

      `data-migration-verification` still touches no git and stays shallow.
    */
    // Compared numerically: this file's small YAML reader returns scalars as
    // strings, so `toBe(0)` would pin the reader rather than the workflow.
    expect(
      Number(checkoutOf(jobs["migration-drift"]).with?.["fetch-depth"]),
    ).toBe(0);
    expect(
      checkoutOf(jobs["data-migration-verification"]).with?.["fetch-depth"],
    ).toBeUndefined();

    for (const jobId of ["migration-drift", "data-migration-verification"]) {
      const invocations = jobs[jobId].steps
        .filter((step) => typeof step.run === "string")
        .flatMap((step) => classifyRunScript(step.run));
      expect(invocations.length).toBeGreaterThan(0);
      expect(invocations.every((invocation) => invocation.kind === "targeted")).toBe(true);
    }
  });
});

describe("the command-line entry point", () => {
  it("exits 0 and says what it inspected when every workflow is correct", () => {
    const root = fixtureRepo({
      "ci.yml": suiteWorkflow({ checkoutWith: "fetch-depth: 0" }),
    });
    const result = spawnSync(process.execPath, [CHECKER_PATH], {
      cwd: root,
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Workflow checkout-depth check passed");
  });

  it("exits 1 and prints both the offending step and the reason", () => {
    const root = fixtureRepo({ "ci.yml": suiteWorkflow() });
    const result = spawnSync(process.execPath, [CHECKER_PATH], {
      cwd: root,
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('step 2 "Run the suite"');
    expect(result.stderr).toContain("fatal: ambiguous argument");
  });

  it("exits 1 rather than reporting a pass it has not earned when there are no workflows", () => {
    const root = mkdtempSync(path.join(tmpdir(), "workflow-depth-empty-"));
    TEMP_ROOTS.add(root);
    writeFixtureFile(root, "README.md", "no workflows here\n");

    const result = spawnSync(process.execPath, [CHECKER_PATH], {
      cwd: root,
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("nothing to check, which is not the same as a pass");
  });
});
