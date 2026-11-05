import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  COVERAGE_TOLERANCE_PP,
  baselineAtRef,
  baselineLowered,
  evaluateCoverage,
  evaluateMutation,
  latestMainRunId,
  listMoneyFiles,
  raiseCoverageBaseline,
  raiseMutationBaseline,
  renderCoverageReport,
  scoreFromMutationReport,
  worstFiles,
  type CoverageSummary,
  type CoverageTotal,
  type MoneyTestBaseline,
  type MutationReport,
} from "./money-test-ratchet.mjs";
import { parseWorkflowYaml } from "./check-workflow-suite-checkout-depth.mjs";
import {
  MONEY_MODULE_GLOBS,
  MUTATION_TARGET_GLOBS,
  MUTATION_TEST_FILES,
  codeownersSrcLibGlobs,
} from "../lib/money-modules.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (file: string): string => fs.readFileSync(path.join(ROOT, file), "utf8");

const baseline: MoneyTestBaseline = {
  coverage: { lines: 60, statements: 59, functions: 50, branches: 40 },
  mutation: { score: 80, breakBelowPercent: 78 },
};
const total = (lines: number, statements: number, functions: number, branches: number): CoverageTotal => ({
  lines: { pct: lines },
  statements: { pct: statements },
  functions: { pct: functions },
  branches: { pct: branches },
});

describe("the coverage ratchet", () => {
  it("passes at the baseline and above it", () => {
    expect(evaluateCoverage(total(60, 59, 50, 40), baseline).ok).toBe(true);
    expect(evaluateCoverage(total(75, 70, 66, 55), baseline).ok).toBe(true);
  });

  it("fails when any one figure is lower, and names which", () => {
    const result = evaluateCoverage(total(60, 59, 50, 39.99), baseline);
    expect(result.ok).toBe(false);
    expect(result.rows.filter((row) => !row.ok).map((row) => row.metric)).toEqual(["branches"]);
  });

  it("does not fail a metric the report has no figure for", () => {
    const result = evaluateCoverage({ ...total(60, 59, 50, 40), branches: { pct: "Unknown" } }, baseline);
    expect(result.ok).toBe(true);
  });

  describe("against the latest successful main run", () => {
    // main measured 87.96 / 86.73 / 89.67 / 80.4 (a recorded summary's totals).
    const main = total(87.96, 86.73, 89.67, 80.4);
    const floor: MoneyTestBaseline = { ...baseline, coverage: { lines: 87, statements: 86, functions: 89, branches: 80 } };

    it("fails a pull request that lowers a figure by more than the tolerance, though it is above the floor", () => {
      // 87.01 is above the committed floor of 87, and most of a point below main.
      const result = evaluateCoverage(total(87.01, 86.73, 89.67, 80.4), floor, main);
      expect(result.ok).toBe(false);
      expect(result.against).toBe("main");
      expect(result.rows.filter((row) => !row.ok).map((row) => `${row.metric} bar ${row.bar}`)).toEqual(["lines bar 87.86"]);
    });

    it("passes equal and higher figures", () => {
      expect(evaluateCoverage(main, floor, main).ok).toBe(true);
      expect(evaluateCoverage(total(88.5, 87, 90, 81), floor, main).ok).toBe(true);
    });

    it("passes a drop within the tolerance and fails one just past it", () => {
      expect(COVERAGE_TOLERANCE_PP).toBe(0.1);
      expect(evaluateCoverage(total(87.86, 86.73, 89.67, 80.4), floor, main).ok).toBe(true);
      expect(evaluateCoverage(total(87.85, 86.73, 89.67, 80.4), floor, main).ok).toBe(false);
    });

    it("falls back to the committed floor, and says so, when there is no main summary", () => {
      const result = evaluateCoverage(total(87.01, 86.1, 89.1, 80.1), floor, null);
      expect(result.ok).toBe(true);
      expect(result.against).toBe("floor");
      expect(evaluateCoverage(total(86.99, 86.1, 89.1, 80.1), floor, null).ok).toBe(false);
      const text = renderCoverageReport(result, { total: main });
      expect(text).toContain("no summary from a successful `main` run was available");
    });

    it("falls back per figure where the main summary has none for it", () => {
      const result = evaluateCoverage(total(87.96, 86.73, 89.67, 80.4), floor, { ...main, branches: { pct: "Unknown" } });
      expect(result.rows.map((row) => row.against)).toEqual(["main", "main", "main", "floor"]);
      expect(result.against).toBe("floor");
    });

    it("renders which bar it used, with the tolerance", () => {
      const text = renderCoverageReport(evaluateCoverage(main, floor, main), { total: main });
      expect(text).toContain("latest successful `main` run, allowing 0.1 percentage points");
      expect(text).toContain("| lines | main 87.96% | 87.86% | 87.96% | 0 | ok |");
    });
  });

  it("refuses a baseline that lacks a figure, rather than passing silently", () => {
    expect(() => evaluateCoverage(total(60, 59, 50, 40), { coverage: { lines: 60 } })).toThrow(/statements/);
  });

  it("only raises the baseline, never lowers it", () => {
    const raised = raiseCoverageBaseline(baseline, total(70, 50, 55, 40));
    expect(raised.coverage).toEqual({ lines: 70, statements: 59, functions: 55, branches: 40 });
  });

  it("flags a baseline lower than the base branch's, per figure", () => {
    const lowered = {
      coverage: { ...baseline.coverage, lines: 59 },
      mutation: { score: 80, breakBelowPercent: 70 },
    };
    expect(baselineLowered(baseline, lowered)).toEqual(["coverage.lines 60 -> 59", "mutation.breakBelowPercent 78 -> 70"]);
    expect(baselineLowered(baseline, baseline)).toEqual([]);
  });

  it("reports the files with the most uncovered lines, relative to the repository", () => {
    const summary: CoverageSummary = {
      total: total(60, 59, 50, 40),
      "/repo/src/lib/a.ts": { lines: { total: 10, covered: 10, pct: 100 } },
      "/repo/src/lib/b.ts": { lines: { total: 10, covered: 4, pct: 40 } },
      "/repo/src/lib/c.ts": { lines: { total: 100, covered: 90, pct: 90 } },
    };
    expect(worstFiles(summary, 5, "/repo").map((row) => row.file)).toEqual(["src/lib/c.ts", "src/lib/b.ts"]);
    const text = renderCoverageReport(evaluateCoverage(total(59, 59, 50, 40), baseline), summary);
    expect(text).toContain("BELOW THE BAR");
    expect(text).toContain("committed floor");
    expect(text).toContain("| lines | floor 60% | 60% | 59% | -1 | **lower** |");
  });
});

