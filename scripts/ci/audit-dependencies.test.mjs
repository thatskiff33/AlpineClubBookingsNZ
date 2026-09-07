import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
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
} from "./audit-dependencies.mjs";

/*
  Two cases here spawn a real Node process against a stubbed `npm`, which does
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
 * Fixtures: real `npm audit --json` shapes, not paraphrases of them.
 * ------------------------------------------------------------------------- */

function counts({ info = 0, low = 0, moderate = 0, high = 0, critical = 0 } = {}) {
  return { info, low, moderate, high, critical, total: info + low + moderate + high + critical };
}

/** A tree with nothing at or above the threshold — two moderates, which do not fail. */
const CLEAN_REPORT = JSON.stringify({
  auditReportVersion: 2,
  vulnerabilities: {
    "some-transitive-thing": {
      name: "some-transitive-thing",
      severity: "moderate",
      isDirect: false,
      via: [{ severity: "moderate", title: "Inefficient regular expression" }],
      range: "<1.2.3",
      fixAvailable: true,
    },
  },
  metadata: { vulnerabilities: counts({ low: 1, moderate: 2 }), dependencies: { total: 1421 } },
});

/**
 * A real high-severity advisory. `browserslist <= 4.28.6` (GHSA-c83g-rgw3-j3cx,
 * unbounded memory growth) is one this repository has genuinely carried and
 * documented in docs/MAINTENANCE.md, so this is the exact shape that must keep
 * failing the check.
 */
const VULNERABLE_REPORT = JSON.stringify({
  auditReportVersion: 2,
  vulnerabilities: {
    browserslist: {
      name: "browserslist",
      severity: "high",
      isDirect: false,
      via: [
        {
          source: 1_105_522,
          name: "browserslist",
          title: "browserslist has unbounded memory growth with no cache eviction",
          url: "https://github.com/advisories/GHSA-c83g-rgw3-j3cx",
          severity: "high",
          range: "<=4.28.6",
        },
      ],
      effects: [],
      range: "<=4.28.6",
      nodes: ["node_modules/browserslist"],
      fixAvailable: true,
    },
  },
  metadata: { vulnerabilities: counts({ high: 1 }), dependencies: { total: 1421 } },
});

/** A critical advisory with no fix published, to prove both are counted. */
const CRITICAL_REPORT = JSON.stringify({
  auditReportVersion: 2,
  vulnerabilities: {
    "left-pad": {
      name: "left-pad",
      severity: "critical",
      via: [{ severity: "critical", title: "Arbitrary code execution" }],
      range: "*",
      fixAvailable: false,
    },
  },
  metadata: { vulnerabilities: counts({ critical: 1 }), dependencies: { total: 3 } },
});

/**
 * The three failures measured on 4 September 2026 (#3246/#3247), reproduced as
 * npm reported them. These are the whole reason the issue exists.
 */
