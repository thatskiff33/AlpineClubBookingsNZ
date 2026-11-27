import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { BaseSequencer } from "vitest/node";

import { parseWorkflowYaml } from "./check-workflow-suite-checkout-depth.mjs";
import { escapeRegex } from "./escape-regex.mjs";
import { parseArtifactWaitArgs } from "./wait-for-run-artifacts.mjs";
import {
  EXPECTED_SHARD_COUNT,
  classifyRequiredJobs,
  classifyTestShardJobs,
  getAttemptJobs,
  parseShardGateArgs,
  RUN_END_GRACE_MINUTES,
  requireTestShards,
  shardGateWaitMs,
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
// Any allowances will do where a test is not about the wait itself.
const ALLOW = { maxQueueMinutes: 60, maxRunMinutes: 45 };
// A clock past any wait from its second reading on: the gate's first timeout check fires.
const expiredClock = () => { let ms = 0; return () => (ms += 1e9); };
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
      ...ALLOW,
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
      maxQueueMinutes: 1,
      maxRunMinutes: 1,
      intervalMs: 60_000,
    })).rejects.toThrow(/Timed out after 1 minutes' runner queue \+ 1 minutes' job limit \+ 5 minutes' grace waiting for Test shard jobs: missing 4\/4/);
  });

  it("fails closed on an API/auth error without treating it as an empty successful run", async () => {
    await expect(requireTestShards({ ...ALLOW, loadJobs: async () => { throw new Error("HTTP 403"); } }))
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
    expect(options.required.toSorted()).toEqual([...SPLIT_JOBS.map(({ id }) => workflow.jobs[id].name), workflow.jobs["realdb-all"].name].toSorted());
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

  // #5164: `next build` type-checks the app project in a worker that inherits
  // NODE_OPTIONS, and a cold run peaked at about 4.6 GB (#5053), over Node's
  // ~4 GB default on the hosted runner. Every `next build` CI runs gets the
  // one ceiling ci.yml's `Build` step states the reason for. A census of every
  // workflow, not a named list, so a new build site cannot quietly miss it.
  it("gives every `next build` in CI the same 8 GB heap ceiling", () => {
    const HEAP = "--max-old-space-size=8192";
    const workflowsDir = path.join(root, ".github", "workflows");
    const sites = [];
    for (const file of readdirSync(workflowsDir).filter((name) => /\.ya?ml$/.test(name)).sort()) {
      const parsed = parseWorkflowYaml(readFileSync(path.join(workflowsDir, file), "utf8"));
      for (const [id, job] of Object.entries(parsed.jobs ?? {})) {
        for (const step of job.steps ?? []) {
          const where = `${file} → ${id} → ${step.name ?? step.uses ?? step.run}`;
          const run = step.run ?? "";
          if (/\bpnpm run build(?:\s|$)|\bnext build\b|server-only-boundary-selftest\.mjs/.test(run)) {
            sites.push(where);
            expect(step.env?.NODE_OPTIONS, where).toBe(HEAP);
          } else if (/\bdocker build\b/.test(run)) {
            sites.push(where);
            expect(run, where).toContain('--build-arg NODE_OPTIONS="${NODE_BUILD_OPTIONS}"');
            expect(job.env?.NODE_BUILD_OPTIONS, where).toBe(HEAP);
          } else if (step.uses?.startsWith("docker/build-push-action@")) {
            sites.push(where);
            expect(step.with?.["build-args"]?.split("\n"), where).toContain("NODE_OPTIONS=${{ env.NODE_BUILD_OPTIONS }}");
            expect(job.env?.NODE_BUILD_OPTIONS, where).toBe(HEAP);
          }
        }
      }
    }
    // Build + self-test, the Trivy image, two GHCR images, the E2E image and
    // its cache export, the rollover proof's image: the census is not empty.
    expect(sites.length, sites.join("\n")).toBeGreaterThanOrEqual(8);
    // The local E2E stack builds the same image through compose.
    const stack = readFileSync(path.join(root, "scripts", "e2e-stack.sh"), "utf8");
    expect(stack).toContain(`export NODE_BUILD_OPTIONS="\${NODE_BUILD_OPTIONS:-${HEAP}}"`);
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
      ...ALLOW,
      loadJobs: async () => (++calls === 1 ? [...passed(), lint("in_progress", null)] : [...passed(), lint("completed", "success")]),
      sleep: async () => {},
    })).resolves.toBeUndefined();
    expect(calls).toBe(2);
    await expect(requireTestShards({
      required: ["Lint"],
      ...ALLOW,
      loadJobs: async () => [shard(1, "in_progress", null), lint("completed", "failure")],
      sleep: async () => { throw new Error("waited instead of failing"); },
    })).rejects.toThrow(/Required job "Lint" completed as failure/);
  });
});

