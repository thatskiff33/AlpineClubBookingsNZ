import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { BaseSequencer } from "vitest/node";

import { parseWorkflowYaml } from "./check-workflow-suite-checkout-depth.mjs";
import { parseArtifactWaitArgs } from "./wait-for-run-artifacts.mjs";
import {
  EXPECTED_SHARD_COUNT,
  classifyRequiredJobs,
  classifyTestShardJobs,
  getAttemptJobs,
  parseShardGateArgs,
  requireTestShards,
} from "./require-test-shards.mjs";

const root = path.resolve(import.meta.dirname, "..", "..");
const workflow = parseWorkflowYaml(
  readFileSync(path.join(root, ".github", "workflows", "ci.yml"), "utf8"),
);

function shard(index, status = "completed", conclusion = "success") {
  return { name: `Test shard (${index}/${EXPECTED_SHARD_COUNT})`, status, conclusion };
}

const passed = () => Array.from({ length: EXPECTED_SHARD_COUNT }, (_, i) => shard(i + 1));

const GATE = "node scripts/ci/require-test-shards.mjs";
const splitArgs = (command) => command.match(/"[^"]*"|\S+/g).map((arg) => arg.replace(/^"|"$/g, ""));
const verifyGateStep = () => workflow.jobs.verify.steps.find((step) => step.run?.startsWith(`${GATE} `) || step.run === GATE);

describe("required verify's independent test-shard gate", () => {
  it("preserves the required job name, avoids needs/job-level if, and gives every shard a full checkout", () => {
    const verify = workflow.jobs.verify;
    const matrixJob = workflow.jobs["test-shard"];
    expect(verify.needs).toBeUndefined();
    expect(verify.if).toBeUndefined();
    expect(verify["continue-on-error"]).toBeUndefined();
    expect(verify.permissions.actions).toBe("read");
    expect(verify.permissions.contents).toBe("read");
    const gateStep = verifyGateStep();
    expect(gateStep).toBeDefined();
    // The unit-test defaults: `verify` gates the whole matrix, not a slice.
    expect(parseShardGateArgs(splitArgs(gateStep.run.slice(GATE.length)))).toMatchObject({ label: "Test shard", count: EXPECTED_SHARD_COUNT, from: 1 });
    expect(gateStep?.if).toBeUndefined();
    expect(gateStep?.["continue-on-error"]).toBeUndefined();
    expect(verify.steps.some((step) => /(?:^|\s)p?npm test(?:\s|$)/.test(step.run ?? ""))).toBe(false);
    expect(matrixJob.if).toBeUndefined();
    expect(matrixJob["continue-on-error"]).toBeUndefined();
    // Both jobs run the suite/build under one effective test environment.
    // The pre-install workflow parser cannot expand YAML aliases, and a
    // workflow-wide env would reach unrelated jobs, so pin complete equality.
    expect(matrixJob.env).toEqual(verify.env);
    expect(matrixJob.strategy["fail-fast"]).toBe("false");
    expect(matrixJob.strategy.matrix.shard.map(Number)).toEqual([1, 2, 3, 4]);
    expect(matrixJob.strategy.matrix.shard).toHaveLength(EXPECTED_SHARD_COUNT);
    expect(matrixJob.name).toBe(`Test shard (${"${{ matrix.shard }}"}/${EXPECTED_SHARD_COUNT})`);
    expect(matrixJob.steps.find((step) => step.uses?.startsWith("actions/checkout"))?.with?.["fetch-depth"]).toBe("0");
    const testStep = matrixJob.steps.find((step) => step.run === `pnpm test --shard=${"${{ matrix.shard }}"}/${EXPECTED_SHARD_COUNT}`);
    expect(testStep).toBeDefined();
    expect(testStep?.if).toBeUndefined();
    expect(testStep?.["continue-on-error"]).toBeUndefined();
    expect(workflow.jobs.verify.steps.at(-1).name).toBe("File-size budget ratchet");
  });

  it("requires all expected successes, never accepting a partial or duplicate matrix", () => {
    expect(classifyTestShardJobs(passed())).toEqual([]);
    expect(classifyTestShardJobs(passed().slice(0, -1))).toEqual(["missing 4/4"]);
    expect(() => classifyTestShardJobs([...passed(), shard(1)])).toThrow(/Duplicate/);
    expect(() => classifyTestShardJobs([...passed(), { ...shard(1), name: "Test shard (5/4)" }])).toThrow(/Unexpected/);
    expect(() => classifyTestShardJobs([...passed(), { ...shard(1), name: "Test shard (1/3)" }])).toThrow(/Unexpected/);
  });

  it.each(["failure", "cancelled", "skipped", "neutral", "timed_out", "action_required", null])(
    "fails closed on a completed %s conclusion",
    (conclusion) => {
      const jobs = passed();
      jobs[2] = shard(3, "completed", conclusion);
      expect(() => classifyTestShardJobs(jobs)).toThrow(/Test shard 3\/4 completed as/);
    },
  );

  it("waits for not-yet-created and running shards, then accepts the complete attempt", async () => {
    let calls = 0;
    await expect(requireTestShards({
      loadJobs: async () => {
        calls += 1;
        if (calls === 1) return [];
        if (calls === 2) return [shard(1, "in_progress", null), ...passed().slice(1)];
        return passed();
      },
      sleep: async () => {},
    })).resolves.toBeUndefined();
    expect(calls).toBe(3);
  });

  it("times out when a shard never appears or finishes", async () => {
    let clock = 0;
    await expect(requireTestShards({
      loadJobs: async () => passed().slice(0, -1),
      now: () => clock,
      sleep: async (ms) => { clock += ms; },
      maxWaitMs: 20,
      intervalMs: 10,
    })).rejects.toThrow(/Timed out.*missing 4\/4/);
  });

  it("fails closed on an API/auth error without treating it as an empty successful run", async () => {
    await expect(requireTestShards({ loadJobs: async () => { throw new Error("HTTP 403"); } }))
      .rejects.toThrow(/HTTP 403/);
  });
});

