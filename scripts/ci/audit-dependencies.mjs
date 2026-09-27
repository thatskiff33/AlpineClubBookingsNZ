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
 * ## The move to pnpm (27 September 2026, issue #3673)
 *
 * The repository moved from npm to pnpm, and this gate moved from `npm audit` to
 * `pnpm audit` with the same semantics: the same `high` threshold, the same
 * lockfile-only, install-free reading of the tree, the same three verdicts plus
 * "could not run", the same retry-then-still-fail policy and the same budgets.
 * Only the tool changed. pnpm asks the same service npm did — the bulk advisory
 * endpoint `…/-/npm/v1/security/advisories/bulk` on the configured registry,
 * which here is npmjs.org — so the outage this script names is still an
 * npmjs.org outage.
 *
 * One flag is new, `--config.fetch-retries=0`, and it is load-bearing. pnpm
 * retries a failed request to the advisory endpoint on its own (twice by
 * default, waiting 10 seconds and then a minute), which would duplicate the
 * retry policy below and spend the per-attempt budget on every 503. Measured on
 * pnpm 11.27.1 against an endpoint answering 503: with its own retries pnpm
 * waited 10 seconds and then a minute before giving up; without them it gave up
 * in about two seconds. This script owns the retry policy, so pnpm makes exactly
 * one request per attempt.
 *
 * The half of the value that is not the retry is the **wording**: every outcome
 * below prints a verdict line that names the case in capitals, so nobody has to
 * infer "the registry was down" from a warning buried in the log.
 *
 * ## How a verdict is reached, and why it fails closed
 *
 * `CLEAN` is only ever reported when a real audit report was parsed AND every
 * severity count in it is a finite number AND nothing at or above the threshold
 * is in them AND pnpm itself exited 0. Every other shape — an unparseable body,
 * a pnpm error object, a report with no `metadata.vulnerabilities`, a counts
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
 * pnpm's own exit code is consulted for the same reason. `--audit-level=high` is
 * on the command, so pnpm exits 0 exactly when it lists nothing at or above the
 * threshold: a non-zero exit sitting beside counts we read as clean means pnpm
 * and this script disagree, and a disagreement is not a pass. That is the one
 * signal in the whole pipeline that no report-shape drift can fake, and the
 * command this script replaced was structurally immune because it read nothing
 * else.
 *
 * The counts decide, not pnpm's advisory list. They differ in one known way:
 * an advisory named in pnpm's `auditConfig.ignoreGhsas` setting is dropped from
 * the list and from pnpm's exit code but is still counted in
 * `metadata.vulnerabilities` (measured on pnpm 11.27.1). So that setting does
 * not clear this gate — it fails closed, as `VULNERABILITY FOUND` with the
 * ignored advisory counted but not listed. The recorded way to accept a
 * finding is still an override with its reasoning in docs/MAINTENANCE.md.
 *
 * `inconclusive` is deliberately **not** retried: a usage error, a missing
 * lockfile, an endpoint that refuses the request (a 4xx other than 429) or a
 * report shape this gate cannot read will not fix itself, and burning the retry
 * budget on it only delays the report its reader needs. The cost is that an
 * outage arriving in a shape matching neither the error codes, the HTTP status
 * nor the phrase list — an HTML proxy error page served with a 200, say — gets a
 * one-shot red rather than a retried one. Widen the lists rather than retrying
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
 * Source-only and install-free by design: it shells out to `pnpm audit`, which
 * reads `pnpm-lock.yaml`, so the job needs no `pnpm install`.
 */

/**
 * The severity threshold, stated once. Both the flag handed to `pnpm audit` and
 * the severities this script counts as failing are derived from it, so the
 * threshold cannot drift between "what pnpm was asked" and "what we judged".
 */
export const AUDIT_LEVEL = "high";

/** Severities in ascending order, as `pnpm audit --json` reports them. */
export const SEVERITY_ORDER = ["info", "low", "moderate", "high", "critical"];

/** The severities at or above {@link AUDIT_LEVEL}: the ones that fail the check. */
export const FAILING_SEVERITIES = SEVERITY_ORDER.slice(
  SEVERITY_ORDER.indexOf(AUDIT_LEVEL),
);

