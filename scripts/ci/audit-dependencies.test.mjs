import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ATTEMPT_TIMEOUT_MS,
  AUDIT_COMMAND,
  AUDIT_LEVEL,
  auditWithRetries,
  classifyAuditRun,
  extractJson,
  FAILING_SEVERITIES,
  formatReport,
  main,
  MAX_ATTEMPTS,
  RETRY_DELAYS_MS,
  runPnpmAudit,
  SEVERITY_ORDER,
} from "./audit-dependencies.mjs";

/*
  Two cases here spawn a real Node process against a stubbed `pnpm`, which does
  not reliably finish inside vitest's 5-second default on a loaded runner. The
  work itself is milliseconds; this only stops the clock deciding which
  assertion runs.
*/
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const SCRIPT_PATH = path.join(import.meta.dirname, "audit-dependencies.mjs");
const TEMP_ROOTS = new Set();

afterEach(() => {
  for (const root of TEMP_ROOTS) rmSync(root, { force: true, recursive: true });
  TEMP_ROOTS.clear();
  vi.restoreAllMocks();
});

function tempRoot(prefix) {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  TEMP_ROOTS.add(root);
  return root;
}

/* ------------------------------------------------------------------------- *
 * Fixtures: real `pnpm audit --json` shapes (pnpm 11.27.1, measured for
 * #3673), not paraphrases of them. pnpm pretty-prints its JSON, so the
 * fixtures do too.
 * ------------------------------------------------------------------------- */

const pretty = (value) => `${JSON.stringify(value, null, 2)}\n`;

function counts({ info = 0, low = 0, moderate = 0, high = 0, critical = 0 } = {}) {
  // pnpm's counts carry exactly the five severities — no `total`, unlike npm's.
  return { info, low, moderate, high, critical };
}

function metadata(vulnerabilities) {
  return {
    vulnerabilities,
    dependencies: 540,
    devDependencies: 441,
    optionalDependencies: 224,
    totalDependencies: 1099,
  };
}

/** One entry of pnpm's `advisories` object, which is keyed by advisory id. */
function advisory({
  id,
  moduleName,
  severity,
  vulnerable,
  patched,
  title = "An advisory",
  ghsa = "GHSA-xxxx-xxxx-xxxx",
  version = "1.0.0",
}) {
  return {
    findings: [{ version, paths: [`.>${moduleName}`], dev: false, optional: false, bundled: false }],
    id,
    title,
    module_name: moduleName,
    vulnerable_versions: vulnerable,
    patched_versions: patched,
    severity,
    cwe: ["CWE-400"],
    github_advisory_id: ghsa,
    url: `https://github.com/advisories/${ghsa}`,
  };
}

/**
 * A tree with nothing at or above the threshold — two moderates and a low, which
 * do not fail. With `--audit-level=high` pnpm leaves them out of `advisories`
 * but still counts them, which is exactly what it printed on this repository.
 */
const CLEAN_REPORT = pretty({
  advisories: {},
  metadata: metadata(counts({ low: 1, moderate: 2 })),
});

/**
 * A real high-severity advisory. `browserslist <= 4.28.6` (GHSA-c83g-rgw3-j3cx,
 * unbounded memory growth) is one this repository has genuinely carried and
 * documented in docs/MAINTENANCE.md, so this is the exact shape that must keep
 * failing the check.
 */
const VULNERABLE_REPORT = pretty({
  advisories: {
    1105522: advisory({
      id: 1_105_522,
      moduleName: "browserslist",
      severity: "high",
      vulnerable: "<=4.28.6",
      patched: ">=4.28.7",
      title: "browserslist has unbounded memory growth with no cache eviction",
      ghsa: "GHSA-c83g-rgw3-j3cx",
      version: "4.28.6",
    }),
  },
  metadata: metadata(counts({ high: 1 })),
});

/**
 * A critical advisory with no fix published, to prove both are counted. The
 * advisory service writes "no patched version" as `<0.0.0`, a range nothing
 * satisfies.
 */
const CRITICAL_REPORT = pretty({
  advisories: {
    1000001: advisory({
      id: 1_000_001,
      moduleName: "left-pad",
      severity: "critical",
      vulnerable: "*",
      patched: "<0.0.0",
      title: "Arbitrary code execution",
    }),
  },
  metadata: metadata(counts({ critical: 1 })),
});

