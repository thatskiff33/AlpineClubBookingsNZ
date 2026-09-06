import fs from "node:fs";
import { pathToFileURL } from "node:url";

/**
 * Drops results that the scanner itself already suppressed from a SARIF file,
 * so GitHub code scanning does not file them as permanently-open alerts
 * (issue #2841, alerts 43 and 42).
 *
 * The problem, measured from the SARIF artifact of a green `main` run: our
 * Semgrep scan reports exactly two `acb-unsafe-raw-sql` results, and BOTH carry
 *
 *   "suppressions": [{ "kind": "inSource" }]
 *
 * because both call sites carry a justified `nosemgrep` comment. Semgrep honours
 * those comments — which is why the blocking `Static analysis gate` passes — but
 * GitHub's SARIF ingest does not act on the `suppressions` field, so it files
 * them as open alerts that can never be closed. Re-scanning re-opens them.
 *
 * SINCE #2842 A THIRD RESULT IS WITHHELD, and it is not a raw-SQL one, so say
 * it plainly: `react-dangerouslysetinnerhtml` at
 * `src/components/club-post-editor.tsx`. That is #2842's own headline
 * correction — the measurement proved the blocking gate DOES emit that rule,
 * where the earlier note had it down as cloud-only. It is suppressed for the
 * reason given at the call site (the seed is sanitised through the board
 * allowlist), so it is filtered here like the other two. A reader of this
 * docblock should not have to discover from a diff that a
 * `dangerouslySetInnerHTML` alert is being kept off the Security tab.
 *
 * Why that is worth a build step rather than two dismissals. `INV-OPS-014`'s own
 * failure message INSTRUCTS a contributor to add a `nosemgrep` comment when the
 * exemption is justified. So every justified exemption mints an un-closable
 * alert, and a genuinely dangerous new raw-SQL call would arrive in that list
 * looking identical to the known-safe ones. That is a false negative by
 * habituation — the same erosion that left the CodeQL backlog unread until #2841
 * was filed.
 *
 * WHAT THIS CANNOT WEAKEN. The blocking gate runs `semgrep scan --error` on the
 * UNFILTERED scan, before this script exists in the pipeline, and the raw SARIF
 * is still uploaded as a build artifact. This only changes what is published to
 * the Security tab. Removing a `nosemgrep` comment makes Semgrep report the
 * result unsuppressed again, and it reappears as an alert.
 */

/**
 * SARIF suppression `status` values that mean the suppression is NOT in force.
 *
 * SARIF 2.1.0 gives `suppression.status` three values: `accepted`,
 * `underReview` and `rejected`. A `rejected` suppression is a suppression
 * somebody turned down, so the result is live and must still be published; an
 * absent status defaults to `accepted`. Semgrep emits no `status` at all today,
 * so this branch is about not being wrong if that changes rather than about
 * current output.
 */
const INACTIVE_SUPPRESSION_STATUSES = new Set(["rejected"]);

/**
 * `suppressions[].kind` values this filter acts on. `inSource` means the
 * suppression is a comment in the scanned file — a `nosemgrep` line, which is
 * reviewable in the diff like any other code. `external` suppressions live in
 * some system outside the repository, so they are deliberately NOT honoured
 * here: nothing in a pull request would show one being added.
 */
const HONOURED_SUPPRESSION_KINDS = new Set(["inSource"]);

/** Whether one SARIF `suppressions[]` entry is in force. */
function isActiveSuppression(suppression) {
  if (!suppression || typeof suppression !== "object") return false;
  if (!HONOURED_SUPPRESSION_KINDS.has(suppression.kind)) return false;
  if (
    typeof suppression.status === "string" &&
    INACTIVE_SUPPRESSION_STATUSES.has(suppression.status)
  ) {
    return false;
  }
  return true;
}

/** Whether the scanner reported this result as suppressed in the source. */
export function isSuppressedInSource(result) {
  const suppressions = result?.suppressions;
  if (!Array.isArray(suppressions) || suppressions.length === 0) return false;
  return suppressions.some(isActiveSuppression);
}

/** A short, log-friendly description of where a dropped result came from. */
export function describeResult(result) {
  const rule = result?.ruleId ?? "<no ruleId>";
  const location = result?.locations?.[0]?.physicalLocation;
  const file = location?.artifactLocation?.uri;
  const line = location?.region?.startLine;
  if (!file) return rule;
  return line ? `${rule} at ${file}:${line}` : `${rule} at ${file}`;
}

/**
 * Returns a copy of the SARIF log with in-source-suppressed results removed,
 * plus the list of what was dropped. The input object is not mutated, and
 * everything other than the `results` arrays is passed through untouched — a
 * SARIF file with no runs, or a run with no results, comes back unchanged.
 */
export function filterSuppressedResults(sarif) {
  if (!sarif || typeof sarif !== "object" || !Array.isArray(sarif.runs)) {
    return { sarif, dropped: [] };
  }

  const dropped = [];
  const runs = sarif.runs.map((run) => {
    if (!run || typeof run !== "object" || !Array.isArray(run.results)) {
      return run;
    }
    const results = run.results.filter((result) => {
      if (!isSuppressedInSource(result)) return true;
      dropped.push(describeResult(result));
      return false;
    });
    return { ...run, results };
  });

  return { sarif: { ...sarif, runs }, dropped };
}

/**
 * Reads `inputPath`, writes the filtered log to `outputPath`, and returns what
 * was dropped. Throws when the file is missing or is not valid JSON — the caller
 * decides whether that is fatal.
 */
export function filterSarifFile(inputPath, outputPath) {
  const raw = fs.readFileSync(inputPath, "utf8");
  const { sarif, dropped } = filterSuppressedResults(JSON.parse(raw));
  fs.writeFileSync(outputPath, JSON.stringify(sarif), "utf8");
  return dropped;
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedPath === import.meta.url) {
  const [inputPath, outputPath] = process.argv.slice(2);

  if (!inputPath || !outputPath) {
    console.error(
      "Usage: node scripts/ci/filter-suppressed-sarif.mjs <input.sarif> <output.sarif>",
    );
    process.exitCode = 1;
  } else if (!fs.existsSync(inputPath)) {
    // Not this script's failure to report: the scan step that should have
    // produced the file has already failed the job. Say so and stop, leaving the
    // upload step to fail on the missing file exactly as it did before this
    // script existed.
    console.error(
      `No SARIF at ${inputPath} — nothing to filter. The scan step that writes it must have failed.`,
    );
  } else {
    try {
      const dropped = filterSarifFile(inputPath, outputPath);
      if (dropped.length === 0) {
        console.log(
          "SARIF suppression filter: no in-source-suppressed results to drop.",
        );
      } else {
        console.log(
          [
            `SARIF suppression filter: dropped ${dropped.length} result(s) the scanner had already suppressed in source (#2841):`,
            ...dropped.map((entry) => `  - ${entry}`),
            "These stay in the raw SARIF build artifact, and the blocking scan already ran unfiltered.",
          ].join("\n"),
        );
      }
    } catch (error) {
      console.error(`SARIF suppression filter failed: ${error.message}`);
      process.exitCode = 1;
    }
  }
}
