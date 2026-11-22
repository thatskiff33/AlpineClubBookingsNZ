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
 *     the guide's `## Unreleased` block into the release's own heading (on
 *     `--amend`, late steps into that heading: #4983);
 *   - `release:cut publish` refuses a commit whose guide does not record the
 *     release: no section for it, steps still waiting, or a step added to a
 *     section an earlier release shipped (#4983);
 *   - the census `src/lib/__tests__/upgrade-docs-scope.test.ts` fails a pull
 *     request that breaks one, and alone enforces the one rule that needs the
 *     migration ledger (`runbookWindowedProblems`).
 *
 * Pure text functions only: no file system, git or network access.
 */
import { githubHeadingAnchor } from "../lib/github-heading-anchor.mjs";
import {
  AFTER_DEPLOY_TITLE,
  DEPLOY_STEPS_INTRO,
  DEPLOY_STEPS_START,
  deployStepsBlock,
  findDeploySteps,
} from "../lib/deploy-fragments.mjs";
import { scannableLines } from "../lib/markdown-blocks.mjs";
import { UNRELEASED_TITLE } from "./compile-changelog.mjs";
import { compareReleaseParts, formatReleaseParts, parseReleaseTag } from "./release-version.mjs";

export const UPGRADING_PATH = "docs/UPGRADING.md";
export const RUNBOOK_PATH = "docs/PRODUCTION_UPGRADE_RUNBOOK.md";

/** The block that collects the next release's upgrade steps: the changelog's own sentinel. */
export const UNRELEASED_HEADING = UNRELEASED_TITLE;

/**
 * The link that points at the guide's pending steps. Folding them into a
 * release leaves it on the fresh, empty heading and `docs:linkcheck` still
 * resolves it, so `release:cut prepare` refuses while a document uses it (link
 * the step's own heading instead: its anchor does not move). #4983.
 */
export const UNRELEASED_LINK = `${UPGRADING_PATH.split("/").pop()}#${githubHeadingAnchor(UNRELEASED_HEADING)}`;

/**
 * The body a release's section gets when nothing was waiting under
 * `## Unreleased`, so every tag has a section and a club can tell "no steps"
 * from "steps missing" (#4983).
 */
export const NO_UPGRADE_STEPS = "No manual upgrade steps for this release: follow the generic upgrade procedure above.";

/** A released section's heading, `## v0.13.1 → v0.13.2` (or `## v0.1.0` for a first release). */
const RELEASED_SECTION = /^## v\d/;

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

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const ISSUE_REFERENCE = /\(#\d+/;
const RELEASE_MENTION = /\bv\d+\.\d+\.\d+\b/g;

/**
 * Every Markdown heading outside fenced code, as `{ level, line, index }` where
 * `line` is the heading's own text (`## Principles`) and `index` its line number
 * from 0. Fences matter here: the guide's shell and SQL blocks hold `#` comments.
 * Code blocks are found by the repository's one Markdown scanner, which also
 * handles a longer fence holding a shorter one and a fence of one kind holding
 * the other, where a simple toggle would close the block early (#4983).
 */
export function markdownHeadings(text) {
  const headings = [];
  for (const { number, text: raw } of scannableLines(text)) {
    const match = HEADING.exec(raw);
    if (match) headings.push({ level: match[1].length, line: `${match[1]} ${match[2]}`, index: number - 1 });
  }
  return headings;
}

/**
 * `## v<from> → v<to>`: the heading a release's upgrade steps sit under once it
 * is cut, or `## v<to>` for a first release with nothing before it.
 */
export function upgradingReleaseHeading(fromVersion, toVersion) {
  return fromVersion === null ? `## v${toVersion}` : `## v${fromVersion} → v${toVersion}`;
}

/** Whether the guide has a section headed exactly `heading`. */
export function hasUpgradingSection(text, heading) {
  return markdownHeadings(text).some((existing) => existing.line === heading);
}

/**
 * The `## Unreleased` block: its heading's line number, the line number of the
 * next `## ` heading (or the end), whether it holds any steps, and its `### `
 * step titles. A trailing `---` separator alone is not a step. `null` unless
 * there is exactly one block.
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
  const inside = headings.filter((heading) => heading.index > start && heading.index < end);
  return {
    start,
    end,
    hasSteps: body !== "",
    opensWithChecklist: inside[0]?.line === UPGRADE_CHECKLIST_HEADING,
    stepTitles: inside.filter((heading) => heading.level === 3).map((heading) => heading.line),
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

/** `lines` without blank edges or the `---` rule that closes a section. */
function sectionSteps(lines) {
  const isEdge = (line) => line.trim() === "" || line.trim() === "---";
  let start = 0;
  let end = lines.length;
  while (start < end && isEdge(lines[start])) start += 1;
  while (end > start && isEdge(lines[end - 1])) end -= 1;
  return lines.slice(start, end);
}

/** Whether `steps` is only the `NO_UPGRADE_STEPS` line, however it was reflowed. */
const isNoStepsBody = (steps) => steps.join(" ").replace(/\s+/g, " ").trim() === NO_UPGRADE_STEPS;

/**
 * The guide with its `## Unreleased` block filed under the release's heading,
 * and a fresh, empty `## Unreleased` above it, ready for the next release's
 * steps. `fromVersion` is `null` for a first release (`upgradingReleaseHeading`).
 *
 *   - When the heading is new, the block is renamed to it; an empty block gets
 *     `NO_UPGRADE_STEPS` as its body, so every tag has a section (#4983).
 *   - With `amend`, when the heading already exists, the waiting steps join the
 *     end of it (replacing a `NO_UPGRADE_STEPS` body): the late-steps fold of
 *     `release:cut prepare --amend` (#4983). Only the section directly below
 *     `## Unreleased` can still be untagged, so any other refuses. Nothing
 *     waiting returns the text unchanged.
 *
 * Only `## Unreleased` and the section directly below it are ever rewritten;
 * everything above the block and every older section is copied through byte
 * for byte, mirroring the changelog's `--append` guard. The lines it adds end
 * the way the heading they replace ends, so a CRLF checkout is never left with
 * mixed line endings. Throws when the layout is broken, or the release heading
 * already exists and `amend` is not set.
 */
export function foldUpgradingUnreleased(text, { fromVersion, toVersion, amend = false }) {
  const block = unreleasedBlock(text);
  if (block === null) throw new Error(`${UPGRADING_PATH} must have exactly one "${UNRELEASED_HEADING}" heading.`);
  const heading = upgradingReleaseHeading(fromVersion, toVersion);
  const headings = markdownHeadings(text);
  const existing = headings.find((candidate) => candidate.line === heading);
  if (existing !== undefined && !amend) throw new Error(`${UPGRADING_PATH} already has "${heading}".`);
  const lines = text.split("\n");
  const carriageReturn = lines[block.start].endsWith("\r") ? "\r" : "";
  const added = (structure) => structure.map((line) => `${line}${carriageReturn}`);
  const opening = added([UNRELEASED_HEADING, "", "---", "", heading]);

  if (existing === undefined) {
    if (block.hasSteps) lines.splice(block.start, 1, ...opening);
    else lines.splice(block.start, block.end - block.start, ...opening, ...added(["", NO_UPGRADE_STEPS, "", "---", ""]));
    return lines.join("\n");
  }
  if (!block.hasSteps) return text;
  if (existing.index !== block.end) {
    throw new Error(
      `"${heading}" is not the section directly below "${UNRELEASED_HEADING}" in ${UPGRADING_PATH}; ` +
        "late steps only join the newest, untagged release section.",
    );
  }
  const sectionEnd = headings.find((candidate) => candidate.level <= 2 && candidate.index > existing.index)?.index ?? lines.length;
  const waiting = sectionSteps(lines.slice(block.start + 1, block.end));
  const filed = sectionSteps(lines.slice(existing.index + 1, sectionEnd));
  const kept = isNoStepsBody(filed) ? [] : filed;
  const steps = kept.length > 0 ? [...kept, ...added([""]), ...waiting] : waiting;
  lines.splice(block.start, sectionEnd - block.start, ...opening, ...added([""]), ...steps, ...added(["", "---", ""]));
  return lines.join("\n");
}

/** The guide's released sections (`## v…`) as `{ heading, titles }`, each with its `### ` step titles. */
function releasedSections(text) {
  const sections = [];
  let current = null;
  for (const heading of markdownHeadings(text)) {
    if (heading.level <= 2) {
      current = heading.level === 2 && RELEASED_SECTION.test(heading.line) ? { heading: heading.line, titles: [] } : null;
      if (current) sections.push(current);
    } else if (current && heading.level === 3) {
      current.titles.push(heading.line);
    }
  }
  return sections;
}

/** `titles` less one occurrence of each of `known`: a multiset difference, so a repeated title still counts. */
function withoutEach(titles, known) {
  const remaining = [...known];
  return titles.filter((title) => {
    const at = remaining.indexOf(title);
    if (at < 0) return true;
    remaining.splice(at, 1);
    return false;
  });
}

/**
 * Steps in the guide's released sections that the guide at the latest release
 * tag (`releasedGuide`) did not have (#4983). A pull request opened before a
 * cut that appends its step at the end of `## Unreleased` merges cleanly after
 * the fold, landing in the section just released: its code ships in the next
 * release, but a club upgrading to it would never see the step.
 *
 * A section is late when it holds MORE `### ` steps than the tag's copy of it,
 * not when a title is new. Titles repeat across releases (`### Before
 * deployment`, `### Post-upgrade actions`), so a title test lets a late step
 * through under a name some other section uses; and retitling a released step
 * adds nothing, so it must not be refused. The steps named are the section's
 * titles the tag's copy lacked.
 *
 * Only sections the tag's guide already had are judged. A release section that
 * arrives whole between two tags (a fork merging an upstream tag, a backfill of
 * a missing release) carries steps the tag never saw, and they are not late.
 * `untaggedHeading`'s section is never judged: it is the release being cut.
 */
function stepsAddedToReleasedSections({ guide, releasedGuide, untaggedHeading }) {
  const tagTitles = new Map(releasedSections(releasedGuide).map((section) => [section.heading, section.titles]));
  return releasedSections(guide).flatMap((section) => {
    const before = tagTitles.get(section.heading);
    if (section.heading === untaggedHeading || before === undefined || section.titles.length <= before.length) return [];
    return withoutEach(section.titles, before);
  });
}

/**
 * Why the guide has steps in a section `previousTag` already released, naming
 * them and the way out, or `null` (see `stepsAddedToReleasedSections`).
 * `releasedGuide` `null` (no tag, or no guide at it) is never a problem.
 */
export function releasedSectionStepsProblem({ guide, releasedGuide, untaggedHeading, previousTag }) {
  const added = releasedGuide === null ? [] : stepsAddedToReleasedSections({ guide, releasedGuide, untaggedHeading });
  if (added.length === 0) return null;
  return (
    `${UPGRADING_PATH} has upgrade step(s) in a section already released, which ${previousTag} did not have ` +
    `(${added.slice(0, 3).join("; ")}${added.length > 3 ? "; …" : ""}). Their changes ship in the next release, ` +
    `so move them under "${UNRELEASED_HEADING}" with a pull request. A title you only reworded is not a new step and is not ` +
    `counted: if one is listed here, a real new step sits beside it in that section.`
  );
}

/** The `###` heading a release section's after-deploy steps sit under (#5379). */
export const UPGRADE_DEPLOY_STEPS_HEADING = `### ${AFTER_DEPLOY_TITLE}`;

/** `{ start, end }` line numbers of the `## ` section headed exactly `heading`, or `null`. */
function sectionBounds(text, heading) {
  const headings = markdownHeadings(text);
  const found = headings.find((candidate) => candidate.line === heading);
  if (found === undefined) return null;
  const next = headings.find((candidate) => candidate.level <= 2 && candidate.index > found.index);
  return { start: found.index, end: next ? next.index : text.split("\n").length };
}

/**
 * The guide without `heading`'s "After deploying this release" sub-section, and
 * the step items it held (#5379). `release:cut prepare --amend` takes them out
 * before folding late upgrade steps, so the fold sees the section's own steps,
 * and files them back, with any late ones, at the section's end. A guide with
 * no such section or sub-section comes back unchanged, with no items.
 */
export function takeUpgradeDeploySteps(text, heading) {
  const bounds = sectionBounds(text, heading);
  if (bounds === null) return { text, items: [] };
  const lines = text.split("\n");
  const sub = markdownHeadings(text).find(
    (candidate) => candidate.index > bounds.start && candidate.index < bounds.end && candidate.line === UPGRADE_DEPLOY_STEPS_HEADING,
  );
  if (sub === undefined) return { text, items: [] };
  const found = findDeploySteps(lines.slice(sub.index, bounds.end).join("\n"));
  if (found === null) {
    throw new Error(`"${UPGRADE_DEPLOY_STEPS_HEADING}" under "${heading}" in ${UPGRADING_PATH} has no "${DEPLOY_STEPS_START}" block.`);
  }
  let stop = sub.index + found.end + 1;
  while (stop < bounds.end && lines[stop].trim() === "" && sub.index > 0 && lines[sub.index - 1].trim() === "") stop += 1;
  lines.splice(sub.index, stop - sub.index);
  return { text: lines.join("\n"), items: found.items };
}

/**
 * The guide with `items` (rendered after-deploy steps) filed at the end of
 * `heading`'s section, under `UPGRADE_DEPLOY_STEPS_HEADING`, above the `---`
 * that closes it (#5379). Throws when the section is missing or already has
 * the sub-section (take it out first with `takeUpgradeDeploySteps`).
 */
export function fileUpgradeDeploySteps(text, heading, items) {
  const bounds = sectionBounds(text, heading);
  if (bounds === null) throw new Error(`${UPGRADING_PATH} has no "${heading}" section to file after-deploy steps under.`);
  const lines = text.split("\n");
  const inside = lines.slice(bounds.start, bounds.end).map((line) => line.trimEnd());
  if (inside.includes(UPGRADE_DEPLOY_STEPS_HEADING)) {
    throw new Error(`"${heading}" in ${UPGRADING_PATH} already has "${UPGRADE_DEPLOY_STEPS_HEADING}".`);
  }
  let at = bounds.end;
  while (at > bounds.start + 1 && ["", "---"].includes(lines[at - 1].trim())) at -= 1;
  const carriageReturn = lines[bounds.start].endsWith("\r") ? "\r" : "";
  const added = ["", UPGRADE_DEPLOY_STEPS_HEADING, "", DEPLOY_STEPS_INTRO, "", ...deployStepsBlock(items)].map(
    (line) => `${line}${carriageReturn}`,
  );
  lines.splice(at, 0, ...added);
  return lines.join("\n");
}