describe("the mutation score", () => {
  const report: MutationReport = {
    files: {
      "src/lib/a.ts": {
        mutants: [
          { status: "Killed", mutatorName: "ArithmeticOperator", location: { start: { line: 1 } } },
          { status: "Timeout", mutatorName: "BlockStatement", location: { start: { line: 2 } } },
          { status: "Survived", mutatorName: "EqualityOperator", location: { start: { line: 3 } } },
          { status: "NoCoverage", mutatorName: "StringLiteral", location: { start: { line: 4 } } },
          { status: "CompileError", mutatorName: "X", location: { start: { line: 5 } } },
          { status: "Ignored", mutatorName: "X", location: { start: { line: 6 } } },
        ],
      },
    },
  };

  it("counts killed and timed-out mutants as detected, and survivors and uncovered ones against", () => {
    const scored = scoreFromMutationReport(report);
    expect(scored.score).toBe(50);
    expect(scored.judged).toBe(4);
    expect(scored.survivors.map((s) => `${s.file}:${s.line}`)).toEqual(["src/lib/a.ts:3", "src/lib/a.ts:4"]);
  });

  it("refuses a report with nothing to score", () => {
    expect(() => scoreFromMutationReport({ files: {} })).toThrow(/no mutants/);
  });

  it("fails below the floor and raises the floor with the score, one point under it", () => {
    expect(evaluateMutation(77.9, baseline).ok).toBe(false);
    expect(evaluateMutation(78, baseline).ok).toBe(true);
    expect(raiseMutationBaseline(baseline, 90.4).mutation).toEqual({ score: 90.4, breakBelowPercent: 89 });
    // A lower score never lowers the stored one; the floor still follows it.
    expect(raiseMutationBaseline(baseline, 70).mutation).toEqual({ score: 80, breakBelowPercent: 79 });
  });
});

