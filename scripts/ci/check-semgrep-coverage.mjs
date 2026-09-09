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
 * BE PRECISE ABOUT WHICH DIRECTION IS MECHANICAL. Deletion is forced by this
 * gate. Addition is not: the list is a versioned file, so an entry added in
 * the same commit passes, and what holds the line there is review. Saying the
 * list "only shrinks" would be a claim the code does not back - and it cannot
 * be made true by refusing additions outright, because every entry that
 * remains is the string-literal ampersand, which has no safe rewrite. The
 * honest guarantee is that it never grows SILENTLY.
 *
 * THE ALLOWLIST IS ALSO THE CANARY, and this is the property that makes the
 * gate hard to fool rather than merely strict. A report only passes if it names
 * EXACTLY those files as partially parsed and clears the scanned-file floor.
 * A broken, truncated or forged scan cannot satisfy both: too few files fails
 * the floor, and any report that does not reproduce the allowlist's exact file
 * set fails from one side or the other — a missing entry reads as stale, an extra
 * one as newly unparsed. #2842's security review attacked exactly this, forging
 * reports that clear the floor with no failures, and could not construct one.
 *
 * THE FLOOR ITSELF IS NOT RATCHETED, and that is a stated limit rather than a
 * guarantee. It sits at 4,000 against roughly 4,250 targets — about five per
 * cent of slack — so a change that excludes a directory AND lowers the floor in
 * the same commit passes everything here. Review holds that direction, exactly
 * as it holds an addition to the allowlist; the floor catches the accident, not
 * the intent.
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
 * WHAT IT DOES NOT SEE, and this is pre-existing (#2842) rather than something
 * #3318 or #3345 changed: it reads `errors` and `paths.scanned` only, and the
 * report's `paths` object carries no `skipped` key at all. A target above
 * Semgrep's default `--max-target-bytes` is therefore neither scanned nor an
 * error — it costs exactly 1 against `minimumScannedFiles`, which is a coarse
 * floor with roughly 290 files of slack (4,293 measured against a committed
 * 4,000). One oversized file drops out silently; a directory's worth does not.
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
 * @param {{ minimumScannedFiles?: unknown }} allowlist
 * @returns {number}
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

/**
 * The allowlisted paths, with every entry's REASON structurally required.
 *
 * #3318 changed the entry shape from a bare path string to
 * `{ file, reason }`. Until then the reasons lived in this file's `//` prose as
 * a composition summary - "165 carry a generic call, the remaining 4 are the
 * string-literal ampersand" - and both halves of that sentence were wrong by
 * the time anybody read it: the generic-call population has been rewritten away
 * entirely, and the ampersand count was FOUR in the prose and THREE in this
 * script, because one of the four was unparsed for the call shape and its own
 * `&` never tripped anything. A summary of a list is a second statement of the
 * list, and it drifted exactly as `INV-SSOT-001` says it will.
 *
 * So the reason now sits on the entry it explains and cannot be omitted. That
 * is the whole point: an entry signs part of a real file off as unscanned, and
 * the only legitimate ground for one is that there is genuinely no rewrite.
 * Everything that HAD a rewrite is gone, and the lint rule
 * `scan/no-semgrep-unparsable-import-type` is what stops it coming back.
 */
export function readAllowlistFiles(allowlist) {
  if (!Array.isArray(allowlist?.files)) {
    throw new Error(
      "Allowlist is malformed: expected a `files` array of `{ file, reason }` entries.",
    );
  }
  const paths = [];
  for (const entry of allowlist.files) {
    if (
      typeof entry !== "object" ||
      entry === null ||
      Array.isArray(entry) ||
      typeof entry.file !== "string" ||
      entry.file.length === 0
    ) {
      throw new Error(
        `Allowlist is malformed: every \`files\` entry must be an object with a non-empty \`file\`, found ${JSON.stringify(entry)}.`,
      );
    }
    if (typeof entry.reason !== "string" || entry.reason.trim().length === 0) {
      throw new Error(
        `Allowlist is malformed: \`${entry.file}\` carries no \`reason\`. Every entry signs part of a file off as unscanned, so it has to say why there is no rewrite - and after #3318 emptied this list of everything that had one, an entry without a reason is almost certainly a shape the lint rule should have caught instead.`,
      );
    }
    paths.push(normalisePath(entry.file));
  }
  return paths;
}

/**
 * What Semgrep's TypeScript parser actually chokes on here, stated as the RULE
 * rather than as a spelling. This text is what a contributor is HANDED when the
 * gate fires, so being wrong here sends them the wrong way - and it has now
 * been wrong three times, each time by describing the fault more narrowly than
 * it is:
 *
 *  - "the construct is `importOriginal<...>()`" missed the 22 files spelling it
 *    `vi.importActual` or a destructured `importActual`. Someone hitting the
 *    gate on the idiomatic spelling greps for `importOriginal`, finds none,
 *    decides the gate is confused, and takes the allowlist escape;
 *  - "it is the EMPTY argument list" (#2842's correction, measured on a
 *    single-line repro) missed the TRAILING COMMA, which breaks it just as
 *    reliably: it appeared at 12 call sites, and for 10 of the 169 entries it
 *    was the only cause - a formatter split a long argument list across lines
 *    and added the comma with the reflow. Nobody wrote that spelling
 *    deliberately, which is why a description keyed on the empty parens went on
 *    missing it;
 *  - and both of those described only a CALL. One allowlisted file carried no
 *    call shape at all: its fault was an `import()` type in a function
 *    PARAMETER annotation, and its entry read as unexplained for as long as the
 *    description named only the call (#3318).
 *
 * The `&amp;` remedy has been wrong once too, in the other direction: it is
 * correct in JSX TEXT only. The same fault fires on a `&` inside a STRING
 * literal, where rewriting it changes the value - one of the entries below is
 * asserted with `toHaveAttribute` - so those have no rewrite and are the only
 * legitimate entries left.
 *
 * AND THE FOURTH CORRECTION, #3345: "three shapes defeat the parser" was itself
 * too narrow, and so was the claim that two of them "cannot come back". #3318
 * had measured the parameter POSITION and generalised from it. Re-measured on
 * the same pinned image against minimal single-construct files, roughly a dozen
 * further positions fail - a type alias, an interface property, a return
 * annotation, a class property, a generic constraint or default, a nested type
 * argument, an `extends` or `implements` clause, `keyof`, a parenthesised
 * qualified type - and #3318's rule was silent on every one. Worse, the remedy
 * it printed ("give the type a name") produces `type P = import("x").A<null>`,
 * which is one of the failing forms: the guard was handing out an instruction
 * that opened the region it exists to protect. Two members of the CALL class
 * were silent too - a bare instantiation expression `f<typeof import("x")>`
 * with no call, and `f<typeof import("x")>?.()`, where the type arguments hang
 * off the callee.
 *
 * WHAT LINT NOW BANS, and what it does not. Since #3345,
 * `scan/no-semgrep-unparsable-import-type` reports the call class including
 * both instantiation shapes, every DECORATED `import()` type wherever it
 * appears, and an undecorated one in a parameter position; it autofixes the
 * call form. That removes the growth at source for those positions, and THIS
 * GATE REMAINS THE BACKSTOP FOR THE REST - a parse fault in a shape the rule
 * does not reach still lands here, which is the arrangement rather than a
 * failure of it. So a partial parse of a shape the rule DOES reach means the
 * rule was bypassed or the file is outside its globs, and that is what to fix;
 * a partial parse of anything else is a real finding, and the honest response
 * is to measure the construct and widen the rule.
 */
const KNOWN_CONSTRUCTS =
  'Three FAMILIES defeat the parser, all of them valid TypeScript the build accepts. Do not read the lists inside them as closed - #3318 stated them narrower than they are and #3345 re-measured; if your construct is not below, measure it before adding an entry. (1) A CALL whose type argument contains an `import()` type - `f<typeof import("...")>(...)`, for any `f`; the spellings measured here are `importOriginal`, `vi.importActual` and `importActual`. It fails with an EMPTY argument list (`>()` was unexpected), with a TRAILING COMMA, which is what a formatter adds on reflowing a long call (`,` was unexpected), with a SECOND type argument even given an argument, as a bare instantiation `f<typeof import("...")>` with no call, and as `f<typeof import("...")>?.()`. It parses with one type argument and a non-empty argument list, as `f?.<typeof import("...")>()`, as a tagged template, and under `new` in every argument-list variant. Move the type out of the call: `(await f()) as typeof import("...")`. (2) A DECORATED `import()` type - one carrying a type-argument list, an indexed access, a `keyof`, or a wrapping parenthesis - in almost any type position: a parameter, a return, a variable, a TYPE ALIAS, an interface property, a class property, a generic constraint or default, a nested type argument, an `extends` or `implements` clause. THE REMEDY IS A TOP-LEVEL TYPE-ONLY IMPORT, not an alias: `type P = import("x").A<null>;` also fails, which is what #3318 wrongly told people to write. Use `import type { A } from "x";` and then `A<null>["k"]`, or root the type at `typeof` - `typeof import("x").k` and `(typeof import("x"))["k"]` parse everywhere outside a call. The boundary inside this family is incoherent: `import("x").A<null>["k"]` parses in an alias while deleting the index makes it fail, and `keyof import("x")` fails while `keyof typeof import("x")` parses, which is why the lint rule reports the whole decoration rather than the failing spelling. Families (1) and (2) are banned by `scan/no-semgrep-unparsable-import-type`, so a partial parse of one means the rule was bypassed - but the rule bans the positions listed here and not a closed set, and this gate is the backstop for anything it does not reach. (3) A BARE `&` IN JSX TEXT - `<h1>Rooms & Beds</h1>` - which becomes `&amp;`. That remedy applies to JSX TEXT ONLY: the same parser fault fires on a `&` inside a string literal, such as a URL query, and rewriting it there would change the value, so those are the entries this allowlist legitimately holds.'


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
      detail: `Semgrep skipped a region of this file, so part of it went unscanned. ${KNOWN_CONSTRUCTS} Adding this path to .semgrep/unparsed-allowlist.json is the LAST resort, not the first: it signs part of this file off as unscanned. Do it only when there is genuinely no rewrite - the string-literal ampersand is the one known case - and say which case it is in the pull request, because the reviewer is what holds that direction of the list.`,
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
      ? "This file is on the unparsed allowlist but Semgrep parsed all of it in this run, so the entry has outlived its evidence: delete it."
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
