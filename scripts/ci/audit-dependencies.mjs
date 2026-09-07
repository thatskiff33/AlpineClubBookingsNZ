import { spawn } from "node:child_process";
import fs from "node:fs";
import { pathToFileURL } from "node:url";

/**
 * Runs this repository's dependency audit and says **which of three things
 * happened** (#3254): the audit ran and found nothing, the audit ran and found a
 * high-or-worse advisory, or the advisory service could not be reached.
 *
 * ## Why this exists
 *
 * `Dependency audit` is a required status check, and until now it was one line:
 * `npm audit --audit-level=high`. That command asks npmjs.org for advisories
 * over the network, and when the request fails it exits non-zero — so the job
 * went red in **exactly** the same way as it does for a real vulnerability. Same
 * check name, same colour, same position in the list. Telling them apart meant
 * opening the job log and finding a `npm warn audit …` line in it.
 *
 * That happened three times across two pull requests inside about an hour on
 * 4 September 2026 (#3246, #3247): a network timeout on
 * `…/-/npm/v1/security/advisories/bulk`, a 503 on the same endpoint, and — after
 * an explicit re-run — the same 503 reaching `npm error audit endpoint returned
 * an error`. All three passed unchanged later. None had a vulnerability. A
 * fully-green pull request was held for hours.
 *
 * The cost that matters is not the re-runs. A required security gate that
 * sometimes goes red for reasons that do not matter teaches its readers that red
 * sometimes means nothing, and that is how a genuine advisory eventually gets
 * clicked past. During that outage the check was re-run three times without the
 * log being read, which is the behaviour this script exists to stop.
 *
 * ## The recorded decision (owner, 5 September 2026, issue #3254)
 *
 * **Retry, then still fail.** When the advisory service cannot be reached the
 * audit is retried a small number of times with a short backoff; if it still
 * cannot be reached, the check FAILS. A required security gate that could not do
 * its job does not get to report success — green keeps meaning "the audit really
 * ran and found nothing".
 *
 * The cost was accepted deliberately rather than overlooked: the 4 September
 * outage lasted hours, so retries alone would not have saved #3247, and a
 * sustained npm outage still blocks every merge. The alternative — passing with
 * a loud warning — was rejected because a green tick is what people read, not
 * the summary underneath it.
 *
 * The half of the value that is not the retry is the **wording**: every outcome
 * below prints a verdict line that names the case in capitals, so nobody has to
 * infer "the registry was down" from a warning buried in the log.
 *
 * ## How a verdict is reached, and why it fails closed
 *
 * `CLEAN` is only ever reported when a real audit report was parsed AND its
 * severity counts are present AND nothing at or above the threshold is in them.
 * Every other shape — an unparseable body, an npm error object, a report with no
 * `metadata.vulnerabilities` — is inconclusive, and inconclusive is never
 * success. That is structural rather than a rule to remember: there is exactly
 * one branch that can exit 0, and it needs the counts in its hand.
 *
 * ## What it deliberately does not do
 *
 * It carries no way to skip, no `continue-on-error`, and no environment switch
 * that softens the verdict. It also must never be given a job-level `if:` or
 * `needs:` in the workflow: GitHub counts a *skipped* required check as
 * satisfying branch protection, so a condition at job level would make this gate
 * vacuously green. Conditions go on steps. See `AGENTS.md` → "Completion and
 * Merge".
 *
 * Source-only and install-free by design: it shells out to `npm audit`, which
 * reads `package-lock.json`, so the job needs no `npm ci`.
 */

/**
 * The severity threshold, stated once. Both the flag handed to `npm audit` and
 * the severities this script counts as failing are derived from it, so the
 * threshold cannot drift between "what npm was asked" and "what we judged".
 */
export const AUDIT_LEVEL = "high";

/** Severities in ascending order, as `npm audit --json` reports them. */
export const SEVERITY_ORDER = ["info", "low", "moderate", "high", "critical"];

/** The severities at or above {@link AUDIT_LEVEL}: the ones that fail the check. */
export const FAILING_SEVERITIES = SEVERITY_ORDER.slice(
  SEVERITY_ORDER.indexOf(AUDIT_LEVEL),
);

/** The command this gate runs. `--json` is what makes the outcome classifiable. */
export const AUDIT_COMMAND = ["audit", `--audit-level=${AUDIT_LEVEL}`, "--json"];

/**
 * The retry budget, chosen deliberately (#3254 asked for the reasoning to be
 * written down rather than left to be re-derived).
 *
 * Four attempts with 5s, 15s and 45s between them adds at most 65 seconds of
 * waiting to a job whose own timeout is 10 minutes. That is generous enough to
 * absorb the ordinary bad minute — a single timed-out request, one 503 from a
 * load-balancer mid-deploy, a rate-limit blip — which is what all three measured
 * failures were. It is deliberately NOT generous enough to sit out a real
 * outage: the 4 September one ran for hours, and a runner spending ten minutes
 * discovering that helps nobody. Fail fast, say plainly that it was an outage,
 * and let the person re-run when npm is back.
 */