/**
 * An advisory service that could not be reached, in each shape pnpm reports
 * it. The shapes of the three failures measured on 4 September 2026
 * (#3246/#3247) — a timeout, a 503, and the same 503 again — are the whole
 * reason the issue exists; these are how pnpm says the same things.
 */
const OUTAGE_FIXTURES = {
  // Connection refused, a DNS failure and pnpm's own request timeout all look
  // like this (all three measured).
  "no answer at all — refused, unresolvable or timed out": {
    exitCode: 1,
    stdout: pretty({ error: { code: "pnpm", message: "fetch failed" } }),
    stderr: "",
  },
  "503 from the bulk advisories endpoint (#3247)": {
    exitCode: 1,
    stdout: pretty({
      error: {
        code: "ERR_PNPM_AUDIT_BAD_RESPONSE",
        message:
          "The audit endpoint (at https://registry.npmjs.org/-/npm/v1/security/advisories/bulk) responded with 503: Service Unavailable",
      },
    }),
    stderr: "",
  },
  "429 from the bulk advisories endpoint — rate limited": {
    exitCode: 1,
    stdout: pretty({
      error: {
        code: "ERR_PNPM_AUDIT_BAD_RESPONSE",
        message:
          "The audit endpoint (at https://registry.npmjs.org/-/npm/v1/security/advisories/bulk) responded with 429: Too Many Requests",
      },
    }),
    stderr: "",
  },
  // pnpm's prose form, as it prints without `--json`: the outage arrives with
  // no JSON body at all, and has to be recognised from the words.
  "a prose-only outage with no JSON body": {
    exitCode: 1,
    stdout: "",
    stderr:
      "[ERR_PNPM_AUDIT_BAD_RESPONSE] The audit endpoint (at https://registry.npmjs.org/-/npm/v1/security/advisories/bulk) responded with 502: Bad Gateway\n",
  },
  "an attempt killed for running past its budget": {
    exitCode: null,
    stdout: "",
    stderr: "\npnpm audit did not answer within 90000 ms and was killed with SIGKILL.",
    timedOut: true,
  },
};

/** The endpoint answered and refused: a 4xx other than 429. Not an outage. */
const REFUSED_BY_ENDPOINT = {
  exitCode: 1,
  stdout: pretty({
    error: {
      code: "ERR_PNPM_AUDIT_BAD_RESPONSE",
      message:
        "The audit endpoint (at https://registry.npmjs.org/-/npm/v1/security/advisories/bulk) responded with 403: Forbidden",
    },
  }),
  stderr: "",
};

/** Measured verbatim: `pnpm audit --json` in a project with no lockfile. */
const NO_LOCKFILE = {
  exitCode: 1,
  stdout: pretty({
    error: {
      code: "ERR_PNPM_AUDIT_NO_LOCKFILE",
      message: "No pnpm-lock.yaml found: Cannot audit a project without a lockfile",
    },
  }),
  stderr: "",
};

/* ------------------------------------------------------------------------- *
 * Classification
 * ------------------------------------------------------------------------- */

