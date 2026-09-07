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
 * `CLEAN` is only ever reported when a real audit report was parsed AND every
 * severity count in it is a finite number AND nothing at or above the threshold
 * is in them AND npm itself exited 0. Every other shape — an unparseable body,
 * an npm error object, a report with no `metadata.vulnerabilities`, a counts
 * object missing a severity or carrying a non-numeric one — is inconclusive, and
 * inconclusive is never success. That is structural rather than a rule to
 * remember: there is exactly one branch that can exit 0, and it needs the
 * complete counts in its hand.
 *
 * The counts are **validated, never coerced**. `Number(counts.high ?? 0)` would
 * turn a missing key into `0` and a renamed or nested one into `NaN`, and
 * `NaN > 0` is `false` — so a future report-shape change would take the clean
 * arm on every branch, permanently and silently, with no test failing. Requiring
 * each severity to be present and finite is what stops that.
 *
 * npm's own exit code is consulted for the same reason. `--audit-level=high` is
 * on the command, so npm exits 0 exactly when it found nothing at or above the
 * threshold: a non-zero exit sitting beside counts we read as clean means npm
 * and this script disagree, and a disagreement is not a pass. That is the one
 * signal in the whole pipeline that no report-shape drift can fake, and the
 * command this script replaced was structurally immune because it read nothing
 * else.
 *
 * `inconclusive` is deliberately **not** retried: a usage error, a broken
 * lockfile or a report shape this gate cannot read will not fix itself, and
 * burning the retry budget on it only delays the report its reader needs. The
 * cost is that an outage arriving in a shape matching neither the npm error
 * codes nor the phrase list — an HTML proxy error page, say — gets a one-shot
 * red rather than a retried one. Widen the lists rather than retrying
 * everything.
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
 * How long ONE attempt may run before it is killed and counted as unreachable.
 *
 * Without this the "at most 65 seconds of waiting" above is an assumption rather
 * than a bound: the backoff is bounded, but each attempt was not. There is no
 * `.npmrc` here, so npm's defaults apply — `fetch-timeout` 300000ms and
 * `fetch-retries` 2 — and a request to an endpoint that black-holes packets
 * (no answer and no reset, a different failure from the measured timeout and
 * 503, both of which answered fast) can sit for minutes. Four of those would
 * blow the job's own `timeout-minutes: 10`, GitHub would cancel the runner
 * mid-attempt, and the check would report failure with NO verdict line at
 * all — precisely the unexplained red this script exists to abolish, made up to
 * four times more likely by the retry loop than the single-shot command was.
 *
 * 90 seconds is the budget. The arithmetic against the ten-minute ceiling:
 * 4 x 90s of attempts + 65s of backoff = 425s worst case, leaving over two and a
 * half minutes for checkout and `setup-node` (which take well under one). It is
 * also roughly nine times the longest a healthy `npm audit` takes on this
 * lockfile, so a slow-but-working registry is never mistaken for a dead one.
 */
export const ATTEMPT_TIMEOUT_MS = 90_000;

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

/**
 * npm's own last word, for the `Last error:` line. When the report is
 * unparseable the parser's reason ("no parseable JSON report") is accurate about
 * the parser and useless about the outage, so the line npm actually printed is
 * carried through in front of it where there is one.
 */
