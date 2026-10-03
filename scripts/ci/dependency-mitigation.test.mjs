import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { classifyAuditRun, formatReport, main } from "./audit-dependencies.mjs";
import {
  applyMitigation,
  formatMitigatedReport,
  loadMitigationRecords,
  MAX_EXPIRY_AHEAD_MS,
  MITIGATIONS_DIR,
} from "./dependency-mitigation.mjs";

/*
  #3843: the accept/reject matrix for MITIGATED. Every case starts from a
  SYNTHETIC fixture — a record, a patch and stand-ins for pnpm-workspace.yaml and
  pnpm-lock.yaml under scripts/ci/fixtures/dependency-mitigation/, the record
  binding their digests — copied into a scratch root, and from the report
  `pnpm audit --json` really printed for this branch (pnpm 11.27.1, 3 Oct 2026).
  Each reject case changes exactly one thing, so a passing reject proves THAT
  condition is load-bearing.

  Nothing here reads the live record, patch or lockfile for its digests: a
  dependency change is the audit gate's to refuse, not this suite's, and the
  suite must keep passing once the live record is retired.

  The clock is always passed in. No case reads the real date.
*/

const REPO = path.resolve(import.meta.dirname, "..", "..");
const FIXTURE = path.join(import.meta.dirname, "fixtures", "dependency-mitigation");
const RECORD_NAME = "3843-braces-ghsa-vfj7-8cjw-p6xm.json";
const PATCH = "patches/braces@3.0.3.patch";
const BEFORE_EXPIRY = new Date("2026-10-05T00:00:00Z");
const EXPIRY = new Date("2026-10-10T00:00:00Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const TEMP_ROOTS = new Set();

afterEach(() => {
  for (const root of TEMP_ROOTS) rmSync(root, { force: true, recursive: true });
  TEMP_ROOTS.clear();
  vi.restoreAllMocks();
});

/** The measured report, verbatim in shape and values. */
function measuredReport() {
  return {
    advisories: {
      1240992: {
        findings: [
          {
            version: "3.0.3",
            paths: [".>eslint-config-next>@next/eslint-plugin-next>fast-glob>micromatch>braces"],
            dev: true,
            optional: false,
            bundled: false,
          },
        ],
        id: 1240992,
        title:
          "braces vulnerable to stack-exhaustion denial of service through deeply nested patterns",
        module_name: "braces",
        vulnerable_versions: "<=3.0.3",
        patched_versions: null,
        severity: "high",
        cwe: "CWE-674",
        github_advisory_id: "GHSA-vfj7-8cjw-p6xm",
        url: "https://github.com/advisories/GHSA-vfj7-8cjw-p6xm",
        patched_versions_unpublished: true,
      },
    },
    metadata: {
      vulnerabilities: { info: 0, low: 0, moderate: 0, high: 1, critical: 0 },
      dependencies: 540,
      devDependencies: 440,
      optionalDependencies: 224,
      totalDependencies: 1098,
    },
  };
}

const pretty = (value) => `${JSON.stringify(value, null, 2)}\n`;
const advisoryOf = (report) => report.advisories["1240992"];
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** A scratch repository root laid out from the synthetic fixture. */
function scratchRoot() {
  const root = mkdtempSync(path.join(tmpdir(), "dep-mitigation-"));
  TEMP_ROOTS.add(root);
  mkdirSync(path.join(root, MITIGATIONS_DIR));
  mkdirSync(path.join(root, "patches"));
  for (const [from, to] of [
    ["workspace.yaml", "pnpm-workspace.yaml"],
    ["lock.yaml", "pnpm-lock.yaml"],
    ["braces@3.0.3.patch", PATCH],
    ["record.json", `${MITIGATIONS_DIR}/${RECORD_NAME}`],
  ]) {
    copyFileSync(path.join(FIXTURE, from), path.join(root, to));
  }
  return root;
}

const recordPath = (root, name = RECORD_NAME) => path.join(root, MITIGATIONS_DIR, name);
function editRecord(root, edit) {
  const record = JSON.parse(readFileSync(recordPath(root), "utf8"));
  edit(record);
  writeFileSync(recordPath(root), `${JSON.stringify(record, null, 2)}\n`);
}

/** Classify a captured run with the real classifier, then judge it. */
function judge({
  report = measuredReport(),
  stdout = pretty(report),
  exitCode = 1,
  root = scratchRoot(),
  now = BEFORE_EXPIRY,
} = {}) {
  return applyMitigation(classifyAuditRun({ exitCode, stdout, stderr: "" }), { now, root });
}

function expectRefused(result, fragment) {
  expect(result.outcome).toBe("vulnerable");
  expect(result.mitigationRefused?.join("\n")).toContain(fragment);
  const { exitCode, lines } = formatReport(result);
  expect(exitCode).toBe(1);
  // A refused record points at how to extend or retire it, not only at "upgrade".
  expect(lines.join("\n")).toContain("Extend it (a new reviewed");
  expect(lines.join("\n")).toContain("dependency-mitigations.d/README.md");
}

describe("the fixture", () => {
  it("is accepted as it stands, so every reject case below changes one thing from a pass", () => {
    expect(judge().outcome).toBe("mitigated");
  });

  it("binds the digests of its own synthetic inputs", () => {
    const record = JSON.parse(readFileSync(path.join(FIXTURE, "record.json"), "utf8"));
    expect(record.patch.sha256).toBe(sha256(readFileSync(path.join(FIXTURE, "braces@3.0.3.patch"))));
    expect(record.reviewedInputs["pnpm-workspace.yaml"]).toBe(sha256(readFileSync(path.join(FIXTURE, "workspace.yaml"))));
    expect(record.reviewedInputs["pnpm-lock.yaml"]).toBe(sha256(readFileSync(path.join(FIXTURE, "lock.yaml"))));
  });
});

describe("the committed directory", () => {
  // Deliberately NOT checked here: the live record's lock and workspace
  // digests. A dependency change already turns the required audit red; it must
  // not also redden this suite. Zero records (after retirement) passes.
  it("holds only well-formed records, each naming a patch whose bytes it binds", () => {
    const { records, problems } = loadMitigationRecords({ root: REPO });
    expect(problems).toEqual([]);
    for (const { file, record } of records) {
      expect(sha256(readFileSync(path.join(REPO, record.patch.path))), file).toBe(record.patch.sha256);
    }
  });
});

describe("MITIGATED is reported, and is never CLEAN", () => {
  it("exits 0 but says NOT CLEAN, keeps the raw advisory, and prints the scope", () => {
    const result = judge();
    const { exitCode, lines } = formatMitigatedReport(result);
    const text = lines.join("\n");
    expect(exitCode).toBe(0);
    expect(lines[0]).toMatch(/^Dependency audit: MITIGATED — NOT CLEAN\./);
    expect(text).not.toMatch(/Dependency audit: CLEAN/);
    expect(text).toContain("GHSA-vfj7-8cjw-p6xm");
    expect(text).toContain('"github_advisory_id": "GHSA-vfj7-8cjw-p6xm"');
    expect(text).toContain("SCOPE: This mitigation covers ONLY");
    expect(text.match(/NOT COVERED:/g)).toHaveLength(7);
    expect(text).toContain("Expires: 2026-10-10T00:00:00Z");
  });

  it("raises a warning annotation naming the advisory, and changes nothing else", () => {
    const report = formatMitigatedReport(judge());
    expect(report.annotations).toEqual([
      "::warning title=Dependency audit MITIGATED (NOT CLEAN)::GHSA-vfj7-8cjw-p6xm braces@3.0.3, expires 2026-10-10T00:00:00Z",
    ]);
    expect(report.lines.join("\n")).not.toContain("::warning");
    expect(report.exitCode).toBe(0);
  });

  it("goes through main with exit 0 only while every condition holds", async () => {
    const out = [];
    vi.spyOn(console, "log").mockImplementation((line) => out.push(String(line)));
    vi.spyOn(console, "error").mockImplementation((line) => out.push(String(line)));
    const previous = process.exitCode;
    const run = () => Promise.resolve({ exitCode: 1, stdout: pretty(measuredReport()), stderr: "" });
    try {
      process.exitCode = undefined;
      await main({ run, sleep: () => Promise.resolve(), now: BEFORE_EXPIRY, root: scratchRoot() });
      expect(process.exitCode).toBe(0);
      expect(out[0]).toContain("MITIGATED — NOT CLEAN");
      expect(out).toContain(
        "::warning title=Dependency audit MITIGATED (NOT CLEAN)::GHSA-vfj7-8cjw-p6xm braces@3.0.3, expires 2026-10-10T00:00:00Z",
      );

      process.exitCode = undefined;
      out.length = 0;
      await main({ run, sleep: () => Promise.resolve(), now: EXPIRY, root: scratchRoot() });
      expect(process.exitCode).toBe(1);
      expect(out[0]).toContain("VULNERABILITY FOUND");
      expect(out.join("\n")).toContain("Mitigation record NOT applied");
      expect(out.join("\n")).toContain("dependency-mitigations.d/README.md");
      expect(out.join("\n")).not.toContain("::warning");
    } finally {
      process.exitCode = previous;
    }
  });

  it("needs the clock passed in", () => {
    const vulnerable = classifyAuditRun({ exitCode: 1, stdout: pretty(measuredReport()) });
    expect(() => applyMitigation(vulnerable, { root: scratchRoot() })).toThrow(TypeError);
  });
});

describe("outcomes other than a vulnerability are never touched", () => {
  it.each([
    ["clean", { exitCode: 0, stdout: pretty({ ...measuredReport(), advisories: {}, metadata: { ...measuredReport().metadata, vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0 } } }) }],
    ["unreachable", { exitCode: 1, stdout: pretty({ error: { code: "pnpm", message: "fetch failed" } }) }],
    ["inconclusive", { exitCode: 1, stdout: "not json at all" }],
    ["inconclusive", { exitCode: 1, stdout: pretty({ advisories: {}, metadata: { vulnerabilities: { high: "1" } } }) }],
  ])("leaves %s as it is", (outcome, run) => {
    const classified = classifyAuditRun({ stderr: "", ...run });
    expect(classified.outcome).toBe(outcome);
    expect(applyMitigation(classified, { now: BEFORE_EXPIRY, root: scratchRoot() })).toBe(classified);
  });

  it("leaves a vulnerability alone when there is no record at all", () => {
    const root = scratchRoot();
    rmSync(recordPath(root));
    const result = judge({ root });
    expect(result.outcome).toBe("vulnerable");
    expect(result.mitigationRefused).toBeUndefined();
    expect(formatReport(result).lines.join("\n")).not.toContain("dependency-mitigations.d/README.md");
  });
});