describe("classifyAuditRun", () => {
  it("reports a clean tree as clean, with its counts", () => {
    const result = classifyAuditRun({ exitCode: 0, stdout: CLEAN_REPORT, stderr: "" });
    expect(result.outcome).toBe("clean");
    expect(result.severityCounts).toMatchObject({ moderate: 2, high: 0, critical: 0 });
  });

  // THE CRITERION THAT IS NOT OPTIONAL (#3254): a real advisory must still fail.
  it("reports a real high-severity advisory as a vulnerability, never as an outage", () => {
    const result = classifyAuditRun({ exitCode: 1, stdout: VULNERABLE_REPORT, stderr: "" });
    expect(result.outcome).toBe("vulnerable");
    expect(result.advisories).toEqual([
      { name: "browserslist", severity: "high", range: "<=4.28.6", fixAvailable: true },
    ]);
  });

  it("reports a critical advisory as a vulnerability too, with no fix published", () => {
    const result = classifyAuditRun({ exitCode: 1, stdout: CRITICAL_REPORT });
    expect(result.outcome).toBe("vulnerable");
    expect(result.advisories).toEqual([
      { name: "left-pad", severity: "critical", range: "*", fixAvailable: false },
    ]);
  });

  // pnpm keys advisories by id, and one package routinely carries several —
  // the measured lodash@4.17.20 report had two highs for lodash alone.
  it("lists identical findings for one package once, and distinct ones separately", () => {
    const lodash = (id, vulnerable, patched) =>
      advisory({ id, moduleName: "lodash", severity: "high", vulnerable, patched });
    const stdout = pretty({
      advisories: {
        1106913: lodash(1_106_913, "<4.17.21", ">=4.17.21"),
        1106914: lodash(1_106_914, "<4.17.21", ">=4.17.21"),
        1115806: lodash(1_115_806, ">=4.0.0 <=4.17.23", ">=4.18.1"),
        1000002: advisory({
          id: 1_000_002,
          moduleName: "axios",
          severity: "high",
          vulnerable: "<1.0.0",
          patched: ">=1.0.0",
        }),
      },
      metadata: metadata(counts({ high: 4 })),
    });
    const result = classifyAuditRun({ exitCode: 1, stdout });
    expect(result.outcome).toBe("vulnerable");
    expect(result.advisories).toEqual([
      { name: "axios", severity: "high", range: "<1.0.0", fixAvailable: true },
      { name: "lodash", severity: "high", range: "<4.17.21", fixAvailable: true },
      { name: "lodash", severity: "high", range: ">=4.0.0 <=4.17.23", fixAvailable: true },
    ]);
  });

  it("lists only the failing severities, whatever else the report carries", () => {
    const stdout = pretty({
      advisories: {
        1: advisory({ id: 1, moduleName: "a", severity: "moderate", vulnerable: "*", patched: "" }),
        2: advisory({ id: 2, moduleName: "b", severity: "high", vulnerable: "<2", patched: ">=2" }),
      },
      metadata: metadata(counts({ moderate: 1, high: 1 })),
    });
    expect(classifyAuditRun({ exitCode: 1, stdout }).advisories.map((a) => a.name)).toEqual(["b"]);
  });

  it.each(Object.entries(OUTAGE_FIXTURES))(
    "reports an unreachable advisory service as an outage: %s",
    (_label, captured) => {
      expect(classifyAuditRun(captured).outcome).toBe("unreachable");
    },
  );

  // A 403, a 401 or a 410 is the endpoint answering and refusing. Retrying it
  // would spend a minute to be refused again, and calling it an outage would
  // send the reader to status.npmjs.org for a problem that is not there.
  it("does not call a 4xx other than 429 an outage", () => {
    const result = classifyAuditRun(REFUSED_BY_ENDPOINT);
    expect(result.outcome).toBe("inconclusive");
    expect(result.reason).toContain("[ERR_PNPM_AUDIT_BAD_RESPONSE]");
    expect(result.reason).toContain("403");
  });

  it("lets the HTTP status decide over an outage-sounding page body", () => {
    const result = classifyAuditRun({
      exitCode: 1,
      stdout: pretty({
        error: {
          code: "ERR_PNPM_AUDIT_BAD_RESPONSE",
          message:
            "The audit endpoint (at https://registry.npmjs.org/-/npm/v1/security/advisories/bulk) responded with 401: <html>Service Unavailable to anonymous users</html>",
        },
      }),
    });
    expect(result.outcome).toBe("inconclusive");
  });

  it("calls every 5xx from the endpoint an outage", () => {
    for (const status of [500, 502, 503, 504]) {
      const result = classifyAuditRun({
        exitCode: 1,
        stdout: pretty({
          error: {
            code: "ERR_PNPM_AUDIT_BAD_RESPONSE",
            message: `The audit endpoint (at https://registry.npmjs.org/-/npm/v1/security/advisories/bulk) responded with ${status}: x`,
          },
        }),
      });
      expect(result.outcome, String(status)).toBe("unreachable");
    }
  });

  it("does not call a missing endpoint an outage", () => {
    const result = classifyAuditRun({
      exitCode: 1,
      stdout: pretty({
        error: {
          code: "ERR_PNPM_AUDIT_ENDPOINT_NOT_EXISTS",
          message:
            "The audit endpoint (at https://registry.npmjs.org/-/npm/v1/security/advisories/bulk) doesn't exist.",
        },
      }),
    });
    expect(result.outcome).toBe("inconclusive");
  });

  it("does not call a non-network pnpm failure an outage, and does not retry it", () => {
    const result = classifyAuditRun(NO_LOCKFILE);
    expect(result.outcome).toBe("inconclusive");
    expect(result.reason).toBe(
      "[ERR_PNPM_AUDIT_NO_LOCKFILE] No pnpm-lock.yaml found: Cannot audit a project without a lockfile",
    );
  });

  // pnpm puts the endpoint's whole response body into the message, and an
  // outage page can be kilobytes of HTML.
  it("keeps a huge error message to one readable line", () => {
    const result = classifyAuditRun({
      exitCode: 1,
      stdout: pretty({
        error: {
          code: "ERR_PNPM_AUDIT_BAD_RESPONSE",
          message: `The audit endpoint (at x) responded with 503: <html>\n${"<p>down</p>\n".repeat(2000)}</html>`,
        },
      }),
    });
    expect(result.outcome).toBe("unreachable");
    expect(result.reason).not.toContain("\n");
    expect(result.reason.length).toBeLessThan(500);
  });

  it("never calls an unparseable answer clean", () => {
    const result = classifyAuditRun({ exitCode: 0, stdout: "<html>502 Bad Gateway</html>" });
    expect(result.outcome).not.toBe("clean");
  });

  it("never calls a report with no counts clean, even on exit 0", () => {
    const result = classifyAuditRun({ exitCode: 0, stdout: pretty({ advisories: {} }) });
    expect(result.outcome).not.toBe("clean");
  });

  it("never calls a killed attempt clean, even if a clean report arrived first", () => {
    const result = classifyAuditRun({
      exitCode: null,
      stdout: CLEAN_REPORT,
      stderr: "pnpm audit did not answer within 90000 ms and was killed with SIGKILL.",
      timedOut: true,
    });
    expect(result.outcome).toBe("unreachable");
  });

  /*
    The counts are VALIDATED, not coerced. `Number(counts[severity] ?? 0)` read a
    missing key as 0 and a non-numeric one as NaN, and `NaN > 0` is false — so
    each of these shapes took the clean arm and exited 0. A report-shape change
    in the audit tool (a new report version, renamed or nested severity keys, an
    empty counts map from a degraded registry response) would therefore have turned
    this required security gate green on every branch, permanently and silently,
    with the log reading `Dependency audit: CLEAN`.
  */
  describe("a counts object it cannot read is never clean", () => {
    const UNREADABLE_COUNTS = {
      "an empty counts object — every severity missing": {},
      "an array where an object belongs": [],
      "a non-numeric count — a renamed or degraded field": {
        info: 0,
        low: 0,
        moderate: 0,
        high: "unknown",
        critical: 0,
      },
      "one severity missing, the rest present": { info: 0, low: 0, moderate: 0, critical: 0 },
      // JSON has no NaN: a tool serialising one emits `null`, which coerced to 0.
      "a count serialised as null": { info: 0, low: 0, moderate: 0, high: null, critical: 0 },
    };

    it.each(Object.entries(UNREADABLE_COUNTS))(
      "refuses to exit 0 for %s",
      (_label, vulnerabilities) => {
        const stdout = pretty({ advisories: {}, metadata: metadata(vulnerabilities) });
        const result = classifyAuditRun({ exitCode: 0, stdout });
        expect(result.outcome).toBe("inconclusive");
        expect(formatReport(result).exitCode).toBe(1);
      },
    );

    it("names the severities it could not read, so the drift is diagnosable", () => {
      const result = classifyAuditRun({
        exitCode: 0,
        stdout: JSON.stringify({
          metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: "unknown" } },
        }),
      });
      expect(result.reason).toContain("high");
      expect(result.reason).toContain("critical");
    });

    it("still accepts a complete counts object with every severity a real number", () => {
      const stdout = JSON.stringify({
        metadata: { vulnerabilities: Object.fromEntries(SEVERITY_ORDER.map((s) => [s, 0])) },
      });
      expect(classifyAuditRun({ exitCode: 0, stdout }).outcome).toBe("clean");
    });
  });

  /*
    pnpm's own exit code is the one signal no report-shape drift can fake, and
    the command this script replaced — `npm audit --audit-level=high` — was
    structurally immune because it read nothing else. Carrying `exitCode` in the
    result object and never consulting it gave that immunity away.
  */
  it("never calls a report clean when pnpm itself exited non-zero", () => {
    const result = classifyAuditRun({ exitCode: 1, stdout: CLEAN_REPORT, stderr: "" });
    expect(result.outcome).toBe("inconclusive");
    expect(result.reason).toContain("disagree");
    expect(formatReport(result).exitCode).toBe(1);
  });

  it("never calls a report clean when pnpm died on a signal", () => {
    expect(classifyAuditRun({ exitCode: null, stdout: CLEAN_REPORT }).outcome).toBe("inconclusive");
  });

  it("still exits 0 when the counts are clean and pnpm agrees", () => {
    expect(classifyAuditRun({ exitCode: 0, stdout: CLEAN_REPORT }).outcome).toBe("clean");
  });

  /*
    pnpm's `auditConfig.ignoreGhsas` drops an advisory from the list and from
    pnpm's exit code but not from the counts (measured on 11.27.1). The counts
    decide, so that setting cannot turn this gate green.
  */
  it("still fails when pnpm exits 0 because the advisory was ignored in its config", () => {
    const stdout = pretty({ advisories: {}, metadata: metadata(counts({ high: 2, moderate: 3 })) });
    const result = classifyAuditRun({ exitCode: 0, stdout });
    expect(result.outcome).toBe("vulnerable");
    expect(formatReport({ ...result, attempt: 1 }).exitCode).toBe(1);
  });

  // #3254 review: `Last error: … produced no parseable JSON report.` is accurate
  // about the parser and useless about the outage.
  it("carries pnpm's own message into the reason when the body is unparseable", () => {
    const result = classifyAuditRun(OUTAGE_FIXTURES["a prose-only outage with no JSON body"]);
    expect(result.outcome).toBe("unreachable");
    expect(result.reason).toContain("[ERR_PNPM_AUDIT_BAD_RESPONSE] The audit endpoint");
    expect(formatReport({ ...result, attempt: MAX_ATTEMPTS }).lines.join("\n")).toContain(
      "Last error: [ERR_PNPM_AUDIT_BAD_RESPONSE] The audit endpoint",
    );
  });

  // pnpm prints prose errors to stdout, so that is where the line is found when
  // there is no report; and an error line wins over a warning printed before it.
  it("finds pnpm's error line on stdout, ahead of an earlier warning", () => {
    const result = classifyAuditRun({
      exitCode: 1,
      stdout:
        "[WARN] Unsupported engine: wanted: {\"node\":\">=99\"}\n" +
        "[ERR_PNPM_AUDIT_BAD_RESPONSE] The audit endpoint (at x) responded with 503: Service Unavailable\n",
      stderr: "",
    });
    expect(result.outcome).toBe("unreachable");
    expect(result.reason).toMatch(/^\[ERR_PNPM_AUDIT_BAD_RESPONSE\] The audit endpoint/);
  });

  it("names the timeout when an attempt was killed", () => {
    const result = classifyAuditRun(OUTAGE_FIXTURES["an attempt killed for running past its budget"]);
    expect(result.reason).toBe(
      "pnpm audit did not answer within 90000 ms and was killed with SIGKILL.",
    );
  });

  it("reads a report prefixed with a warning line", () => {
    const result = classifyAuditRun({ exitCode: 0, stdout: `[WARN] config foo\n${CLEAN_REPORT}` });
    expect(result.outcome).toBe("clean");
  });

  // A stray line carrying a brace ahead of the report — pnpm's own wording
  // `Failed to replace env in config: ${NPM_TOKEN}` is one — must not hide the
  // report behind it.
  it("reads a report prefixed with a line that itself carries a brace", () => {
    const stdout = `[WARN] Failed to replace env in config: \${NPM_TOKEN}\n${VULNERABLE_REPORT}`;
    expect(classifyAuditRun({ exitCode: 1, stdout }).outcome).toBe("vulnerable");
  });

  it("asks pnpm for the same threshold it judges by", () => {
    expect(AUDIT_COMMAND).toContain(`--audit-level=${AUDIT_LEVEL}`);
    expect(FAILING_SEVERITIES).toEqual(["high", "critical"]);
  });

  /*
    pnpm retries a failed request on its own — 10 seconds, then a minute — which
    would spend the per-attempt budget on a single 503 and duplicate the retry
    policy this script owns. The flag is what makes one attempt one request.
  */
  it("switches pnpm's own retries off, so this script owns the retry policy", () => {
    expect(AUDIT_COMMAND).toContain("--config.fetch-retries=0");
    expect(AUDIT_COMMAND).toContain("--json");
    expect(AUDIT_COMMAND[0]).toBe("audit");
  });

  it("extractJson survives a body that is not JSON at all", () => {
    expect(extractJson("no braces here")).toBeUndefined();
    expect(extractJson(undefined)).toBeUndefined();
    expect(extractJson("} {")).toBeUndefined();
  });
});

