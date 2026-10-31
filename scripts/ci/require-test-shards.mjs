import { performance } from "node:perf_hooks";

import { escapeRegex } from "./escape-regex.mjs";
import { isMainModule } from "../lib/is-main-module.mjs";

// #3431: this is the sole required-check bridge for independent jobs.
// `verify` runs it with the unit-test shard defaults and, since #4425, names
// its typecheck, lint and build jobs with `--job`, so one poll gates all
// of them; `e2e.yml`'s required jobs run it with `--label`/`--count` for their
// matrix (#4397). The workflow contract tests (require-test-shards.test.mjs)
// check that these names match the jobs in both workflows.
export const EXPECTED_SHARD_COUNT = 4;
export const DEFAULT_SHARD_LABEL = "Test shard";
const POLL_INTERVAL_MS = 15_000;
const MAX_WAIT_MS = 45 * 60_000;

const PENDING_STATUSES = ["queued", "in_progress", "waiting", "pending", "requested"];

/** A GitHub job name as `--upstream` and `--job` accept it. */
export const UPSTREAM_JOB_NAME = /^[A-Za-z][\w -]*$/;

/** `--max-wait-minutes`, shared by both waiting gates. */
export function parseMaxWaitMinutes(value) {
  if (!/^[1-9]\d{0,2}$/.test(value ?? "")) throw new Error(`Invalid --max-wait-minutes: ${value}`);
  return Number(value) * 60_000;
}

/**
 * #4397: the one rule both waiting gates use for their upstream jobs. A
 * matrix whose `needs:` failed is skipped before its names expand (GitHub
 * reports a placeholder such as `matrix.name`), and an artifact a failed job
 * never uploaded never appears, so waiting could only time out: throw at once
 * when a named upstream job has completed as anything but success.
 */
export function assertUpstreamSucceeded(jobs, upstream) {
  for (const name of upstream) {
    const job = jobs.find((item) => item?.name === name);
    if (job?.status === "completed" && job.conclusion !== "success") {
      throw new Error(`Upstream job "${name}" completed as ${job.conclusion ?? "unknown"}`);
    }
  }
}

/**
 * #4425: single jobs a gate requires by exact name (`--job`). Each must
 * appear exactly once and succeed; missing or still running is pending, and
 * any other completed conclusion, a skip included, fails at once.
 */
export function classifyRequiredJobs(jobs, required = []) {
  if (!Array.isArray(jobs)) throw new Error("GitHub returned no jobs array");
  const pending = [];
  for (const name of required) {
    const matches = jobs.filter((job) => job?.name === name);
    if (matches.length > 1) throw new Error(`Duplicate required job: ${name}`);
    const [job] = matches;
    if (!job) {
      pending.push(`missing "${name}"`);
    } else if (!jobSucceeded(job, `Required job "${name}"`)) {
      pending.push(`"${name}" ${job.status}`);
    }
  }
  return pending;
}

/** One job's state: true once it succeeded, false while it is still pending; any other conclusion or status throws. */
function jobSucceeded(job, what) {
  if (job.status === "completed") {
    if (job.conclusion !== "success") throw new Error(`${what} completed as ${job.conclusion ?? "unknown"}`);
    return true;
  }
  if (PENDING_STATUSES.includes(job.status)) return false;
  throw new Error(`${what} has unknown status ${job.status ?? "missing"}`);
}

export function classifyTestShardJobs(jobs, count = EXPECTED_SHARD_COUNT, label = DEFAULT_SHARD_LABEL, upstream = [], from = 1) {
  if (!Array.isArray(jobs)) throw new Error("GitHub returned no jobs array");
  if (from > count) throw new Error(`--from ${from} is past --count ${count}: nothing would be checked`);
  assertUpstreamSucceeded(jobs, upstream);
  const found = new Map();
  const pattern = new RegExp(`^${escapeRegex(label)} \\(([1-9]\\d*)\\/([1-9]\\d*)\\)$`);
  for (const job of jobs) {
    if (typeof job?.name !== "string" || !job.name.startsWith(`${label} (`)) continue;
    const match = pattern.exec(job.name);
    if (!match || Number(match[2]) !== count || Number(match[1]) > count) {
      throw new Error(`Unexpected ${label} job name: ${job.name}`);
    }
    const index = Number(match[1]);
    if (found.has(index)) throw new Error(`Duplicate ${label} job: ${job.name}`);
    found.set(index, job);
  }

  const pending = [];
  // `from` > 1: the calling job runs the shards before `from` itself
  // (`Playwright E2E` is shard 1 of the browser suite, #4397).
  if ([...found.keys()].some((index) => index < from)) {
    throw new Error(`${label} ${Math.min(...found.keys())}/${count} should be run by the gate job itself, not a separate job`);
  }
  for (let index = from; index <= count; index += 1) {
    const job = found.get(index);
    if (!job) {
      pending.push(`missing ${index}/${count}`);
      continue;
    }
    if (!jobSucceeded(job, `${label} ${index}/${count}`)) pending.push(`${index}/${count} ${job.status}`);
  }
  return pending;
}

/**
 * One GET against this run's Actions API (#4397: shared by the shard gate and
 * the artifact wait, so both validate the run identity and send the same
 * headers the same way).
 */
