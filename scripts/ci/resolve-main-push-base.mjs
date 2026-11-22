/**
 * The commit a push to `main` is judged from (INV-OPS-021, #5356).
 *
 *   node scripts/ci/resolve-main-push-base.mjs --job <job name> --step <step name> [--step …]
 *
 * WHY NOT `github.event.before`. Since #5356 a newer merge may replace `main`'s
 * queued CI run: the push concurrency group holds one running and one pending
 * run, and GitHub drops the older pending one. `before` is the previous `main`
 * tip, and when that commit's run was dropped its change was never judged by
 * the push-only gates (doc index, file-size ratchet, migration-safety ledger).
 * Judging from `before` would then let that change through unseen. So a push to
 * `main` is judged from the LAST JUDGED MAIN COMMIT instead, which covers every
 * merge in between. When nothing was dropped it is `before`.
 *
 * "Judged" is asked of the caller's own gate steps, not of the run's overall
 * result: a run can end `failure` because a test shard flaked before the
 * ratchet ever ran. So the last judged commit is the head of the newest earlier
 * `ci.yml` push run on `main` whose latest attempt finished every `--step` of
 * the job named by `--job` with `success` or `failure` (the gate ran, whatever
 * it said; a red gate turned `main` red and was seen). A run still in progress
 * does not count yet. The run must be older than this one (a lower run number;
 * a re-run keeps its number), for another commit, and that commit must be an
 * ancestor of HEAD.
 *
 * Writes `sha=<commit>` to `$GITHUB_OUTPUT`. Any event other than a push to
 * `main` writes nothing, so the caller keeps its own base (epic pushes and pull
 * requests are unchanged). It FAILS CLOSED: an API answer it cannot read, or no
 * judged run in what it reads, exits non-zero rather than falling back to
 * `before`, because a silent fallback is exactly the unjudged merge this exists
 * to prevent. `resolve-main-push-base.test.mjs` pins the callers' wiring.
 *
 * Node built-ins only: `verify` and `migration-drift` run it before installing.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import process from "node:process";

import { getActionsApiJson } from "./require-test-shards.mjs";
import { CI_WORKFLOW_FILE } from "../lib/ci-workflow.mjs";
import { isMainModule } from "../lib/is-main-module.mjs";

const MAIN_REF = "refs/heads/main";
const PAGE_SIZE = 100;
/** A full commit id: the only `head_sha` this passes to git or writes to `$GITHUB_OUTPUT`. */
const COMMIT_SHA = /^[0-9a-f]{40}$/;
/** Ten pages is a thousand `main` runs: far past any real run of cancellations. */
const MAX_PAGES = 10;
/** A completed run with one of these conclusions never ran its gates, so it is not worth asking about its steps. */
const NOTHING_RAN = new Set(["cancelled", "skipped", "stale", "startup_failure"]);
/** A gate step that finished with one of these ran and gave its verdict. */
const GATE_RAN = new Set(["success", "failure"]);

export class MainPushBaseError extends Error {}