/* ------------------------------------------------------------------------- *
 * Retry policy
 * ------------------------------------------------------------------------- */

describe("auditWithRetries", () => {
  it("retries an unreachable service and succeeds when it recovers", async () => {
    const captures = [
      OUTAGE_FIXTURES["503 from the bulk advisories endpoint (#3247)"],
      { exitCode: 0, stdout: CLEAN_REPORT, stderr: "" },
    ];
    const slept = [];
    const result = await auditWithRetries({
      run: () => Promise.resolve(captures.shift()),
      sleep: (ms) => {
        slept.push(ms);
        return Promise.resolve();
      },
    });

    expect(result.outcome).toBe("clean");
    expect(result.attempt).toBe(2);
    expect(slept).toEqual([RETRY_DELAYS_MS[0]]);
  });

  it("gives up after the whole budget and still calls it an outage", async () => {
    const slept = [];
    let calls = 0;
    const result = await auditWithRetries({
      run: () => {
        calls += 1;
        return Promise.resolve(OUTAGE_FIXTURES["no answer at all — refused, unresolvable or timed out"]);
      },
      sleep: (ms) => {
        slept.push(ms);
        return Promise.resolve();
      },
    });

    expect(calls).toBe(MAX_ATTEMPTS);
    expect(slept).toEqual(RETRY_DELAYS_MS);
    expect(result.outcome).toBe("unreachable");
  });

  // A vulnerability is an answer, not a failure to answer. Retrying it would
  // waste a minute and, worse, invite the reading that a red audit is transient.
  it("never retries a vulnerability", async () => {
    let calls = 0;
    const result = await auditWithRetries({
      run: () => {
        calls += 1;
        return Promise.resolve({ exitCode: 1, stdout: VULNERABLE_REPORT, stderr: "" });
      },
      sleep: () => Promise.reject(new Error("must not sleep")),
    });

    expect(calls).toBe(1);
    expect(result.outcome).toBe("vulnerable");
  });

  it("keeps the budget short enough not to hold a runner hostage", () => {
    const total = RETRY_DELAYS_MS.reduce((sum, ms) => sum + ms, 0);
    expect(total).toBeGreaterThanOrEqual(30_000); // worth having
    expect(total).toBeLessThanOrEqual(120_000); // the job's own timeout is 10 minutes
  });

  /*
    The backoff is bounded; each ATTEMPT has to be too, or the worst case is
    unbounded and the job hits its own `timeout-minutes: 10`, gets cancelled
    mid-attempt, and reports failure with NO verdict line — the exact
    unexplained red this script exists to abolish. Two minutes of headroom for
    checkout and setup-node.
  */
  it("bounds the whole job's worst case under the ten-minute ceiling", () => {
    const backoff = RETRY_DELAYS_MS.reduce((sum, ms) => sum + ms, 0);
    const worstCase = MAX_ATTEMPTS * ATTEMPT_TIMEOUT_MS + backoff;
    expect(worstCase).toBeLessThanOrEqual(600_000 - 120_000);
    // And generous enough that a slow-but-working registry is not called dead.
    expect(ATTEMPT_TIMEOUT_MS).toBeGreaterThanOrEqual(60_000);
  });
});

