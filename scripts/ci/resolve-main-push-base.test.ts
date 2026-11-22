import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { parseWorkflowYaml } from "./check-workflow-suite-checkout-depth.mjs";
import { type WorkflowRun, MainPushBaseError, main, parseArgs, resolveMainPushBase } from "./resolve-main-push-base.mjs";

/*
  INV-OPS-021 (#5356): a push to main is judged from the last main commit
  whose ci.yml run ran the caller's gate steps, so a merge whose queued run a
  newer merge replaced, or whose run stopped before the gates, is still judged.
  These cases drive the resolver over a fake GitHub API, then pin how ci.yml
  wires it, because a step that quietly stops running leaves every consumer
  on `github.event.before` with nothing red.
*/

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
const sha = (letter: string) => letter.repeat(40);
const GATE = { job: "verify", steps: ["Doc index", "File-size budget ratchet"] };

/** A `main` push run of ci.yml as GitHub lists it. */
function run(runNumber: number, head: string, conclusion: string | null = "success", status = "completed"): WorkflowRun {
  return { id: 1000 + runNumber, run_number: runNumber, head_sha: head, status, conclusion: status === "completed" ? conclusion : null };
}

type FakeJob = { name: string; steps: Array<{ name: string; conclusion: string | null }> };

/** The `verify` job of a run whose gate steps ended as `conclusions` (null: the step never ran). */
function verifyJob(...conclusions: Array<string | null>): FakeJob {
  return { name: "verify", steps: GATE.steps.map((name, index) => ({ name, conclusion: conclusions[index] ?? null })) };
}

/**
 * A fetch serving `pages` of runs (newest-first lists) and each run's jobs
 * from `jobsByRunNumber` (default: both gates ran). Records the paths asked for.
 */
function fakeApi(pages: WorkflowRun[][], jobsByRunNumber: Record<number, FakeJob[]> = {}, { status = 200 } = {}) {
  const paths: string[] = [];
  const fetchImpl = async (input: string) => {
    const url = new URL(input);
    paths.push(`${url.pathname}${url.search}`);
    const jobsMatch = /\/actions\/runs\/(\d+)\/jobs$/.exec(url.pathname);
    let body: unknown;
    if (jobsMatch) {
      const jobs = jobsByRunNumber[Number(jobsMatch[1]) - 1000] ?? [verifyJob("success", "success")];
      body = { total_count: jobs.length, jobs };
    } else {
      body = { total_count: 0, workflow_runs: pages[Number(url.searchParams.get("page")) - 1] ?? [] };
    }
    return { ok: status === 200, status, json: async () => body };
  };
  return { fetchImpl, paths };
}

const everyAncestor = () => true;
const request = (overrides: Partial<Parameters<typeof resolveMainPushBase>[0]>) => ({ repository: "owner/repo", token: "t", runNumber: 50, headSha: sha("f"), isAncestor: everyAncestor, ...GATE, ...overrides });

