/**
 * The release's documents beside the changelog (issue #4983): the upgrade
 * guide's per-release section and the release-notes page with its index line.
 *
 * v0.13.2 was cut by hand in one commit that rolled the changelog, renamed the
 * upgrade guide's `## Unreleased` to `## v0.13.1 → v0.13.2`, wrote
 * `docs/releases/v0.13.2.md` and listed it in the release index. #4465
 * automated only the changelog half, so the release boundary was recorded in
 * one document and not the other. `release:cut prepare` now files the upgrade
 * guide and writes the notes stub through these helpers, and `release:cut
 * publish` refuses a commit where either is missing or unfinished.
 *
 * Everything here is pure except `planReleaseDocs`, which only reads files.
 * The `## Unreleased` sentinel and the section reader are the changelog
 * compiler's own (`INV-SSOT`); only the heading shape differs: the upgrade
 * guide names the step taken (`## v0.13.2 → v0.14.0`), not a date.
 */
import fs from "node:fs";
import path from "node:path";

import { githubHeadingAnchor, locateSection, stripBlankEdges, UNRELEASED_HEADING } from "./compile-changelog.mjs";

/** The upgrade guide clubs follow release by release. */
export const UPGRADE_GUIDE_PATH = "docs/UPGRADING.md";
/** One notes page per release, indexed by `RELEASE_NOTES_INDEX_PATH`. */
export const RELEASE_NOTES_DIR = "docs/releases";
export const RELEASE_NOTES_INDEX_PATH = `${RELEASE_NOTES_DIR}/README.md`;
/** The index section that lists published notes, newest first. */
export const PUBLISHED_NOTES_HEADING = "## Published release notes";

/**
 * The body a release's upgrade section gets when nothing was filed under
 * `## Unreleased`, so every tag has a section and a club can tell "no steps"
 * from "steps missing".
 */
export const NO_UPGRADE_STEPS = "No manual upgrade steps for this release: follow the generic upgrade procedure above.";

/**
 * The line a notes stub carries until someone writes the page. `publish`
 * refuses while it is present anywhere in the page.
 */
export const RELEASE_NOTES_UNFINISHED_MARKER = "<!-- release-notes:unfinished -->";

/** A horizontal rule; the upgrade guide closes each release section with one. */
const SECTION_RULE = /^---[ \t]*$/;
/** A release's upgrade section: `## v0.13.1 → v0.13.2`, or `## v0.1.0` for the first. */
const RELEASE_SECTION_HEADING = /^## v\d/;
/** A fenced code block's opening or closing line. */
const FENCE = /^\s*(```|~~~)/;

/** The upgrade-guide heading for the step from `previousTag` to `version`. */
export function upgradeGuideHeading(previousTag, version) {
  return previousTag ? `## ${previousTag} → v${version}` : `## v${version}`;
}

/** The repository-relative path of `version`'s notes page. */
export function releaseNotesPath(version) {
  return `${RELEASE_NOTES_DIR}/v${version}.md`;
}

const toLines = (text) => text.replace(/\r\n/g, "\n").split("\n");

/**
 * A section body split into its steps (blank edges trimmed) and whether it is
 * closed by the `---` rule that separates release sections.
 */
function splitBody(bodyLines) {
  const trimmed = stripBlankEdges(bodyLines);
  const ruled = trimmed.length > 0 && SECTION_RULE.test(trimmed[trimmed.length - 1]);
  return { steps: stripBlankEdges(ruled ? trimmed.slice(0, -1) : trimmed), ruled };
}

/** `heading`, its steps, then the closing rule when the guide uses one. */
function emitSection(heading, steps, ruled) {
  return [heading, "", ...(steps.length > 0 ? [...steps, ""] : []), ...(ruled ? ["---", ""] : [])];
}

const countSteps = (steps) => steps.filter((line) => line.startsWith("### ")).length;

/** Whether `steps` is only the `NO_UPGRADE_STEPS` line, however it was reflowed. */
const isNoStepsBody = (steps) => steps.join(" ").replace(/\s+/g, " ").trim() === NO_UPGRADE_STEPS;

