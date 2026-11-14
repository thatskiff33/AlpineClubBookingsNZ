/**
 * The release-specific upgrade documents and the rules that keep them in step
 * with the release being cut (#4979).
 *
 * Two documents name a release: the upgrade guide (`docs/UPGRADING.md`), whose
 * `## Unreleased` block collects this release's operator steps until the
 * release is cut, and the production upgrade runbook
 * (`docs/PRODUCTION_UPGRADE_RUNBOOK.md`), whose opening paragraph says which
 * upgrade it covers. Both drifted once because nothing in the release process
 * re-scoped them, so the rules live here and two readers enforce them:
 *
 *   - `release:cut prepare` refuses a release while a rule is broken, and folds
 *     the guide's `## Unreleased` block into the release's own heading;
 *   - the census `src/lib/__tests__/upgrade-docs-scope.test.ts` fails a pull
 *     request that breaks one, and alone enforces the one rule that needs the
 *     migration ledger (`runbookWindowedProblems`).
 *
 * Pure text functions only: no file system, git or network access.
 */
import { compareReleaseParts, formatReleaseParts, parseReleaseTag } from "./release-version.mjs";

export const UPGRADING_PATH = "docs/UPGRADING.md";
export const RUNBOOK_PATH = "docs/PRODUCTION_UPGRADE_RUNBOOK.md";

/** The block that collects the next release's upgrade steps. */
export const UNRELEASED_HEADING = "## Unreleased";

/**
 * The guide's fixed, release-independent sections, in order. They are the only
 * `## ` headings allowed above `## Unreleased`: anything release-specific above
 * it would stay behind when the block is folded into its version heading.
 */
export const UPGRADING_GUIDE_HEADINGS = Object.freeze([
  "## Principles",
  "## How to read `docs/BLUE_GREEN_MIGRATION_SAFETY.tsv`",
  "## Generic upgrade procedure",
]);

/** The ordered before / during / after list that opens a release's block. */
export const UPGRADE_CHECKLIST_HEADING = "### Upgrade checklist for this release";

/**
 * The phrase that marks the runbook as covering any release-to-release jump.
 * Without it, the runbook's opening paragraph must name a release no older than
 * the current one.
 */
export const RUNBOOK_RELEASE_AGNOSTIC_MARKER = "This runbook is release-agnostic";

/** The runbook section that must name every windowed migration (its number may move). */
const RUNBOOK_WINDOWED_SECTION = /^### \d+\.\d+ Windowed migration deploy sequence$/;

