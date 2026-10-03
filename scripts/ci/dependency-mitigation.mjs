import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * The one way a known, unfixed advisory may pass the dependency audit (#3843):
 * **MITIGATED**, which is never CLEAN.
 *
 * ## Why this exists
 *
 * `braces@3.0.3` carries a high-severity stack-exhaustion advisory
 * (GHSA-vfj7-8cjw-p6xm) with no published fix, and the required
 * `Dependency audit` check was red for every branch. The owner approved a
 * reviewed patch applied through pnpm's `patchedDependencies`, plus ONE
 * expiring, owner-approved record that lets the audit wrapper
 * (`audit-dependencies.mjs`) say MITIGATED instead of VULNERABILITY FOUND —
 * and only while every fact the approval was given on is still true.
 *
 * ## When a record is accepted
 *
 * The conditions are stated ONCE, with the reason for each, in
 * `dependency-mitigations.d/README.md` -> "When the wrapper says MITIGATED".
 * This module implements that list: `recordProblems` (a well-formed record),
 * `reportProblems` (the report is exactly the reviewed one), `inputProblems`
 * (the patch and the dependency inputs) and the expiry checks in
 * `applyMitigation`. Change the list there and the code here together.
 *
 * Anything this module cannot read is a reason to refuse, never a reason to
 * accept: there is exactly one return path that says `outcome: "mitigated"`.
 *
 * ## What it does not do
 *
 * It does not filter the report. The raw advisory is still printed, in full,
 * and the counts are still the counts. It does not change the threshold, read
 * an environment variable, or accept anything after the expiry. It covers ONLY
 * the copy `pnpm audit` can see: copies of the same package compiled into
 * other packages' bundles are neither patched nor audited, and the record's
 * `knownUncoveredCopies` lists them so the verdict says so on every run.
 *
 * Install-free, like the wrapper: Node built-ins only.
 */

/** Where the records live, relative to the repository root. */
export const MITIGATIONS_DIR = "dependency-mitigations.d";

/**
 * The furthest ahead of `now` a record's expiry may sit (#3843, third owner
 * decision). An approval is for days, not months: a record written with a
 * distant expiry is refused outright rather than trusted for longer, so
 * re-sealing a record cannot quietly buy a long-lived exception.
 */
export const MAX_EXPIRY_AHEAD_MS = 14 * 24 * 60 * 60 * 1000;

/** The dependency inputs whose exact bytes an acceptance is bound to. */
const REVIEWED_INPUTS = ["pnpm-workspace.yaml", "pnpm-lock.yaml"];

/*
  The report shapes, measured on pnpm 11.27.1 (`pnpm audit --json`). Exact key
  sets: a key pnpm adds later is a shape this gate has not reviewed, and it
  refuses rather than guesses.
*/
const REPORT_KEYS = ["advisories", "metadata"];
const METADATA_KEYS = [
  "vulnerabilities",
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "totalDependencies",
];
const SEVERITIES = ["info", "low", "moderate", "high", "critical"];
const ADVISORY_KEYS = [
  "findings",
  "id",
  "title",
  "module_name",
  "vulnerable_versions",
  "patched_versions",
  "severity",
  "cwe",
  "github_advisory_id",
  "url",
  "patched_versions_unpublished",
];
const FINDING_KEYS = ["version", "paths", "dev", "optional", "bundled"];

/** A record's exact top-level keys, and each nested object's. */
const RECORD_SHAPE = {
  issue: "integer",
  advisory: { ghsa: "string", url: "string", package: "string", range: "string", severity: "string" },
  covers: { version: "string", auditPath: "string", dev: "boolean" },
  upstream: { source: "string", commit: "string" },
  ownerDecisions: "url-list",
  expires: "string",
  patch: { path: "string", sha256: "string" },
  reviewedInputs: Object.fromEntries(REVIEWED_INPUTS.map((name) => [name, "string"])),
  scope: "string",
  knownUncoveredCopies: "copy-list",
};
const COPY_KEYS = ["copy", "files", "reachedThrough"];

const SHA256 = /^[0-9a-f]{64}$/;
const GHSA = /^GHSA(-[23456789cfghjmpqrvwx]{4}){3}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const DECISION_URL =
  /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(issues|pull)\/\d+#issuecomment-\d+$/;
const RECORD_FILE = /^(\d+)-[a-z0-9]+(?:-[a-z0-9]+)*\.json$/;
const PATCH_PATH = /^patches\/[\w.@+-]+\.patch$/;

const isPlainObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function sameKeys(value, keys) {
  if (!isPlainObject(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, i) => key === expected[i]);
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Problems with one record's shape and values; empty when it is well-formed. */
function recordProblems(record, fileName) {
  const problems = [];
  if (!sameKeys(record, Object.keys(RECORD_SHAPE))) {
    return [`${fileName}: expected exactly the keys ${Object.keys(RECORD_SHAPE).join(", ")}.`];
  }
  for (const [key, kind] of Object.entries(RECORD_SHAPE)) {
    const value = record[key];
    if (isPlainObject(kind)) {
      if (!sameKeys(value, Object.keys(kind))) {
        problems.push(`${fileName}: \`${key}\` must have exactly ${Object.keys(kind).join(", ")}.`);
        continue;
      }
      for (const [inner, innerKind] of Object.entries(kind)) {
        const got = value[inner];
        const ok = innerKind === "boolean" ? typeof got === "boolean" : typeof got === "string" && got.trim() !== "";
        if (!ok) problems.push(`${fileName}: \`${key}.${inner}\` must be a non-empty ${innerKind}.`);
      }
    } else if (kind === "integer") {
      if (!Number.isInteger(value) || value <= 0) problems.push(`${fileName}: \`${key}\` must be a positive integer.`);
    } else if (kind === "string") {
      if (typeof value !== "string" || value.trim() === "") problems.push(`${fileName}: \`${key}\` must be a non-empty string.`);
    } else if (kind === "url-list") {
      if (!Array.isArray(value) || value.length === 0 || !value.every((url) => typeof url === "string" && DECISION_URL.test(url))) {
        problems.push(`${fileName}: \`${key}\` must list at least one GitHub issue or pull-request comment URL recording the owner's decision.`);
      }
    } else if (kind === "copy-list") {
      const okCopy = (copy) =>
        sameKeys(copy, COPY_KEYS) &&
        typeof copy.copy === "string" && copy.copy !== "" &&
        Array.isArray(copy.files) && copy.files.length > 0 && copy.files.every((f) => typeof f === "string" && f !== "") &&
        typeof copy.reachedThrough === "string" && copy.reachedThrough !== "";
      if (!Array.isArray(value) || !value.every(okCopy)) {
        problems.push(`${fileName}: \`${key}\` must be a list of { ${COPY_KEYS.join(", ")} }.`);
      }
    }
  }
  if (problems.length > 0) return problems;

  const match = RECORD_FILE.exec(path.basename(fileName));
  if (!match || Number(match[1]) !== record.issue) problems.push(`${fileName}: the file name's issue number does not match \`issue\` (${record.issue}).`);
  if (!GHSA.test(record.advisory.ghsa)) problems.push(`${fileName}: \`advisory.ghsa\` is not a GHSA identifier.`);
  if (record.advisory.severity !== "high") problems.push(`${fileName}: only a high-severity advisory can be mitigated; a critical one never can.`);
  if (!COMMIT.test(record.upstream.commit)) problems.push(`${fileName}: \`upstream.commit\` must be a full 40-character commit hash.`);
  if (!PATCH_PATH.test(record.patch.path) || record.patch.path.includes("..")) problems.push(`${fileName}: \`patch.path\` must be a file directly under patches/.`);
  for (const digest of [record.patch.sha256, ...Object.values(record.reviewedInputs)]) {
    if (!SHA256.test(digest)) problems.push(`${fileName}: \`${digest}\` is not a lowercase SHA256 digest.`);
  }
  if (!INSTANT.test(record.expires) || Number.isNaN(Date.parse(record.expires))) {
    problems.push(`${fileName}: \`expires\` must be a UTC instant written YYYY-MM-DDTHH:MM:SSZ.`);
  }
  return problems;
}

/**
 * Reads every record in {@link MITIGATIONS_DIR}. A file that is not a record
 * (anything but README.md and `<issue>-<slug>.json`), or a record that does not
 * parse or validate, is a problem — and any problem refuses every mitigation,
 * because a directory this gate cannot fully read is not one it may act on.
 */
export function loadMitigationRecords({ root = process.cwd(), fsImpl = fs } = {}) {
  const dir = path.join(root, MITIGATIONS_DIR);
  let entries;
  try {
    entries = fsImpl.readdirSync(dir, { withFileTypes: true });
  } catch {
    return { records: [], problems: [] };
  }
  const records = [];
  const problems = [];
  for (const entry of entries) {
    if (entry.name === "README.md" && entry.isFile()) continue;
    if (!entry.isFile() || !RECORD_FILE.test(entry.name)) {
      problems.push(`${MITIGATIONS_DIR}/${entry.name}: not a record (expected README.md or <issue>-<slug>.json).`);
      continue;
    }
    let record;
    try {
      record = JSON.parse(fsImpl.readFileSync(path.join(dir, entry.name), "utf8"));
    } catch (error) {
      problems.push(`${MITIGATIONS_DIR}/${entry.name}: does not parse as JSON (${error.message}).`);
      continue;
    }
    const found = recordProblems(record, `${MITIGATIONS_DIR}/${entry.name}`);
    if (found.length > 0) problems.push(...found);
    else records.push({ file: `${MITIGATIONS_DIR}/${entry.name}`, record });
  }
  return { records, problems };
}

/** The block of a top-level YAML key, as its indented lines. */
function yamlBlock(text, key) {
  const lines = text.split("\n");
  const start = lines.indexOf(`${key}:`);
  if (start === -1) return [];
  const block = [];
  for (const line of lines.slice(start + 1)) {
    if (line !== "" && !/^\s/.test(line)) break;
    if (line.trim() !== "") block.push(line.trim());
  }
  return block;
}

/** Why the report is not exactly the reviewed one; empty when it is. */
function reportProblems({ report, stdout, exitCode, record }) {
  const problems = [];
  if (exitCode !== 1) {
    problems.push(`pnpm audit exited ${exitCode}, not 1; a report and an exit code that disagree are never mitigated.`);
  }
  if (!sameKeys(report, REPORT_KEYS) || !sameKeys(report.metadata, METADATA_KEYS) || !sameKeys(report.metadata.vulnerabilities, SEVERITIES) || !isPlainObject(report.advisories)) {
    return [...problems, "the audit report's shape is not the reviewed pnpm shape, so it is not read further."];
  }
  const counts = report.metadata.vulnerabilities;
  if (!SEVERITIES.every((s) => Number.isInteger(counts[s]) && counts[s] >= 0)) {
    return [...problems, "the severity counts are not all non-negative integers."];
  }
  const total = SEVERITIES.reduce((sum, s) => sum + counts[s], 0);
  if (counts.high !== 1 || counts.critical !== 0 || total !== 1) {
    problems.push(`the counts must be exactly one high and nothing else; they are ${SEVERITIES.map((s) => `${s} ${counts[s]}`).join(", ")}.`);
  }
  const scanned = report.metadata.totalDependencies;
  if (!(Number.isInteger(scanned) && scanned > 0)) problems.push("the report audited no packages.");
  const entries = Object.entries(report.advisories);
  // JSON.parse keeps the LAST of two duplicate keys, so a duplicated advisory
  // could vanish from the parsed object; the raw text cannot hide it.
  const rawMentions = String(stdout ?? "").split('"github_advisory_id"').length - 1;
  if (entries.length !== 1 || rawMentions !== 1) {
    return [...problems, `the report must carry exactly one advisory; it carries ${entries.length} (${rawMentions} in the raw output).`];
  }
  const [key, advisory] = entries[0];
  if (!sameKeys(advisory, ADVISORY_KEYS) || String(advisory.id) !== key) {
    return [...problems, "the advisory entry's shape is not the reviewed pnpm shape."];
  }
  const want = record.advisory;
  if (advisory.github_advisory_id !== want.ghsa) problems.push(`the advisory is ${advisory.github_advisory_id}, not ${want.ghsa}.`);
  if (advisory.module_name !== want.package) problems.push(`the advisory names ${advisory.module_name}, not ${want.package}.`);
  if (advisory.vulnerable_versions !== want.range) problems.push(`the advisory's range is ${advisory.vulnerable_versions}, not ${want.range}.`);
  if (advisory.severity !== want.severity) problems.push(`the advisory's severity is ${advisory.severity}, not ${want.severity}.`);
  const findings = advisory.findings;
  if (!Array.isArray(findings) || findings.length !== 1 || !sameKeys(findings[0], FINDING_KEYS)) {
    return [...problems, "the advisory must carry exactly one finding of the reviewed shape."];
  }
  const finding = findings[0];
  if (finding.version !== record.covers.version) problems.push(`the affected version is ${finding.version}, not ${record.covers.version}.`);
  if (!Array.isArray(finding.paths) || finding.paths.length !== 1 || finding.paths[0] !== record.covers.auditPath) {
    problems.push(`the affected paths are ${JSON.stringify(finding.paths)}, not exactly ["${record.covers.auditPath}"].`);
  }
  if (finding.dev !== record.covers.dev || finding.bundled !== false || finding.optional !== false) {
    problems.push("the finding's dev/bundled/optional flags are not the reviewed ones.");
  }
  return problems;
}

/** Why the patch and the dependency inputs are not the reviewed ones; empty when they are. */
function inputProblems({ record, root, fsImpl }) {
  const problems = [];
  const read = (rel) => {
    try {
      return fsImpl.readFileSync(path.join(root, rel));
    } catch {
      return undefined;
    }
  };
  const target = `${record.advisory.package}@${record.covers.version}`;
  const patch = read(record.patch.path);
  if (patch === undefined) problems.push(`the patch ${record.patch.path} is missing.`);
  else if (sha256(patch) !== record.patch.sha256) problems.push(`the patch ${record.patch.path} is not the reviewed one (SHA256 ${sha256(patch)}).`);

  const inputs = Object.fromEntries(REVIEWED_INPUTS.map((name) => [name, read(name)]));
  const workspace = inputs["pnpm-workspace.yaml"];
  const lock = inputs["pnpm-lock.yaml"];
  if (workspace === undefined || lock === undefined) {
    return [...problems, "pnpm-workspace.yaml or pnpm-lock.yaml is missing."];
  }
  if (!yamlBlock(workspace.toString("utf8"), "patchedDependencies").includes(`${target}: ${record.patch.path}`)) {
    problems.push(`pnpm-workspace.yaml does not register ${record.patch.path} for ${target}.`);
  }
  if (!yamlBlock(lock.toString("utf8"), "patchedDependencies").includes(`${target}: ${record.patch.sha256}`)) {
    problems.push(`pnpm-lock.yaml does not record the reviewed patch hash for ${target}.`);
  }
  for (const [name, bytes] of Object.entries(inputs)) {
    if (sha256(bytes) !== record.reviewedInputs[name]) {
      problems.push(`${name} has changed since the mitigation was reviewed (SHA256 ${sha256(bytes)}); a dependency change needs a fresh review.`);
    }
  }
  return problems;
}

/**
 * Turns a VULNERABILITY FOUND result into MITIGATED when, and only when, every
 * condition in the module docblock holds. Any other result is returned as it
 * came; a refused mitigation comes back still `vulnerable`, carrying
 * `mitigationRefused` (the reasons) for the report.
 *
 * `now` is required rather than defaulted, so no caller can forget the clock is
 * an input.
 */
export function applyMitigation(result, { now, root = process.cwd(), fsImpl = fs }) {
  if (result?.outcome !== "vulnerable") return result;
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError("applyMitigation needs the current instant as a valid Date.");
  }
  const { records, problems } = loadMitigationRecords({ root, fsImpl });
  if (records.length === 0 && problems.length === 0) return result;
  const refuse = (reasons) => ({ ...result, mitigationRefused: reasons });
  if (problems.length > 0) return refuse(problems);

  const report = result.report;
  const ghsas = isPlainObject(report?.advisories)
    ? Object.values(report.advisories).map((a) => a?.github_advisory_id)
    : [];
  const matching = records.filter(({ record }) => ghsas.includes(record.advisory.ghsa));
  if (matching.length === 0) return refuse(["no mitigation record names an advisory in this report."]);
  if (matching.length > 1) return refuse([`more than one mitigation record names ${matching[0].record.advisory.ghsa}: ${matching.map((m) => m.file).join(", ")}.`]);

  const { file, record } = matching[0];
  const reasons = [
    ...reportProblems({ report, stdout: result.stdout, exitCode: result.exitCode, record }),
    ...inputProblems({ record, root, fsImpl }),
  ];
  const expiresAt = Date.parse(record.expires);
  if (now.getTime() >= expiresAt) {
    reasons.push(`the approval expired at ${record.expires}; extending it needs a new reviewed change and the owner's approval.`);
  } else if (expiresAt - now.getTime() > MAX_EXPIRY_AHEAD_MS) {
    reasons.push(`the expiry ${record.expires} is more than 14 days away; a record may run for at most 14 days from now.`);
  }
  if (reasons.length > 0) return refuse(reasons.map((reason) => `${file}: ${reason}`));
  return { ...result, outcome: "mitigated", mitigation: { file, record } };
}

/**
 * One GitHub Actions workflow command. The message escapes `%`, CR and LF, and
 * a property additionally `:` and `,`, as the runner's parser requires.
 */
export function workflowCommand(command, title, message) {
  const data = (text) => text.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
  const property = (text) => data(text).replace(/:/g, "%3A").replace(/,/g, "%2C");
  return `::${command} title=${property(title)}::${data(message)}`;
}

/**
 * The MITIGATED report. Exits 0 — that is what the record buys — but its
 * first line says NOT CLEAN, the advisory is printed as pnpm reported it, and
 * the scope statement and the bundled copies the patch cannot reach are printed
 * on every run, so nobody reads this as "the advisory is gone".
 */
export function formatMitigatedReport(result) {
  const { file, record } = result.mitigation;
  const advisory = Object.values(result.report.advisories)[0];
  const counts = result.report.metadata.vulnerabilities;
  return {
    exitCode: 0,
    // A GitHub Actions warning annotation, so a MITIGATED pass shows on the
    // pull request itself and never reads as a plain green tick. The verdict
    // and exit code are unchanged by it.
    annotations: [
      workflowCommand(
        "warning",
        "Dependency audit MITIGATED (NOT CLEAN)",
        `${advisory.github_advisory_id} ${advisory.module_name}@${record.covers.version}, expires ${record.expires}`,
      ),
    ],
    lines: [
      "Dependency audit: MITIGATED — NOT CLEAN. One reviewed high-severity advisory is still " +
        "reported; an owner-approved patch covers the one copy the audit can see.",
      `  - ${advisory.module_name}@${record.covers.version} (${advisory.severity}) ` +
        `${advisory.vulnerable_versions} — ${advisory.github_advisory_id}: ${advisory.title}`,
      `    path: ${record.covers.auditPath}${record.covers.dev ? " (dev)" : ""}`,
      `  Counts: ${[...SEVERITIES].reverse().map((s) => `${s} ${counts[s]}`).join(", ")}.`,
      `  Record: ${file} (issue #${record.issue}).`,
      `  Patch: ${record.patch.path}, SHA256 ${record.patch.sha256} — matches, and is registered ` +
        "in pnpm-workspace.yaml and pnpm-lock.yaml.",
      "  Reviewed inputs: pnpm-workspace.yaml and pnpm-lock.yaml match their recorded SHA256.",
      `  Upstream fix applied: ${record.upstream.source} at ${record.upstream.commit}.`,
      ...record.ownerDecisions.map((url) => `  Owner decision: ${url}`),
      `  Expires: ${record.expires}. From then this check fails again until a fixed release ` +
        "or a newly approved record.",
      "",
      `  SCOPE: ${record.scope}`,
      ...record.knownUncoveredCopies.map(
        (copy) => `  - NOT COVERED: ${copy.copy} (${copy.files.join(", ")}) — ${copy.reachedThrough}`,
      ),
      "",
      "  Any further advisory, any change to the patch, pnpm-workspace.yaml or",
      "  pnpm-lock.yaml, or the expiry passing turns this check red again.",
      "",
      "  The unfiltered pnpm audit report:",
      ...String(result.stdout ?? "")
        .trimEnd()
        .split("\n")
        .map((line) => `    ${line}`),
    ],
  };
}