describe("the approval expires, and is short-lived", () => {
  it("accepts up to the last millisecond before expiry", () => {
    expect(judge({ now: new Date(EXPIRY.getTime() - 1) }).outcome).toBe("mitigated");
  });

  it("refuses at the expiry instant and after it", () => {
    expectRefused(judge({ now: EXPIRY }), "the approval expired at 2026-10-10T00:00:00Z");
    expectRefused(judge({ now: new Date("2027-01-01T00:00:00Z") }), "expired");
  });

  it("accepts an expiry exactly 14 days ahead", () => {
    expect(MAX_EXPIRY_AHEAD_MS).toBe(14 * DAY_MS);
    expect(judge({ now: new Date(EXPIRY.getTime() - 14 * DAY_MS) }).outcome).toBe("mitigated");
  });

  it("refuses an expiry more than 14 days ahead, by a millisecond or by months", () => {
    expectRefused(judge({ now: new Date(EXPIRY.getTime() - 14 * DAY_MS - 1) }), "more than 14 days away");
    const root = scratchRoot();
    editRecord(root, (r) => (r.expires = "2027-10-10T00:00:00Z"));
    expectRefused(judge({ root }), "more than 14 days away");
  });
});

describe("the patch must be the reviewed, registered patch", () => {
  it("refuses a missing patch", () => {
    const root = scratchRoot();
    rmSync(path.join(root, PATCH));
    expectRefused(judge({ root }), "patches/braces@3.0.3.patch is missing");
  });

  it("refuses an altered patch", () => {
    const root = scratchRoot();
    const file = path.join(root, PATCH);
    writeFileSync(file, `${readFileSync(file, "utf8")}\n`);
    expectRefused(judge({ root }), "is not the reviewed one");
  });

  it("refuses a patch the workspace no longer registers", () => {
    const root = scratchRoot();
    const file = path.join(root, "pnpm-workspace.yaml");
    writeFileSync(file, readFileSync(file, "utf8").replace("braces@3.0.3: patches/braces@3.0.3.patch", "braces@3.0.3: patches/other.patch"));
    expectRefused(judge({ root }), "pnpm-workspace.yaml does not register");
  });

  it("refuses a lockfile that records a different patch hash", () => {
    const root = scratchRoot();
    const file = path.join(root, "pnpm-lock.yaml");
    writeFileSync(file, readFileSync(file, "utf8").replace("  braces@3.0.3: efe68ba7", "  braces@3.0.3: 0fe68ba7"));
    expectRefused(judge({ root }), "pnpm-lock.yaml does not record the reviewed patch hash");
  });
});