/**
 * The section reader splits on every `## ` line, so one inside a code block
 * would be taken for a heading and steps filed into the middle of the block.
 */
function refuseFencedHeadings(lines) {
  let fenced = false;
  lines.forEach((line, index) => {
    if (FENCE.test(line)) fenced = !fenced;
    else if (fenced && line.startsWith("## ")) {
      throw new Error(
        `${UPGRADE_GUIDE_PATH}:${index + 1} has a "## " line inside a code block, which would be read as a section heading; indent or reword it.`,
      );
    }
  });
}

/**
 * The `### ` step titles in the guide's released sections: every `## v…`
 * section except `untaggedHeading`'s.
 */
export function releasedStepTitles(guide, untaggedHeading = null) {
  const titles = [];
  let released = false;
  for (const line of toLines(guide)) {
    if (line.startsWith("## ")) released = RELEASE_SECTION_HEADING.test(line) && line.trimEnd() !== untaggedHeading;
    else if (released && line.startsWith("### ")) titles.push(line.trimEnd());
  }
  return titles;
}

/**
 * Steps in `guide`'s released sections that the guide at the latest release
 * tag (`releasedGuide`) did not have. A pull request opened before a cut that
 * appends its step at the end of `## Unreleased` merges cleanly after the
 * roll, landing in the section just released: its code ships in the next
 * release, but a club upgrading to it would never see the step. Reworded
 * prose in a released section is not a new step and passes.
 */
export function stepsAddedToReleasedSections({ guide, releasedGuide, untaggedHeading }) {
  const before = new Set(releasedStepTitles(releasedGuide));
  return releasedStepTitles(guide, untaggedHeading).filter((title) => !before.has(title));
}

/**
 * The steps waiting under the upgrade guide's `## Unreleased` (blank edges
 * and its closing rule removed), or `null` when it has no such heading.
 */
export function unreleasedUpgradeSteps(guide) {
  const lines = toLines(guide);
  const found = locateSection(lines, (line) => UNRELEASED_HEADING.test(line));
  return found ? splitBody(lines.slice(found.start + 1, found.end)).steps : null;
}

/** Whether the upgrade guide has a section headed exactly `heading`. */
export function hasUpgradeSection(guide, heading) {
  return toLines(guide).some((line) => line.trimEnd() === heading);
}

/**
 * File the steps under `## Unreleased` as a release's section. Returns
 * `{ guide, action, steps }`, `action` being:
 *
 *   - `"roll"` when `heading` is new: `## Unreleased` is renamed to it and a
 *     fresh, empty `## Unreleased` opens above it (with `NO_UPGRADE_STEPS` as
 *     the body when nothing was waiting);
 *   - `"fold"` when `heading` already exists and `amend` is set: the waiting
 *     steps join the end of it (replacing a `NO_UPGRADE_STEPS` body);
 *   - `"none"` when there is nothing to fold.
 *
 * Only `## Unreleased` and the section directly below it are ever rewritten;
 * everything above `## Unreleased` and every older section is copied through
 * byte for byte, mirroring the changelog's `--append` guard.
 */