// #4425: typecheck, lint and the build with its proofs left `verify` for jobs
// of their own, which reach the required check only through `verify`'s gate
// step. Each must stay unconditional (a skipped job fails the gate, but a
// condition that is always false would fail every PR), run under `verify`'s
// environment, and be named exactly as the gate's `--job` names it.
describe("verify's typecheck, lint and build jobs (#4425)", () => {
  const SPLIT_JOBS = [
    { id: "typecheck", command: "pnpm run typecheck" },
    { id: "lint", command: "pnpm run lint" },
    { id: "build", command: "pnpm run build" },
  ];

  it("gates exactly these jobs, by the names GitHub reports them under", () => {
    const options = parseShardGateArgs(splitArgs(verifyGateStep().run.slice(GATE.length)));
    expect(options.required.toSorted()).toEqual(SPLIT_JOBS.map(({ id }) => workflow.jobs[id].name).toSorted());
  });

  it.each(SPLIT_JOBS)("$id has no needs/if/continue-on-error, verify's env, and runs `$command` unconditionally, not in verify", ({ id, command }) => {
    const job = workflow.jobs[id];
    expect(job.needs).toBeUndefined();
    expect(job.if).toBeUndefined();
    expect(job["continue-on-error"]).toBeUndefined();
    expect(job.strategy).toBeUndefined();
    expect(job.env).toEqual(workflow.jobs.verify.env);
    const step = job.steps.find((item) => item.run === command);
    expect(step, command).toBeDefined();
    expect(step.if).toBeUndefined();
    expect(step["continue-on-error"]).toBeUndefined();
    expect(workflow.jobs.verify.steps.some((item) => item.run === command)).toBe(false);
  });

  // #4752: the test project's tsc program measured 9.0 GB on main, so an 8 GB
  // ceiling made the required gate fail by chance (OOM, exit 134). Keep 12 GB.
  it("gives the typecheck step at least a 12 GB heap", () => {
    const step = workflow.jobs.typecheck.steps.find((item) => item.run === "pnpm run typecheck");
    const heapMb = Number(/--max-old-space-size=(\d+)/.exec(step.env?.NODE_OPTIONS ?? "")?.[1]);
    expect(heapMb).toBeGreaterThanOrEqual(12288);
  });

  it("keeps the build's output proofs after the build, in the build job, unconditional", () => {
    const steps = workflow.jobs.build.steps;
    const at = (needle) => steps.findIndex((step) => step.run?.includes(needle));
    const build = at("pnpm run build");
    for (const proof of ["check-prerendered-script-nonces.mjs", "check-website-prerender-manifest.mjs", "server-only-boundary-selftest.mjs"]) {
      expect(at(proof), proof).toBeGreaterThan(build);
      expect(steps[at(proof)].if, proof).toBeUndefined();
      expect(steps[at(proof)]["continue-on-error"], proof).toBeUndefined();
    }
    // The self-test clobbers `.next`, so it stays the last build-output consumer.
    expect(at("server-only-boundary-selftest.mjs")).toBe(steps.length - 1);
  });

  it("requires each named job to appear once and succeed, failing at once on any other conclusion", () => {
    const job = (name, status = "completed", conclusion = "success") => ({ name, status, conclusion });
    const names = ["Typecheck", "Lint"];
    expect(classifyRequiredJobs([job("Typecheck"), job("Lint"), job("Other", "completed", "failure")], names)).toEqual([]);
    expect(classifyRequiredJobs([job("Typecheck", "in_progress", null)], names)).toEqual(['"Typecheck" in_progress', 'missing "Lint"']);
    for (const conclusion of ["failure", "cancelled", "skipped", "neutral", "timed_out", null]) {
      expect(() => classifyRequiredJobs([job("Typecheck", "completed", conclusion), job("Lint")], names)).toThrow(/Required job "Typecheck" completed as/);
    }
    expect(() => classifyRequiredJobs([job("Lint"), job("Lint")], names)).toThrow(/Duplicate required job: Lint/);
    expect(() => classifyRequiredJobs([job("Lint", "exploded", null)], ["Lint"])).toThrow(/unknown status exploded/);
    expect(() => parseShardGateArgs(["--job", "Lint", "--job", "Lint"])).toThrow(/Duplicate --job/);
    expect(() => parseShardGateArgs(["--job", "x\"; rm"])).toThrow(/Invalid --job/);
  });

  it("the gate waits for the shards AND the named jobs, and fails before the shards finish when one fails", async () => {
    const lint = (status, conclusion) => ({ name: "Lint", status, conclusion });
    let calls = 0;
    await expect(requireTestShards({
      required: ["Lint"],
      loadJobs: async () => (++calls === 1 ? [...passed(), lint("in_progress", null)] : [...passed(), lint("completed", "success")]),
      sleep: async () => {},
    })).resolves.toBeUndefined();
    expect(calls).toBe(2);
    await expect(requireTestShards({
      required: ["Lint"],
      loadJobs: async () => [shard(1, "in_progress", null), lint("completed", "failure")],
      sleep: async () => { throw new Error("waited instead of failing"); },
    })).rejects.toThrow(/Required job "Lint" completed as failure/);
  });
});

