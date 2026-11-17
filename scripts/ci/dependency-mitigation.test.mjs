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
  workflowCommand,
} from "./dependency-mitigation.mjs";

/*
  #3843, #5252: the accept/reject matrix for MITIGATED. Every case starts from a
  SYNTHETIC fixture — a record covering two copies, a patch for each and
  stand-ins for pnpm-workspace.yaml and pnpm-lock.yaml under
  scripts/ci/fixtures/dependency-mitigation/, the record binding their digests —
  copied into a scratch root, and from the report `pnpm audit --json` really
  printed for #5252 (pnpm 11.27.1, 18 Nov 2026), trimmed to three of the 74
  paths of picomatch@4.0.7 and the one path of picomatch@2.3.2. Each reject case
  changes exactly one thing, so a passing reject proves THAT condition is
  load-bearing.

  Nothing here reads the live record, patch or lockfile for its digests: a
  dependency change is the audit gate's to refuse, not this suite's, and the
  suite must keep passing once the live record is retired.

  The clock is always passed in. No case reads the real date.
*/

const REPO = path.resolve(import.meta.dirname, "..", "..");
const FIXTURE = path.join(import.meta.dirname, "fixtures", "dependency-mitigation");
const RECORD_NAME = "5252-picomatch-ghsa-fc5q-39xc-vjpf.json";
const PATCH4 = "patches/picomatch@4.0.7.patch";
const PATCH2 = "patches/picomatch@2.3.2.patch";
const SENTRY = ".>@sentry/nextjs>@rollup/plugin-commonjs";
const ESLINT_PATH = ".>eslint-config-next>@next/eslint-plugin-next>fast-glob>micromatch>picomatch";
const BEFORE_EXPIRY = new Date("2026-10-05T00:00:00Z");
const EXPIRY = new Date("2026-10-10T00:00:00Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const TEMP_ROOTS = new Set();

afterEach(() => {
  for (const root of TEMP_ROOTS) rmSync(root, { force: true, recursive: true });
  TEMP_ROOTS.clear();
  vi.restoreAllMocks();
});

/** The measured report, verbatim in shape and values, its paths trimmed. */
function measuredReport() {
  return {
    advisories: {
      1247710: {
        findings: [
          {
            version: "4.0.7",
            paths: [
              `${SENTRY}>@rollup/pluginutils>picomatch`,
              `${SENTRY}>fdir>picomatch`,
              `${SENTRY}>picomatch`,
            ],
            dev: false,
            optional: false,
            bundled: false,
          },
          {
            version: "2.3.2",
            paths: [ESLINT_PATH],
            dev: true,
            optional: false,
            bundled: false,
          },
        ],
        id: 1247710,
        title: "picomatch vulnerable to ReDoS through single-branch repeated extglobs",
        module_name: "picomatch",
        vulnerable_versions: "<=4.0.7",
        patched_versions: null,
        severity: "high",
        cwe: "CWE-1333",
        github_advisory_id: "GHSA-fc5q-39xc-vjpf",
        url: "https://github.com/advisories/GHSA-fc5q-39xc-vjpf",
        patched_versions_unpublished: true,
      },
    },
    metadata: {
      vulnerabilities: { info: 0, low: 0, moderate: 0, high: 1, critical: 0 },
      dependencies: 514,
      devDependencies: 521,
      optionalDependencies: 277,
      totalDependencies: 1232,
    },
  };
}

const pretty = (value) => `${JSON.stringify(value, null, 2)}\n`;
const advisoryOf = (report) => report.advisories["1247710"];
const findingOf = (report, version) => advisoryOf(report).findings.find((f) => f.version === version);
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
    ["picomatch@4.0.7.patch", PATCH4],
    ["picomatch@2.3.2.patch", PATCH2],
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
    for (const copy of record.covers) {
      expect(copy.patch.sha256).toBe(sha256(readFileSync(path.join(FIXTURE, path.basename(copy.patch.path)))));
    }
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
      for (const copy of record.covers) {
        expect(sha256(readFileSync(path.join(REPO, copy.patch.path))), file).toBe(copy.patch.sha256);
      }
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
    expect(text).toContain("GHSA-fc5q-39xc-vjpf");
    expect(text).toContain('"github_advisory_id": "GHSA-fc5q-39xc-vjpf"');
    expect(text).toContain("SCOPE: SYNTHETIC FIXTURE");
    expect(text).toContain("cover the 2 copies the audit can see");
    expect(text).toContain("picomatch@4.0.7: 3 dependency paths, exactly as recorded.");
    expect(text).toContain("picomatch@2.3.2: 1 dependency path, exactly as recorded (dev).");
    expect(text).toContain(`Patch: ${PATCH4}, SHA256`);
    expect(text).toContain(`Patch: ${PATCH2}, SHA256`);
    expect(text.match(/NOT COVERED:/g)).toHaveLength(2);
    expect(text).toContain("Expires: 2026-10-10T00:00:00Z");
  });

  it("raises a warning annotation naming the advisory, and changes nothing else", () => {
    const report = formatMitigatedReport(judge());
    expect(report.annotations).toEqual([
      "::warning title=Dependency audit MITIGATED (NOT CLEAN)::GHSA-fc5q-39xc-vjpf picomatch@4.0.7, picomatch@2.3.2, expires 2026-10-10T00:00:00Z",
    ]);
    expect(report.lines.join("\n")).not.toContain("::warning");
    expect(report.exitCode).toBe(0);
  });

  it("escapes the annotation as the runner's parser requires", () => {
    expect(workflowCommand("warning", "a: b, c", "100% done\r\n::error::x")).toBe(
      "::warning title=a%3A b%2C c::100%25 done%0D%0A::error::x",
    );
  });

  it("adds further properties, comma-separated and escaped like the title", () => {
    expect(workflowCommand("warning", "T", "m", { file: "e2e/a,b:c\n.ts" })).toBe(
      "::warning title=T,file=e2e/a%2Cb%3Ac%0A.ts::m",
    );
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
        "::warning title=Dependency audit MITIGATED (NOT CLEAN)::GHSA-fc5q-39xc-vjpf picomatch@4.0.7, picomatch@2.3.2, expires 2026-10-10T00:00:00Z",
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

  // #3851: the retired state. The directory holds only its README, and
  // `patches/` only its .gitkeep: a clean audit is CLEAN with no mention of a
  // mitigation, and a vulnerability is still VULNERABILITY FOUND, unrefused.
  it("treats a directory holding only its README as no records: CLEAN passes, a high advisory still fails (#3851)", async () => {
    const root = scratchRoot();
    rmSync(recordPath(root));
    rmSync(path.join(root, PATCH4));
    rmSync(path.join(root, PATCH2));
    writeFileSync(path.join(root, MITIGATIONS_DIR, "README.md"), "# Dependency mitigation records\n");
    writeFileSync(path.join(root, "patches", ".gitkeep"), "");
    expect(loadMitigationRecords({ root })).toEqual({ records: [], problems: [] });

    const clean = pretty({
      ...measuredReport(),
      advisories: {},
      metadata: { ...measuredReport().metadata, vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0 } },
    });
    const out = [];
    vi.spyOn(console, "log").mockImplementation((line) => out.push(String(line)));
    vi.spyOn(console, "error").mockImplementation((line) => out.push(String(line)));
    const previous = process.exitCode;
    try {
      process.exitCode = undefined;
      await main({ run: () => Promise.resolve({ exitCode: 0, stdout: clean, stderr: "" }), sleep: () => Promise.resolve(), now: BEFORE_EXPIRY, root });
      expect(process.exitCode).toBe(0);
      expect(out[0]).toMatch(/^Dependency audit: CLEAN/);
      expect(out.join("\n")).not.toMatch(/MITIGATED|Mitigation record|::warning/);

      process.exitCode = undefined;
      out.length = 0;
      await main({ run: () => Promise.resolve({ exitCode: 1, stdout: pretty(measuredReport()), stderr: "" }), sleep: () => Promise.resolve(), now: BEFORE_EXPIRY, root });
      expect(process.exitCode).toBe(1);
      expect(out[0]).toContain("VULNERABILITY FOUND");
      expect(out.join("\n")).not.toMatch(/MITIGATED|Mitigation record NOT applied|::warning/);
    } finally {
      process.exitCode = previous;
    }
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

describe("each covered copy's patch must be the reviewed, registered patch", () => {
  const edit = (root, name, from, to) => {
    const file = path.join(root, name);
    const text = readFileSync(file, "utf8");
    expect(text).toContain(from);
    writeFileSync(file, text.replace(from, to));
  };

  it.each([PATCH4, PATCH2])("refuses a missing %s", (patch) => {
    const root = scratchRoot();
    rmSync(path.join(root, patch));
    expectRefused(judge({ root }), `${patch} is missing`);
  });

  it.each([PATCH4, PATCH2])("refuses an altered %s while the other copy's patch still matches", (patch) => {
    const root = scratchRoot();
    const file = path.join(root, patch);
    writeFileSync(file, `${readFileSync(file, "utf8")}\n`);
    const result = judge({ root });
    expectRefused(result, `the patch ${patch} is not the reviewed one`);
    expect(result.mitigationRefused.filter((r) => r.includes("is not the reviewed one"))).toHaveLength(1);
  });

  it.each(["4.0.7", "2.3.2"])("refuses when the workspace no longer registers picomatch@%s's patch", (version) => {
    const root = scratchRoot();
    edit(root, "pnpm-workspace.yaml", `  picomatch@${version}: patches/picomatch@${version}.patch\n`, "");
    expectRefused(judge({ root }), `pnpm-workspace.yaml does not register patches/picomatch@${version}.patch for picomatch@${version}`);
  });

  it("refuses a registration that points one copy at the other's patch", () => {
    const root = scratchRoot();
    edit(root, "pnpm-workspace.yaml", `picomatch@2.3.2: ${PATCH2}`, `picomatch@2.3.2: ${PATCH4}`);
    expectRefused(judge({ root }), "pnpm-workspace.yaml does not register patches/picomatch@2.3.2.patch for picomatch@2.3.2");
  });

  it.each(["4.0.7", "2.3.2"])("refuses a lockfile that records a different patch hash for picomatch@%s only", (version) => {
    const root = scratchRoot();
    const record = JSON.parse(readFileSync(path.join(FIXTURE, "record.json"), "utf8"));
    const digest = record.covers.find((c) => c.version === version).patch.sha256;
    edit(root, "pnpm-lock.yaml", `  picomatch@${version}: ${digest}`, `  picomatch@${version}: ${"0".repeat(64)}`);
    const result = judge({ root });
    expectRefused(result, `pnpm-lock.yaml does not record the reviewed patch hash for picomatch@${version}`);
    expect(result.mitigationRefused.filter((r) => r.includes("does not record the reviewed patch hash"))).toHaveLength(1);
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

describe("only the reviewed advisory, and exactly the covered copies and paths", () => {
  const variant = (edit) => {
    const report = measuredReport();
    edit(report);
    return judge({ report });
  };

  it("refuses a different GHSA", () => {
    expectRefused(variant((r) => (advisoryOf(r).github_advisory_id = "GHSA-c83g-rgw3-j3cx")), "no mitigation record names");
  });
  it("refuses a different package", () => {
    expectRefused(variant((r) => (advisoryOf(r).module_name = "micromatch")), "names micromatch, not picomatch");
  });
  it("refuses a different range", () => {
    expectRefused(variant((r) => (advisoryOf(r).vulnerable_versions = "<=4.0.8")), "range is <=4.0.8");
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
  it("refuses a different version for a covered copy", () => {
    expectRefused(variant((r) => (findingOf(r, "2.3.2").version = "2.3.1")), "affected version 2.3.1 is not a covered copy");
  });
  it("refuses an extra, unpatched version beside the covered ones", () => {
    expectRefused(
      variant((r) => advisoryOf(r).findings.push({ version: "3.0.1", paths: [".>chokidar>anymatch>picomatch"], dev: true, optional: false, bundled: false })),
      "affected version 3.0.1 is not a covered copy (the record covers 4.0.7, 2.3.2)",
    );
  });
  it.each(["4.0.7", "2.3.2"])("refuses a report missing the covered copy picomatch@%s", (version) => {
    expectRefused(
      variant((r) => (advisoryOf(r).findings = advisoryOf(r).findings.filter((f) => f.version !== version))),
      `the covered copy picomatch@${version} is not in the report`,
    );
  });
  it("refuses a different path, naming what was added and what removed", () => {
    expectRefused(
      variant((r) => (findingOf(r, "2.3.2").paths = [".>micromatch>picomatch"])),
      `picomatch@2.3.2: the affected paths are not exactly the 1 recorded (1 reported); added [".>micromatch>picomatch"], removed ["${ESLINT_PATH}"]`,
    );
  });
  it("refuses one path added to a covered copy", () => {
    expectRefused(
      variant((r) => findingOf(r, "4.0.7").paths.push(`${SENTRY}>tinyglobby>picomatch`)),
      `picomatch@4.0.7: the affected paths are not exactly the 3 recorded (4 reported); added ["${SENTRY}>tinyglobby>picomatch"], removed []`,
    );
  });
  it("refuses one path removed from a covered copy", () => {
    expectRefused(
      variant((r) => findingOf(r, "4.0.7").paths.splice(1, 1)),
      `picomatch@4.0.7: the affected paths are not exactly the 3 recorded (2 reported); added [], removed ["${SENTRY}>fdir>picomatch"]`,
    );
  });
  it("refuses a path listed twice, even though the set is unchanged", () => {
    expectRefused(
      variant((r) => findingOf(r, "4.0.7").paths.push(`${SENTRY}>picomatch`)),
      "picomatch@4.0.7: the report lists one dependency path more than once",
    );
  });
  it("accepts the recorded paths in any order", () => {
    const report = measuredReport();
    findingOf(report, "4.0.7").paths.reverse();
    expect(judge({ report }).outcome).toBe("mitigated");
  });
  it.each([
    ["4.0.7", "now dev-only", (f) => (f.dev = true)],
    ["2.3.2", "no longer dev-only", (f) => (f.dev = false)],
    ["4.0.7", "bundled", (f) => (f.bundled = true)],
    ["2.3.2", "bundled", (f) => (f.bundled = true)],
    ["4.0.7", "optional", (f) => (f.optional = true)],
    ["2.3.2", "optional", (f) => (f.optional = true)],
  ])("refuses picomatch@%s's finding when it is %s", (version, _label, edit) => {
    expectRefused(variant((r) => edit(findingOf(r, version))), `picomatch@${version}: the finding's dev/bundled/optional flags`);
  });
});

describe("duplicates, missing findings and extra advisories", () => {
  it("refuses a duplicate finding", () => {
    const report = measuredReport();
    advisoryOf(report).findings.push({ ...findingOf(report, "2.3.2") });
    expectRefused(judge({ report }), "the advisory reports picomatch@2.3.2 in more than one finding");
  });

  it("refuses an advisory with no findings", () => {
    const report = measuredReport();
    advisoryOf(report).findings = [];
    expectRefused(judge({ report }), "one or more findings, each of the reviewed shape");
  });

  it("refuses an extra advisory, even a moderate one", () => {
    const report = measuredReport();
    report.advisories["1000002"] = { ...advisoryOf(report), id: 1000002, module_name: "qs", severity: "moderate", github_advisory_id: "GHSA-6pq8-jhm2-2vcw" };
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
      `"advisories": {\n    "1247710": ${body},`,
    );
    expect(JSON.parse(stdout).advisories).toHaveProperty("1247710");
    expectRefused(judge({ stdout }), "exactly one advisory");
  });

  // #5252 security lens: JSON.parse keeps the last of two duplicate keys, so a
  // duplicated key could hide an unpatched finding. Real pnpm output never
  // repeats a key; these pin the defence in depth.
  const hidden = '{ "version": "3.0.1", "paths": [".>chokidar>anymatch>picomatch"], "dev": true, "optional": false, "bundled": false }';

  it("refuses a duplicated \"findings\" key that hides an unpatched copy", () => {
    const stdout = pretty(measuredReport()).replace('"findings": [', `"findings": [${hidden}],\n        "findings": [`);
    expect(advisoryOf(JSON.parse(stdout)).findings.map((f) => f.version)).toEqual(["4.0.7", "2.3.2"]);
    expectRefused(judge({ stdout }), 'the raw report carries the "findings" key 2 times, not once');
  });

  it("refuses a duplicated \"version\" key that hides an unpatched version", () => {
    const stdout = pretty(measuredReport()).replace('"version": "2.3.2"', '"version": "3.0.1", "version": "2.3.2"');
    expect(findingOf(JSON.parse(stdout), "2.3.2")).toBeDefined();
    expectRefused(judge({ stdout }), 'the raw report carries the "version" key 3 times for 2 findings');
  });

  it("counts keys only, so free text quoting \"findings\" or \"version\" changes nothing", () => {
    const report = measuredReport();
    // Inside a JSON string a quote is escaped, so only text ENDING in a quoted
    // word puts the raw substring `"version"` into the report (`\"version"`).
    advisoryOf(report).title = 'a title saying "findings": [] and ending "version';
    findingOf(report, "2.3.2").paths = [ESLINT_PATH];
    const stdout = pretty(report);
    expect(stdout.split('"version"').length - 1).toBe(3);
    expect(judge({ report, stdout }).outcome).toBe("mitigated");
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
    findingOf(report, "2.3.2").ignored = true;
    expectRefused(judge({ report }), "one or more findings, each of the reviewed shape");
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
    ["an impossible day that would roll forward", (r) => (r.expires = "2026-09-31T00:00:00Z"), "UTC instant"],
    ["a 24:00 hour that would roll forward", (r) => (r.expires = "2026-10-09T24:00:00Z"), "UTC instant"],
    ["a short commit", (r) => (r.upstream.commit = "f03bec2c"), "40-character"],
    ["a patch outside patches/", (r) => (r.covers[1].patch.path = "../picomatch.patch"), "`covers[1]`.patch.path must be a file directly under patches/"],
    ["an upper-case patch digest", (r) => (r.covers[0].patch.sha256 = r.covers[0].patch.sha256.toUpperCase()), "lowercase SHA256"],
    ["an upper-case input digest", (r) => (r.reviewedInputs["pnpm-lock.yaml"] = r.reviewedInputs["pnpm-lock.yaml"].toUpperCase()), "lowercase SHA256"],
    ["an issue number that disagrees with the file name", (r) => (r.issue = 1), "file name's issue number"],
    ["a missing scope list", (r) => delete r.knownUncoveredCopies, "expected exactly the keys"],
    ["a copy with no files", (r) => (r.knownUncoveredCopies[0].files = []), "knownUncoveredCopies"],
    ["an extra field on a covered copy", (r) => (r.covers[0].anyPath = true), "`covers[0]` must have exactly version, dev, patch, auditPaths"],
    ["an extra field on a covered copy's patch", (r) => (r.covers[1].patch.allowAny = true), "`covers[1]`.patch must have exactly path, sha256"],
    ["no covered copies", (r) => (r.covers = []), "`covers` must list one or more covered copies"],
    ["a version range instead of a version", (r) => (r.covers[0].version = "^4.0.7"), "`covers[0]`.version must be one exact version"],
    ["a dev flag that is not a boolean", (r) => (r.covers[1].dev = "true"), "`covers[1]`.dev must be a boolean"],
    ["no recorded paths", (r) => (r.covers[1].auditPaths = []), "`covers[1]`.auditPaths must list one or more dependency paths"],
    ["a path not written as pnpm prints it", (r) => (r.covers[1].auditPaths = ["eslint-config-next>picomatch"]), "each starting \".>\""],
    ["unsorted paths", (r) => r.covers[0].auditPaths.reverse(), "`covers[0]`.auditPaths must be sorted, with no duplicates"],
    ["a duplicated path", (r) => r.covers[1].auditPaths.push(r.covers[1].auditPaths[0]), "`covers[1]`.auditPaths must be sorted, with no duplicates"],
    ["a path that does not end at the package", (r) => (r.covers[1].auditPaths = [".>eslint-config-next>micromatch"]), "every dependency path of picomatch@2.3.2 must end at picomatch"],
    ["one version covered twice", (r) => (r.covers[1].version = "4.0.7"), "`covers` names a version more than once"],
    ["two copies sharing one patch", (r) => (r.covers[1].patch = { ...r.covers[0].patch }), "each covered copy needs its own patch file"],
  ])("refuses %s", (_label, edit, fragment) => {
    const root = scratchRoot();
    editRecord(root, edit);
    expectRefused(judge({ root }), fragment);
  });

  it("refuses two records for the same advisory", () => {
    const root = scratchRoot();
    const copy = JSON.parse(readFileSync(recordPath(root), "utf8"));
    copy.issue = 9999;
    writeFileSync(recordPath(root, "9999-picomatch-again.json"), JSON.stringify(copy));
    expectRefused(judge({ root }), "more than one mitigation record names GHSA-fc5q-39xc-vjpf");
  });

  it("refuses a record that does not parse", () => {
    const root = scratchRoot();
    writeFileSync(recordPath(root), "{ not json");
    expectRefused(judge({ root }), "does not parse as JSON");
  });

  it.each(["notes.txt", "5252-picomatch.yaml", "draft.json"])(
    "refuses a stray %s in the directory",
    (name) => {
      const root = scratchRoot();
      writeFileSync(path.join(root, MITIGATIONS_DIR, name), "{}");
      expectRefused(judge({ root }), "not a record");
    },
  );

  // #5252: one shape only. The retired single-copy shape (#3843) — `covers` an
  // object with one `auditPath`, beside a top-level `patch` — is refused, never
  // read as a one-element list.
  it("refuses a record in the retired single-copy shape", () => {
    const root = scratchRoot();
    editRecord(root, (r) => {
      const [copy] = r.covers;
      r.covers = { version: copy.version, auditPath: copy.auditPaths[0], dev: copy.dev };
      r.patch = copy.patch;
    });
    expectRefused(judge({ root }), "expected exactly the keys");
    editRecord(root, (r) => delete r.patch);
    expectRefused(judge({ root }), "the single-copy object shape is retired");
  });

  it("keeps the README out of the record set", () => {
    const root = scratchRoot();
    writeFileSync(path.join(root, MITIGATIONS_DIR, "README.md"), "# not a record\n");
    expect(judge({ root }).outcome).toBe("mitigated");
  });
});