const OUTAGE_FIXTURES = {
  "network timeout on the bulk advisories endpoint (#3246)": {
    exitCode: 1,
    stdout: JSON.stringify({
      error: {
        code: "ERR_SOCKET_TIMEOUT",
        summary:
          "request to https://registry.npmjs.org/-/npm/v1/security/advisories/bulk failed, reason: network timeout",
        detail: "This is a problem related to network connectivity.",
      },
    }),
    stderr:
      "npm warn audit network timeout at: https://registry.npmjs.org/-/npm/v1/security/advisories/bulk\n",
  },
  "503 from the bulk advisories endpoint (#3247)": {
    exitCode: 1,
    stdout: JSON.stringify({
      error: {
        code: "E503",
        summary:
          "503 Service Unavailable - POST https://registry.npmjs.org/-/npm/v1/security/advisories/bulk",
        detail: "",
      },
    }),
    stderr:
      "npm warn audit 503 Service Unavailable - POST https://registry.npmjs.org/-/npm/v1/security/advisories/bulk\n",
  },
  "audit endpoint returned an error, after a re-run (#3247)": {
    exitCode: 1,
    stdout: "",
    stderr: "npm error audit endpoint returned an error\n",
  },
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

  it("reports a critical advisory as a vulnerability too", () => {
    expect(classifyAuditRun({ exitCode: 1, stdout: CRITICAL_REPORT }).outcome).toBe("vulnerable");
  });

  it.each(Object.entries(OUTAGE_FIXTURES))(
    "reports an unreachable advisory service as an outage: %s",
    (_label, captured) => {
      expect(classifyAuditRun(captured).outcome).toBe("unreachable");
    },
  );

  it("does not call a non-network npm failure an outage, and does not retry it", () => {
    const result = classifyAuditRun({
      exitCode: 1,
      stdout: JSON.stringify({
        error: { code: "EUSAGE", summary: "This command requires an existing lockfile.", detail: "" },
      }),
    });
    expect(result.outcome).toBe("inconclusive");
  });

  it("never calls an unparseable answer clean", () => {
    const result = classifyAuditRun({ exitCode: 0, stdout: "<html>502 Bad Gateway</html>" });
    expect(result.outcome).not.toBe("clean");
  });

  it("never calls a report with no counts clean, even on exit 0", () => {
    const result = classifyAuditRun({ exitCode: 0, stdout: JSON.stringify({ auditReportVersion: 2 }) });
    expect(result.outcome).not.toBe("clean");
  });

  it("reads a report that npm prefixed with a warning line", () => {
    const result = classifyAuditRun({ exitCode: 0, stdout: `npm warn config foo\n${CLEAN_REPORT}` });
    expect(result.outcome).toBe("clean");
  });

  it("asks npm for the same threshold it judges by", () => {
    expect(AUDIT_COMMAND).toContain(`--audit-level=${AUDIT_LEVEL}`);
    expect(FAILING_SEVERITIES).toEqual(["high", "critical"]);
  });

  it("extractJson survives a body that is not JSON at all", () => {
    expect(extractJson("no braces here")).toBeUndefined();
    expect(extractJson(undefined)).toBeUndefined();
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
        return Promise.resolve(OUTAGE_FIXTURES["audit endpoint returned an error, after a re-run (#3247)"]);
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

  // The two failures must be distinguishable from the FIRST line, because that
  // is what a reader skimming a job log sees. This is the whole defect.
  it("gives the two failure cases different first lines", () => {
    const vulnerable = formatReport(classifyAuditRun({ exitCode: 1, stdout: VULNERABLE_REPORT }));
    const outage = formatReport(
      classifyAuditRun(OUTAGE_FIXTURES["503 from the bulk advisories endpoint (#3247)"]),
    );
    expect(vulnerable.lines[0]).not.toBe(outage.lines[0]);
  });

  it("says plainly when npm answered with something that is not an audit report", () => {
    const report = formatReport(
      classifyAuditRun({ exitCode: 1, stdout: JSON.stringify({ error: { code: "EUSAGE", summary: "no lockfile" } }) }),
    );
    expect(report.exitCode).toBe(1);
    expect(report.lines[0]).toContain("THE AUDIT COULD NOT RUN");
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
 * The real CLI, against a stubbed `npm` on PATH. This is the only case that
 * proves the shipped entry point — argv guard, spawn, exit code — rather than
 * the functions underneath it.
 * ------------------------------------------------------------------------- */

describe("the CLI as the workflow invokes it", () => {
  function stubNpm({ stdout, exitCode }) {
    const root = tempRoot("audit-cli-");
    const bin = path.join(root, "bin");
    mkdirSync(bin, { recursive: true });
    const payload = path.join(root, "payload.json");
    writeFileSync(payload, stdout, "utf8");
    const body = [
      "import { readFileSync } from 'node:fs';",
      `process.stdout.write(readFileSync(${JSON.stringify(payload)}, 'utf8'));`,
      `process.exit(${exitCode});`,
    ].join("\n");
    const runner = path.join(root, "fake-npm.mjs");
    writeFileSync(runner, body, "utf8");

    // Both shapes, so the stub is found however the platform resolves `npm`.
    writeFileSync(
      path.join(bin, "npm"),
      `#!/bin/sh\nexec "${process.execPath}" "${runner}"\n`,
      "utf8",
    );
    chmodSync(path.join(bin, "npm"), 0o755);
    writeFileSync(
      path.join(bin, "npm.cmd"),
      `@echo off\r\n"${process.execPath}" "${runner}"\r\n`,
      "utf8",
    );
    return bin;
  }

  function runCli(stub) {
    const bin = stubNpm(stub);
    return spawnSync(process.execPath, [SCRIPT_PATH], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, GITHUB_STEP_SUMMARY: "" },
    });
  }

  it("exits 0 when the stubbed advisory service reports a clean tree", () => {
    const result = runCli({ stdout: CLEAN_REPORT, exitCode: 0 });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("CLEAN");
  });

  // The mutation proof, wired as a permanent case: if anything ever makes the
  // gate vacuously green, this is the assertion that goes red.
  it("exits 1 when the stubbed advisory service reports a real high-severity advisory", () => {
    const result = runCli({ stdout: VULNERABLE_REPORT, exitCode: 1 });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("VULNERABILITY FOUND");
  });
});
