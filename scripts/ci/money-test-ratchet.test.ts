import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  baselineLowered,
  evaluateCoverage,
  evaluateMutation,
  listMoneyFiles,
  raiseCoverageBaseline,
  raiseMutationBaseline,
  renderCoverageReport,
  scoreFromMutationReport,
  worstFiles,
} from "./money-test-ratchet.mjs";
import { parseWorkflowYaml } from "./check-workflow-suite-checkout-depth.mjs";
import {
  MONEY_MODULE_GLOBS,
  MUTATION_TARGET_GLOBS,
  MUTATION_TEST_FILES,
} from "../lib/money-modules.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");

const baseline = {
  coverage: { lines: 60, statements: 59, functions: 50, branches: 40 },
  mutation: { score: 80, breakBelowPercent: 78 },
};
const total = (lines, statements, functions, branches) => ({
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

  it("refuses a baseline that lacks a figure, rather than passing silently", () => {
    expect(() => evaluateCoverage(total(60, 59, 50, 40), { coverage: { lines: 60 } })).toThrow(/statements/);
  });

  it("only raises the baseline, never lowers it", () => {
    const raised = raiseCoverageBaseline(baseline, total(70, 50, 55, 40));
    expect(raised.coverage).toEqual({ lines: 70, statements: 59, functions: 55, branches: 40 });
  });

  it("flags a baseline lower than the base branch's, per figure", () => {
    const lowered = { ...baseline, coverage: { ...baseline.coverage, lines: 59 }, mutation: { score: 80, breakBelowPercent: 70 } };
    expect(baselineLowered(baseline, lowered)).toEqual(["coverage.lines 60 -> 59", "mutation.breakBelowPercent 78 -> 70"]);
    expect(baselineLowered(baseline, baseline)).toEqual([]);
  });

  it("reports the files with the most uncovered lines, relative to the repository", () => {
    const summary = {
      total: total(60, 59, 50, 40),
      "/repo/src/lib/a.ts": { lines: { total: 10, covered: 10, pct: 100 } },
      "/repo/src/lib/b.ts": { lines: { total: 10, covered: 4, pct: 40 } },
      "/repo/src/lib/c.ts": { lines: { total: 100, covered: 90, pct: 90 } },
    };
    expect(worstFiles(summary, 5, "/repo").map((row) => row.file)).toEqual(["src/lib/c.ts", "src/lib/b.ts"]);
    const text = renderCoverageReport(evaluateCoverage(total(59, 59, 50, 40), baseline), summary);
    expect(text).toContain("BELOW THE BASELINE");
    expect(text).toContain("| lines | 60% | 59% | -1 | **lower** |");
  });
});

describe("the mutation score", () => {
  const report = {
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
    expect(raiseMutationBaseline(baseline, 70).mutation).toEqual(baseline.mutation);
  });
});

describe("the money-module list", () => {
  it("matches real files for every glob, so none is a dead entry", () => {
    const files = listMoneyFiles(ROOT);
    for (const glob of MONEY_MODULE_GLOBS) {
      expect(files.some((file) => path.posix.matchesGlob(file, glob)), glob).toBe(true);
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

  it("holds a committed baseline the ratchet can read", () => {
    const stored = JSON.parse(read("scripts/ci/money-test-baseline.json"));
    expect(() => evaluateCoverage(total(100, 100, 100, 100), stored)).not.toThrow();
    expect(stored.mutation.breakBelowPercent).toBeLessThanOrEqual(stored.mutation.score);
  });
});

describe("the CLI", () => {
  it("fails on a summary below the baseline and passes on one above it", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "money-ratchet-"));
    try {
      const stored = JSON.parse(read("scripts/ci/money-test-baseline.json"));
      const write = (name, pct) => {
        const file = path.join(dir, name);
        const entry = { pct };
        fs.writeFileSync(file, JSON.stringify({ total: { lines: entry, statements: entry, functions: entry, branches: entry } }));
        return file;
      };
      const run = (summary) =>
        execFileSync(process.execPath, [path.join(ROOT, "scripts/ci/money-test-ratchet.mjs"), "coverage", "--summary", summary], {
          cwd: ROOT,
          // Not the job summary of whichever CI job runs this test.
          env: { ...process.env, GITHUB_STEP_SUMMARY: "" },
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        });
      const floor = Math.max(...Object.values(stored.coverage));
      expect(() => run(write("above.json", floor + 1))).not.toThrow();
      // Strictly below the smallest stored figure, so at least one metric fails.
      const lowest = Math.min(...Object.values(stored.coverage));
      if (lowest > 0) {
        expect(() => run(write("below.json", lowest - 0.01))).toThrow(/baseline/);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the workflows stay advisory (#4459)", () => {
  const coverage = parseWorkflowYaml(read(".github/workflows/money-coverage.yml"));
  const mutation = parseWorkflowYaml(read(".github/workflows/money-mutation.yml"));

  it("the mutation run is nightly or on demand, never a pull-request check", () => {
    const triggers = Object.keys(mutation.on);
    expect(triggers.sort()).toEqual(["schedule", "workflow_dispatch"]);
  });

  it("the coverage run reports on pull requests and is not part of ci.yml's `verify`", () => {
    expect(Object.keys(coverage.on)).toContain("pull_request");
    expect(read(".github/workflows/ci.yml")).not.toMatch(/money-coverage|Money coverage/);
    expect(read("scripts/ci/require-test-shards.mjs")).not.toMatch(/Money coverage|coverage-shard/);
  });

  it("runs the same four shards the required suite does, merges them, and judges once", () => {
    expect(coverage.jobs["coverage-shard"].strategy.matrix.shard).toEqual([1, 2, 3, 4]);
    expect(coverage.jobs["coverage-ratchet"].needs).toBe("coverage-shard");
    const shardRun = coverage.jobs["coverage-shard"].steps.find((step) => String(step.run ?? "").includes("--shard="));
    expect(shardRun.run).toContain("--shard=${{ matrix.shard }}/4");
    expect(shardRun.run).toContain("--coverage");
    expect(shardRun.run).toContain("--reporter=blob");
    const merge = coverage.jobs["coverage-ratchet"].steps.find((step) => String(step.run ?? "").includes("--merge-reports"));
    expect(merge.run).toContain("--coverage");
  });
});