/* ------------------------------------------------------------------------- *
 * What an operator actually reads
 * ------------------------------------------------------------------------- */

describe("formatReport", () => {
  it("exits 0 and says CLEAN only when the audit really ran", () => {
    const report = formatReport(classifyAuditRun({ exitCode: 0, stdout: CLEAN_REPORT }));
    expect(report.exitCode).toBe(0);
    expect(report.lines[0]).toContain("CLEAN");
  });

  it("names a vulnerability as a finding and says it is not an outage", () => {
    const report = formatReport({
      ...classifyAuditRun({ exitCode: 1, stdout: VULNERABLE_REPORT }),
      attempt: 1,
    });
    const text = report.lines.join("\n");
    expect(report.exitCode).toBe(1);
    expect(report.lines[0]).toContain("VULNERABILITY FOUND");
    expect(text).toContain("NOT an outage");
    expect(text).toContain("browserslist");
    expect(text).not.toContain("UNREACHABLE");
  });

  it("names an outage as an outage and says it is not a vulnerability", () => {
    const report = formatReport({
      ...classifyAuditRun(OUTAGE_FIXTURES["503 from the bulk advisories endpoint (#3247)"]),
      attempt: MAX_ATTEMPTS,
    });
    const text = report.lines.join("\n");
    expect(report.exitCode).toBe(1);
    expect(report.lines[0]).toContain("ADVISORY SERVICE UNREACHABLE");
    expect(report.lines[0]).toContain("NOT a vulnerability");
    expect(text).not.toContain("VULNERABILITY FOUND");
    // The recorded decision travels with the failure, so the next reader does
    // not have to re-derive why an outage is allowed to block them (#3254).
    expect(text).toContain("#3254");
  });

  /*
    The delays are stored in milliseconds. Printing them with an `s` after them
    said the job had waited eighteen hours, in the one message whose whole
    purpose is to be believed at a glance — and no assertion covered the line, so
    the mutation was invisible to this suite.
  */
  it("prints the backoff in seconds, not in milliseconds", () => {
    const report = formatReport({
      ...classifyAuditRun(OUTAGE_FIXTURES["503 from the bulk advisories endpoint (#3247)"]),
      attempt: MAX_ATTEMPTS,
    });
    expect(report.lines[1]).toBe(
      "  npmjs.org did not answer after 4 attempts with 5s, 15s and 45s of backoff between them.",
    );
    expect(report.lines.join("\n")).not.toContain("5000s");
  });

  // The two failures must be distinguishable from the FIRST line, because that
  // is what a reader skimming a job log sees. This is the whole defect.
  it("gives the two failure cases different first lines", () => {
    const vulnerable = formatReport(classifyAuditRun({ exitCode: 1, stdout: VULNERABLE_REPORT }));
    const outage = formatReport(
      classifyAuditRun(OUTAGE_FIXTURES["503 from the bulk advisories endpoint (#3247)"]),
    );
    expect(vulnerable.lines[0]).not.toBe(outage.lines[0]);
  });

  it("says plainly when pnpm answered with something that is not an audit report", () => {
    const report = formatReport(classifyAuditRun(NO_LOCKFILE));
    expect(report.exitCode).toBe(1);
    expect(report.lines[0]).toContain("THE AUDIT COULD NOT RUN");
    expect(report.lines).toContain(
      "  [ERR_PNPM_AUDIT_NO_LOCKFILE] No pnpm-lock.yaml found: Cannot audit a project without a lockfile",
    );
    expect(report.lines.join("\n")).toContain("a missing or malformed pnpm-lock.yaml");
  });
});

