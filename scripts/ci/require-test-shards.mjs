import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

// #3431: this is the sole required-check bridge for the independent matrix.
// The workflow contract test checks that these names match the matrix.
export const EXPECTED_SHARD_COUNT = 4;
const POLL_INTERVAL_MS = 15_000;
const MAX_WAIT_MS = 45 * 60_000;

export function classifyTestShardJobs(jobs, count = EXPECTED_SHARD_COUNT) {
  if (!Array.isArray(jobs)) throw new Error("GitHub returned no jobs array");
  const found = new Map();
  for (const job of jobs) {
    if (typeof job?.name !== "string" || !job.name.startsWith("Test shard (")) continue;
    const match = /^Test shard \(([1-9]\d*)\/([1-9]\d*)\)$/.exec(job.name);
    if (!match || Number(match[2]) !== count || Number(match[1]) > count) {
      throw new Error(`Unexpected test-shard job name: ${job.name}`);
    }
    const index = Number(match[1]);
    if (found.has(index)) throw new Error(`Duplicate test-shard job: ${job.name}`);
    found.set(index, job);
  }

  const pending = [];
  for (let index = 1; index <= count; index += 1) {
    const job = found.get(index);
    if (!job) {
      pending.push(`missing ${index}/${count}`);
      continue;
    }
    if (job.status === "completed") {
      if (job.conclusion !== "success") {
        throw new Error(`Test shard ${index}/${count} completed as ${job.conclusion ?? "unknown"}`);
      }
    } else if (["queued", "in_progress", "waiting", "pending", "requested"].includes(job.status)) {
      pending.push(`${index}/${count} ${job.status}`);
    } else {
      throw new Error(`Test shard ${index}/${count} has unknown status ${job.status ?? "missing"}`);
    }
  }
  return pending;
}

export async function getAttemptJobs({ apiUrl, repository, runId, attempt, token, fetchImpl = fetch }) {
  if (!/^[-\w.]+\/[-\w.]+$/.test(repository ?? "")) throw new Error("Invalid GITHUB_REPOSITORY");
  if (!/^[1-9]\d*$/.test(String(runId ?? ""))) throw new Error("Invalid GITHUB_RUN_ID");
  if (!/^[1-9]\d*$/.test(String(attempt ?? ""))) throw new Error("Invalid GITHUB_RUN_ATTEMPT");
  if (!token) throw new Error("GITHUB_TOKEN is required to verify test shards");
  const base = new URL(apiUrl);
  const jobs = [];
  for (let page = 1; page <= 20; page += 1) {
    const url = new URL(
      `repos/${repository}/actions/runs/${runId}/attempts/${attempt}/jobs`,
      `${base.toString().replace(/\/$/, "")}/`,
    );
    url.searchParams.set("per_page", "100");
    url.searchParams.set("page", String(page));
    const response = await fetchImpl(url, {
      signal: AbortSignal.timeout(10_000),
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!response.ok) throw new Error(`GitHub jobs API returned HTTP ${response.status}`);
    const payload = await response.json();
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
  now = () => performance.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  maxWaitMs = MAX_WAIT_MS,
  intervalMs = POLL_INTERVAL_MS,
}) {
  const start = now();
  while (true) {
    const pending = classifyTestShardJobs(await loadJobs());
    if (pending.length === 0) return;
    if (now() - start >= maxWaitMs) {
      throw new Error(`Timed out waiting for test shards: ${pending.join(", ")}`);
    }
    await sleep(intervalMs);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await requireTestShards({
      loadJobs: () => getAttemptJobs({
        apiUrl: process.env.GITHUB_API_URL ?? "https://api.github.com",
        repository: process.env.GITHUB_REPOSITORY,
        runId: process.env.GITHUB_RUN_ID,
        attempt: process.env.GITHUB_RUN_ATTEMPT,
        token: process.env.GITHUB_TOKEN,
      }),
    });
    console.log(`All ${EXPECTED_SHARD_COUNT} unit-test shards passed in this run attempt.`);
  } catch (error) {
    console.error(`::error::Unit-test shard gate failed: ${error.message}`);
    process.exitCode = 1;
  }
}