/** Is `sha` an ancestor of HEAD in this checkout? A commit the checkout lacks is not. */
export function gitIsAncestor(sha) {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", sha, "HEAD"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** `getActionsApiJson`, with every failure raised as the resolver's own error. */
async function apiJson(context, path, params, what) {
  try {
    return await getActionsApiJson(context, path, params, what);
  } catch (error) {
    throw new MainPushBaseError(`Reading ${what} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** One page of `main` push runs of `CI_WORKFLOW_FILE`, newest first. Throws on any answer it cannot read. */
async function runsPage(context, page) {
  const what = `${CI_WORKFLOW_FILE} runs on main`;
  const body = await apiJson(context, `workflows/${CI_WORKFLOW_FILE}/runs`, { branch: "main", event: "push", per_page: PAGE_SIZE, page }, what);
  const runs = body?.workflow_runs;
  const readable =
    Array.isArray(runs) &&
    runs.every((run) => Number.isInteger(run?.id) && Number.isInteger(run.run_number) && COMMIT_SHA.test(run.head_sha ?? "") && typeof run.status === "string");
  if (!readable) throw new MainPushBaseError(`GitHub answered ${what} in a shape this script does not read`);
  return runs;
}

/** Did the latest attempt of `run` finish every gate step of `job`? Throws on any answer it cannot read. */
async function gatesRan(context, run, job, steps) {
  const what = `the jobs of ${CI_WORKFLOW_FILE} run #${run.run_number}`;
  const body = await apiJson(context, `runs/${run.id}/jobs`, { filter: "latest", per_page: PAGE_SIZE }, what);
  const jobs = body?.jobs;
  if (!Array.isArray(jobs) || !Number.isInteger(body.total_count)) throw new MainPushBaseError(`GitHub answered ${what} in a shape this script does not read`);
  if (jobs.length < body.total_count) throw new MainPushBaseError(`GitHub answered ${what} with more than one page, more than this script reads`);
  const found = jobs.find((candidate) => candidate?.name === job);
  if (!found) return false;
  if (!Array.isArray(found.steps)) throw new MainPushBaseError(`GitHub answered ${what} without the steps of "${job}"`);
  return steps.every((name) => found.steps.some((step) => step?.name === name && GATE_RAN.has(step.conclusion)));
}

/**
 * The last judged `main` commit before the run numbered `runNumber` for
 * `headSha`, with the run that judged it: the newest earlier run whose `job`
 * finished every one of `steps`. Throws `MainPushBaseError` when the API cannot
 * be read or no such run exists.
 */
export async function resolveMainPushBase({
  apiUrl = "https://api.github.com",
  repository,
  token,
  runNumber,
  headSha,
  job,
  steps,
  isAncestor = gitIsAncestor,
  fetchImpl = fetch,
}) {
  if (!job || steps.length === 0) throw new MainPushBaseError("Name the gate with --job and at least one --step");
  const context = { apiUrl, repository, token, fetchImpl };
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const runs = await runsPage(context, page);
    for (const run of runs) {
      if (run.run_number >= runNumber || run.head_sha === headSha) continue;
      if (run.status !== "completed" || NOTHING_RAN.has(run.conclusion)) continue;
      if (!isAncestor(run.head_sha)) continue;
      if (await gatesRan(context, run, job, steps)) return { sha: run.head_sha, run };
    }
    if (runs.length < PAGE_SIZE) break;
  }
  throw new MainPushBaseError(
    `No earlier ${CI_WORKFLOW_FILE} push run on main ran "${job}" → ${steps.map((step) => `"${step}"`).join(", ")} ` +
      `on an ancestor of ${headSha.slice(0, 12)}, so there is no commit to judge this push from.`,
  );
}

/** `--job <name>` once and `--step <name>` one or more times. */
export function parseArgs(argv) {
  const parsed = { job: null, steps: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if ((flag !== "--job" && flag !== "--step") || value === undefined) throw new MainPushBaseError(`Unexpected argument "${flag}"`);
    if (flag === "--job") parsed.job = value;
    else parsed.steps.push(value);
    index += 1;
  }
  if (!parsed.job || parsed.steps.length === 0) throw new MainPushBaseError("Name the gate with --job and at least one --step");
  return parsed;
}

/** The CLI: resolve and write `sha=` for a push to `main`; write nothing for any other event. */
export async function main({ argv = process.argv.slice(2), env = process.env, fetchImpl = fetch, isAncestor = gitIsAncestor, log = console } = {}) {
  const { job, steps } = parseArgs(argv);
  if (env.GITHUB_EVENT_NAME !== "push" || env.GITHUB_REF !== MAIN_REF) {
    log.log(`Not a push to main (${env.GITHUB_EVENT_NAME ?? "no event"} on ${env.GITHUB_REF ?? "no ref"}); the step keeps its own base.`);
    return 0;
  }
  const runNumber = Number.parseInt(env.GITHUB_RUN_NUMBER ?? "", 10);
  for (const name of ["GITHUB_REPOSITORY", "GITHUB_TOKEN", "GITHUB_SHA"]) {
    if (!env[name]) throw new MainPushBaseError(`${name} is not set`);
  }
  if (!Number.isInteger(runNumber)) throw new MainPushBaseError("GITHUB_RUN_NUMBER is not a run number");

  const { sha, run } = await resolveMainPushBase({
    apiUrl: env.GITHUB_API_URL || undefined,
    repository: env.GITHUB_REPOSITORY,
    token: env.GITHUB_TOKEN,
    runNumber,
    headSha: env.GITHUB_SHA,
    job,
    steps,
    isAncestor,
    fetchImpl,
  });
  const before = env.PUSH_BEFORE_SHA;
  if (before && before !== sha) {
    // Visible on the run page: the merges in between were not judged on their own.
    log.log(
      `::notice::Judging this push from ${sha.slice(0, 12)} (run #${run.run_number}), not the previous main commit ${before.slice(0, 12)}: ` +
        `the runs in between were replaced, cancelled or stopped before these gates, so their changes are judged here (INV-OPS-021).`,
    );
  } else {
    log.log(`Judging this push from ${sha.slice(0, 12)} (run #${run.run_number}).`);
  }
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `sha=${sha}\n`);
  return 0;
}

if (isMainModule(import.meta.url)) {
  try {
    process.exitCode = await main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `::error::${message}\n` +
        "Nothing was judged. If GitHub's API failed, re-run this job. If no earlier main run reached these gates, " +
        "re-run the newest replaced one with `gh run rerun <run-id>` when nothing is pending on main (CONTRIBUTING.md, \"Finding which merge broke main\"), and once it has finished re-run this job.\n",
    );
    process.exitCode = 1;
  }
}