/* ------------------------------------------------------------------------- *
 * End to end: the exit code the job actually reports
 * ------------------------------------------------------------------------- */

describe("main", () => {
  async function runMain(captures) {
    const queue = [...captures];
    let last = captures.at(-1);
    const out = [];
    vi.spyOn(console, "log").mockImplementation((line) => out.push(String(line)));
    vi.spyOn(console, "error").mockImplementation((line) => out.push(String(line)));
    const previous = process.exitCode;
    process.exitCode = undefined;
    try {
      await main({
        run: () => {
          if (queue.length > 0) last = queue.shift();
          return Promise.resolve(last);
        },
        sleep: () => Promise.resolve(),
      });
      return { exitCode: process.exitCode ?? 0, text: out.join("\n") };
    } finally {
      process.exitCode = previous;
    }
  }

  it("exits 0 for a clean audit", async () => {
    const { exitCode, text } = await runMain([{ exitCode: 0, stdout: CLEAN_REPORT, stderr: "" }]);
    expect(exitCode).toBe(0);
    expect(text).toContain("CLEAN");
  });

  it("exits 1 for a real advisory", async () => {
    const { exitCode, text } = await runMain([{ exitCode: 1, stdout: VULNERABLE_REPORT, stderr: "" }]);
    expect(exitCode).toBe(1);
    expect(text).toContain("VULNERABILITY FOUND");
  });

  it("exits 1 for a sustained outage, saying it was an outage", async () => {
    const { exitCode, text } = await runMain([
      OUTAGE_FIXTURES["503 from the bulk advisories endpoint (#3247)"],
    ]);
    expect(exitCode).toBe(1);
    expect(text).toContain("ADVISORY SERVICE UNREACHABLE");
  });

  it("writes the verdict to the job summary when GitHub provides one", async () => {
    const root = tempRoot("audit-summary-");
    const summary = path.join(root, "summary.md");
    writeFileSync(summary, "", "utf8");
    vi.stubEnv("GITHUB_STEP_SUMMARY", summary);
    try {
      await runMain([OUTAGE_FIXTURES["503 from the bulk advisories endpoint (#3247)"]]);
      expect(readFileSync(summary, "utf8")).toContain("ADVISORY SERVICE UNREACHABLE");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

/* ------------------------------------------------------------------------- *
 * The real CLI, against a stubbed `pnpm` on PATH. This is the only case that
 * proves the shipped entry point — argv guard, spawn, exit code — rather than
 * the functions underneath it.
 * ------------------------------------------------------------------------- */

describe("the CLI as the workflow invokes it", () => {
  function stubPnpm({ stdout, exitCode }) {
    const root = tempRoot("audit-cli-");
    const bin = path.join(root, "bin");
    mkdirSync(bin, { recursive: true });
    const payload = path.join(root, "payload.json");
    writeFileSync(payload, stdout, "utf8");
    // The stub records the arguments it was given, so the CLI case proves the
    // command the gate really spawns, not just the constant it is built from.
    const argvFile = path.join(root, "argv.json");
    const body = [
      "import { readFileSync, writeFileSync } from 'node:fs';",
      `writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)));`,
      `process.stdout.write(readFileSync(${JSON.stringify(payload)}, 'utf8'));`,
      `process.exit(${exitCode});`,
    ].join("\n");
    const runner = path.join(root, "fake-pnpm.mjs");
    writeFileSync(runner, body, "utf8");

    // Both shapes, so the stub is found however the platform resolves `pnpm`.
    writeFileSync(
      path.join(bin, "pnpm"),
      `#!/bin/sh\nexec "${process.execPath}" "${runner}" "$@"\n`,
      "utf8",
    );
    chmodSync(path.join(bin, "pnpm"), 0o755);
    writeFileSync(
      path.join(bin, "pnpm.cmd"),
      `@echo off\r\n"${process.execPath}" "${runner}" %*\r\n`,
      "utf8",
    );
    return { bin, argvFile };
  }

  function runCli(stub) {
    const { bin, argvFile } = stubPnpm(stub);
    const result = spawnSync(process.execPath, [SCRIPT_PATH], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, GITHUB_STEP_SUMMARY: "" },
    });
    return { ...result, argv: JSON.parse(readFileSync(argvFile, "utf8")) };
  }

  /*
    A `pnpm` that never answers — a black-holed endpoint, or a pnpm stalled
    anywhere its own 60s `fetch-timeout` does not reach. The stub hangs WITHOUT a grandchild
    process on either platform, so the kill is observable as a `close` with a
    signal rather than being held open by a surviving descendant's pipe.
  */
  it("kills an attempt that never answers, and calls it an outage", async () => {
    const root = tempRoot("audit-hang-");
    const bin = path.join(root, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(path.join(bin, "pnpm"), "#!/bin/sh\nexec sleep 60\n", "utf8");
    chmodSync(path.join(bin, "pnpm"), 0o755);
    writeFileSync(path.join(bin, "pnpm.cmd"), "@echo off\r\n:loop\r\ngoto loop\r\n", "utf8");

    vi.stubEnv("PATH", `${bin}${path.delimiter}${process.env.PATH}`);
    try {
      const captured = await runPnpmAudit({ timeoutMs: 750 });
      expect(captured.timedOut).toBe(true);
      const classified = classifyAuditRun(captured);
      expect(classified.outcome).toBe("unreachable");
      expect(classified.reason).toContain("was killed with");
      expect(formatReport({ ...classified, attempt: MAX_ATTEMPTS }).exitCode).toBe(1);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("exits 0 when the stubbed advisory service reports a clean tree", () => {
    const result = runCli({ stdout: CLEAN_REPORT, exitCode: 0 });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("CLEAN");
    expect(result.argv).toEqual(AUDIT_COMMAND);
  });

  // The mutation proof, wired as a permanent case: if anything ever makes the
  // gate vacuously green, this is the assertion that goes red.
  it("exits 1 when the stubbed advisory service reports a real high-severity advisory", () => {
    const result = runCli({ stdout: VULNERABLE_REPORT, exitCode: 1 });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("VULNERABILITY FOUND");
  });
});