export function fileUpgradeSteps({ guide, heading, amend = false }) {
  const lines = toLines(guide);
  refuseFencedHeadings(lines);
  const unreleased = locateSection(lines, (line) => UNRELEASED_HEADING.test(line));
  const exists = hasUpgradeSection(guide, heading);
  if (exists && !amend) {
    throw new Error(`${UPGRADE_GUIDE_PATH} already has "${heading}"; a release's upgrade section is only rolled once.`);
  }
  if (!unreleased) {
    if (exists) return { guide, action: "none", steps: 0 };
    throw new Error(
      `${UPGRADE_GUIDE_PATH} has no "## Unreleased" heading to roll into "${heading}"; restore it above the newest release section and re-run.`,
    );
  }
  const head = lines.slice(0, unreleased.start);
  const waiting = splitBody(lines.slice(unreleased.start + 1, unreleased.end));
  const fresh = emitSection(lines[unreleased.start], [], waiting.ruled);

  if (!exists) {
    const tail = lines.slice(unreleased.end);
    const steps = waiting.steps.length > 0 ? waiting.steps : [NO_UPGRADE_STEPS];
    return {
      guide: [...head, ...fresh, ...emitSection(heading, steps, waiting.ruled), ...tail].join("\n"),
      action: "roll",
      steps: countSteps(waiting.steps),
    };
  }

  if (waiting.steps.length === 0) return { guide, action: "none", steps: 0 };
  // Only the section directly below `## Unreleased` can still be untagged.
  if (lines[unreleased.end]?.trimEnd() !== heading) {
    throw new Error(
      `"${heading}" is not the section directly below "## Unreleased" in ${UPGRADE_GUIDE_PATH}; ` +
        "late steps only join the newest, untagged release section.",
    );
  }
  const targetEnd = unreleased.end + locateSection(lines.slice(unreleased.end), () => true).end;
  const filed = splitBody(lines.slice(unreleased.end + 1, targetEnd));
  const kept = isNoStepsBody(filed.steps) ? [] : filed.steps;
  const merged = kept.length > 0 ? [...kept, "", ...waiting.steps] : waiting.steps;
  return {
    guide: [...head, ...fresh, ...emitSection(heading, merged, filed.ruled), ...lines.slice(targetEnd)].join("\n"),
    action: "fold",
    steps: countSteps(waiting.steps),
  };
}

/**
 * The stub `docs/releases/v<version>.md` starts as: the version, date and
 * release type, links to its changelog and upgrade-guide sections, and
 * `RELEASE_NOTES_UNFINISHED_MARKER` until someone writes the overview.
 */