describe("attempt-scoped GitHub jobs read", () => {
  const options = {
    apiUrl: "https://api.github.com",
    repository: "club/repo",
    runId: "123",
    attempt: "2",
    token: "test-token",
  };

  it("reads every page of this run attempt, never a previous attempt", async () => {
    const urls = [];
    const fetchImpl = async (url, request) => {
      urls.push(url.toString());
      expect(request.headers.Authorization).toBe("Bearer test-token");
      const page = Number(url.searchParams.get("page"));
      return { ok: true, json: async () => ({ total_count: 101, jobs: page === 1 ? Array(100).fill({ name: "other" }) : [shard(1)] }) };
    };
    expect(await getAttemptJobs({ ...options, fetchImpl })).toHaveLength(101);
    expect(urls).toHaveLength(2);
    expect(urls.every((url) => url.includes("/runs/123/attempts/2/jobs?"))).toBe(true);
  });

  it("rejects missing credentials, HTTP errors, malformed lists and short pages", async () => {
    await expect(getAttemptJobs({ ...options, token: "" })).rejects.toThrow(/GITHUB_TOKEN/);
    await expect(getAttemptJobs({ ...options, fetchImpl: async () => ({ ok: false, status: 403 }) })).rejects.toThrow(/HTTP 403/);
    await expect(getAttemptJobs({ ...options, fetchImpl: async () => ({ ok: true, json: async () => ({ jobs: null }) }) })).rejects.toThrow(/invalid job list/);
    await expect(getAttemptJobs({ ...options, fetchImpl: async () => ({ ok: true, json: async () => ({ total_count: 1, jobs: [] }) }) })).rejects.toThrow(/incomplete page/);
  });
});

it("the CLI fails closed without a GitHub run identity", () => {
  const result = spawnSync(process.execPath, [path.join(root, "scripts", "ci", "require-test-shards.mjs")], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, GITHUB_REPOSITORY: "", GITHUB_TOKEN: "" },
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('Shard gate for "Test shard" failed');
});

