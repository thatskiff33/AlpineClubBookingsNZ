import { performance } from "node:perf_hooks";

import { UPSTREAM_JOB_NAME, assertUpstreamSucceeded, getAttemptJobs, getRunApiJson, parseMaxWaitMinutes } from "./require-test-shards.mjs";
import { isMainModule } from "../lib/is-main-module.mjs";

// #4397: lets a REQUIRED job use another job's output without a `needs:`
// edge. A required job with `needs:` reports "skipped" when its upstream
// fails, and branch protection counts a skipped required check as passing
// (CONTRIBUTING.md -> "Branch protection"). So `Playwright E2E` and
// `E2E multi-lodge` start at once and wait here, in a step, for this run's
// image and seeded-database artifacts: they fail the moment a named upstream
// job ends in anything but success, or when the wait times out. Doing their
// own shard of the suite afterwards, instead of a separate idle gate job,
// halved the runner-minutes a pull request holds (run 40248216639 queued its
// runners 25 minutes behind two polling gates).
const POLL_INTERVAL_MS = 15_000;
const DEFAULT_MAX_WAIT_MS = 45 * 60_000;

/** `--artifact <name>` and `--upstream <job name>` (both repeatable), `--max-wait-minutes <n>`. */
export function parseArtifactWaitArgs(argv) {
  const options = { artifacts: [], upstream: [], maxWaitMs: DEFAULT_MAX_WAIT_MS };
  for (let i = 0; i < argv.length; i += 2) {
    const [flag, value] = [argv[i], argv[i + 1]];
    if (value === undefined) throw new Error(`${flag} needs a value`);
    if (flag === "--artifact") {
      if (!/^[\w.-]+$/.test(value)) throw new Error(`Invalid --artifact: ${value}`);
      options.artifacts.push(value);
    } else if (flag === "--upstream") {
      if (!UPSTREAM_JOB_NAME.test(value)) throw new Error(`Invalid --upstream: ${value}`);
      options.upstream.push(value);
    } else if (flag === "--max-wait-minutes") {
      options.maxWaitMs = parseMaxWaitMinutes(value);
    } else {
      throw new Error(`Unknown argument: ${flag}`);
    }
  }
  if (options.artifacts.length === 0) throw new Error("At least one --artifact is required");
  return options;
}

/**
 * What is still missing, and whether every upstream job has finished (they
 * all succeeded: a failure throws). Missing with everything finished means
 * the upload never happened - the caller confirms it on a second poll, as the
 * artifacts listing can trail the jobs listing.
 */
export function classifyArtifactWait({ artifacts, jobs, wanted, upstream }) {
  assertUpstreamSucceeded(jobs, upstream);
  const present = new Set(artifacts.filter((item) => item && item.expired !== true).map((item) => item.name));
  const missing = wanted.filter((name) => !present.has(name));
  const upstreamDone = upstream.length > 0 && upstream.every((name) => jobs.find((item) => item?.name === name)?.status === "completed");
  return { missing, upstreamDone };
}

async function getRunArtifacts(context) {
  const payload = await getRunApiJson(context, "artifacts", { per_page: 100 }, "artifacts");
  if (!Array.isArray(payload?.artifacts)) throw new Error("GitHub artifacts API returned no artifacts array");
  return payload.artifacts;
}

export async function waitForRunArtifacts({
  wanted,
  upstream,
  loadArtifacts,
  loadJobs,
  maxWaitMs = DEFAULT_MAX_WAIT_MS,
  now = () => performance.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  intervalMs = POLL_INTERVAL_MS,
}) {
  const start = now();
  let missingAfterUpstreamDone = 0;
  while (true) {
    // Jobs first: an artifact uploaded before its job finished is then
    // listed by the time the artifacts are read.
    const jobs = await loadJobs();
    const { missing, upstreamDone } = classifyArtifactWait({ artifacts: await loadArtifacts(), jobs, wanted, upstream });
    if (missing.length === 0) return;
    missingAfterUpstreamDone = upstreamDone ? missingAfterUpstreamDone + 1 : 0;
    if (missingAfterUpstreamDone >= 2) throw new Error(`Every upstream job finished but ${missing.join(", ")} never appeared`);
    if (now() - start >= maxWaitMs) throw new Error(`Timed out waiting for artifacts: ${missing.join(", ")}`);
    await sleep(intervalMs);
  }
}

if (isMainModule(import.meta.url)) {
  try {
    const options = parseArtifactWaitArgs(process.argv.slice(2));
    const context = {
      apiUrl: process.env.GITHUB_API_URL ?? "https://api.github.com",
      repository: process.env.GITHUB_REPOSITORY,
      runId: process.env.GITHUB_RUN_ID,
      attempt: process.env.GITHUB_RUN_ATTEMPT,
      token: process.env.GITHUB_TOKEN,
    };
    await waitForRunArtifacts({
      wanted: options.artifacts,
      upstream: options.upstream,
      maxWaitMs: options.maxWaitMs,
      loadArtifacts: () => getRunArtifacts(context),
      loadJobs: () => getAttemptJobs(context),
    });
    console.log(`Artifacts ready: ${options.artifacts.join(", ")}`);
  } catch (error) {
    console.error(`::error::Waiting for this run's artifacts failed: ${error.message}`);
    process.exitCode = 1;
  }
}
