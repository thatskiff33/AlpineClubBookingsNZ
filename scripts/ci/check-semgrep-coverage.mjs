import fs from "node:fs";
import { pathToFileURL } from "node:url";

/**
 * Fails the build when Semgrep's real coverage shrinks (issue #2842).
 *
 * WHY THIS EXISTS. `semgrep scan --error` exits 0 on findings-free code even
 * when it could not parse some of that code. Parse failures are reported at
 * `warn` level in the `errors` array and nowhere in the exit status, so a file
 * Semgrep cannot read looks exactly like a file Semgrep read and cleared.
 * The measurement that produced this gate, and the counts, live in
 * `docs/MAINTENANCE.md` -> "Semgrep parse coverage". They are not restated
 * here: they are a dated fact about one tree, and a copy of a number nothing
 * compares is a number that drifts.
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
 * `errors[].type` values that mean Semgrep GAVE UP running rules on a file it
 * could parse perfectly well.
 *
 * These were once treated as "not this gate's problem, the scan step fails on
 * them". **That premise was false and it cost a live finding.** Measured on
 * this tree with the exact blocking invocation plus `--timeout 1` to force the
 * condition: `semgrep scan --error` exits **0** with 11 `Timeout` errors across
 * 7 files. It does not fail. And Semgrep's default `--timeout-threshold 3`
 * abandons ALL REMAINING RULES on a file after three rule timeouts, so on a
 * loaded runner the security rules - `react-unsanitized-*`, `express-ssrf`,
 * `xss.direct-response-write` - stop running on exactly the biggest files,
 * with no error attributed to the finding they would have reported. A
 * `react-dangerouslysetinnerhtml` XSS finding vanished that way while the scan
 * exited 0 and this gate printed "coverage did not shrink".
 *
 * So they are a coverage hole, they are this gate's problem, and they FAIL it.
 */
