#!/usr/bin/env node
/**
 * CI's file-size and function-length gate, with an optional trusted upstream
 * for a deployment fork (#5196).
 *
 * Upstream, and in any fork that has not opted in, this runs exactly today's
 * command — `pnpm run quality:budget --base "$BUDGET_BASE"` — and fetches
 * nothing. A deployment fork that syncs down from upstream sets the repository
 * variable `QUALITY_BUDGET_UPSTREAM_REPO` to `owner/repo`; this then fetches
 * that repository's `main`, without tags and needing no extra credentials,
 * into a fixed local ref and passes it as `--upstream-ref`, so a sync-down is
 * not refused for upstream's own reviewed code (see `scripts/lib/budget-upstream-ref.ts`).
 *
 * The upstream comes only from a repository variable, never from anything a
 * pull request controls, and its branch is fixed at `main`. Arguments are
 * passed as arrays, never through a shell. A malformed value or a failed fetch
 * exits 1 without running the gate: falling back to an ordinary run would turn
 * a broken fork configuration into a red gate with the wrong explanation.
 */
import { spawnSync } from "node:child_process";

import { isMainModule } from "../lib/is-main-module.mjs";

/** Where the fetched upstream `main` lands, and the ref the gate is handed. */
export const UPSTREAM_LOCAL_REF = "refs/remotes/budget-upstream/main";

const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/**
 * @typedef {{ command: string, args: string[] }} Step
 * @typedef {{ ok: true, fetch: Step | null, gate: Step } | { ok: false, error: string }} Plan
 */

/**
 * What to run, from the step's environment.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {Plan}
 */
export function planBudgetGate(env) {
  const gate = {
    command: "pnpm",
    args: ["run", "quality:budget", "--base", env.BUDGET_BASE ?? ""],
  };
  const repo = env.BUDGET_UPSTREAM_REPO ?? "";
  if (repo === "") return { ok: true, fetch: null, gate };
  if (!REPO_PATTERN.test(repo) || repo.split("/").some((part) => /^\.+$/.test(part))) {
    return {
      ok: false,
      error:
        `QUALITY_BUDGET_UPSTREAM_REPO must be "owner/repo" on github.com, got ${JSON.stringify(repo)}. ` +
        "Fix the repository variable, or unset it to run the ordinary gate.",
    };
  }
  return {
    ok: true,
    fetch: {
      command: "git",
      args: [
        "fetch",
        "--no-tags",
        `https://github.com/${repo}.git`,
        `+refs/heads/main:${UPSTREAM_LOCAL_REF}`,
      ],
    },
    gate: { command: gate.command, args: [...gate.args, "--upstream-ref", UPSTREAM_LOCAL_REF] },
  };
}

/**
 * Carry out a plan. `spawn` is injectable so the tests can watch the order
 * without a network or a gate run.
 *
 * @param {Record<string, string | undefined>} env
 * @param {(command: string, args: string[]) => { status: number | null }} spawn
 * @param {(line: string) => void} writeError
 * @returns {number}
 */
export function runBudgetGate(env, spawn, writeError) {
  const plan = planBudgetGate(env);
  if (!plan.ok) {
    writeError(`Budget gate: ${plan.error}\n`);
    return 1;
  }
  if (plan.fetch) {
    const fetched = spawn(plan.fetch.command, plan.fetch.args);
    if (fetched.status !== 0) {
      writeError(
        `Budget gate: could not fetch the trusted upstream (${plan.fetch.args[2]}), so the ` +
          "gate did not run. A public upstream needs no extra credentials; check the " +
          "repository variable QUALITY_BUDGET_UPSTREAM_REPO.\n",
      );
      return 1;
    }
  }
  return spawn(plan.gate.command, plan.gate.args).status ?? 1;
}

if (isMainModule(import.meta.url)) {
  process.exitCode = runBudgetGate(
    process.env,
    (command, args) => spawnSync(command, args, { stdio: "inherit" }),
    (line) => process.stderr.write(line),
  );
}