export const RETRY_DELAYS_MS = [5_000, 15_000, 45_000];

/** Total attempts: the first try plus one per backoff delay. */
export const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1;

/**
 * npm error codes that mean "the request did not get an answer", not "your tree
 * has a problem". Anything matching is retried; anything else is not, because a
 * usage or lockfile error will not fix itself and burning 65 seconds on it just
 * delays a report the reader needs.
 */
const NETWORK_ERROR_CODES = new Set([
  "E429",
  "E500",
  "E502",
  "E503",
  "E504",
  "EAI_AGAIN",
  "ECONNRESET",
  "ECONNREFUSED",
  "ENOTFOUND",
  "EPIPE",
  "ERR_SOCKET_TIMEOUT",
  "ETIMEDOUT",
  "FETCH_ERROR",
]);

/**
 * Phrases npm prints when the advisory endpoint misbehaves. Codes are checked
 * first; this catches the shapes that arrive as prose, including the exact three
 * measured on 4 September 2026.
 */
const NETWORK_ERROR_PHRASES = [
  "audit endpoint returned an error",
  "network timeout",
  "service unavailable",
  "socket hang up",
  "gateway time-out",
  "bad gateway",
  "getaddrinfo",
  "econnreset",
  "etimedout",
  "eai_again",
  "request to https://registry.npmjs.org",
  "too many requests",
];

/**
 * Pulls the JSON body out of a captured stdout. npm writes the report to stdout
 * on its own, but a stray warning or a proxy banner ahead of it would break a
 * naive `JSON.parse`, so the first balanced-looking object is taken instead.
 */