export function releaseNotesStub({ version, previousTag, date, bump, changelogHeading, upgradeHeading }) {
  const after = previousTag ? `, the first release after \`${previousTag}\`` : "";
  const changelogTitle = changelogHeading.replace(/^##\s+/, "");
  const upgradeTitle = upgradeHeading.replace(/^##\s+/, "");
  return [
    `# Release v${version}`,
    "",
    RELEASE_NOTES_UNFINISHED_MARKER,
    "",
    "> **Unfinished stub written by `release:cut prepare`.** Replace the placeholder",
    "> below with this release's overview, then delete this note and the marker",
    "> comment above it. `release:cut publish` refuses while the marker is here.",
    "",
    "> Part of the [release notes index](README.md).",
    "",
    `Release target: \`v${version}\` on ${date}, a ${bump} release${after}.`,
    "",
    `- Every change: the [\`${changelogTitle}\`](../../CHANGELOG.md#${githubHeadingAnchor(changelogHeading)}) section of \`CHANGELOG.md\`.`,
    `- Upgrade steps: [\`${upgradeTitle}\`](../UPGRADING.md#${githubHeadingAnchor(upgradeHeading)}) in the upgrade guide.`,
    "  Follow them in order around the deploy.",
    "",
    "## What this release changes",
    "",
    "Placeholder: summarise what operators, treasurers and committees need to know,",
    "from the changelog section linked above.",
    "",
  ].join("\n");
}

/**
 * `index` (the release index) with `version`'s page added as the first line of
 * "Published release notes". Refuses an index without that section, or one
 * that already lists the page.
 */
export function addReleaseNotesIndexLine({ index, version, date, bump }) {
  const lines = toLines(index);
  const page = `v${version}.md`;
  if (lines.some((line) => line.includes(`](${page})`))) {
    throw new Error(`${RELEASE_NOTES_INDEX_PATH} already lists ${page}.`);
  }
  const found = locateSection(lines, (line) => line.trimEnd() === PUBLISHED_NOTES_HEADING);
  if (!found) {
    throw new Error(`${RELEASE_NOTES_INDEX_PATH} has no "${PUBLISHED_NOTES_HEADING}" section to list ${page} in.`);
  }
  const firstEntry = lines.slice(found.start + 1, found.end).findIndex((line) => line.startsWith("- "));
  const entry = `- [v${version}](${page}) — ${date} ${bump} public reference release.`;
  const at = firstEntry >= 0 ? found.start + 1 + firstEntry : found.start + 1;
  const insert = firstEntry >= 0 ? [entry] : ["", entry];
  return [...lines.slice(0, at), ...insert, ...lines.slice(at)].join("\n");
}

/**
 * Refuse steps added to a released section since the latest tag (see
 * `stepsAddedToReleasedSections`), naming them and the way out.
 */
export function refuseStepsInReleasedSections({ guide, releasedGuide, untaggedHeading, previousTag }) {
  const added = releasedGuide === null ? [] : stepsAddedToReleasedSections({ guide, releasedGuide, untaggedHeading });
  if (added.length > 0) {
    throw new Error(
      `${UPGRADE_GUIDE_PATH} has upgrade step(s) in a section already released, which ${previousTag} did not have ` +
        `(${added.slice(0, 3).join("; ")}${added.length > 3 ? "; …" : ""}). Their changes ship in the next release, ` +
        `so move them under "## Unreleased" with a pull request.`,
    );
  }
}

/**
 * Read the release documents in `repoRoot` and work out what the release-prep
 * commit changes in them. `releasedGuide` is the upgrade guide at
 * `previousTag` (`null` when there is none to compare). Returns
 * `{ upgradeHeading, upgrade, notesPath, notesCreated, files, describe }`:
 * `files` lists `{ relative, text, created }` to write (empty when nothing
 * changes), `describe` the plan as printable lines. Throws, writing nothing, on
 * any document it cannot file safely.
 */
export function planReleaseDocs({ repoRoot, version, previousTag, date, bump, changelogHeading, releasedGuide = null, amend = false }) {
  const read = (relative) => {
    const file = path.join(repoRoot, relative);
    if (!fs.existsSync(file)) throw new Error(`${relative} is missing; the release documents cannot be filed.`);
    return fs.readFileSync(file, "utf8");
  };
  const upgradeHeading = upgradeGuideHeading(previousTag, version);
  const guide = read(UPGRADE_GUIDE_PATH);
  refuseStepsInReleasedSections({ guide, releasedGuide, untaggedHeading: upgradeHeading, previousTag });
  const upgrade = fileUpgradeSteps({ guide, heading: upgradeHeading, amend });
  const files = [];
  const describe = [];
  if (upgrade.action === "roll") {
    files.push({ relative: UPGRADE_GUIDE_PATH, text: upgrade.guide, created: false });
    describe.push(
      upgrade.steps > 0
        ? `${UPGRADE_GUIDE_PATH}: rename "## Unreleased" to "${upgradeHeading}" (${upgrade.steps} step(s)), with a fresh empty "## Unreleased" above it`
        : `${UPGRADE_GUIDE_PATH}: add "${upgradeHeading}" saying there are no manual steps, below a fresh empty "## Unreleased"`,
    );
  } else if (upgrade.action === "fold") {
    files.push({ relative: UPGRADE_GUIDE_PATH, text: upgrade.guide, created: false });
    describe.push(`${UPGRADE_GUIDE_PATH}: move ${upgrade.steps} late step(s) from "## Unreleased" into "${upgradeHeading}"`);
  }

  const notesPath = releaseNotesPath(version);
  const notesExists = fs.existsSync(path.join(repoRoot, notesPath));
  if (notesExists && !amend) {
    throw new Error(`${notesPath} already exists; a release's notes page is only written once.`);
  }
  if (!notesExists) {
    const stub = releaseNotesStub({ version, previousTag, date, bump, changelogHeading, upgradeHeading });
    const index = addReleaseNotesIndexLine({ index: read(RELEASE_NOTES_INDEX_PATH), version, date, bump });
    files.push({ relative: notesPath, text: stub, created: true });
    files.push({ relative: RELEASE_NOTES_INDEX_PATH, text: index, created: false });
    describe.push(`${notesPath}: new notes stub, marked unfinished until it is written`);
    describe.push(`${RELEASE_NOTES_INDEX_PATH}: list v${version} first under "Published release notes"`);
  }
  return { upgradeHeading, upgrade, notesPath, notesCreated: !notesExists, files, describe };
}

/** Write `planReleaseDocs`'s files; a page it creates must not exist yet. */
export function writeReleaseDocs(repoRoot, files) {
  for (const { relative, text, created } of files) {
    fs.writeFileSync(path.join(repoRoot, relative), text, created ? { flag: "wx" } : undefined);
  }
}