// #4907 (owner decision, 11 Nov 2026, option B): every real-PostgreSQL suite
// reaches the merge gate through `verify`'s poll, by the job's display name.
// `realdb-ci-coverage-census.test.ts` pins that name and the job's wiring.
describe("verify's real-database gate (#4907)", () => {
  const options = () => parseShardGateArgs(splitArgs(verifyGateStep().run.slice(GATE.length)));
  const name = workflow.jobs["realdb-all"].name;
  const realdb = (conclusion = "success", status = "completed") => ({ name, status, conclusion });
  const otherJobs = () => [...passed(), ...["typecheck", "lint", "build"].map((id) => ({
    name: workflow.jobs[id].name, status: "completed", conclusion: "success",
  }))];

  it("polls the real-database job by the name GitHub reports it under", () => {
    expect(options().required).toContain(name);
  });

  it.each(["failure", "cancelled", "timed_out", "skipped", null])(
    "fails verify at once when the real-database result is %s",
    async (conclusion) => {
      await expect(requireTestShards({
        ...options(),
        loadJobs: async () => [...otherJobs(), realdb(conclusion)],
        sleep: async () => { throw new Error("waited instead of failing"); },
      })).rejects.toThrow(new RegExp(`Required job "${escapeRegex(name)}" completed as`));
    },
  );

  it("fails verify when this attempt has no real-database result", async () => {
    await expect(requireTestShards({
      ...options(), loadJobs: async () => otherJobs(), now: expiredClock(), sleep: async () => {},
    })).rejects.toThrow(new RegExp(`Timed out.*missing "${escapeRegex(name)}"`));
  });

  it("cannot reuse a successful real-database result from an earlier attempt", async () => {
    const urls = [];
    await expect(requireTestShards({
      ...options(),
      now: expiredClock(),
      sleep: async () => {},
      loadJobs: () => getAttemptJobs({
        apiUrl: "https://api.github.com",
        repository: "club/repo",
        runId: "123",
        attempt: "2",
        token: "test-token",
        fetchImpl: async (url) => {
          urls.push(url.pathname);
          // A run-wide lookup can include the successful first attempt.
          // Only the second attempt lacks the real-database result.
          const jobs = url.pathname.includes("/attempts/2/")
            ? otherJobs() : [...otherJobs(), realdb()];
          return { ok: true, json: async () => ({ total_count: jobs.length, jobs }) };
        },
      }),
    })).rejects.toThrow(new RegExp(`Timed out.*missing "${escapeRegex(name)}"`));
    expect(urls).toEqual(["/repos/club/repo/actions/runs/123/attempts/2/jobs"]);
  });

  it("waits for the real-database job, then accepts its success", async () => {
    let calls = 0;
    await expect(requireTestShards({
      ...options(),
      loadJobs: async () => [...otherJobs(), ++calls === 1 ? realdb(null, "in_progress") : realdb()],
      sleep: async () => {},
    })).resolves.toBeUndefined();
    expect(calls).toBe(2);
  });
});

