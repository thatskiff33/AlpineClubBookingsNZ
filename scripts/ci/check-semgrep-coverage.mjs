import fs from "node:fs";
import { pathToFileURL } from "node:url";

/**
 * Fails the build when Semgrep's real coverage shrinks (issue #2842).
 *
 * WHY THIS EXISTS. `semgrep scan --error` exits 0 on findings-free code even
 * when it could not parse some of that code. Parse failures are reported at
 * `warn` level in the `errors` array and nowhere in the exit status, so a file
 * Semgrep cannot read looks exactly like a file Semgrep read and cleared.
 * Measured on the epic base with the pinned CI image: 177 of 4,219 scanned
 * files carried a parse error behind a green gate, and three of those were
 * whole-file failures where no rule ran at all.
 *
 * THE TWO CLASSES ARE NOT THE SAME RISK, so this treats them differently.
 *
 *   Whole-file  the parser gave up on the file. Coverage is ZERO. Never
 *               allowlisted - a file nothing scans cannot be signed off as
 *               scanned, so this always fails.
 *   Partial     the parser skipped a region and read the rest. Coverage is
 *               reduced, not absent. These are allowlisted so the known set
 *               is visible and versioned.
 *
 * THE ALLOWLIST IS A RATCHET, AND IT ONLY TURNS ONE WAY. A partial failure in
 * a file that is not listed fails the build, so coverage cannot quietly
 * shrink. A listed file that now parses ALSO fails the build, so the list
 * cannot outlive its evidence - whoever fixes a file is made to delete its
 * entry in the same change. That second direction is the half that usually
 * gets left out, and without it the list rots into a permanent exemption
 * roster nobody rechecks.
 *
 * FAIL-CLOSED ON ANYTHING UNRECOGNISED. An `errors` entry this script cannot
 * classify is reported and fails the build rather than being ignored. A
 * scanner that starts reporting a new kind of failure must not be able to
 * reduce coverage silently just because this script predates the name.
 */

/** Semgrep `errors[].type` values that mean the whole file failed to parse. */
const WHOLE_FILE_PARSE_ERROR_TYPES = new Set([
  "Syntax error",
  "Lexical error",
  "Other syntax error",
]);

/**
 * `errors[].type` values that are not about parsing. A timeout is a real
 * problem, but it is the scan step's to fail on, not this gate's to classify
 * as unparsed source.
 */
const NON_PARSE_ERROR_TYPES = new Set([
  "Timeout",
  "Out of memory",
  "Timeout during interfile analysis",
  "OOM during interfile analysis",
]);

/**
 * Sorts the tagged type Semgrep puts in `errors[].type` into one of four
 * buckets. The field is a bare string for a whole-file failure and a tagged
 * array - `["PartialParsing", [span, ...]]` - for a recovered region.
 *
 * @param {unknown} type
 * @returns {"whole-file" | "partial" | "not-parse" | "unknown"}
 */
export function classifyErrorType(type) {
  if (Array.isArray(type)) {
    return type[0] === "PartialParsing" ? "partial" : "unknown";
  }
  if (typeof type !== "string") return "unknown";
  if (WHOLE_FILE_PARSE_ERROR_TYPES.has(type)) return "whole-file";
  if (NON_PARSE_ERROR_TYPES.has(type)) return "not-parse";
  return "unknown";
}

/**
 * Reduces a Semgrep JSON report to the coverage facts this gate decides on.
 *
 * @param {{ errors?: ReadonlyArray<Record<string, unknown>>, paths?: { scanned?: ReadonlyArray<string> } }} report
 */
export function summariseCoverage(report) {
  const wholeFile = new Set();
  const partial = new Set();
  /** @type {{ path: string, type: string }[]} */
  const unknown = [];

  for (const error of report.errors ?? []) {
    const path = typeof error.path === "string" ? error.path : "<unknown path>";
    switch (classifyErrorType(error.type)) {
      case "whole-file":
        wholeFile.add(path);
        break;
      case "partial":
        partial.add(path);
        break;
      case "not-parse":
        break;
      default:
        unknown.push({ path, type: JSON.stringify(error.type) });
    }
  }

  // A file can report both a whole-file failure and partial spans. Zero
  // coverage is the stronger fact, so it wins and the file is not also
  // reported as merely partial.
  for (const path of wholeFile) partial.delete(path);

  return {
    wholeFile: [...wholeFile].sort(),
    partial: [...partial].sort(),
    unknown,
    scannedCount: report.paths?.scanned?.length ?? 0,
  };
}

/**
 * @param {{ files?: unknown }} allowlist
 * @returns {string[]}
 */
export function readAllowlistFiles(allowlist) {
  if (!Array.isArray(allowlist?.files)) {
    throw new Error(
      "Allowlist is malformed: expected a `files` array of repository-relative paths.",
    );
  }
  for (const entry of allowlist.files) {
    if (typeof entry !== "string" || entry.length === 0) {
      throw new Error(
        `Allowlist is malformed: every \`files\` entry must be a non-empty string, found ${JSON.stringify(entry)}.`,
      );
    }
  }
  return [...allowlist.files];
}