const RULES_ABANDONED_ERROR_TYPES = new Set([
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
 * @returns {"whole-file" | "partial" | "abandoned" | "unknown"}
 */
export function classifyErrorType(type) {
  if (Array.isArray(type)) {
    return type[0] === "PartialParsing" ? "partial" : "unknown";
  }
  if (typeof type !== "string") return "unknown";
  if (WHOLE_FILE_PARSE_ERROR_TYPES.has(type)) return "whole-file";
  if (RULES_ABANDONED_ERROR_TYPES.has(type)) return "abandoned";
  return "unknown";
}

/**
 * Puts a path into the one spelling this gate compares in.
 *
 * Semgrep reports paths in the host's own separator, so the SAME file is
 * `src/lib/x.ts` from the Linux container CI runs and `src\\lib\\x.ts` from a
 * Semgrep installed on Windows. The allowlist is committed with forward
 * slashes. Without this, running the documented local command on Windows
 * reports every allowlisted file as BOTH newly-unparsed and stale - 338
 * failures over an allowlist of 169, which is how this was found.
 *
 * @param {string} path
 */
export function normalisePath(path) {
  return path.replace(/\\/g, "/");
}

/**
 * Reduces a Semgrep JSON report to the coverage facts this gate decides on.
 *
 * @param {{ errors?: ReadonlyArray<Record<string, unknown>>, paths?: { scanned?: ReadonlyArray<string> } }} report
 */
export function summariseCoverage(report) {
  const wholeFile = new Set();
  const partial = new Set();
  const abandoned = new Set();
  /** @type {{ path: string, type: string }[]} */
  const unknown = [];

  for (const error of report.errors ?? []) {
    const path =
      typeof error.path === "string"
        ? normalisePath(error.path)
        : "<unknown path>";
    switch (classifyErrorType(error.type)) {
      case "whole-file":
        wholeFile.add(path);
        break;
      case "partial":
        partial.add(path);
        break;
      case "abandoned":
        abandoned.add(path);
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
    abandoned: [...abandoned].sort(),
    unknown,
    scannedCount: report.paths?.scanned?.length ?? 0,
  };
}

/**
 * @param {{ files?: unknown }} allowlist
 * @returns {string[]}
 */
export function readMinimumScannedFiles(allowlist) {
  const floor = allowlist?.minimumScannedFiles;
  if (typeof floor !== "number" || !Number.isInteger(floor) || floor < 1) {
    throw new Error(
      "Allowlist is malformed: expected a positive integer `minimumScannedFiles`.",
    );
  }
  return floor;
}

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
  return allowlist.files.map(normalisePath);
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
export function findCoverageFailures(
  coverage,
  allowlisted,
  fileExists,
  minimumScannedFiles,
) {
  const allowed = new Set(allowlisted);
  const partial = new Set(coverage.partial);
  const abandoned = new Set(coverage.abandoned ?? []);
  /** @type {{ kind: string, path: string, detail: string }[]} */
  const failures = [];

  // F3: a scan that scanned nothing must never read as a pass. `scannedCount`
  // was computed and printed but never compared to anything, so `echo "{}" |`
  // this gate printed OK. The 169-entry allowlist masked it by accident, and
  // the entire point of a shrinking allowlist is that the mask goes away. The
  // floor also closes the other axis: a new `--exclude` or `.semgrepignore`
  // entry can drop hundreds of files from coverage with no error at all.
  if (typeof minimumScannedFiles === "number") {
    if (coverage.scannedCount === 0) {
      failures.push({
        kind: "scan covered nothing",
        path: "(whole scan)",
        detail:
          "The report lists zero scanned files. That is a broken scan, not clean code; refusing to report coverage on it.",
      });
    } else if (coverage.scannedCount < minimumScannedFiles) {
      failures.push({
        kind: "scan covered too little",
        path: "(whole scan)",
        detail: `Only ${coverage.scannedCount} files were scanned, below the committed floor of ${minimumScannedFiles}. Something removed files from the scan's scope - usually a new --exclude or .semgrepignore entry. If the drop is legitimate, lower \`minimumScannedFiles\` in .semgrep/unparsed-allowlist.json in the same change and say why.`,
      });
    }
  }

  // F1: rules abandoned on a file Semgrep could read. Measured: the scan step
  // exits 0 on these, so if this gate stays quiet nothing reports them.
  for (const path of coverage.abandoned ?? []) {
    failures.push({
      kind: "rules abandoned on a readable file",
      path,
      detail:
        "Semgrep timed out or ran out of memory running rules on this file, so an unknown subset of rules never ran on it - with no finding and no parse error to show for it. The scan step exits 0 on this, which is why the check lives here. Re-run to see whether it is load-dependent; if it is persistent, shrink or split the file, and if the runner is simply too slow raise the scan's --timeout.",
    });
  }

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
    // F2: a file whose rules were abandoned reports no PartialParsing, so it
    // LOOKS like it started parsing cleanly. It is not evidence of anything -
    // measured, the entries that flipped to stale on a loaded machine were
    // exactly the files that hit the timeout threshold. Reporting them as
    // stale makes a required check flap in both directions, and a check that
    // flaps gets re-run reflexively and then stops being read. The abandoned
    // failure above already reports the real problem.
    if (abandoned.has(path)) continue;
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
  const minimumScannedFiles = readMinimumScannedFiles(allowlist);
  const failures = findCoverageFailures(
    coverage,
    allowlisted,
    (path) => fs.existsSync(path),
    minimumScannedFiles,
  );
  return { coverage, allowlisted, minimumScannedFiles, failures };
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
      const { coverage, allowlisted, minimumScannedFiles, failures } =
        checkSemgrepCoverage(reportPath, allowlistPath);

      console.log(
        [
          "Semgrep coverage gate (#2842):",
          `  files scanned                 ${coverage.scannedCount} (floor ${minimumScannedFiles})`,
          `  scanned by nothing            ${coverage.wholeFile.length}`,
          `  rules abandoned (timeout/OOM) ${coverage.abandoned.length}`,
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