// #5222: `realdb-all` queued 37 minutes for a runner and ran 24 (PR #5176,
// run 43902903981, 17 Nov 2026), past the old flat 45-minute wait, so
// `verify` went red over a green run. The wait is now the runner-queue
// allowance plus the longest limit among the awaited jobs, each pinned here
// to the workflow, and `verify`'s own limit outlasts it.
describe("verify's gate outwaits every job it awaits (#5222)", () => {
  const options = () => parseShardGateArgs(splitArgs(verifyGateStep().run.slice(GATE.length)));
  const awaited = () => ["test-shard", "typecheck", "lint", "build", "realdb-all"].map((id) => workflow.jobs[id]);
  // The longest runner queue seen before an awaited job started.
  const OBSERVED_QUEUE_MINUTES = 37;
  // Checkout, install and `verify`'s own gates before it starts polling.
  const PRE_GATE_MINUTES = 15;

  it("awaits exactly the jobs whose limits it is pinned to", () => {
    const names = awaited().map((job) => job.name);
    expect(names[0]).toBe(`Test shard (${"${{ matrix.shard }}"}/${EXPECTED_SHARD_COUNT})`);
    expect(options().required.toSorted()).toEqual(names.slice(1).toSorted());
  });

  it("allows the longest awaited job its whole limit after a queue longer than any seen", () => {
    const limits = awaited().map((job) => Number(job["timeout-minutes"]));
    expect(limits.every((minutes) => Number.isInteger(minutes) && minutes > 0), String(limits)).toBe(true);
    expect(options().maxRunMinutes).toBe(Math.max(...limits));
    expect(options().maxQueueMinutes).toBeGreaterThan(OBSERVED_QUEUE_MINUTES);
  });

  it("is outlasted by verify's own timeout, so the gate's error is the one reported", () => {
    const waitMinutes = shardGateWaitMs(options()) / 60_000;
    expect(waitMinutes).toBe(options().maxQueueMinutes + options().maxRunMinutes + RUN_END_GRACE_MINUTES);
    expect(Number(workflow.jobs.verify["timeout-minutes"])).toBeGreaterThanOrEqual(PRE_GATE_MINUTES + waitMinutes);
  });

  it("passes when the real-database job queues 37 minutes and runs 24, as in run 43902903981", async () => {
    const name = workflow.jobs["realdb-all"].name;
    const others = [...passed(), ...["typecheck", "lint", "build"].map((id) => ({ name: workflow.jobs[id].name, status: "completed", conclusion: "success" }))];
    let clock = 0;
    const minutes = () => clock / 60_000;
    await expect(requireTestShards({
      ...options(),
      now: () => clock,
      sleep: async (ms) => { clock += ms; },
      loadJobs: async () => {
        if (minutes() < 37) return [...others, { name, status: "queued", conclusion: null }];
        if (minutes() < 37 + 24) return [...others, { name, status: "in_progress", conclusion: null }];
        return [...others, { name, status: "completed", conclusion: "success" }];
      },
    })).resolves.toBeUndefined();
    expect(minutes()).toBeGreaterThanOrEqual(61);
  });

  it("still fails at once when a job fails late in a long wait", async () => {
    const name = workflow.jobs["realdb-all"].name;
    let clock = 0;
    await expect(requireTestShards({
      ...options(),
      now: () => clock,
      sleep: async (ms) => { clock += ms; },
      loadJobs: async () => [...passed(), {
        name, status: clock < 90 * 60_000 ? "in_progress" : "completed", conclusion: clock < 90 * 60_000 ? null : "cancelled",
      }],
      required: [name],
    })).rejects.toThrow(/completed as cancelled/);
    expect(clock).toBe(90 * 60_000);
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
  // #5222: with both allowances, so it fails on the identity, not on a missing flag.
  const result = spawnSync(process.execPath, [path.join(root, "scripts", "ci", "require-test-shards.mjs"), "--max-queue-minutes", "1", "--max-run-minutes", "1"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, GITHUB_REPOSITORY: "", GITHUB_TOKEN: "" },
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('Shard gate for "Test shard" failed');
  expect(result.stderr).toMatch(/failed: (Invalid GITHUB_|GITHUB_TOKEN is required)/);
});

// #4397: e2e.yml's required jobs reuse this gate for their own matrices.
describe("the gate for another matrix (--label/--count)", () => {
  const e2e = (index, status = "completed", conclusion = "success") => ({ name: `E2E shard (${index}/3)`, status, conclusion });

  it("parses its arguments, defaulting to the unit-test matrix, and refuses anything else", () => {
    const allow = ["--max-queue-minutes", "25", "--max-run-minutes", "45"];
    expect(parseShardGateArgs(allow)).toEqual({ label: "Test shard", count: EXPECTED_SHARD_COUNT, maxQueueMinutes: 25, maxRunMinutes: 45, upstream: [], from: 1, required: [] });
    expect(parseShardGateArgs(["--label", "E2E shard", "--count", "3", ...allow])).toEqual({ label: "E2E shard", count: 3, maxQueueMinutes: 25, maxRunMinutes: 45, upstream: [], from: 1, required: [] });
    // #5222: no default wait. Each caller states its queue and run allowances.
    expect(() => parseShardGateArgs([])).toThrow(/--max-queue-minutes is required/);
    expect(() => parseShardGateArgs(["--max-queue-minutes", "25"])).toThrow(/--max-run-minutes is required/);
    expect(() => parseShardGateArgs([...allow, "--max-run-minutes", "0"])).toThrow(/Invalid --max-run-minutes: 0/);
    expect(() => parseShardGateArgs(["--max-wait-minutes", "75"])).toThrow(/Unknown argument/);
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
    expect(parseShardGateArgs(["--max-queue-minutes", "1", "--max-run-minutes", "1", "--upstream", "E2E app image", "--upstream", "E2E seeded database"]).upstream).toEqual(["E2E app image", "E2E seeded database"]);
  });

  it("names the matrix in a timeout", async () => {
    let clock = 0;
    await expect(requireTestShards({
      loadJobs: async () => [e2e(1)],
      count: 3,
      label: "E2E shard",
      now: () => clock,
      sleep: async (ms) => { clock += ms; },
      ...ALLOW,
    })).rejects.toThrow(/waiting for E2E shard jobs: missing 2\/3, missing 3\/3/);
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
    expect(options.maxQueueMinutes).toBeGreaterThanOrEqual(QUEUE_MINUTES);
    expect(options.maxRunMinutes).toBe(Number(shards["timeout-minutes"]));
    const gateMinutes = shardGateWaitMs(options) / 60_000;
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

// #5192: `ubuntu-latest` is a moving label. While GitHub rolled it from 24.04
// to 26.04, the same commit got either image by chance, and on 26.04 the
// runner's newer `pg_dump` broke the required roles proof against the
// PostgreSQL 16 service. Every job in every workflow names one pinned image;
// moving to a newer one changes this constant and every workflow together
// (#5193 made the move to 26.04).
describe("every workflow job runs on the one pinned runner image (#5192)", () => {
  const RUNNER_IMAGE = "ubuntu-26.04";

  it("names the pinned image on every job, never a moving label", () => {
    const workflowsDir = path.join(root, ".github", "workflows");
    const jobs = [];
    for (const file of readdirSync(workflowsDir).filter((name) => /\.ya?ml$/.test(name)).sort()) {
      const parsed = parseWorkflowYaml(readFileSync(path.join(workflowsDir, file), "utf8"));
      for (const [id, job] of Object.entries(parsed.jobs ?? {})) {
        // A job that calls a reusable workflow has no runner of its own.
        if (job.uses) continue;
        jobs.push(`${file} → ${id}`);
        expect(job["runs-on"], `${file} → ${id}`).toBe(RUNNER_IMAGE);
      }
    }
    // Vacuity guard: the census read real workflows.
    expect(jobs.length).toBeGreaterThanOrEqual(30);
  });
});

// #5362: CONTRIBUTING.md (Branch protection) carries the one human-readable
// table of each gate's limits, and the workflows set the real numbers. This
// reads both and fails when they part, so the table cannot drift. It reads the
// files only; it changes no workflow.
describe("the CONTRIBUTING.md gate-limits table matches the workflows (#5362)", () => {
  const workflowsDir = path.join(root, ".github", "workflows");
  const contributing = readFileSync(path.join(root, "CONTRIBUTING.md"), "utf8");
  const HEADER = "| Gate | Runner queue | Longest job limit | Total wait | Gate job's limit |";

  // The table's body rows, from the header to the first line that is not a row.
  const tableRows = () => {
    const lines = contributing.split(/\r?\n/);
    // Runs of spaces collapsed, so re-padding the table's columns does not fail this.
    const start = lines.findIndex((line) => line.replace(/ +/g, " ").trim() === HEADER);
    expect(start, "the limits table's header row").toBeGreaterThan(-1);
    const rows = [];
    for (const line of lines.slice(start + 2)) {
      if (!line.startsWith("|")) break;
      const cells = line.split("|").slice(1, -1).map((cell) => cell.replace(/ +/g, " ").trim());
      expect(cells, line).toHaveLength(5);
      rows.push({ line, gate: cells[0].match(/^`([^`]+)`/)?.[1], cells });
    }
    return rows;
  };

  // Every gate step in every workflow, with the job it runs in.
  const gateSteps = () => {
    const found = [];
    for (const file of readdirSync(workflowsDir).filter((name) => /\.ya?ml$/.test(name)).sort()) {
      const parsed = parseWorkflowYaml(readFileSync(path.join(workflowsDir, file), "utf8"));
      for (const [id, job] of Object.entries(parsed.jobs ?? {})) {
        for (const step of job.steps ?? []) {
          if (!step.run?.startsWith(`${GATE} `)) continue;
          found.push({ where: `${file} → ${id}`, jobs: parsed.jobs, job, name: job.name ?? id, options: parseShardGateArgs(splitArgs(step.run.slice(GATE.length))) });
        }
      }
    }
    return found;
  };

  const leadingMinutes = (cell) => {
    const match = cell.match(/^(\d+)(?:\s|$)/);
    expect(match, `a cell that starts with its minutes: ${cell}`).not.toBeNull();
    return Number(match[1]);
  };

  it("has one row per gate step in the workflows, and no other", () => {
    const steps = gateSteps();
    // Vacuity guard: both known gates were read.
    expect(steps.length).toBeGreaterThanOrEqual(2);
    expect(tableRows().map((row) => row.gate).toSorted()).toEqual(steps.map((step) => step.name).toSorted());
  });

  it("states each gate's queue and run flags, its total wait and its job's timeout-minutes", () => {
    const rows = new Map(tableRows().map((row) => [row.gate, row]));
    for (const step of gateSteps()) {
      const row = rows.get(step.name);
      expect(row, `a table row for ${step.where}`).toBeDefined();
      const [, queue, longest, total, gateLimit] = row.cells;
      expect(leadingMinutes(queue), `${step.where}: runner queue`).toBe(step.options.maxQueueMinutes);
      expect(leadingMinutes(longest), `${step.where}: longest job limit`).toBe(step.options.maxRunMinutes);
      expect(leadingMinutes(total), `${step.where}: total wait`).toBe(shardGateWaitMs(step.options) / 60_000);
      expect(leadingMinutes(gateLimit), `${step.where}: gate job's limit`).toBe(Number(step.job["timeout-minutes"]));
    }
  });

  it("names jobs in the longest-limit column whose timeout-minutes are the figures it gives", () => {
    const jobsByName = (jobs) => Object.values(jobs).map((job) => ({ name: String(job.name ?? ""), minutes: Number(job["timeout-minutes"]) }));
    const rows = new Map(tableRows().map((row) => [row.gate, row]));
    let checked = 0;
    for (const step of gateSteps()) {
      const cell = rows.get(step.name).cells[2];
      // `45 (`Test shard`; `Real-PostgreSQL suites (all)` is 45)`: the first name
      // carries the leading figure, and any `<name>` is N carries its own.
      const first = cell.match(/^\d+ \(`([^`]+)`/)?.[1];
      expect(first, `${step.where}: the job the longest limit belongs to`).toBeDefined();
      const owner = jobsByName(step.jobs).filter((job) => job.name.startsWith(first));
      expect(owner, `${step.where}: one job named ${first}`).toHaveLength(1);
      expect(owner[0].minutes, `${step.where}: ${first}`).toBe(leadingMinutes(cell));
      checked += 1;
      for (const [, name, minutes] of cell.matchAll(/`([^`]+)` is (\d+)/g)) {
        const job = jobsByName(step.jobs).find((candidate) => candidate.name === name);
        expect(job, `${step.where}: a job named ${name}`).toBeDefined();
        expect(job.minutes, `${step.where}: ${name}`).toBe(Number(minutes));
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThanOrEqual(3);
  });
});