describe("resolveMainPushBase", () => {
  it("judges from the newest earlier run whose gates ran, past runs a newer merge replaced", async () => {
    const { fetchImpl, paths } = fakeApi([
      [run(50, sha("f"), null, "in_progress"), run(49, sha("d"), "cancelled"), run(48, sha("c"), "cancelled"), run(47, sha("b"), "failure"), run(46, sha("a"))],
    ]);

    const result = await resolveMainPushBase(request({ fetchImpl }));

    expect(result.sha).toBe(sha("b"));
    expect(paths).toEqual([
      "/repos/owner/repo/actions/workflows/ci.yml/runs?branch=main&event=push&per_page=100&page=1",
      "/repos/owner/repo/actions/runs/1047/jobs?filter=latest&per_page=100",
    ]);
  });

  it("takes the previous commit when nothing was dropped", async () => {
    const { fetchImpl } = fakeApi([[run(50, sha("f"), null, "in_progress"), run(49, sha("e"))]]);
    expect((await resolveMainPushBase(request({ fetchImpl }))).sha).toBe(sha("e"));
  });

  it("skips a red run that stopped before the gates, though it was not cancelled", async () => {
    // #49 failed on a flaky shard before the ratchet; #48 ran the doc index only.
    const { fetchImpl } = fakeApi([[run(49, sha("e"), "failure"), run(48, sha("d"), "failure"), run(47, sha("c"), "failure")]], {
      49: [verifyJob(null, null)],
      48: [verifyJob("success", null)],
      47: [verifyJob("success", "failure")],
    });
    expect((await resolveMainPushBase(request({ fetchImpl }))).sha).toBe(sha("c"));
  });

  it("skips a run without the job, and runs not yet finished or that never ran", async () => {
    const { fetchImpl } = fakeApi(
      [[run(49, sha("e"), null, "in_progress"), run(48, sha("d"), null, "queued"), run(47, sha("c"), "startup_failure"), run(46, sha("b")), run(45, sha("a"))]],
      { 46: [{ name: "lint", steps: [] }] },
    );
    expect((await resolveMainPushBase(request({ fetchImpl }))).sha).toBe(sha("a"));
  });

  it("ignores newer runs, its own commit's other runs, and commits that are not ancestors", async () => {
    const { fetchImpl } = fakeApi([[run(52, sha("9")), run(51, sha("f")), run(49, sha("f")), run(48, sha("8")), run(47, sha("c"))]]);
    const result = await resolveMainPushBase(request({ fetchImpl, isAncestor: (commit) => commit !== sha("8") }));
    expect(result.sha).toBe(sha("c"));
  });

  it("reads further pages until it finds one", async () => {
    const cancelled = Array.from({ length: 100 }, (_, index) => run(49 - index, sha("d"), "cancelled"));
    const { fetchImpl } = fakeApi([cancelled, [run(-60, sha("a"))]]);
    expect((await resolveMainPushBase(request({ fetchImpl }))).sha).toBe(sha("a"));
  });

  it("fails closed when no earlier run ran the gates on an ancestor", async () => {
    const { fetchImpl } = fakeApi([[run(49, sha("d"), "cancelled"), run(48, sha("c"), "failure")]], { 48: [verifyJob(null, null)] });
    await expect(resolveMainPushBase(request({ fetchImpl }))).rejects.toThrow(MainPushBaseError);
  });

  it("counts a run that ran a renamed gate under the old name given as an alias", async () => {
    // #49 ran the ratchet as "Size ratchet"; this PR renamed it. Without the
    // alias nothing matches and every main push fails closed for good, since
    // the gates after the resolver are skipped and never record the new name.
    const renamed = { name: "verify", steps: [{ name: "Doc index", conclusion: "success" }, { name: "Size ratchet", conclusion: "success" }] };
    const { fetchImpl } = fakeApi([[run(49, sha("e"))]], { 49: [renamed] });
    await expect(resolveMainPushBase(request({ fetchImpl }))).rejects.toThrow(/--step-was/);
    const steps = ["Doc index", { name: "File-size budget ratchet", was: ["Size ratchet"] }];
    expect((await resolveMainPushBase(request({ fetchImpl, steps }))).sha).toBe(sha("e"));
  });

  it("counts a run of a renamed job under the old name given as an alias", async () => {
    const { fetchImpl } = fakeApi([[run(49, sha("e"))]], { 49: [{ ...verifyJob("success", "success"), name: "Verify" }] });
    await expect(resolveMainPushBase(request({ fetchImpl }))).rejects.toThrow(MainPushBaseError);
    expect((await resolveMainPushBase(request({ fetchImpl, jobWas: ["Verify"] }))).sha).toBe(sha("e"));
  });

  it("fails closed on an API error or an answer it cannot read", async () => {
    await expect(resolveMainPushBase(request({ fetchImpl: fakeApi([], {}, { status: 403 }).fetchImpl }))).rejects.toThrow(/HTTP 403/);
    const garbled = async () => ({ ok: true, status: 200, json: async () => ({ workflow_runs: [{ id: "1" }] }) });
    await expect(resolveMainPushBase(request({ fetchImpl: garbled }))).rejects.toThrow(/shape/);
    const notACommit = fakeApi([[{ ...run(49, sha("e")), head_sha: "--output=x" }]]).fetchImpl;
    await expect(resolveMainPushBase(request({ fetchImpl: notACommit }))).rejects.toThrow(/shape/);
    const offline = async () => {
      throw new Error("network down");
    };
    await expect(resolveMainPushBase(request({ fetchImpl: offline }))).rejects.toThrow(/network down/);
    const truncated = fakeApi([[run(49, sha("e"))]]);
    const truncatedJobs = async (input: string) => {
      if (!String(input).includes("/jobs")) return truncated.fetchImpl(input);
      return { ok: true, status: 200, json: async () => ({ total_count: 150, jobs: [verifyJob("success", "success")] }) };
    };
    await expect(resolveMainPushBase(request({ fetchImpl: truncatedJobs }))).rejects.toThrow(/more than one page/);
  });
});

describe("parseArgs", () => {
  it("attaches each --step-was to the --step before it, and collects --job-was", () => {
    expect(parseArgs(["--job", "verify", "--job-was", "Verify", "--step", "A", "--step-was", "Old A", "--step-was", "Older A", "--step", "B"])).toEqual({
      job: "verify",
      jobWas: ["Verify"],
      steps: [
        { name: "A", was: ["Old A", "Older A"] },
        { name: "B", was: [] },
      ],
    });
  });

  it("refuses a --step-was with no --step before it, and an unknown flag", () => {
    expect(() => parseArgs(["--job", "verify", "--step-was", "Old", "--step", "A"])).toThrow(/must follow/);
    expect(() => parseArgs(["--job", "verify", "--steps", "A"])).toThrow(/Unexpected argument/);
  });
});