/**
 * The command this gate runs. `--json` is what makes the outcome classifiable.
 *
 * `--config.fetch-retries=0` switches off pnpm's own retries, because this
 * script owns the retry policy (see "The move to pnpm" above): with it, one
 * attempt is one request, bounded by pnpm's default `fetch-timeout` of 60
 * seconds, which fits inside {@link ATTEMPT_TIMEOUT_MS}. Do not add
 * `--config.fetch-timeout=…` beside it: on pnpm 11.27.1 that spelling arrives
 * as a string and fails every request at once with `fetch failed` (measured),
 * which this script would then report as an outage.
 */
export const AUDIT_COMMAND = [
  "audit",
  `--audit-level=${AUDIT_LEVEL}`,
  "--json",
  "--config.fetch-retries=0",
];

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
 * and let the person re-run when npmjs.org is back.
 */
export const RETRY_DELAYS_MS = [5_000, 15_000, 45_000];

/** Total attempts: the first try plus one per backoff delay. */
export const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1;

/**
 * How long ONE attempt may run before it is killed and counted as unreachable.
 *
 * Without this the "at most 65 seconds of waiting" above is an assumption rather
 * than a bound: the backoff is bounded, but each attempt was not. (When this was
 * written for npm, npm's defaults — `fetch-timeout` 300000ms and
 * `fetch-retries` 2 — let one attempt against an endpoint that black-holes
 * packets sit for minutes.) Today pnpm's `fetch-timeout` default of 60000ms
 * bounds its single request, since {@link AUDIT_COMMAND} switches its retries
 * off — but that is pnpm's bound, not this script's, and a pnpm that stalls
 * anywhere else would still have none. Four unbounded attempts could blow the
 * job's own `timeout-minutes: 10`, GitHub would cancel the runner mid-attempt,
 * and the check would report failure with NO verdict line at all — precisely
 * the unexplained red this script exists to abolish, made up to four times more
 * likely by the retry loop than the single-shot command was.
 *
 * 90 seconds is the budget. The arithmetic against the ten-minute ceiling:
 * 4 x 90s of attempts + 65s of backoff = 425s worst case, leaving over two and a
 * half minutes for checkout, pnpm and `setup-node` (which take well under one).
 * It leaves pnpm's 60-second request timeout room to report its own failure
 * first — measured: against an endpoint that accepts the connection and never
 * answers, one attempt ended in pnpm's own `fetch failed` after about 77 seconds
 * on a Windows workstation; were it ever slower, the kill reaches the same
 * verdict — and it is about twenty times the longest a healthy `pnpm audit` took
 * on this lockfile when measured (under five seconds), so a slow-but-working
 * registry is never mistaken for a dead one.
 */
export const ATTEMPT_TIMEOUT_MS = 90_000;

/**
 * Error codes that mean "the request did not get an answer", not "your tree has
 * a problem". Anything matching is retried; anything else is not, because a
 * usage or lockfile error will not fix itself and burning 65 seconds on it just
 * delays a report the reader needs.
 *
 * pnpm itself reports a request that got no answer — connection refused, a DNS
 * failure, its own 60-second timeout — as the bare code `pnpm` with the message
 * `fetch failed` (all measured), which is too generic to list here; the phrase
 * list below catches it. These are the lower-level codes of the same failures,
 * for when one surfaces as the code.
 */