function npmSaid(stderr) {
  const lines = String(stderr ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.find((line) => /^npm\s+(error|err!|warn)\b/i.test(line)) ?? lines[0];
}

/**
 * True only when `counts` carries a finite number for EVERY severity. A missing
 * key, a renamed one, a nested one, a string, `null`, an array — all false. See
 * "How a verdict is reached" above for why this is validated rather than
 * coerced.
 */
function hasCompleteCounts(counts) {
  if (!counts || typeof counts !== "object" || Array.isArray(counts)) return false;
  return SEVERITY_ORDER.every(
    (severity) => typeof counts[severity] === "number" && Number.isFinite(counts[severity]),
  );
}

/** The severities a counts object failed to supply as a finite number. */
function unreadableSeverities(counts) {
  if (!counts || typeof counts !== "object") return [...SEVERITY_ORDER];
  return SEVERITY_ORDER.filter(
    (severity) => !(typeof counts[severity] === "number" && Number.isFinite(counts[severity])),
  );
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
export function classifyAuditRun({ exitCode, stdout = "", stderr = "", timedOut = false }) {
  const parsed = extractJson(stdout);
  const combined = `${stdout}\n${stderr}`;

  // A killed attempt did not answer, whatever reached stdout before the signal.
  // Treated as the outage it is — retryable, never clean, even if a complete
  // report happens to have arrived first.
  if (timedOut) {
    const killed = String(stderr ?? "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.includes("was killed with"));
    return {
      outcome: "unreachable",
      reason:
        killed ?? `npm audit was killed after ${ATTEMPT_TIMEOUT_MS} ms without answering.`,
      exitCode,
    };
  }

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
  if (!parsed || !hasCompleteCounts(counts)) {
    // No report, or a report whose severity counts this gate cannot read. If the
    // noise npm made looks like the network, say so — that is the case this
    // whole script exists to name — otherwise be honest that we do not know, and
    // fail either way.
    const outcome = looksLikeNetworkFailure({ text: combined })
      ? "unreachable"
      : "inconclusive";
    let reason;
    if (!parsed) {
      reason = "npm audit produced no parseable JSON report.";
    } else if (!counts || typeof counts !== "object") {
      reason = "npm audit returned JSON with no `metadata.vulnerabilities` counts.";
    } else {
      reason =
        "npm audit returned severity counts this gate could not read: expected a " +
        `number for each of ${SEVERITY_ORDER.join(", ")}, and did not get one for ` +
        `${unreadableSeverities(counts).join(", ")}.`;
    }
    const npmLine = npmSaid(stderr);
    return {
      outcome,
      reason: npmLine ? `${npmLine} — ${reason}` : reason,
      exitCode,
    };
  }

  const severityCounts = Object.fromEntries(
    SEVERITY_ORDER.map((severity) => [severity, counts[severity]]),
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

  if (failing > 0) return { outcome: "vulnerable", severityCounts, advisories, exitCode };

  // The counts say clean. npm was asked with `--audit-level=high`, so it exits 0
  // exactly when it agrees — and a disagreement means one of the two is reading
  // a shape the other is not. Never resolve that in favour of green.
  if (exitCode !== 0) {
    return {
      outcome: "inconclusive",
      severityCounts,
      exitCode,
      reason:
        `npm audit exited ${exitCode === null ? "on a signal" : exitCode} while its own ` +
        `severity counts report nothing at ${AUDIT_LEVEL} or above. npm and this gate ` +
        "disagree, so nothing has been cleared.",
    };
  }

  return { outcome: "clean", severityCounts, exitCode };
}

/**
 * Spawns the real `npm audit`, capturing both streams, and kills an attempt that
 * exceeds {@link ATTEMPT_TIMEOUT_MS}. A killed attempt resolves with
 * `timedOut: true`, which {@link classifyAuditRun} reads as unreachable — so an
 * endpoint that never answers is retried and then named as an outage, instead of
 * running the job into its own ceiling with no verdict printed.
 */
export function runNpmAudit({ cwd = process.cwd(), timeoutMs = ATTEMPT_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    // `shell: true` on Windows only, because `npm` there is `npm.cmd` and Node
    // refuses to spawn a batch file without a shell. It prints a DEP0190
    // deprecation warning about unescaped arguments; that warning is about
    // arguments an attacker could influence, and every element of
    // AUDIT_COMMAND is a module-level constant in this file. CI runs on Linux,
    // where the shell is not used at all.
    const child = spawn("npm", AUDIT_COMMAND, {
      cwd,
      shell: process.platform === "win32",
      stdio: ["ignore", "pipe", "pipe"],
      // Node kills the child itself once the budget is up. On Linux — which is
      // where CI runs, and the only place this bound has to hold — the signal
      // reaches `npm` directly, because no shell is interposed.
      timeout: timeoutMs,
      killSignal: "SIGKILL",
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
    child.on("close", (exitCode, signal) => {
      if (signal) {
        resolve({
          exitCode,
          stdout,
          stderr:
            `${stderr}\nnpm audit did not answer within ${timeoutMs} ms and was killed ` +
            `with ${signal}.`,
          timedOut: true,
        });
        return;
      }
      resolve({ exitCode, stdout, stderr });
    });
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
 * `[5000, 15000, 45000]` -> `"5s, 15s and 45s"`. The delays are stored in
 * milliseconds and read by a person, and printing the stored numbers with an `s`
 * after them claimed the job had waited eighteen hours — in the one message
 * whose whole purpose is to be believed at a glance.
 */
function formatBackoff(delaysMs) {
  const seconds = delaysMs.map((ms) => `${ms / 1000}s`);
  if (seconds.length < 2) return seconds.join("");
  return `${seconds.slice(0, -1).join(", ")} and ${seconds.at(-1)}`;
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
        `  npmjs.org did not answer after ${MAX_ATTEMPTS} attempts with ${formatBackoff(
          RETRY_DELAYS_MS,
        )} of backoff between them.`,
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
