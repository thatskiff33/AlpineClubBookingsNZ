/**
 * The commit a push to `main` is judged from (INV-OPS-021, #5356).
 *
 *   node scripts/ci/resolve-main-push-base.mjs
 *
 * WHY NOT `github.event.before`. Since #5356 a newer merge may replace `main`'s
 * queued CI run: the push concurrency group holds one running and one pending
 * run, and GitHub drops the older pending one. `before` is the previous `main`
 * tip, and when that commit's run was dropped its change was never judged by
 * the push-only gates (doc index, file-size ratchet, migration-safety ledger).
 * Judging from `before` would then let that change through unseen. So a push to
 * `main` is judged from the LAST JUDGED MAIN COMMIT instead: the head of the
 * newest earlier `ci.yml` push run on `main` that ran, which covers every merge
 * whose run was dropped in between. When nothing was dropped it is `before`.
 *
 * A run counts as having judged its commit when it is in progress (it will
 * report) or completed with any conclusion except the ones where its gates
 * never ran: `cancelled`, `skipped`, `stale`, `startup_failure`. Queued and
 * waiting runs do not count, because a newer push can still replace them. The
 * run must be older than this one (a lower run number; a re-run keeps its
 * number), for another commit, and that commit must be an ancestor of HEAD.
 *
 * Writes `sha=<commit>` to `$GITHUB_OUTPUT`. Any event other than a push to
 * `main` writes nothing, so the caller keeps its own base (epic pushes and pull
 * requests are unchanged). It FAILS CLOSED: an API answer it cannot read, or no
 * judged run in what it reads, exits non-zero rather than falling back to
 * `before`, because a silent fallback is exactly the unjudged merge this exists
 * to prevent.
 *
 * Node built-ins only: `verify` and `migration-drift` run it before installing.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import process from "node:process";

import { isMainModule } from "../lib/is-main-module.mjs";

/** The workflow whose push runs carry the push-only gates. */
export const CI_WORKFLOW_FILE = "ci.yml";
const MAIN_REF = "refs/heads/main";
const PAGE_SIZE = 100;
/** Ten pages is a thousand `main` runs: far past any real run of cancellations. */
const MAX_PAGES = 10;
/** Conclusions of a completed run whose gates never ran, so its commit was not judged. */
const UNJUDGED_CONCLUSIONS = new Set(["cancelled", "skipped", "stale", "startup_failure"]);

export class MainPushBaseError extends Error {}

/** Did this run judge its commit (or will it, once it finishes)? */
export function runJudgedItsCommit(run) {
  if (run.status === "in_progress") return true;
  return run.status === "completed" && !UNJUDGED_CONCLUSIONS.has(run.conclusion);
}

/** Is `sha` an ancestor of HEAD in this checkout? A commit the checkout lacks is not. */
export function gitIsAncestor(sha) {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", sha, "HEAD"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** One page of `main` push runs of `CI_WORKFLOW_FILE`, newest first. Throws on any answer it cannot read. */
async function fetchRunsPage({ apiUrl, repository, token, page, fetchImpl }) {
  const url =
    `${apiUrl}/repos/${repository}/actions/workflows/${CI_WORKFLOW_FILE}/runs` +
    `?branch=main&event=push&per_page=${PAGE_SIZE}&page=${page}`;
  let response;
  try {
    response = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
    });
  } catch (error) {
    throw new MainPushBaseError(`Listing ${CI_WORKFLOW_FILE} runs on main failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) throw new MainPushBaseError(`Listing ${CI_WORKFLOW_FILE} runs on main answered HTTP ${response.status}`);
  const body = await response.json().catch(() => null);
  const runs = body?.workflow_runs;
  const readable =
    Array.isArray(runs) &&
    runs.every(
      (run) =>
        Number.isInteger(run?.id) &&
        Number.isInteger(run.run_number) &&
        typeof run.head_sha === "string" &&
        typeof run.status === "string",
    );
  if (!readable) throw new MainPushBaseError(`Listing ${CI_WORKFLOW_FILE} runs on main answered in a shape this script does not read`);
  return runs;
}

/**
 * The last judged `main` commit before the run numbered `runNumber` for
 * `headSha`, with the run that judged it. Throws `MainPushBaseError` when the
 * API cannot be read or no such run exists.
 */
export async function resolveMainPushBase({
  apiUrl = "https://api.github.com",
  repository,
  token,
  runNumber,
  headSha,
  isAncestor = gitIsAncestor,
  fetchImpl = fetch,
}) {
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const runs = await fetchRunsPage({ apiUrl, repository, token, page, fetchImpl });
    for (const run of runs) {
      if (run.run_number >= runNumber || run.head_sha === headSha) continue;
      if (!runJudgedItsCommit(run)) continue;
      if (!isAncestor(run.head_sha)) continue;
      return { sha: run.head_sha, run };
    }
    if (runs.length < PAGE_SIZE) break;
  }
  throw new MainPushBaseError(
    `No earlier ${CI_WORKFLOW_FILE} push run on main judged an ancestor of ${headSha.slice(0, 12)}, so there is no commit to judge this push from.`,
  );
}

/** The CLI: resolve and write `sha=` for a push to `main`; write nothing for any other event. */
export async function main({ env = process.env, fetchImpl = fetch, isAncestor = gitIsAncestor, log = console } = {}) {
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
    isAncestor,
    fetchImpl,
  });
  const before = env.PUSH_BEFORE_SHA;
  if (before && before !== sha) {
    // Visible on the run page: the merges in between had their runs replaced.
    log.log(
      `::notice::Judging this push from ${sha.slice(0, 12)} (run #${run.run_number}), not the previous main commit ${before.slice(0, 12)}: ` +
        `the runs in between were replaced or cancelled, so their changes are judged here (INV-OPS-021).`,
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
        "Nothing was judged. If GitHub's API failed, re-run this job. If the earlier main runs were all cancelled, " +
        "re-run the newest of them with `gh run rerun <run-id>` and then re-run this job.\n",
    );
    process.exitCode = 1;
  }
}