const NETWORK_ERROR_CODES = new Set([
  "EAI_AGAIN",
  "ECONNRESET",
  "ECONNREFUSED",
  "ENOTFOUND",
  "EPIPE",
  "ETIMEDOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);

/**
 * Phrases printed when the advisory endpoint misbehaves. Codes and the HTTP
 * status are checked first; this catches the shapes that arrive as prose. The
 * first entry is what pnpm says for every request that got no answer; the rest
 * are the proxy, socket and resolver wordings of the same thing, including the
 * wordings of the three failures measured on 4 September 2026.
 */
const NETWORK_ERROR_PHRASES = [
  "fetch failed",
  "network timeout",
  "service unavailable",
  "socket hang up",
  "gateway time-out",
  "gateway timeout",
  "bad gateway",
  "getaddrinfo",
  "econnreset",
  "econnrefused",
  "enotfound",
  "etimedout",
  "eai_again",
  "too many requests",
];

/**
 * pnpm reports every non-2xx, non-404 answer from the advisory endpoint under
 * one code, `ERR_PNPM_AUDIT_BAD_RESPONSE`, with the status in the message:
 * `The audit endpoint (at …) responded with 503: Service Unavailable`. The
 * status is what separates an outage from a refusal, so it is read out.
 */
const HTTP_STATUS_PATTERN = /\bresponded with (\d{3})\b/i;

/**
 * An answer that means "try again later": rate limiting, or the service failing
 * on its own side. Any other status — a 401, 403, 404, 410 — is the endpoint
 * refusing this request, which will not change on a retry.
 */
function isOutageStatus(status) {
  return status === 429 || (status >= 500 && status <= 599);
}

/**
 * Pulls the JSON body out of a captured stdout. pnpm writes the report to
 * stdout on its own (with `--json` its warnings go to stderr), but a stray line
 * ahead of it — a proxy banner, a wrapper's notice — would break a naive
 * `JSON.parse`. The report is pretty-printed and starts on a line of its own, so
 * each object that starts a line is tried first; then, for a banner that shares
 * its line with the report, the first brace anywhere. A stray line that itself
 * carries a brace (pnpm's own wording `Failed to replace env in config:
 * ${NPM_TOKEN}`, say) therefore does not hide the report behind it.
 */
export function extractJson(stdout) {
  if (typeof stdout !== "string") return undefined;
  const end = stdout.lastIndexOf("}");
  if (end === -1) return undefined;
  const starts = [];
  for (let index = stdout.indexOf("{"); index !== -1 && index < end; ) {
    if (index === 0 || stdout[index - 1] === "\n") starts.push(index);
    index = stdout.indexOf("{", index + 1);
  }
  const first = stdout.indexOf("{");
  if (first !== -1 && !starts.includes(first)) starts.push(first);
  for (const start of starts) {
    try {
      const parsed = JSON.parse(stdout.slice(start, end + 1));
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      // Not the report; try the next candidate.
    }
  }
  return undefined;
}

/**
 * Keeps a message readable on one line. pnpm puts the endpoint's whole response
 * body into its BAD_RESPONSE message, and an outage page can be kilobytes of
 * HTML — which would otherwise become the `Last error:` line and the job
 * summary.
 */
const MAX_REASON_LENGTH = 400;
function oneLine(text) {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  return flat.length > MAX_REASON_LENGTH ? `${flat.slice(0, MAX_REASON_LENGTH)}…` : flat;
}

/**
 * pnpm's own last word, for the `Last error:` line. When the report is
 * unparseable the parser's reason ("no parseable JSON report") is accurate about
 * the parser and useless about the outage, so the line pnpm actually printed is
 * carried through in front of it where there is one. pnpm prints its errors as
 * `[ERR_PNPM_…] message` (or ` ERR_PNPM_…  message`) and its warnings as
 * `[WARN] …`; an error line is preferred over a warning, and an `npm error` /
 * `npm warn` line from anything npm-shaped on the path is recognised too.
 *
 * pnpm prints a prose error to stdout (measured without `--json`), and npm
 * printed its errors to stderr, so both streams are searched for those lines —
 * no line of a JSON report can look like one. Failing that, the first line of
 * stderr is quoted, or of stdout when stdout held no JSON at all, so a line of a
 * report is never quoted back as pnpm's last word.
 */
const ERROR_LINE = /^(\[(ERR_PNPM_\w+|ERROR)\]|ERR_PNPM_\w+\b|npm\s+(error|err!)\b)/i;
const WARN_LINE = /^(\[WARN\]|WARN\b|npm\s+warn\b)/i;
function pnpmSaid({ stdout, stderr, stdoutIsProse }) {
  const linesOf = (text) =>
    String(text ?? "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  const errLines = linesOf(stderr);
  const outLines = linesOf(stdout);
  const all = [...errLines, ...outLines];
  const said =
    all.find((line) => ERROR_LINE.test(line)) ??
    all.find((line) => WARN_LINE.test(line)) ??
    errLines[0] ??
    (stdoutIsProse ? outLines[0] : undefined);
  return said === undefined ? undefined : oneLine(said);
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
  // An HTTP status is the endpoint's own statement of what happened, so where
  // there is one it decides, and a refusal is not re-read as an outage because
  // the page that carried it happened to contain an outage-sounding word.
  const status = HTTP_STATUS_PATTERN.exec(haystack);
  if (status) return isOutageStatus(Number(status[1]));
  return NETWORK_ERROR_PHRASES.some((phrase) => haystack.includes(phrase));
}

/**
 * A fix exists when pnpm names a real patched range. The advisory service uses
 * `<0.0.0` — a range nothing satisfies — for "no patched version", and an absent
 * or empty value says the same.
 */
function hasPublishedFix(patchedVersions) {
  if (typeof patchedVersions !== "string") return false;
  const range = patchedVersions.trim();
  return range !== "" && range !== "<0.0.0";
}

/**
 * The failing advisories, one line per distinct finding, for the report. pnpm
 * keys `advisories` by advisory id and several can name the same package; an
 * entry identical in every field printed is listed once.
 */
function failingAdvisories(advisories) {
  if (!advisories || typeof advisories !== "object") return [];
  const seen = new Set();
  return Object.values(advisories)
    .filter((entry) => FAILING_SEVERITIES.includes(entry?.severity))
    .map((entry) => ({
      name: String(entry.module_name ?? "unknown package"),
      severity: String(entry.severity),
      range: entry.vulnerable_versions ? String(entry.vulnerable_versions) : undefined,
      fixAvailable: hasPublishedFix(entry.patched_versions),
    }))
    .filter((advisory) => {
      const key = JSON.stringify([
        advisory.name,
        advisory.severity,
        advisory.range,
        advisory.fixAvailable,
      ]);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Turns one captured `pnpm audit --json` run into a verdict.
 *
 * Returns `{ outcome, ... }` where `outcome` is one of:
 * - `"clean"` — a report was parsed and nothing at or above the threshold is in
 *   it. **The only outcome that may exit 0.**
 * - `"vulnerable"` — a report was parsed and it carries a failing advisory.
 * - `"unreachable"` — the advisory service did not answer. Retryable.
 * - `"inconclusive"` — pnpm failed for some other reason, or answered with
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
        killed ?? `pnpm audit was killed after ${ATTEMPT_TIMEOUT_MS} ms without answering.`,
      exitCode,
    };
  }

  // pnpm's error object is `{ code, message }`; npm's was `{ code, summary,
  // detail }`. Both are read, so a shape between the two still names its cause.
  const pnpmError = parsed && typeof parsed.error === "object" ? parsed.error : undefined;
  if (pnpmError) {
    const said = [pnpmError.message, pnpmError.summary, pnpmError.detail]
      .filter(Boolean)
      .join(" ");
    // Judged on everything pnpm said; only the line printed is shortened.
    const outcome = looksLikeNetworkFailure({ code: pnpmError.code, text: said })
      ? "unreachable"
      : "inconclusive";
    const detail = oneLine(said);
    // Written the way pnpm itself prints it, `[ERR_PNPM_…] message`, when the
    // code says anything; pnpm's bare `pnpm` code does not.
    const code = typeof pnpmError.code === "string" ? pnpmError.code : undefined;
    let reason = detail || `pnpm audit failed with ${code ?? "no code"}`;
    if (detail && code && /^ERR_/i.test(code)) reason = `[${code}] ${detail}`;
    return { outcome, reason, exitCode };
  }

  const counts = parsed?.metadata?.vulnerabilities;
  if (!parsed || !hasCompleteCounts(counts)) {
    // No report, or a report whose severity counts this gate cannot read. If the
    // noise pnpm made looks like the network, say so — that is the case this
    // whole script exists to name — otherwise be honest that we do not know, and
    // fail either way.
    const outcome = looksLikeNetworkFailure({ text: combined })
      ? "unreachable"
      : "inconclusive";
    let reason;
    if (!parsed) {
      reason = "pnpm audit produced no parseable JSON report.";
    } else if (!counts || typeof counts !== "object") {
      reason = "pnpm audit returned JSON with no `metadata.vulnerabilities` counts.";
    } else {
      reason =
        "pnpm audit returned severity counts this gate could not read: expected a " +
        `number for each of ${SEVERITY_ORDER.join(", ")}, and did not get one for ` +
        `${unreadableSeverities(counts).join(", ")}.`;
    }
    const pnpmLine = pnpmSaid({ stdout, stderr, stdoutIsProse: !parsed });
    return {
      outcome,
      reason: pnpmLine ? `${pnpmLine} — ${reason}` : reason,
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

  if (failing > 0) {
    const advisories = failingAdvisories(parsed.advisories);
    return { outcome: "vulnerable", severityCounts, advisories, exitCode };
  }

  // The counts say clean. pnpm was asked with `--audit-level=high`, so it exits
  // 0 exactly when it agrees — and a disagreement means one of the two is
  // reading a shape the other is not. Never resolve that in favour of green.
  if (exitCode !== 0) {
    return {
      outcome: "inconclusive",
      severityCounts,
      exitCode,
      reason:
        `pnpm audit exited ${exitCode === null ? "on a signal" : exitCode} while its own ` +
        `severity counts report nothing at ${AUDIT_LEVEL} or above. pnpm and this gate ` +
        "disagree, so nothing has been cleared.",
    };
  }

  // A scan of nothing is not a clean scan (#3673 review). pnpm reports how many
  // packages it sent to the advisory service; a lockfile it read as empty, or a
  // report that no longer says, must not print CLEAN over a tree it never saw.
  const scanned = parsed.metadata?.totalDependencies;
  if (!(typeof scanned === "number" && Number.isFinite(scanned) && scanned > 0)) {
    return {
      outcome: "inconclusive",
      severityCounts,
      exitCode,
      reason:
        "pnpm audit reported no packages audited (`metadata.totalDependencies` is " +
        `${scanned === undefined ? "absent" : JSON.stringify(scanned)}), so a clean count ` +
        "covers nothing. Nothing has been cleared.",
    };
  }

  return { outcome: "clean", severityCounts, exitCode, scanned };
}

/**
 * Spawns the real `pnpm audit`, capturing both streams, and kills an attempt
 * that exceeds {@link ATTEMPT_TIMEOUT_MS}. A killed attempt resolves with
 * `timedOut: true`, which {@link classifyAuditRun} reads as unreachable — so an
 * endpoint that never answers is retried and then named as an outage, instead of
 * running the job into its own ceiling with no verdict printed.
 */
export function runPnpmAudit({ cwd = process.cwd(), timeoutMs = ATTEMPT_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    // `shell: true` on Windows only, because `pnpm` there is usually `pnpm.cmd`
    // and Node refuses to spawn a batch file without a shell. It prints a
    // DEP0190 deprecation warning about unescaped arguments; that warning is
    // about arguments an attacker could influence, and every element of
    // AUDIT_COMMAND is a module-level constant in this file. CI runs on Linux,
    // where the shell is not used at all.
    const child = spawn("pnpm", AUDIT_COMMAND, {
      cwd,
      shell: process.platform === "win32",
      stdio: ["ignore", "pipe", "pipe"],
      // Node kills the child itself once the budget is up. On Linux — which is
      // where CI runs, and the only place this bound has to hold — the signal
      // reaches `pnpm` directly, because no shell is interposed (and CI installs
      // the exact `packageManager` version, so pnpm does not hand off to a
      // second pnpm process of another version).
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
            `${stderr}\npnpm audit did not answer within ${timeoutMs} ms and was killed ` +
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
  run = runPnpmAudit,
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
  const { outcome, attempt, severityCounts, advisories = [], reason, scanned } = result;
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
        `  Packages audited: ${scanned}.`,
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
      "  pnpm answered with something that is not an audit report, so nothing has been",
      "  cleared. Read the pnpm output above; a missing or malformed pnpm-lock.yaml",
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
