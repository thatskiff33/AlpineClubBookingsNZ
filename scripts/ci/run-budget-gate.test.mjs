import { describe, expect, it } from "vitest";

import { UPSTREAM_LOCAL_REF, planBudgetGate, runBudgetGate } from "./run-budget-gate.mjs";

/**
 * #5196 — CI's budget step: today's command unless a fork names a trusted
 * upstream, and never an ordinary run in place of a broken trusted one.
 */

function recorder(statuses = {}) {
  const calls = [];
  const errors = [];
  const spawn = (command, args) => {
    calls.push([command, ...args]);
    return { status: statuses[command] ?? 0 };
  };
  return { calls, errors, spawn, writeError: (line) => errors.push(line) };
}

describe("planBudgetGate", () => {
  it("runs today's exact command and fetches nothing when no upstream is set", () => {
    for (const env of [{ BUDGET_BASE: "origin/main" }, { BUDGET_BASE: "origin/main", BUDGET_UPSTREAM_REPO: "" }]) {
      expect(planBudgetGate(env)).toEqual({
        ok: true,
        fetch: null,
        gate: { command: "pnpm", args: ["run", "quality:budget", "--base", "origin/main"] },
      });
    }
  });

  it("fetches upstream main into a fixed ref and hands that ref to the gate", () => {
    expect(planBudgetGate({ BUDGET_BASE: "abc123", BUDGET_UPSTREAM_REPO: "thatskiff33/AlpineClubBookingsNZ" })).toEqual({
      ok: true,
      fetch: {
        command: "git",
        args: [
          "fetch",
          "--no-tags",
          "https://github.com/thatskiff33/AlpineClubBookingsNZ.git",
          `+refs/heads/main:${UPSTREAM_LOCAL_REF}`,
        ],
      },
      gate: {
        command: "pnpm",
        args: ["run", "quality:budget", "--base", "abc123", "--upstream-ref", UPSTREAM_LOCAL_REF],
      },
    });
  });

  it.each([
    "owner",
    "owner/repo/extra",
    "owner/repo; rm -rf /",
    "https://github.com/owner/repo",
    "owner/$(id)",
    "../repo",
    "owner/..",
    " owner/repo",
  ])("refuses a malformed repository %j", (repo) => {
    const plan = planBudgetGate({ BUDGET_BASE: "origin/main", BUDGET_UPSTREAM_REPO: repo });
    expect(plan.ok).toBe(false);
  });
});

describe("runBudgetGate", () => {
  it("runs only the gate when no upstream is set, and returns its status", () => {
    const run = recorder({ pnpm: 1 });
    expect(runBudgetGate({ BUDGET_BASE: "origin/main" }, run.spawn, run.writeError)).toBe(1);
    expect(run.calls).toEqual([["pnpm", "run", "quality:budget", "--base", "origin/main"]]);
  });

  it("fetches before running the trusted gate", () => {
    const run = recorder();
    expect(runBudgetGate({ BUDGET_BASE: "origin/main", BUDGET_UPSTREAM_REPO: "up/stream" }, run.spawn, run.writeError)).toBe(0);
    expect(run.calls.map(([command]) => command)).toEqual(["git", "pnpm"]);
  });

  it("does not run the gate at all when the fetch fails or the value is malformed", () => {
    const failedFetch = recorder({ git: 128 });
    expect(
      runBudgetGate({ BUDGET_BASE: "origin/main", BUDGET_UPSTREAM_REPO: "up/stream" }, failedFetch.spawn, failedFetch.writeError),
    ).toBe(1);
    expect(failedFetch.calls.map(([command]) => command)).toEqual(["git"]);
    expect(failedFetch.errors.join("")).toContain("could not fetch the trusted upstream");

    const malformed = recorder();
    expect(
      runBudgetGate({ BUDGET_BASE: "origin/main", BUDGET_UPSTREAM_REPO: "not a repo" }, malformed.spawn, malformed.writeError),
    ).toBe(1);
    expect(malformed.calls).toEqual([]);
  });
});