const FENCE = /^\s*(```|~~~)/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const ISSUE_REFERENCE = /\(#\d+/;
const RELEASE_MENTION = /\bv\d+\.\d+\.\d+\b/g;

/**
 * Every Markdown heading outside fenced code, as `{ level, line, index }` where
 * `line` is the heading's own text (`## Principles`) and `index` its line number
 * from 0. Fences matter here: the guide's shell and SQL blocks hold `#` comments.
 */
export function markdownHeadings(text) {
  const headings = [];
  let fence = null;
  text.split("\n").forEach((raw, index) => {
    const fenceMatch = FENCE.exec(raw);
    if (fenceMatch) {
      if (fence === null) fence = fenceMatch[1];
      else if (fenceMatch[1] === fence) fence = null;
      return;
    }
    if (fence !== null) return;
    const match = HEADING.exec(raw);
    if (match) headings.push({ level: match[1].length, line: `${match[1]} ${match[2]}`, index });
  });
  return headings;
}

/** `## v<from> → v<to>`: the heading a release's upgrade steps sit under once it is cut. */
export function upgradingReleaseHeading(fromVersion, toVersion) {
  return `## v${fromVersion} → v${toVersion}`;
}

/**
 * The `## Unreleased` block: its heading's line number, the line number of the
 * next `## ` heading (or the end), and whether it holds any steps. A trailing
 * `---` separator alone is not a step. `null` unless there is exactly one block.
 */
export function unreleasedBlock(text) {
  const headings = markdownHeadings(text);
  const unreleased = headings.filter((heading) => heading.line === UNRELEASED_HEADING);
  if (unreleased.length !== 1) return null;
  const start = unreleased[0].index;
  const next = headings.find((heading) => heading.level <= 2 && heading.index > start);
  const lines = text.split("\n");
  const end = next ? next.index : lines.length;
  const body = lines
    .slice(start + 1, end)
    .filter((line) => line.trim() !== "" && line.trim() !== "---")
    .join("\n");
  const firstSubheading = headings.find((heading) => heading.index > start && heading.index < end);
  return {
    start,
    end,
    hasSteps: body !== "",
    opensWithChecklist: firstSubheading?.line === UPGRADE_CHECKLIST_HEADING,
  };
}

/**
 * What is wrong with the guide's layout, one sentence each; empty when sound.
 * There must be one `## Unreleased`; above it only `UPGRADING_GUIDE_HEADINGS`,
 * in order; and no heading above it may cite an issue (`(#1234)`), because a
 * release-specific step there is left out when the block is folded.
 */
export function upgradingLayoutProblems(text) {
  const headings = markdownHeadings(text);
  const unreleased = headings.filter((heading) => heading.line === UNRELEASED_HEADING);
  if (unreleased.length !== 1) {
    return [
      `${UPGRADING_PATH} must have exactly one "${UNRELEASED_HEADING}" heading; it has ${unreleased.length}.`,
    ];
  }
  const above = headings.filter((heading) => heading.index < unreleased[0].index && heading.level >= 2);
  const problems = [];
  const topLevel = above.filter((heading) => heading.level === 2).map((heading) => heading.line);
  if (JSON.stringify(topLevel) !== JSON.stringify(UPGRADING_GUIDE_HEADINGS)) {
    const unexpected = topLevel.filter((line) => !UPGRADING_GUIDE_HEADINGS.includes(line));
    const missing = UPGRADING_GUIDE_HEADINGS.filter((line) => !topLevel.includes(line));
    problems.push(
      `${UPGRADING_PATH}'s sections above "${UNRELEASED_HEADING}" must be exactly ` +
        `${UPGRADING_GUIDE_HEADINGS.map((line) => `"${line}"`).join(", ")}, in that order` +
        (unexpected.length > 0 ? `; unexpected: ${unexpected.map((line) => `"${line}"`).join(", ")}` : "") +
        (missing.length > 0 ? `; missing: ${missing.map((line) => `"${line}"`).join(", ")}` : "") +
        ". A release's own steps belong inside the block.",
    );
  }
  for (const heading of above) {
    if (ISSUE_REFERENCE.test(heading.line)) {
      problems.push(
        `${UPGRADING_PATH} has a release-specific section above "${UNRELEASED_HEADING}": "${heading.line}". ` +
          `Move it inside the block (as a "###" section) so it is folded with the release.`,
      );
    }
  }
  return problems;
}

/**
 * The release the runbook's opening paragraph (the text between its title and
 * its first `## ` section) says it covers: `{ agnostic: true }` when it carries
 * `RUNBOOK_RELEASE_AGNOSTIC_MARKER`, otherwise the newest `vX.Y.Z` it names, or
 * `{ agnostic: false, version: null }` when it names none.
 */
export function runbookScope(text) {
  const headings = markdownHeadings(text);
  const title = headings.find((heading) => heading.level === 1);
  const firstSection = headings.find((heading) => heading.level === 2 && heading.index > (title?.index ?? -1));
  const lines = text.split("\n");
  const opening = lines.slice(title ? title.index + 1 : 0, firstSection ? firstSection.index : lines.length).join(" ");
  // Line breaks inside the paragraph may split the marker phrase.
  if (opening.replace(/\s+/g, " ").includes(RUNBOOK_RELEASE_AGNOSTIC_MARKER)) return { agnostic: true };
  let newest = null;
  for (const mention of opening.match(RELEASE_MENTION) ?? []) {
    const parts = parseReleaseTag(mention);
    if (parts && (newest === null || compareReleaseParts(parts, newest) > 0)) newest = parts;
  }
  return { agnostic: false, version: newest === null ? null : formatReleaseParts(newest) };
}

/**
 * Why the runbook's scope is stale against `version` (`X.Y.Z`), or `null`: it
 * is release-agnostic, or names `version` or a newer release.
 */
export function runbookScopeProblem(text, version) {
  const scope = runbookScope(text);
  if (scope.agnostic) return null;
  if (scope.version === null) {
    return `${RUNBOOK_PATH}'s opening paragraph names no release and does not say "${RUNBOOK_RELEASE_AGNOSTIC_MARKER}".`;
  }
  const current = parseReleaseTag(`v${version}`);
  if (current === null) throw new Error(`Not a release version: ${version}`);
  if (compareReleaseParts(parseReleaseTag(`v${scope.version}`), current) < 0) {
    return (
      `${RUNBOOK_PATH}'s opening paragraph scopes it to v${scope.version}, older than v${version}. ` +
      `Re-scope it, or make it say "${RUNBOOK_RELEASE_AGNOSTIC_MARKER}".`
    );
  }
  return null;
}

/**
 * The migrations the ledger (`docs/BLUE_GREEN_MIGRATION_SAFETY.tsv`) declares
 * `windowed`, in file order. Column 4, `old_code_compatible`, says so; the
 * header and the explanatory `#` lines are not rows.
 */
export function windowedLedgerMigrations(ledgerText) {
  return ledgerText
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "" && !line.startsWith("#"))
    .map((line) => line.split("\t"))
    .filter((columns) => columns[3] === "windowed")
    .map((columns) => columns[0]);
}

