import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * The one way a known, unfixed advisory may pass the dependency audit (#3843):
 * **MITIGATED**, which is never CLEAN.
 *
 * ## Why this exists
 *
 * `braces@3.0.3` carried a high-severity stack-exhaustion advisory
 * (GHSA-vfj7-8cjw-p6xm) with no published fix, and the required
 * `Dependency audit` check was red for every branch. The owner approved a
 * reviewed patch applied through pnpm's `patchedDependencies`, plus ONE
 * expiring, owner-approved record that let the audit wrapper
 * (`audit-dependencies.mjs`) say MITIGATED instead of VULNERABILITY FOUND —
 * and only while every fact the approval was given on was still true. GitHub
 * withdrew that advisory on 23 Oct 2026 and the record and patch were retired
 * (#3851). The mechanism stays for the next advisory that has no fix; with no
 * record, this module changes no verdict.
 *
 * #5252 (owner decision, 18 Nov 2026) widened ONE rule: a record may cover an
 * advisory reported against more than one installed copy, when every copy the
 * audit reports is an exact `package@version` the record lists with its own
 * patch, dev flag and exact set of dependency paths. Everything else (one
 * advisory and nothing else, exact versions, patch and input hashes, the
 * 14-day cap) is unchanged.
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
 * the copies `pnpm audit` can see: copies of the same package compiled into
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
  covers: "covered-copy-list",
  upstream: { source: "string", commit: "string" },
  ownerDecisions: "url-list",
  expires: "string",
  reviewedInputs: Object.fromEntries(REVIEWED_INPUTS.map((name) => [name, "string"])),
  scope: "string",
  knownUncoveredCopies: "copy-list",
};
const COPY_KEYS = ["copy", "files", "reachedThrough"];
/**
 * One covered copy (#5252): an exact installed version, its own patch, its dev
 * flag, and every dependency path the audit reports for it, sorted. The paths
 * are listed rather than hashed so a mismatch can name exactly which paths were
 * added and which removed.
 */
const COVERED_COPY_KEYS = ["version", "dev", "patch", "auditPaths"];
const PATCH_KEYS = ["path", "sha256"];

const SHA256 = /^[0-9a-f]{64}$/;
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
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

/**
 * Problems with the `covers` list's shape; empty when it is well-formed. The
 * single-copy object shape (`covers: { version, auditPath, dev }` beside a
 * top-level `patch`, #3843) is retired: there is one shape, and it is a list.
 */
function coveredCopyProblems(covers, fileName) {
  if (!Array.isArray(covers) || covers.length === 0) {
    return [`${fileName}: \`covers\` must list one or more covered copies, each { ${COVERED_COPY_KEYS.join(", ")} }; the single-copy object shape is retired (#5252).`];
  }
  const problems = [];
  covers.forEach((copy, i) => {
    const at = `${fileName}: \`covers[${i}]\``;
    if (!sameKeys(copy, COVERED_COPY_KEYS)) {
      problems.push(`${at} must have exactly ${COVERED_COPY_KEYS.join(", ")}.`);
      return;
    }
    if (typeof copy.version !== "string" || !EXACT_VERSION.test(copy.version)) problems.push(`${at}.version must be one exact version.`);
    if (typeof copy.dev !== "boolean") problems.push(`${at}.dev must be a boolean.`);
    if (!sameKeys(copy.patch, PATCH_KEYS) || typeof copy.patch.path !== "string" || typeof copy.patch.sha256 !== "string") {
      problems.push(`${at}.patch must have exactly ${PATCH_KEYS.join(", ")}.`);
    } else {
      if (!PATCH_PATH.test(copy.patch.path) || copy.patch.path.includes("..")) problems.push(`${at}.patch.path must be a file directly under patches/.`);
      if (!SHA256.test(copy.patch.sha256)) problems.push(`${at}.patch.sha256 \`${copy.patch.sha256}\` is not a lowercase SHA256 digest.`);
    }
    const paths = copy.auditPaths;
    if (!Array.isArray(paths) || paths.length === 0 || !paths.every((p) => typeof p === "string" && p.startsWith(".>"))) {
      problems.push(`${at}.auditPaths must list one or more dependency paths exactly as pnpm audit --json prints them, each starting ".>".`);
    } else if (!paths.every((p, j) => j === 0 || paths[j - 1] < p)) {
      problems.push(`${at}.auditPaths must be sorted, with no duplicates, so one tree has one record.`);
    }
  });
  if (problems.length > 0) return problems;
  const versions = covers.map((copy) => copy.version);
  if (new Set(versions).size !== versions.length) problems.push(`${fileName}: \`covers\` names a version more than once.`);
  const patches = covers.map((copy) => copy.patch.path);
  if (new Set(patches).size !== patches.length) problems.push(`${fileName}: each covered copy needs its own patch file; \`covers\` repeats one.`);
  return problems;
}

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
    } else if (kind === "covered-copy-list") {
      problems.push(...coveredCopyProblems(value, fileName));
    }
  }
  if (problems.length > 0) return problems;

  const match = RECORD_FILE.exec(path.basename(fileName));
  if (!match || Number(match[1]) !== record.issue) problems.push(`${fileName}: the file name's issue number does not match \`issue\` (${record.issue}).`);
  if (!GHSA.test(record.advisory.ghsa)) problems.push(`${fileName}: \`advisory.ghsa\` is not a GHSA identifier.`);
  if (record.advisory.severity !== "high") problems.push(`${fileName}: only a high-severity advisory can be mitigated; a critical one never can.`);
  if (!COMMIT.test(record.upstream.commit)) problems.push(`${fileName}: \`upstream.commit\` must be a full 40-character commit hash.`);
  for (const copy of record.covers) {
    if (!copy.auditPaths.every((p) => p.endsWith(`>${record.advisory.package}`))) {
      problems.push(`${fileName}: every dependency path of ${record.advisory.package}@${copy.version} must end at ${record.advisory.package}.`);
    }
  }
  for (const digest of Object.values(record.reviewedInputs)) {
    if (!SHA256.test(digest)) problems.push(`${fileName}: \`${digest}\` is not a lowercase SHA256 digest.`);
  }
  // Round-trip, so an impossible date ("2026-02-30", "T24:00:00Z") is refused
  // rather than silently rolled forward to a different instant than it prints.
  if (!INSTANT.test(record.expires) || Number.isNaN(Date.parse(record.expires)) || new Date(Date.parse(record.expires)).toISOString().replace(".000Z", "Z") !== record.expires) {
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

/**
 * How many times each name appears as an object KEY in the JSON report inside
 * `stdout`, counting every occurrence (JSON.parse keeps only the last of two
 * duplicate keys, so a duplicated `"findings"` or `"version"` could hide a
 * finding from the parsed object). Only strings in key position count, so a
 * title or path that happens to contain `"version"` changes nothing.
 *
 * The report is located as `extractJson` in the wrapper locates it (a line that
 * starts with `{`, else the first `{`, to the last `}`); that text parsed, so it
 * is valid JSON and this scan only needs to tell strings, escapes and keys
 * apart. Returns undefined when no such text parses.
 */
function jsonKeyCounts(stdout) {
  const text = String(stdout ?? "");
  const end = text.lastIndexOf("}");
  const starts = [];
  for (let i = text.indexOf("{"); i !== -1 && i < end; i = text.indexOf("{", i + 1)) {
    if (i === 0 || text[i - 1] === "\n") starts.push(i);
  }
  const first = text.indexOf("{");
  if (first !== -1 && !starts.includes(first)) starts.push(first);
  const json = starts
    .map((start) => text.slice(start, end + 1))
    .find((candidate) => {
      try {
        JSON.parse(candidate);
        return true;
      } catch {
        return false;
      }
    });
  if (json === undefined) return undefined;
  const counts = new Map();
  for (let i = 0; i < json.length; i++) {
    if (json[i] !== '"') continue;
    let j = i + 1;
    while (json[j] !== '"') j += json[j] === "\\" ? 2 : 1;
    const raw = json.slice(i, j + 1);
    let k = j + 1;
    while (/\s/.test(json[k] ?? "")) k++;
    if (json[k] === ":") {
      const key = JSON.parse(raw);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    i = j;
  }
  return counts;
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
  if (!Array.isArray(findings) || findings.length === 0 || !findings.every((finding) => sameKeys(finding, FINDING_KEYS))) {
    return [...problems, "the advisory must carry one or more findings, each of the reviewed shape."];
  }
  // #5252 (security lens): a duplicated key would let JSON.parse drop a whole
  // findings list or a finding's version, hiding a copy from the checks below.
  // Real pnpm output never repeats a key; this is defence in depth.
  const keys = jsonKeyCounts(stdout);
  if (keys === undefined) {
    return [...problems, "the raw report could not be re-read to count its keys, so it is not trusted."];
  }
  if ((keys.get("findings") ?? 0) !== 1) {
    problems.push(`the raw report carries the "findings" key ${keys.get("findings") ?? 0} times, not once; a duplicated key can hide findings.`);
  }
  if ((keys.get("version") ?? 0) !== findings.length) {
    problems.push(`the raw report carries the "version" key ${keys.get("version") ?? 0} times for ${findings.length} findings; a duplicated key can hide a version.`);
  }
  // #5252: the findings must be exactly the covered copies — one finding per
  // covered version, no version the record does not name, none it names missing.
  const covered = new Map(record.covers.map((copy) => [copy.version, copy]));
  const seen = new Set();
  for (const finding of findings) {
    const label = `${want.package}@${finding.version}`;
    if (seen.has(finding.version)) {
      problems.push(`the advisory reports ${label} in more than one finding.`);
      continue;
    }
    seen.add(finding.version);
    const copy = covered.get(finding.version);
    if (copy === undefined) {
      problems.push(`the affected version ${finding.version} is not a covered copy (the record covers ${[...covered.keys()].join(", ")}).`);
      continue;
    }
    problems.push(...pathProblems(label, finding.paths, copy.auditPaths));
    if (finding.dev !== copy.dev || finding.bundled !== false || finding.optional !== false) {
      problems.push(`${label}: the finding's dev/bundled/optional flags are not the reviewed ones.`);
    }
  }
  for (const version of covered.keys()) {
    if (!seen.has(version)) problems.push(`the covered copy ${want.package}@${version} is not in the report; a record lists exactly the copies the audit reports.`);
  }
  return problems;
}

/**
 * Why one finding's dependency paths are not exactly the recorded ones; empty
 * when they are. Names each path added and each removed, so a reviewer sees
 * what changed in the tree rather than only that something did.
 */
function pathProblems(label, reported, recorded) {
  if (!Array.isArray(reported) || !reported.every((p) => typeof p === "string")) {
    return [`${label}: the affected paths are not a list of strings.`];
  }
  const problems = [];
  const got = new Set(reported);
  if (got.size !== reported.length) problems.push(`${label}: the report lists one dependency path more than once.`);
  const want = new Set(recorded);
  const added = [...got].filter((p) => !want.has(p)).sort();
  const removed = recorded.filter((p) => !got.has(p));
  if (added.length > 0 || removed.length > 0) {
    problems.push(
      `${label}: the affected paths are not exactly the ${recorded.length} recorded (${reported.length} reported); ` +
        `added ${JSON.stringify(added)}, removed ${JSON.stringify(removed)}.`,
    );
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
  // Every covered copy carries its own patch, and each is checked on its own.
  for (const copy of record.covers) {
    const patch = read(copy.patch.path);
    if (patch === undefined) problems.push(`the patch ${copy.patch.path} is missing.`);
    else if (sha256(patch) !== copy.patch.sha256) problems.push(`the patch ${copy.patch.path} is not the reviewed one (SHA256 ${sha256(patch)}).`);
  }

  const inputs = Object.fromEntries(REVIEWED_INPUTS.map((name) => [name, read(name)]));
  const workspace = inputs["pnpm-workspace.yaml"];
  const lock = inputs["pnpm-lock.yaml"];
  if (workspace === undefined || lock === undefined) {
    return [...problems, "pnpm-workspace.yaml or pnpm-lock.yaml is missing."];
  }
  const registered = yamlBlock(workspace.toString("utf8"), "patchedDependencies");
  const locked = yamlBlock(lock.toString("utf8"), "patchedDependencies");
  for (const copy of record.covers) {
    const target = `${record.advisory.package}@${copy.version}`;
    if (!registered.includes(`${target}: ${copy.patch.path}`)) {
      problems.push(`pnpm-workspace.yaml does not register ${copy.patch.path} for ${target}.`);
    }
    if (!locked.includes(`${target}: ${copy.patch.sha256}`)) {
      problems.push(`pnpm-lock.yaml does not record the reviewed patch hash for ${target}.`);
    }
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
 * a property additionally `:` and `,`, as the runner's parser requires. `title`
 * is always set; `properties` adds others, such as `{ file }` to attach the
 * annotation to a path. Property names are code constants and are not escaped.
 * This is the one home of the escaping rule (INV-SSOT-001): a script that emits
 * an annotation calls it rather than copying the rule.
 */
export function workflowCommand(command, title, message, properties = {}) {
  const data = (text) => text.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
  const property = (text) => data(text).replace(/:/g, "%3A").replace(/,/g, "%2C");
  const list = Object.entries({ title, ...properties })
    .map(([name, value]) => `${name}=${property(value)}`)
    .join(",");
  return `::${command} ${list}::${data(message)}`;
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
  const copies = record.covers.map((copy) => `${advisory.module_name}@${copy.version}`);
  return {
    exitCode: 0,
    // A GitHub Actions warning annotation, so a MITIGATED pass shows on the
    // pull request itself and never reads as a plain green tick. The verdict
    // and exit code are unchanged by it.
    annotations: [
      workflowCommand(
        "warning",
        "Dependency audit MITIGATED (NOT CLEAN)",
        `${advisory.github_advisory_id} ${copies.join(", ")}, expires ${record.expires}`,
      ),
    ],
    lines: [
      "Dependency audit: MITIGATED — NOT CLEAN. One reviewed high-severity advisory is still " +
        `reported; owner-approved patches cover the ${copies.length === 1 ? "one copy" : `${copies.length} copies`} the audit can see.`,
      `  - ${advisory.module_name} (${advisory.severity}) ` +
        `${advisory.vulnerable_versions} — ${advisory.github_advisory_id}: ${advisory.title}`,
      ...record.covers.flatMap((copy) => [
        `    ${advisory.module_name}@${copy.version}: ${copy.auditPaths.length} dependency ` +
          `path${copy.auditPaths.length === 1 ? "" : "s"}, exactly as recorded${copy.dev ? " (dev)" : ""}.`,
        `      Patch: ${copy.patch.path}, SHA256 ${copy.patch.sha256} — matches, and is registered ` +
          "in pnpm-workspace.yaml and pnpm-lock.yaml.",
      ]),
      `  Counts: ${[...SEVERITIES].reverse().map((s) => `${s} ${counts[s]}`).join(", ")}.`,
      `  Record: ${file} (issue #${record.issue}).`,
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