/**
 * The two constructs measured behind every parse failure in this repository
 * (#2842). Both are valid TypeScript the build accepts; both have a
 * type-equivalent form Semgrep's parser reads.
 */
const KNOWN_CONSTRUCTS =
  'Rewrite the construct the parser rejects - the two known here are an `importOriginal<typeof import("...")>()` instantiation expression, which becomes `(await importOriginal()) as typeof import("...")`, and a bare `&` in JSX text, which becomes `&amp;`.';

/**
 * Decides the gate. Pure: takes the summarised report, the allowlisted paths
 * and a file-existence predicate, and returns the failures in reporting order.
 *
 * @param {ReturnType<typeof summariseCoverage>} coverage
 * @param {ReadonlyArray<string>} allowlisted
 * @param {(path: string) => boolean} fileExists
 */
export function findCoverageFailures(coverage, allowlisted, fileExists) {
  const allowed = new Set(allowlisted);
  const partial = new Set(coverage.partial);
  /** @type {{ kind: string, path: string, detail: string }[]} */
  const failures = [];

  for (const entry of coverage.unknown) {
    failures.push({
      kind: "unrecognised scan error",
      path: entry.path,
      detail: `Semgrep reported an error of type ${entry.type}, which this gate cannot classify. Fail-closed: teach scripts/ci/check-semgrep-coverage.mjs what it means before merging.`,
    });
  }

  for (const path of coverage.wholeFile) {
    failures.push({
      kind: "file scanned by nothing",
      path,
      detail: `Semgrep could not parse this file at all, so no rule ran on it. This can never be allowlisted. ${KNOWN_CONSTRUCTS}`,
    });
  }

  for (const path of coverage.partial) {
    if (allowed.has(path)) continue;
    failures.push({
      kind: "new unparsed region",
      path,
      detail: `Semgrep skipped a region of this file, so part of it went unscanned. ${KNOWN_CONSTRUCTS} If you genuinely cannot, add this path to .semgrep/unparsed-allowlist.json in the same change and say why in the pull request.`,
    });
  }

  for (const path of allowlisted) {
    if (partial.has(path)) continue;
    const detail = fileExists(path)
      ? "This file is on the unparsed allowlist but Semgrep parsed all of it in this run. The allowlist only shrinks: delete this entry."
      : "This file is on the unparsed allowlist but no longer exists. Delete this entry.";
    failures.push({ kind: "stale allowlist entry", path, detail });
  }

  return failures;
}

/**
 * @param {string} reportPath
 * @param {string} allowlistPath
 */
export function checkSemgrepCoverage(reportPath, allowlistPath) {
  const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  const allowlist = JSON.parse(fs.readFileSync(allowlistPath, "utf8"));
  const coverage = summariseCoverage(report);
  const allowlisted = readAllowlistFiles(allowlist);
  const failures = findCoverageFailures(coverage, allowlisted, (path) =>
    fs.existsSync(path),
  );
  return { coverage, allowlisted, failures };
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedPath === import.meta.url) {
  const [reportPath, allowlistPath = ".semgrep/unparsed-allowlist.json"] =
    process.argv.slice(2);

  if (!reportPath) {
    console.error(
      "Usage: node scripts/ci/check-semgrep-coverage.mjs <semgrep-report.json> [allowlist.json]",
    );
    process.exitCode = 1;
  } else if (!fs.existsSync(reportPath)) {
    // Fail-closed, unlike the SARIF filter next door: that one only decides
    // what gets published, whereas a missing report here means this gate has
    // no evidence at all, and a gate with no evidence must not report a pass.
    console.error(
      `Semgrep coverage gate: no scan report at ${reportPath}. The scan step that writes it must have failed; refusing to report coverage this gate cannot see.`,
    );
    process.exitCode = 1;
  } else {
    try {
      const { coverage, allowlisted, failures } = checkSemgrepCoverage(
        reportPath,
        allowlistPath,
      );

      console.log(
        [
          "Semgrep coverage gate (#2842):",
          `  files scanned                 ${coverage.scannedCount}`,
          `  scanned by nothing            ${coverage.wholeFile.length}`,
          `  partially unparsed            ${coverage.partial.length}`,
          `  allowlisted as unparsed       ${allowlisted.length}`,
        ].join("\n"),
      );

      if (failures.length === 0) {
        console.log(
          "  result                        OK - coverage did not shrink and the allowlist is current.",
        );
      } else {
        console.error(
          [
            "",
            `Semgrep coverage gate FAILED with ${failures.length} problem(s):`,
            ...failures.map(
              (failure) =>
                `\n  [${failure.kind}] ${failure.path}\n      ${failure.detail}`,
            ),
            "",
            'Background: docs/MAINTENANCE.md -> "Semgrep parse coverage".',
          ].join("\n"),
        );
        process.exitCode = 1;
      }
    } catch (error) {
      console.error(`Semgrep coverage gate failed to run: ${error.message}`);
      process.exitCode = 1;
    }
  }
}