/**
 * What the runbook's windowed-migration section (§2.4, with its sub-sections)
 * leaves out, one sentence each: it must name every migration the ledger
 * declares `windowed`, because an operator running a window works from that
 * section and from nowhere else.
 */
export function runbookWindowedProblems(ledgerText, runbookText) {
  const headings = markdownHeadings(runbookText);
  const section = headings.find((heading) => RUNBOOK_WINDOWED_SECTION.test(heading.line));
  if (section === undefined) {
    return [`${RUNBOOK_PATH} has no "### N.N Windowed migration deploy sequence" section.`];
  }
  const next = headings.find((heading) => heading.level <= section.level && heading.index > section.index);
  const lines = runbookText.split("\n");
  const body = lines.slice(section.index, next ? next.index : lines.length).join("\n");
  return windowedLedgerMigrations(ledgerText)
    .filter((migration) => !body.includes(migration))
    .map(
      (migration) =>
        `${RUNBOOK_PATH}'s "${section.line.replace(/^#+ /, "")}" section does not name the windowed migration ${migration}. ` +
        `Add its bullet there: an operator running the window works from that section.`,
    );
}

/**
 * Every problem with the two documents, one sentence each. `releaseVersion` is
 * the release (`X.Y.Z`) being cut, which the runbook must not predate: the one
 * threshold both `release:cut prepare` and the census use. `null` skips that
 * comparison. A missing document (`null` text) is not checked.
 */
export function upgradeDocsProblems({ upgradingText, runbookText, releaseVersion }) {
  const problems = upgradingText === null ? [] : upgradingLayoutProblems(upgradingText);
  if (runbookText !== null && releaseVersion !== null) {
    const stale = runbookScopeProblem(runbookText, releaseVersion);
    if (stale !== null) problems.push(stale);
  }
  return problems;
}

/**
 * The guide with its `## Unreleased` block renamed to the release's heading and
 * a fresh, empty `## Unreleased` above it, ready for the next release's steps.
 * The lines it adds end the way the heading they replace ends, so a CRLF
 * checkout is never left with mixed line endings. Throws when the layout is
 * broken or the release heading already exists.
 */
export function foldUpgradingUnreleased(text, { fromVersion, toVersion }) {
  const block = unreleasedBlock(text);
  if (block === null) throw new Error(`${UPGRADING_PATH} must have exactly one "${UNRELEASED_HEADING}" heading.`);
  const heading = upgradingReleaseHeading(fromVersion, toVersion);
  if (markdownHeadings(text).some((existing) => existing.line === heading)) {
    throw new Error(`${UPGRADING_PATH} already has "${heading}".`);
  }
  const lines = text.split("\n");
  const carriageReturn = lines[block.start].endsWith("\r") ? "\r" : "";
  const folded = [UNRELEASED_HEADING, "", "---", "", heading].map((line) => `${line}${carriageReturn}`);
  lines.splice(block.start, 1, ...folded);
  return lines.join("\n");
}