// #4397: e2e.yml's required jobs reuse this gate for their own matrices.
describe("the gate for another matrix (--label/--count)", () => {
  const e2e = (index, status = "completed", conclusion = "success") => ({ name: `E2E shard (${index}/3)`, status, conclusion });

  it("parses its arguments, defaulting to the unit-test matrix, and refuses anything else", () => {
    expect(parseShardGateArgs([])).toEqual({ label: "Test shard", count: EXPECTED_SHARD_COUNT, maxWaitMs: 45 * 60_000, upstream: [], from: 1, required: [] });
    expect(parseShardGateArgs(["--label", "E2E shard", "--count", "3", "--max-wait-minutes", "55"])).toEqual({ label: "E2E shard", count: 3, maxWaitMs: 55 * 60_000, upstream: [], from: 1, required: [] });
    expect(() => parseShardGateArgs(["--count", "0"])).toThrow(/Invalid --count/);
    expect(() => parseShardGateArgs(["--label", "x\"; rm"])).toThrow(/Invalid --label/);
    expect(() => parseShardGateArgs(["--label"])).toThrow(/needs a value/);
    expect(() => parseShardGateArgs(["--shards", "3"])).toThrow(/Unknown argument/);
  });

  it("counts only its own label's jobs, and fails closed on a skipped, cancelled, missing or duplicate one", () => {
    const unitShard = { name: "Test shard (1/4)", status: "in_progress", conclusion: null };
    expect(classifyTestShardJobs([e2e(1), e2e(2), e2e(3), unitShard], 3, "E2E shard")).toEqual([]);
    expect(classifyTestShardJobs([e2e(1), e2e(3, "queued", null)], 3, "E2E shard")).toEqual(["missing 2/3", "3/3 queued"]);
    expect(() => classifyTestShardJobs([e2e(1), e2e(2, "completed", "skipped"), e2e(3)], 3, "E2E shard")).toThrow(/E2E shard 2\/3 completed as skipped/);
    expect(() => classifyTestShardJobs([e2e(1, "completed", "cancelled")], 3, "E2E shard")).toThrow(/completed as cancelled/);
    expect(() => classifyTestShardJobs([e2e(1), e2e(1)], 3, "E2E shard")).toThrow(/Duplicate E2E shard/);
    expect(() => classifyTestShardJobs([{ name: "E2E shard (1/4)", status: "completed", conclusion: "success" }], 3, "E2E shard")).toThrow(/Unexpected E2E shard/);
  });

  it("fails at once when a named upstream job fails, instead of waiting out runners that will never expand", () => {
    // What GitHub reported in run 40247244343 for the skipped matrix.
    const placeholder = { name: "matrix.name", status: "completed", conclusion: "cancelled" };
    const image = (conclusion, status = "completed") => ({ name: "E2E app image", status, conclusion });
    const upstream = ["E2E app image", "E2E seeded database"];
    expect(() => classifyTestShardJobs([image("failure"), placeholder], 3, "E2E shard", upstream)).toThrow(/Upstream job "E2E app image" completed as failure/);
    expect(() => classifyTestShardJobs([image("cancelled")], 1, "E2E shard", upstream)).toThrow(/completed as cancelled/);
    // Still running or passed upstream: just pending.
    expect(classifyTestShardJobs([image(null, "in_progress"), placeholder], 1, "E2E shard", upstream)).toEqual(["missing 1/1"]);
    expect(classifyTestShardJobs([image("success")], 1, "E2E shard", upstream)).toEqual(["missing 1/1"]);
  });

  it("with --from, checks only the shards from that index and refuses one the gate job should have run", () => {
    expect(classifyTestShardJobs([e2e(2), e2e(3)], 3, "E2E shard", [], 2)).toEqual([]);
    expect(classifyTestShardJobs([e2e(2)], 3, "E2E shard", [], 2)).toEqual(["missing 3/3"]);
    expect(() => classifyTestShardJobs([e2e(2), e2e(3, "completed", "failure")], 3, "E2E shard", [], 2)).toThrow(/3\/3 completed as failure/);
    expect(() => classifyTestShardJobs([e2e(1), e2e(2), e2e(3)], 3, "E2E shard", [], 2)).toThrow(/run by the gate job itself/);
    expect(() => classifyTestShardJobs([], 3, "E2E shard", [], 4)).toThrow(/past --count/);
    expect(() => parseShardGateArgs(["--count", "3", "--from", "4"])).toThrow(/past --count/);
    expect(parseShardGateArgs(["--upstream", "E2E app image", "--upstream", "E2E seeded database"]).upstream).toEqual(["E2E app image", "E2E seeded database"]);
  });

  it("names the matrix in a timeout", async () => {
    let clock = 0;
    await expect(requireTestShards({
      loadJobs: async () => [e2e(1)],
      count: 3,
      label: "E2E shard",
      now: () => clock,
      sleep: async (ms) => { clock += ms; },
      maxWaitMs: 30_000,
      intervalMs: 15_000,
    })).rejects.toThrow(/Timed out waiting for E2E shard jobs: missing 2\/3, missing 3\/3/);
  });
});