export async function getRunApiJson({ apiUrl, repository, runId, token, fetchImpl = fetch }, suffix, params = {}, what = "run") {
  if (!/^[-\w.]+\/[-\w.]+$/.test(repository ?? "")) throw new Error("Invalid GITHUB_REPOSITORY");
  if (!/^[1-9]\d*$/.test(String(runId ?? ""))) throw new Error("Invalid GITHUB_RUN_ID");
  if (!token) throw new Error(`GITHUB_TOKEN is required to read this run's ${what}`);
  const url = new URL(`repos/${repository}/actions/runs/${runId}/${suffix}`, `${new URL(apiUrl).toString().replace(/\/$/, "")}/`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  const response = await fetchImpl(url, {
    signal: AbortSignal.timeout(10_000),
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!response.ok) throw new Error(`GitHub ${what} API returned HTTP ${response.status}`);
  return response.json();
}

export async function getAttemptJobs({ apiUrl, repository, runId, attempt, token, fetchImpl = fetch }) {
  if (!/^[1-9]\d*$/.test(String(attempt ?? ""))) throw new Error("Invalid GITHUB_RUN_ATTEMPT");
  const jobs = [];
  for (let page = 1; page <= 20; page += 1) {
    const payload = await getRunApiJson({ apiUrl, repository, runId, token, fetchImpl }, `attempts/${attempt}/jobs`, { per_page: 100, page }, "jobs");
    if (!Array.isArray(payload?.jobs) || !Number.isSafeInteger(payload.total_count)) {
      throw new Error("GitHub jobs API returned an invalid job list");
    }
    jobs.push(...payload.jobs);
    if (jobs.length >= payload.total_count) {
      if (jobs.length !== payload.total_count) throw new Error("GitHub jobs API count changed during pagination");
      return jobs;
    }
    if (payload.jobs.length === 0) throw new Error("GitHub jobs API returned an incomplete page");
  }
  throw new Error("GitHub jobs API exceeded its pagination bound");
}

export async function requireTestShards({
  loadJobs,
  count = EXPECTED_SHARD_COUNT,
  label = DEFAULT_SHARD_LABEL,
  upstream = [],
  from = 1,
  required = [],
  now = () => performance.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  maxWaitMs = MAX_WAIT_MS,
  intervalMs = POLL_INTERVAL_MS,
}) {
  const start = now();
  while (true) {
    const jobs = await loadJobs();
    const pending = [...classifyTestShardJobs(jobs, count, label, upstream, from), ...classifyRequiredJobs(jobs, required)];
    if (pending.length === 0) return;
    if (now() - start >= maxWaitMs) {
      throw new Error(`Timed out waiting for ${label} jobs: ${pending.join(", ")}`);
    }
    await sleep(intervalMs);
  }
}

/** `--label <job name prefix>`, `--count <n>`, `--from <n>`, `--max-wait-minutes <n>`, and repeatable `--upstream <job name>` and `--job <job name>`; bare, the unit-test defaults. */
export function parseShardGateArgs(argv) {
  const options = { label: DEFAULT_SHARD_LABEL, count: EXPECTED_SHARD_COUNT, maxWaitMs: MAX_WAIT_MS, upstream: [], from: 1, required: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`${flag} needs a value`);
    i += 1;
    if (flag === "--label") {
      if (!/^[A-Za-z][\w -]*$/.test(value)) throw new Error(`Invalid --label: ${value}`);
      options.label = value;
    } else if (flag === "--count") {
      if (!/^[1-9]\d?$/.test(value)) throw new Error(`Invalid --count: ${value}`);
      options.count = Number(value);
    } else if (flag === "--from") {
      if (!/^[1-9]\d?$/.test(value)) throw new Error(`Invalid --from: ${value}`);
      options.from = Number(value);
    } else if (flag === "--upstream") {
      if (!UPSTREAM_JOB_NAME.test(value)) throw new Error(`Invalid --upstream: ${value}`);
      options.upstream.push(value);
    } else if (flag === "--job") {
      if (!UPSTREAM_JOB_NAME.test(value)) throw new Error(`Invalid --job: ${value}`);
      if (options.required.includes(value)) throw new Error(`Duplicate --job: ${value}`);
      options.required.push(value);
    } else if (flag === "--max-wait-minutes") {
      options.maxWaitMs = parseMaxWaitMinutes(value);
    } else {
      throw new Error(`Unknown argument: ${flag}`);
    }
  }
  if (options.from > options.count) throw new Error(`--from ${options.from} is past --count ${options.count}: nothing would be checked`);
  return options;
}

if (isMainModule(import.meta.url)) {
  let label = DEFAULT_SHARD_LABEL;
  try {
    const options = parseShardGateArgs(process.argv.slice(2));
    label = options.label;
    await requireTestShards({
      ...options,
      loadJobs: () => getAttemptJobs({
        apiUrl: process.env.GITHUB_API_URL ?? "https://api.github.com",
        repository: process.env.GITHUB_REPOSITORY,
        runId: process.env.GITHUB_RUN_ID,
        attempt: process.env.GITHUB_RUN_ATTEMPT,
        token: process.env.GITHUB_TOKEN,
      }),
    });
    const also = options.required.length > 0 ? `, and ${options.required.map((name) => `"${name}"`).join(", ")},` : "";
    console.log(`All ${options.count - options.from + 1} "${label}" jobs${also} passed in this run attempt.`);
  } catch (error) {
    console.error(`::error::Shard gate for "${label}" failed: ${error.message}`);
    process.exitCode = 1;
  }
}