describe("the money-module list", () => {
  it("matches real files for every glob, so none is a dead entry", () => {
    const files = listMoneyFiles(ROOT);
    for (const glob of MONEY_MODULE_GLOBS) {
      expect(
        files.some((file) => path.posix.matchesGlob(file, glob)),
        glob,
      ).toBe(true);
    }
    expect(files.some((file) => file.includes("__tests__") || file.endsWith(".d.ts"))).toBe(false);
  });

  it("names mutation targets and suites that exist, and every target is a money module", () => {
    const money = new Set(listMoneyFiles(ROOT));
    for (const file of [...MUTATION_TARGET_GLOBS, ...MUTATION_TEST_FILES]) {
      expect(fs.existsSync(path.join(ROOT, file)), file).toBe(true);
    }
    for (const target of MUTATION_TARGET_GLOBS) expect(money.has(target), target).toBe(true);
    for (const suite of MUTATION_TEST_FILES) expect(suite.endsWith(".realdb.test.ts"), suite).toBe(false);
  });

  it("lists every src/lib TypeScript file CODEOWNERS owns, and every src/lib module the census says must stay owned", () => {
    const listed = new Set(listMoneyFiles(ROOT));
    const tracked = execFileSync("git", ["ls-files", "src/lib"], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
      .split("\n")
      .filter((file) => /\.tsx?$/.test(file) && !file.includes("/__tests__/") && !/\.(?:test|spec)\.tsx?$/.test(file));
    const ownedGlobs = codeownersSrcLibGlobs(read(".github/CODEOWNERS"));
    const owned = tracked.filter((file) => ownedGlobs.some((glob) => path.posix.matchesGlob(file, glob)));
    // Non-vacuous: the owned set is real, and reaches the places a name-family glob missed.
    expect(owned.length).toBeGreaterThan(100);
    expect(owned).toContain("src/lib/stripe.ts");
    expect(owned.some((file) => file.startsWith("src/lib/xero-inbound/"))).toBe(true);
    expect(
      owned.filter((file) => !listed.has(file)),
      "CODEOWNERS owns these src/lib files and the coverage set leaves them out",
    ).toEqual([]);

    // The census's own reverse list is read from its source, so it is not spelled twice.
    const census = read("src/lib/__tests__/codeowners-census.test.ts");
    const block = /const MUST_BE_OWNED = \[([\s\S]*?)\];/.exec(census)?.[1] ?? "";
    const mustBeOwned = [...block.matchAll(/"(src\/lib\/[^"]+\.ts)"/g)].map((match) => match[1]!);
    expect(mustBeOwned.length).toBeGreaterThan(10);
    expect(
      mustBeOwned.filter((file) => !listed.has(file)),
      "codeowners-census.test.ts says these must stay owned money modules",
    ).toEqual([]);
  });

  it("reads CODEOWNERS' src/lib patterns: directories and files, never the owned tests, and refuses what it cannot read", () => {
    const source = [
      "# a comment",
      "/src/lib/*credit*.ts @o",
      "/src/lib/xero-inbound/ @o",
      "/src/lib/__tests__/*settlement* @o",
      "/src/app/api/pay/*/route.ts @o",
      "/docs/invariants/money.md @o",
    ].join("\n");
    expect(codeownersSrcLibGlobs(source)).toEqual(["src/lib/*credit*.ts", "src/lib/xero-inbound/**/*.ts"]);
    expect(() => codeownersSrcLibGlobs("/src/lib/notes.md @o")).toThrow(/neither a directory nor a .ts glob/);
    expect(() => codeownersSrcLibGlobs("/docs/x.md @o")).toThrow(/names no \/src\/lib\/ pattern/);
  });

  it("holds a committed baseline the ratchet can read", () => {
    const stored = JSON.parse(read("scripts/ci/money-test-baseline.json")) as MoneyTestBaseline;
    expect(() => evaluateCoverage(total(100, 100, 100, 100), stored)).not.toThrow();
    expect(stored.mutation.breakBelowPercent).toBeLessThanOrEqual(stored.mutation.score);
  });
});

describe("the base-ref guard reads the base's baseline or fails (review of #4459)", () => {
  const BASELINE_PATH = "scripts/ci/money-test-baseline.json";
  const run = (cwd: string, ...args: string[]): void => {
    execFileSync("git", args, { cwd, stdio: "ignore" });
  };
  /** A throwaway repository with one commit holding `content` at the baseline path, or no file. */
  function repoWith(content: string | null): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "money-base-ref-"));
    run(dir, "init", "-q", "-b", "main");
    run(dir, "config", "user.email", "test@example.invalid");
    run(dir, "config", "user.name", "Test");
    fs.writeFileSync(path.join(dir, "README.md"), "x\n");
    if (content !== null) {
      fs.mkdirSync(path.join(dir, path.dirname(BASELINE_PATH)), { recursive: true });
      fs.writeFileSync(path.join(dir, BASELINE_PATH), content);
    }
    run(dir, "add", "-A");
    run(dir, "commit", "-q", "-m", "base");
    return dir;
  }
  const withRepo = (content: string | null, check: (dir: string) => void): void => {
    const dir = repoWith(content);
    try {
      check(dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };

  it("returns the baseline the ref holds", () => {
    withRepo(JSON.stringify({ coverage: { lines: 50 }, mutation: { score: 1, breakBelowPercent: 1 } }), (dir) => {
      expect(baselineAtRef("main", dir)?.coverage).toEqual({ lines: 50 });
    });
  });

  it("returns null only where the ref has no such file (the base predates it)", () => {
    withRepo(null, (dir) => {
      expect(baselineAtRef("main", dir)).toBeNull();
    });
  });

  it("throws, rather than passing, for a ref that is not in the checkout", () => {
    withRepo("{}", (dir) => {
      expect(() => baselineAtRef("origin/not-fetched", dir)).toThrow(/not a commit in this checkout/);
    });
  });

  it("throws on a baseline that is not JSON", () => {
    withRepo("{ not json", (dir) => {
      expect(() => baselineAtRef("main", dir)).toThrow(SyntaxError);
    });
  });
});