describe("any change to the dependency inputs invalidates the acceptance", () => {
  it.each(["pnpm-workspace.yaml", "pnpm-lock.yaml"])("refuses a changed %s", (name) => {
    const root = scratchRoot();
    const file = path.join(root, name);
    writeFileSync(file, `${readFileSync(file, "utf8")}# one more line\n`);
    expectRefused(judge({ root }), `${name} has changed since the mitigation was reviewed`);
  });

  it("refuses a missing input", () => {
    const root = scratchRoot();
    rmSync(path.join(root, "pnpm-lock.yaml"));
    expectRefused(judge({ root }), "pnpm-workspace.yaml or pnpm-lock.yaml is missing");
  });
});

describe("only the reviewed advisory, version and path", () => {
  const variant = (edit) => {
    const report = measuredReport();
    edit(report);
    return judge({ report });
  };

  it("refuses a different GHSA", () => {
    expectRefused(variant((r) => (advisoryOf(r).github_advisory_id = "GHSA-c83g-rgw3-j3cx")), "no mitigation record names");
  });
  it("refuses a different package", () => {
    expectRefused(variant((r) => (advisoryOf(r).module_name = "micromatch")), "names micromatch, not braces");
  });
  it("refuses a different range", () => {
    expectRefused(variant((r) => (advisoryOf(r).vulnerable_versions = "<=3.0.4")), "range is <=3.0.4");
  });
  it("refuses a different severity", () => {
    expectRefused(
      variant((r) => {
        advisoryOf(r).severity = "critical";
        r.metadata.vulnerabilities = { info: 0, low: 0, moderate: 0, high: 0, critical: 1 };
      }),
      "severity is critical",
    );
  });
  it("refuses a different version", () => {
    expectRefused(variant((r) => (advisoryOf(r).findings[0].version = "3.0.2")), "affected version is 3.0.2");
  });
  it("refuses a different path", () => {
    expectRefused(variant((r) => (advisoryOf(r).findings[0].paths = [".>micromatch>braces"])), "affected paths are");
  });
  it("refuses a second path", () => {
    expectRefused(
      variant((r) => advisoryOf(r).findings[0].paths.push(".>micromatch>braces")),
      "affected paths are",
    );
  });
  it.each([
    ["no longer dev-only", (f) => (f.dev = false)],
    ["bundled", (f) => (f.bundled = true)],
    ["optional", (f) => (f.optional = true)],
  ])("refuses a finding that is %s", (_label, edit) => {
    expectRefused(variant((r) => edit(advisoryOf(r).findings[0])), "dev/bundled/optional flags");
  });
});