export function extractJson(stdout) {
  if (typeof stdout !== "string") return undefined;
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start === -1 || end <= start) return undefined;
  try {
    const parsed = JSON.parse(stdout.slice(start, end + 1));
    return parsed && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function looksLikeNetworkFailure({ code, text }) {
  if (code && NETWORK_ERROR_CODES.has(String(code).toUpperCase())) return true;
  const haystack = String(text ?? "").toLowerCase();
  return NETWORK_ERROR_PHRASES.some((phrase) => haystack.includes(phrase));
}

/**
 * Turns one captured `npm audit --json` run into a verdict.
 *
 * Returns `{ outcome, ... }` where `outcome` is one of:
 * - `"clean"` — a report was parsed and nothing at or above the threshold is in
 *   it. **The only outcome that may exit 0.**
 * - `"vulnerable"` — a report was parsed and it carries a failing advisory.
 * - `"unreachable"` — the advisory service did not answer. Retryable.
 * - `"inconclusive"` — npm failed for some other reason, or answered with
 *   something that is not an audit report. Not retried, and never success.
 */
export function classifyAuditRun({ exitCode, stdout = "", stderr = "" }) {
  const parsed = extractJson(stdout);
  const combined = `${stdout}\n${stderr}`;

  const npmError = parsed && typeof parsed.error === "object" ? parsed.error : undefined;
  if (npmError) {
    const detail = [npmError.summary, npmError.detail].filter(Boolean).join(" ");
    const outcome = looksLikeNetworkFailure({ code: npmError.code, text: detail })
      ? "unreachable"
      : "inconclusive";
    return {
      outcome,
      reason: detail.trim() || `npm audit failed with ${npmError.code ?? "no code"}`,
      exitCode,
    };
  }

  const counts = parsed?.metadata?.vulnerabilities;
  if (!parsed || !counts || typeof counts !== "object") {
    // No report at all. If the noise npm made looks like the network, say so —
    // that is the case this whole script exists to name — otherwise be honest
    // that we do not know, and fail either way.
    const outcome = looksLikeNetworkFailure({ text: combined })
      ? "unreachable"
      : "inconclusive";
    return {
      outcome,
      reason: parsed
        ? "npm audit returned JSON with no `metadata.vulnerabilities` counts."
        : "npm audit produced no parseable JSON report.",
      exitCode,
    };
  }

  const severityCounts = Object.fromEntries(
    SEVERITY_ORDER.map((severity) => [severity, Number(counts[severity] ?? 0)]),
  );
  const failing = FAILING_SEVERITIES.reduce(
    (total, severity) => total + severityCounts[severity],
    0,
  );

  const advisories = Object.values(parsed.vulnerabilities ?? {})
    .filter((entry) => FAILING_SEVERITIES.includes(entry?.severity))
    .map((entry) => ({
      name: String(entry.name ?? "unknown package"),
      severity: String(entry.severity),
      range: entry.range ? String(entry.range) : undefined,
      fixAvailable: Boolean(entry.fixAvailable),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return failing > 0
    ? { outcome: "vulnerable", severityCounts, advisories, exitCode }
    : { outcome: "clean", severityCounts, exitCode };
}

/** Spawns the real `npm audit`, capturing both streams. */
export function runNpmAudit({ cwd = process.cwd() } = {}) {
  return new Promise((resolve) => {
    const child = spawn("npm", AUDIT_COMMAND, {
      cwd,
      shell: process.platform === "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      resolve({ exitCode: null, stdout, stderr: `${stderr}\n${error.message}` });
    });
    child.on("close", (exitCode) => resolve({ exitCode, stdout, stderr }));
  });
}

const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs the audit, retrying only while the advisory service is unreachable.
 *
 * `run` and `sleep` are injected so the retry policy is testable without a
 * network or a real wait.
 */
export async function auditWithRetries({
  run = runNpmAudit,
  sleep = realSleep,
  delays = RETRY_DELAYS_MS,
  onAttempt = () => {},
} = {}) {
  const attempts = [];
  const maxAttempts = delays.length + 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const captured = await run({ attempt });
    const classified = classifyAuditRun(captured);
    attempts.push(classified);
    onAttempt({ attempt, maxAttempts, ...classified });

    if (classified.outcome !== "unreachable") {
      return { ...classified, attempt, attempts };
    }
    if (attempt < maxAttempts) await sleep(delays[attempt - 1]);
  }

  return { ...attempts.at(-1), attempt: maxAttempts, attempts };
}

/**
 * The operator-facing report. One verdict line naming the case in capitals,
 * then the detail. Returned as `{ exitCode, lines }` so the wording is
 * assertable without running a process.
 */
export function formatReport(result) {
  const { outcome, attempt, severityCounts, advisories = [], reason } = result;
  const countsLine = severityCounts
    ? SEVERITY_ORDER.map((severity) => `${severity} ${severityCounts[severity]}`)
        .reverse()
        .join(", ")
    : undefined;

  if (outcome === "clean") {
    return {
      exitCode: 0,
      lines: [
        "Dependency audit: CLEAN — the advisory service answered and this branch " +
          `has no ${AUDIT_LEVEL}-or-worse advisories.`,
        `  Advisory service reached on attempt ${attempt} of ${MAX_ATTEMPTS}.`,
        `  Counts: ${countsLine}.`,
      ],
    };
  }

  if (outcome === "vulnerable") {
    return {
      exitCode: 1,
      lines: [
        `Dependency audit: FAILED — VULNERABILITY FOUND (${AUDIT_LEVEL} or worse).`,
        "  This is a real finding, NOT an outage: the advisory service answered.",
        `  Counts: ${countsLine}.`,
        ...advisories.map(
          (advisory) =>
            `  - ${advisory.name} (${advisory.severity})` +
            `${advisory.range ? ` ${advisory.range}` : ""}` +
            `${advisory.fixAvailable ? " — a fix is available" : " — no fix published yet"}`,
        ),
        "",
        "  Upgrade the dependency, or record a deliberate override with its reasoning",
        "  in docs/MAINTENANCE.md. Do not re-run this check hoping it goes green.",
      ],
    };
  }

  if (outcome === "unreachable") {
    return {
      exitCode: 1,
      lines: [
        "Dependency audit: FAILED — ADVISORY SERVICE UNREACHABLE. This is NOT a vulnerability.",
        `  npmjs.org did not answer after ${MAX_ATTEMPTS} attempts with ${RETRY_DELAYS_MS.join(
          "s, ",
        )}s of backoff between them.`,
        `  Last error: ${reason}`,
        "",
        "  Nothing is known to be wrong with this branch — the audit did not run, so",
        "  it also has not been cleared. Re-run this job once npmjs.org has recovered;",
        "  https://status.npmjs.org shows whether it has.",
        "",
        "  The check fails rather than passing with a warning by owner decision on",
        "  issue #3254: a required security gate that could not do its job does not",
        "  get to report success. The cost — a sustained npm outage blocks merges —",
        "  was accepted deliberately.",
      ],
    };
  }

  return {
    exitCode: 1,
    lines: [
      "Dependency audit: FAILED — THE AUDIT COULD NOT RUN. This is neither a " +
        "vulnerability nor a registry outage.",
      `  ${reason}`,
      "",
      "  npm answered with something that is not an audit report, so nothing has been",
      "  cleared. Read the npm output above; a missing or malformed package-lock.json",
      "  is the usual cause.",
    ],
  };
}

/** Mirrors the verdict into the job summary, where a reader sees it without opening the log. */
function writeStepSummary(lines) {
  const target = process.env.GITHUB_STEP_SUMMARY;
  if (!target) return;
  try {
    fs.appendFileSync(target, `### ${lines[0]}\n\n\`\`\`\n${lines.slice(1).join("\n")}\n\`\`\`\n`);
  } catch {
    // The summary is a convenience; never let it change the verdict.
  }
}

export async function main({ run, sleep } = {}) {
  const result = await auditWithRetries({
    ...(run ? { run } : {}),
    ...(sleep ? { sleep } : {}),
    onAttempt: ({ attempt, maxAttempts, outcome, reason }) => {
      if (outcome === "unreachable") {
        console.error(
          `Attempt ${attempt} of ${maxAttempts}: the advisory service did not answer ` +
            `(${reason}).`,
        );
      }
    },
  });

  const { exitCode, lines } = formatReport(result);
  const write = exitCode === 0 ? console.log : console.error;
  for (const line of lines) write(line);
  writeStepSummary(lines);
  process.exitCode = exitCode;
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedPath === import.meta.url) await main();