describe("finding the latest successful main run", () => {
  const answer = (status: number, body: unknown) => async () => ({ ok: status < 400, status, json: async () => body });

  it("returns the newest run's id, asking for successful main pushes of the coverage workflow", async () => {
    let asked = "";
    const id = await latestMainRunId({
      repository: "o/r",
      token: "t",
      fetchImpl: async (url) => {
        asked = url;
        return { ok: true, status: 200, json: async () => ({ workflow_runs: [{ id: 42 }] }) };
      },
    });
    expect(id).toBe(42);
    expect(asked).toContain("/repos/o/r/actions/workflows/money-coverage.yml/runs");
    expect(asked).toContain("branch=main");
    expect(asked).toContain("status=success");
  });

  it("returns null when there is none, and throws on an API error (the caller falls back to the floor)", async () => {
    expect(await latestMainRunId({ repository: "o/r", token: "t", fetchImpl: answer(200, { workflow_runs: [] }) })).toBeNull();
    await expect(latestMainRunId({ repository: "o/r", token: "t", fetchImpl: answer(403, {}) })).rejects.toThrow(/403/);
  });
});

describe("the CLI", () => {
  it("fails on a summary below the baseline and passes on one above it", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "money-ratchet-"));
    try {
      const stored = JSON.parse(read("scripts/ci/money-test-baseline.json")) as MoneyTestBaseline;
      const write = (name: string, pct: number): string => {
        const file = path.join(dir, name);
        const entry = { pct };
        fs.writeFileSync(file, JSON.stringify({ total: { lines: entry, statements: entry, functions: entry, branches: entry } }));
        return file;
      };
      const run = (summary: string): string =>
        execFileSync(process.execPath, [path.join(ROOT, "scripts/ci/money-test-ratchet.mjs"), "coverage", "--summary", summary], {
          cwd: ROOT,
          // Not the job summary of whichever CI job runs this test.
          env: { ...process.env, GITHUB_STEP_SUMMARY: "" },
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        });
      const figures = Object.values(stored.coverage);
      expect(() => run(write("above.json", Math.max(...figures) + 1))).not.toThrow();
      // Below the smallest stored figure, so at least one metric is lower.
      expect(() => run(write("below.json", Math.min(...figures) - 0.01))).toThrow(/lower than the committed floor/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the workflows stay advisory (#4459)", () => {
  const coverage = read(".github/workflows/money-coverage.yml");
  const mutation = read(".github/workflows/money-mutation.yml");
  /** The workflow's `on:` block: from `on:` to the next top-level key. */
  const triggers = (source: string): string[] => {
    const block = /^on:\n((?: {2}.*\n|\n)+)/m.exec(source)?.[1] ?? "";
    return [...block.matchAll(/^ {2}(\w+):/gm)].map((match) => match[1]!).sort();
  };

  it("the mutation run is nightly or on demand, never a pull-request check", () => {
    expect(triggers(mutation)).toEqual(["schedule", "workflow_dispatch"]);
  });

  it("the coverage run reports on pull requests and is not part of ci.yml's `verify`", () => {
    expect(triggers(coverage)).toEqual(["pull_request", "push", "workflow_dispatch"]);
    expect(read(".github/workflows/ci.yml")).not.toMatch(/money-coverage|Money coverage/);
    expect(read("scripts/ci/require-test-shards.mjs")).not.toMatch(/Money coverage|coverage-shard/);
  });

  it("runs the same four shards the required suite does, merges them, and judges once", () => {
    expect(coverage).toMatch(/shard:\n(?: {10}- \d\n){4}/);
    expect(coverage).toContain("--shard=${{ matrix.shard }}/4 --coverage --reporter=blob");
    expect(coverage).toMatch(/needs: coverage-shard/);
    expect(coverage).toContain("--merge-reports --coverage");
    expect(coverage.match(/money-test-ratchet\.mjs coverage/g)).toHaveLength(1);
  });

  it("every job runs the suite under verify's own environment, so the three cannot drift", () => {
    const verify = parseWorkflowYaml(read(".github/workflows/ci.yml")).jobs.verify!.env;
    expect(verify?.DATABASE_URL).toBeDefined();
    const coverageJobs = parseWorkflowYaml(coverage).jobs;
    expect(coverageJobs["coverage-shard"]!.env).toEqual(verify);
    expect(coverageJobs["coverage-ratchet"]!.env).toEqual(verify);
    expect(parseWorkflowYaml(mutation).jobs.mutation!.env).toEqual(verify);
  });

  it("judges against the branch the pull request targets, read from the event, and may read the main run's artifact", () => {
    const run = coverage.slice(coverage.indexOf("Judge the money modules against the base"));
    expect(run).toContain("BASE_REF: ${{ github.base_ref || 'main' }}");
    expect(run).toContain('--base-ref "origin/${BASE_REF}"');
    expect(coverage).not.toMatch(/--base-ref origin\/main/);
    // `+refs/heads/...` forces the ref to exist whatever the checkout fetched.
    expect(run).toContain('"+refs/heads/${BASE_REF}:refs/remotes/origin/${BASE_REF}"');
    const ratchet = parseWorkflowYaml(coverage).jobs["coverage-ratchet"]!;
    expect(ratchet.permissions).toEqual({ contents: "read", actions: "read" });
  });

  it("skips a docs-only change: the path filter names what can move the figure, on both triggers", () => {
    const needed = [
      "src/**",
      "scripts/**",
      "prisma/**",
      "vitest*.mts",
      "package.json",
      "pnpm-lock.yaml",
      "stryker.config.mjs",
      ".github/CODEOWNERS",
      ".github/workflows/money-coverage.yml",
    ];
    const on = parseWorkflowYaml(coverage).on as Record<string, { paths?: string[] }>;
    for (const trigger of ["pull_request", "push"] as const) {
      expect(on[trigger]!.paths, trigger).toEqual(needed);
    }
    expect(needed.some((glob) => glob.startsWith("docs/"))).toBe(false);
  });
});