describe("duplicates, missing findings and extra advisories", () => {
  it("refuses a duplicate finding", () => {
    const report = measuredReport();
    advisoryOf(report).findings.push({ ...advisoryOf(report).findings[0] });
    expectRefused(judge({ report }), "exactly one finding");
  });

  it("refuses an advisory with no findings", () => {
    const report = measuredReport();
    advisoryOf(report).findings = [];
    expectRefused(judge({ report }), "exactly one finding");
  });

  it("refuses an extra advisory, even a moderate one", () => {
    const report = measuredReport();
    report.advisories["1000002"] = { ...advisoryOf(report), id: 1000002, severity: "moderate", github_advisory_id: "GHSA-aaaa-bbbb-cccc" };
    report.metadata.vulnerabilities.moderate = 1;
    expectRefused(judge({ report }), "exactly one high and nothing else");
  });

  it("refuses a second high advisory", () => {
    const report = measuredReport();
    report.advisories["1000002"] = { ...advisoryOf(report), id: 1000002, github_advisory_id: "GHSA-aaaa-bbbb-cccc" };
    report.metadata.vulnerabilities.high = 2;
    expectRefused(judge({ report }), "exactly one high and nothing else");
  });

  it("refuses an advisory duplicated under one key, which JSON.parse would hide", () => {
    const body = JSON.stringify(advisoryOf(measuredReport()));
    const stdout = pretty(measuredReport()).replace(
      '"advisories": {',
      `"advisories": {\n    "1240992": ${body},`,
    );
    expect(JSON.parse(stdout).advisories).toHaveProperty("1240992");
    expectRefused(judge({ stdout }), "exactly one advisory");
  });

  it("refuses a report with the advisory missing but a high counted", () => {
    const report = measuredReport();
    report.advisories = {};
    expectRefused(judge({ report }), "no mitigation record names an advisory in this report");
  });
});