describe("main", () => {
  let dir: string | undefined;
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));
  const quiet = { log: () => {} };
  const argv = ["--job", "verify", "--step", "Doc index", "--step", "File-size budget ratchet"];

  const mainPushEnv = (output: string | undefined) => ({
    GITHUB_EVENT_NAME: "push",
    GITHUB_REF: "refs/heads/main",
    GITHUB_REPOSITORY: "owner/repo",
    GITHUB_TOKEN: "t",
    GITHUB_RUN_NUMBER: "50",
    GITHUB_SHA: sha("f"),
    GITHUB_OUTPUT: output,
  });

  it("writes the resolved commit for a push to main", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "main-push-base-"));
    const output = path.join(dir, "out");
    const { fetchImpl } = fakeApi([[run(49, sha("d"), "cancelled"), run(48, sha("c"))]]);

    expect(await main({ argv, env: mainPushEnv(output), fetchImpl, isAncestor: everyAncestor, log: quiet })).toBe(0);
    expect(readFileSync(output, "utf8")).toBe(`sha=${sha("c")}\n`);
  });

  it("writes nothing and asks nothing for an epic push or a pull request", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "main-push-base-"));
    const output = path.join(dir, "out");
    const { fetchImpl, paths } = fakeApi([[run(49, sha("e"))]]);
    for (const env of [
      { ...mainPushEnv(output), GITHUB_REF: "refs/heads/epic/12-x" },
      { ...mainPushEnv(output), GITHUB_EVENT_NAME: "pull_request", GITHUB_REF: "refs/pull/7/merge" },
    ]) {
      expect(await main({ argv, env, fetchImpl, isAncestor: everyAncestor, log: quiet })).toBe(0);
    }
    expect(paths).toEqual([]);
    expect(() => readFileSync(output, "utf8")).toThrow();
  });

  it("refuses a push to main it cannot place, and a call that names no gate", async () => {
    const { fetchImpl } = fakeApi([[]]);
    await expect(main({ argv, env: { ...mainPushEnv(undefined), GITHUB_RUN_NUMBER: "" }, fetchImpl, log: quiet })).rejects.toThrow(/GITHUB_RUN_NUMBER/);
    await expect(main({ argv, env: mainPushEnv(undefined), fetchImpl, isAncestor: everyAncestor, log: quiet })).rejects.toThrow(MainPushBaseError);
    await expect(main({ argv: ["--job", "verify"], env: mainPushEnv(undefined), fetchImpl, log: quiet })).rejects.toThrow(/--step/);
  });

  it("as a CLI, exits 1 and writes no output when GitHub's API fails", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "main-push-base-"));
    const output = path.join(dir, "out");
    // A local stand-in for the Actions API that fails every request.
    const server = createServer((_request, response) => response.writeHead(503).end());
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const failure = await promisify(execFile)(process.execPath, [path.join(REPO_ROOT, "scripts", "ci", "resolve-main-push-base.mjs"), ...argv], {
        cwd: REPO_ROOT,
        env: { ...process.env, PUSH_BEFORE_SHA: "", ...mainPushEnv(output), GITHUB_API_URL: `http://127.0.0.1:${port}` },
      }).then(
        () => null,
        (error: { code?: number; stderr?: string }) => error,
      );
      expect(failure?.code).toBe(1);
      expect(failure?.stderr).toMatch(/HTTP 503[\s\S]*Nothing was judged/);
      expect(existsSync(output)).toBe(false);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

/** The words of a `run:` line, honouring double quotes (all ci.yml's resolver steps use). */
function shellWords(line: string): string[] {
  return [...line.matchAll(/"([^"]*)"|(\S+)/g)].map((match) => match[1] ?? match[2] ?? "");
}