describe("Vitest shard partition on the actual repository", () => {
  function listFiles() {
    const result = spawnSync(process.execPath, [
      path.join(root, "node_modules", "vitest", "vitest.mjs"),
      "list", "--filesOnly", "--json",
    ], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, DATABASE_URL: "postgresql://codex:codex@127.0.0.1:5432/codex_local" },
    });
    expect(result.status, result.stderr).toBe(0);
    return JSON.parse(result.stdout).map((entry) => path.relative(root, entry.file).replaceAll("\\", "/"));
  }

  it("assigns every file exactly once using Vitest's actual run sequencer", async () => {
    const all = listFiles();
    // `vitest list --shard` does not apply sharding in Vitest 5: only the RUN
    // path invokes BaseSequencer.shard. Feed the real discovered files to that
    // exact implementation instead of testing an ignored list flag.
    const parts = await Promise.all(Array.from({ length: EXPECTED_SHARD_COUNT }, async (_, i) => {
      const sequencer = new BaseSequencer({
        config: { root, shard: { index: i + 1, count: EXPECTED_SHARD_COUNT } },
      });
      const assigned = await sequencer.shard(all.map((file) => ({ moduleId: path.join(root, file) })));
      return assigned.map((spec) => path.relative(root, spec.moduleId).replaceAll("\\", "/"));
    }));
    const assigned = parts.flat();
    expect(new Set(assigned).size).toBe(assigned.length);
    expect(assigned.toSorted()).toEqual(all.toSorted());
    for (const file of [
      "src/lib/__tests__/frozen-test-clock.test.ts",
      "src/lib/__tests__/frozen-test-clock-opt-out.test.ts",
      "scripts/ci/check-workflow-suite-checkout-depth.test.mjs",
      "src/lib/__tests__/typecheck-project-coverage.test.ts",
    ]) {
      expect(assigned.filter((entry) => entry === file)).toHaveLength(1);
    }
  });
});