describe("malformed counts and report/exit disagreement", () => {
  it.each([
    ["a fractional count", { high: 1.5 }, "non-negative integers"],
    ["a negative count", { low: -1 }, "non-negative integers"],
    ["two highs", { high: 2 }, "exactly one high"],
    ["a critical", { critical: 1 }, "exactly one high"],
    ["a low beside the high", { low: 1 }, "exactly one high"],
  ])("refuses %s", (_label, change, fragment) => {
    const report = measuredReport();
    Object.assign(report.metadata.vulnerabilities, change);
    expectRefused(judge({ report }), fragment);
  });

  it("refuses an empty audit", () => {
    const report = measuredReport();
    report.metadata.totalDependencies = 0;
    expectRefused(judge({ report }), "audited no packages");
  });

  it.each([0, 2])("refuses pnpm exit %i beside the report", (exitCode) => {
    expectRefused(judge({ exitCode }), `pnpm audit exited ${exitCode}, not 1`);
  });
});

describe("unfamiliar report shapes are refused, not guessed at", () => {
  it.each([
    ["an extra top-level key", (r) => (r.muted = [])],
    ["an extra metadata key", (r) => (r.metadata.extra = 1)],
    ["an extra severity", (r) => (r.metadata.vulnerabilities.unknown = 0)],
  ])("refuses %s", (_label, edit) => {
    const report = measuredReport();
    edit(report);
    expectRefused(judge({ report }), "not the reviewed pnpm shape");
  });

  it("refuses an extra advisory key", () => {
    const report = measuredReport();
    advisoryOf(report).ignored = true;
    expectRefused(judge({ report }), "advisory entry's shape");
  });

  it("refuses an advisory filed under a key that is not its id", () => {
    const report = measuredReport();
    advisoryOf(report).id = 1;
    expectRefused(judge({ report }), "advisory entry's shape");
  });

  it("refuses an extra finding key", () => {
    const report = measuredReport();
    advisoryOf(report).findings[0].ignored = true;
    expectRefused(judge({ report }), "exactly one finding of the reviewed shape");
  });
});

describe("the record itself must be well-formed and unique", () => {
  it.each([
    ["an unknown key", (r) => (r.allowExtraAdvisories = true), "expected exactly the keys"],
    ["no owner decision", (r) => (r.ownerDecisions = []), "owner's decision"],
    ["a decision that is not a comment URL", (r) => (r.ownerDecisions = ["https://example.com/ok"]), "owner's decision"],
    ["a critical severity", (r) => (r.advisory.severity = "critical"), "a critical one never can"],
    ["a date-only expiry", (r) => (r.expires = "2026-10-10"), "UTC instant"],
    ["an expiry with an offset", (r) => (r.expires = "2026-10-10T00:00:00+13:00"), "UTC instant"],
    ["a short commit", (r) => (r.upstream.commit = "d0d575e5"), "40-character"],
    ["a patch outside patches/", (r) => (r.patch.path = "../braces.patch"), "directly under patches/"],
    ["an upper-case digest", (r) => (r.patch.sha256 = r.patch.sha256.toUpperCase()), "lowercase SHA256"],
    ["an issue number that disagrees with the file name", (r) => (r.issue = 1), "file name's issue number"],
    ["a missing scope list", (r) => delete r.knownUncoveredCopies, "expected exactly the keys"],
    ["a copy with no files", (r) => (r.knownUncoveredCopies[0].files = []), "knownUncoveredCopies"],
    ["an extra field on the covered path", (r) => (r.covers.anyPath = true), "`covers` must have exactly"],
  ])("refuses %s", (_label, edit, fragment) => {
    const root = scratchRoot();
    editRecord(root, edit);
    expectRefused(judge({ root }), fragment);
  });

  it("refuses two records for the same advisory", () => {
    const root = scratchRoot();
    const copy = JSON.parse(readFileSync(recordPath(root), "utf8"));
    copy.issue = 9999;
    writeFileSync(recordPath(root, "9999-braces-again.json"), JSON.stringify(copy));
    expectRefused(judge({ root }), "more than one mitigation record names GHSA-vfj7-8cjw-p6xm");
  });

  it("refuses a record that does not parse", () => {
    const root = scratchRoot();
    writeFileSync(recordPath(root), "{ not json");
    expectRefused(judge({ root }), "does not parse as JSON");
  });

  it.each(["notes.txt", "3843-braces.yaml", "draft.json"])(
    "refuses a stray %s in the directory",
    (name) => {
      const root = scratchRoot();
      writeFileSync(path.join(root, MITIGATIONS_DIR, name), "{}");
      expectRefused(judge({ root }), "not a record");
    },
  );

  it("keeps the README out of the record set", () => {
    const root = scratchRoot();
    writeFileSync(path.join(root, MITIGATIONS_DIR, "README.md"), "# not a record\n");
    expect(judge({ root }).outcome).toBe("mitigated");
  });
});
