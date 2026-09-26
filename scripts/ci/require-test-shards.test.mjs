import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { BaseSequencer } from "vitest/node";

import { parseWorkflowYaml } from "./check-workflow-suite-checkout-depth.mjs";
import {
  EXPECTED_SHARD_COUNT,
  classifyTestShardJobs,
  getAttemptJobs,
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

describe("required verify's independent test-shard gate", () => {
  it("preserves the required job name, avoids needs/job-level if, and gives every shard a full checkout", () => {
    const verify = workflow.jobs.verify;
    const matrixJob = workflow.jobs["test-shard"];
    expect(verify.needs).toBeUndefined();
    expect(verify.if).toBeUndefined();
    expect(verify["continue-on-error"]).toBeUndefined();
    expect(verify.permissions.actions).toBe("read");
    expect(verify.permissions.contents).toBe("read");
    const gateStep = verify.steps.find((step) => step.run === "node scripts/ci/require-test-shards.mjs");
    expect(gateStep).toBeDefined();
    expect(gateStep?.if).toBeUndefined();
    expect(gateStep?.["continue-on-error"]).toBeUndefined();
    expect(verify.steps.some((step) => /(?:^|\s)npm test(?:\s|$)/.test(step.run ?? ""))).toBe(false);
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
    const testStep = matrixJob.steps.find((step) => step.run === `npm test -- --shard=${"${{ matrix.shard }}"}/${EXPECTED_SHARD_COUNT}`);
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
  expect(result.stderr).toContain("Unit-test shard gate failed");
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