// #4397: e2e.yml's two required checks run browsers themselves (shard 1, and
// the multi-lodge project), wait for their inputs in a step rather than a
// `needs:`, and `Playwright E2E` also gates shards 2 and 3. Pinned the way
// `verify` is above: a change that lets one go green without its tests
// passing must fail here, not on a merged pull request.
describe("e2e.yml's required jobs, their shards and the run action", () => {
  const e2ePath = path.join(root, ".github", "workflows", "e2e.yml");
  const e2e = parseWorkflowYaml(readFileSync(e2ePath, "utf8"));
  const action = parseWorkflowYaml(readFileSync(path.join(root, ".github", "actions", "e2e-run", "action.yml"), "utf8"));
  const shards = e2e.jobs["e2e-shard"];
  const needed = "inputs.needed != 'false'";
  const upstreamNames = shards.needs.replace(/[[\]]/g, "").split(",").map((id) => e2e.jobs[id.trim()].name);
  const runStep = (job) => job.steps.find((step) => step.uses === "./.github/actions/e2e-run");

  it.each([
    { id: "playwright", name: "Playwright E2E", wait: "true" },
    { id: "multi-lodge", name: "E2E multi-lodge", wait: "true" },
  ])("$name keeps its required name, has no needs/if, and really runs browsers after waiting for its inputs", ({ id, name, wait }) => {
    const job = e2e.jobs[id];
    expect(job.name).toBe(name);
    expect(job.needs).toBeUndefined();
    expect(job.if).toBeUndefined();
    expect(job["continue-on-error"]).toBeUndefined();
    expect(job.permissions.actions).toBe("read");
    const run = runStep(job);
    expect(run).toBeDefined();
    expect(run.if).toBeUndefined();
    expect(run["continue-on-error"]).toBeUndefined();
    expect(run.with.needed).toBe("${{ steps.scope.outputs.needed }}");
    expect(run.with["wait-for-artifacts"]).toBe(wait);
    const scope = job.steps.find((step) => step.id === "scope");
    expect(scope?.run).toBe("node scripts/ci/e2e-scope.mjs");
    expect(scope?.if).toBeUndefined();
  });

  it("runs shard 1 and the multi-lodge project with exactly their own settings", () => {
    expect(e2e.jobs.playwright.env.E2E_SHARD).toBe("1/3");
    expect(e2e.jobs.playwright.env.E2E_MULTI_LODGE).toBeUndefined();
    expect(runStep(e2e.jobs.playwright).with["playwright-args"]).toBeUndefined();
    expect(e2e.jobs["multi-lodge"].env.E2E_MULTI_LODGE).toBe("1");
    expect(e2e.jobs["multi-lodge"].env.E2E_SHARD).toBeUndefined();
    expect(runStep(e2e.jobs["multi-lodge"]).with["playwright-args"]).toBe("--project=multi-lodge");
  });

  it("Playwright E2E gates exactly shards 2 and 3, failing at once on an upstream failure", () => {
    const gateStep = e2e.jobs.playwright.steps.find((step) => step.run?.startsWith("node scripts/ci/require-test-shards.mjs"));
    expect(gateStep?.if).toBeUndefined();
    expect(gateStep?.["continue-on-error"]).toBeUndefined();
    expect(e2e.jobs.playwright.steps.indexOf(gateStep)).toBeGreaterThan(e2e.jobs.playwright.steps.indexOf(runStep(e2e.jobs.playwright)));
    const options = parseShardGateArgs(gateStep.run.replace("node scripts/ci/require-test-shards.mjs", "").match(/"[^"]*"|\S+/g).map((arg) => arg.replace(/^"|"$/g, "")));
    expect(options).toMatchObject({ label: "E2E shard", count: 3, from: 2 });
    expect(options.upstream).toEqual(upstreamNames);
    expect(shards.name).toBe("E2E shard (${{ matrix.shard }}/3)");
    expect(shards.strategy.matrix.shard.map(Number)).toEqual([2, 3]);
    expect(shards.env.E2E_SHARD).toBe("${{ matrix.shard }}/3");
    expect(shards.if).toBeUndefined();
    expect(shards["continue-on-error"]).toBeUndefined();
    expect(shards.strategy["fail-fast"]).toBe("false");
    // The names the run action downloads are the ones the jobs upload.
    const downloads = action.runs.steps.filter((step) => step.uses?.startsWith("actions/download-artifact@")).map((step) => step.with.name);
    expect(downloads).toEqual(["e2e-app-image-${{ github.run_id }}", "e2e-seeded-db-${{ github.run_id }}"]);
    const shardRun = runStep(shards);
    expect(shardRun.with["wait-for-artifacts"]).toBe("false");
    expect(shardRun.with["playwright-args"]).toBeUndefined();
    expect(shardRun.if).toBeUndefined();
    // The time budget, stated. The gate starts after shard 1, which itself
    // waited for the image, so it must outwait a shard's own run plus the
    // runner queue it can sit in (25 min measured in run 40248216639). The
    // job outlasts setup, the artifact wait, its own shard and the gate, so
    // the gate's own error reports before the job times out.
    const QUEUE_MINUTES = 25;
    const SETUP_MINUTES = 10;
    const OWN_SHARD_MINUTES = 30;
    const gateMinutes = options.maxWaitMs / 60_000;
    expect(gateMinutes).toBeGreaterThanOrEqual(Number(shards["timeout-minutes"]) + QUEUE_MINUTES);
    const artifactWait = parseArtifactWaitArgs(action.runs.steps.find((step) => step.run?.startsWith("node scripts/ci/wait-for-run-artifacts.mjs")).run.replaceAll("${{ github.run_id }}", "1").replace("node scripts/ci/wait-for-run-artifacts.mjs", "").match(/"[^"]*"|\S+/g).map((arg) => arg.replace(/^"|"$/g, "")));
    const waitMinutes = artifactWait.maxWaitMs / 60_000;
    expect(waitMinutes).toBeGreaterThanOrEqual(Number(e2e.jobs["e2e-image"]["timeout-minutes"]));
    expect(Number(e2e.jobs.playwright["timeout-minutes"])).toBeGreaterThan(SETUP_MINUTES + waitMinutes + OWN_SHARD_MINUTES + gateMinutes);
    expect(Number(e2e.jobs["multi-lodge"]["timeout-minutes"])).toBeGreaterThan(SETUP_MINUTES + waitMinutes + OWN_SHARD_MINUTES);
  });

  it("the run action prepares and runs Playwright, skippable only on an explicit needed=false, and waits on the right inputs", () => {
    const steps = action.runs.steps;
    for (const command of ["bash scripts/e2e-stack.sh prepare", "bash scripts/e2e-stack.sh run ${{ inputs.playwright-args }}"]) {
      const step = steps.find((item) => item.run === command);
      expect(step, command).toBeDefined();
      expect(step.if).toBe(needed);
      expect(step["continue-on-error"]).toBeUndefined();
    }
    const wait = steps.find((item) => item.run?.startsWith("node scripts/ci/wait-for-run-artifacts.mjs"));
    expect(wait?.if).toBe(`${needed} && inputs.wait-for-artifacts == 'true'`);
    expect(wait?.["continue-on-error"]).toBeUndefined();
    const command = wait.run.replace("node scripts/ci/wait-for-run-artifacts.mjs", "").replaceAll("${{ github.run_id }}", "4397");
    const args = parseArtifactWaitArgs(command.match(/"[^"]*"|\S+/g).map((arg) => arg.replace(/^"|"$/g, "")));
    expect(args.artifacts).toEqual(["e2e-app-image-4397", "e2e-seeded-db-4397"]);
    // The names the image and database jobs upload.
    const text = readFileSync(e2ePath, "utf8");
    expect(text).toContain("name: e2e-app-image-${{ github.run_id }}");
    expect(text).toContain("name: e2e-seeded-db-${{ github.run_id }}");
    expect(args.upstream).toEqual(upstreamNames);
    for (const step of steps) {
      if (step.if?.includes("inputs.needed")) expect(step.if).toMatch(/inputs\.needed != 'false'/);
      expect(step["continue-on-error"]).toBeUndefined();
    }
  });

  it("skips heavy steps only on an explicit needed=false, never on a missing answer", () => {
    const text = readFileSync(e2ePath, "utf8") + readFileSync(path.join(root, ".github", "actions", "e2e-run", "action.yml"), "utf8");
    expect(text).not.toMatch(/needed == 'true'/);
    for (const job of Object.values(e2e.jobs)) {
      for (const step of job.steps) {
        if (step.if?.includes("steps.scope")) expect(step.if).toMatch(/steps\.scope\.outputs\.needed != 'false'/);
      }
    }
  });

  it("keeps every secret out of the seeded-database artifact", () => {
    const text = readFileSync(e2ePath, "utf8");
    expect(text.slice(text.indexOf("\n  e2e-db:"))).toContain("bash scripts/e2e-stack.sh snapshot");
    expect(JSON.stringify(e2e.jobs["e2e-db"])).not.toMatch(/\bsecrets\b/);
    expect(e2e.env).toBeUndefined();
    const stack = readFileSync(path.join(root, "scripts", "e2e-stack.sh"), "utf8");
    const body = (name) => stack.slice(stack.indexOf(`\n${name}() {`), stack.indexOf("\n}\n", stack.indexOf(`\n${name}() {`)));
    for (const name of ["seed_database", "snapshot", "reset_database", "capture_fixture_date"]) {
      expect(stack.indexOf(`\n${name}() {`), `${name}() must exist`).toBeGreaterThan(-1);
      expect(body(name), name).not.toMatch(/seed-stripe-credentials|STRIPE/);
    }
    const called = [...body("snapshot").matchAll(/^\s*([a-z_]+)(?:\s|$)/gm)].map((match) => match[1]);
    const checkedOrBuiltin = new Set(["seed_database", "reset_database", "capture_fixture_date", "local", "echo", "mkdir", "compose", "cp", "snapshot"]);
    expect(called.filter((name) => !checkedOrBuiltin.has(name))).toEqual([]);
    expect(stack.slice(stack.indexOf("prepare() {"))).toContain("e2e/setup/seed-stripe-credentials.ts");
  });
});