describe("ci.yml's wiring of the resolver", () => {
  const workflow = parseWorkflowYaml(readFileSync(path.join(REPO_ROOT, ".github", "workflows", "ci.yml"), "utf8"));
  const RESOLVER = "node scripts/ci/resolve-main-push-base.mjs";
  type Step = Record<string, unknown>;
  const reads = (step: Step) => JSON.stringify(step.env ?? {}).includes("steps.main-push-base.outputs.sha");

  /*
    The gate job and step names that runs already on main have recorded. A
    rename that updates --job/--step without the old name as --job-was or
    --step-was leaves no earlier run to match, so every push to main fails
    closed. Change a name here only once a main run has finished the gate
    under its new name (CONTRIBUTING.md "Finding which merge broke main").
    Never change this list in the same pull request as a step or job rename:
    the rename needs its alias (--step-was/--job-was), and this list changes
    only after main has recorded the new name. A rename plus an edit here
    passes every test, then fails closed on every push to main.
  */
  const RECORDED_ON_MAIN: Record<string, { job: string; steps: string[] }> = {
    verify: { job: "verify", steps: ["Check doc index integrity (reachability + invariant ids)", "File-size budget ratchet"] },
    "migration-drift": { job: "Migration drift check", steps: ["Check migration safety ledger coverage"] },
  };

  for (const jobKey of ["verify", "migration-drift"]) {
    it(`${jobKey}'s resolver still matches the names main's runs recorded`, () => {
      const resolver = ((workflow.jobs[jobKey]?.steps ?? []) as Step[]).find((step) => step.id === "main-push-base");
      const { job: jobName, jobWas, steps: gates } = parseArgs(shellWords(String(resolver?.run ?? "").slice(RESOLVER.length)));
      const recorded = RECORDED_ON_MAIN[jobKey];
      if (!recorded) throw new Error(`RECORDED_ON_MAIN has no entry for ${jobKey}`);
      const hint = "a renamed gate keeps its old name as --job-was/--step-was; see CONTRIBUTING.md \"Finding which merge broke main\"";
      expect([jobName, ...jobWas], `${jobKey}: job "${recorded.job}" is missing; ${hint}`).toContain(recorded.job);
      for (const name of recorded.steps) {
        const names = gates.filter((gate) => gate.name === name || gate.was.includes(name));
        expect(names, `${jobKey}: step "${name}" is missing; ${hint}`).toHaveLength(1);
      }
    });

    it(`${jobKey} resolves the base before each gate it names, and every reader follows it`, () => {
      const job = workflow.jobs[jobKey];
      if (!job) throw new Error(`ci.yml has no ${jobKey} job`);
      const steps: Step[] = job.steps ?? [];
      const at = steps.findIndex((step) => step.id === "main-push-base");
      expect(at, `${jobKey} has a step with id main-push-base`).toBeGreaterThan(-1);
      const resolver = steps[at] ?? {};
      expect(String(resolver.run).startsWith(RESOLVER)).toBe(true);
      expect((resolver.env as Record<string, string> | undefined)?.GITHUB_TOKEN).toBe("${{ secrets.GITHUB_TOKEN }}");
      expect(job.permissions?.actions).toBe("read");

      const { job: jobName, jobWas, steps: gates } = parseArgs(shellWords(String(resolver.run).slice(RESOLVER.length)));
      // GitHub's jobs API reports the job's display name.
      expect(jobName).toBe(job.name ?? jobKey);
      const later = steps.slice(at + 1);
      for (const { name } of gates) {
        const step = later.find((candidate) => candidate.name === name);
        expect(step, `${jobKey} runs "${name}" after the resolver`).toBeDefined();
        expect(reads(step as Step), `"${name}" judges from the resolved base`).toBe(true);
      }
      // Fail closed needs the resolver to fail its step and every reader to be
      // skipped after it: each reader's env still falls back to
      // github.event.before. continue-on-error or an `if:` on the resolver, or
      // an `if:` with a status function (always(), failure(), !cancelled()) on
      // a reader, would run a gate after a failed resolver, judging from before.
      expect(resolver["continue-on-error"], `${jobKey}'s resolver must fail its step`).toBeUndefined();
      expect(resolver.if, `${jobKey}'s resolver must run unconditionally`).toBeUndefined();
      expect(job["continue-on-error"], `${jobKey} must not continue on a failed resolver`).toBeUndefined();
      for (const reader of later.filter(reads)) {
        expect(String(reader.if ?? ""), `"${String(reader.name)}" must be skipped after a failed resolver`).not.toMatch(/\b(always|failure|cancelled)\s*\(/);
      }

      // A reader the resolver does not name could be judged from a run where it never ran.
      expect(later.filter(reads).map((step) => step.name)).toEqual(gates.map(({ name }) => name));
      expect(steps.slice(0, at).filter(reads)).toEqual([]);

      // An old name must be old: one that is still a step's name here would
      // count a run where a different step ran as having run this gate.
      const current = new Set(steps.map((step) => step.name));
      for (const old of gates.flatMap(({ was }) => was)) {
        expect(current.has(old), `--step-was "${old}" is still the name of a ${jobKey} step`).toBe(false);
      }
      const jobNames = new Set(Object.entries(workflow.jobs).map(([key, other]) => other.name ?? key));
      for (const old of jobWas) {
        expect(jobNames.has(old), `--job-was "${old}" is still the name of a ci.yml job`).toBe(false);
      }
    });
  }

  it("no other job reads the resolved base without resolving it", () => {
    const readers = Object.entries(workflow.jobs)
      .filter(([, job]) => ((job.steps ?? []) as Step[]).some(reads))
      .map(([key]) => key);
    expect(readers.sort()).toEqual(["migration-drift", "verify"]);
  });
});
