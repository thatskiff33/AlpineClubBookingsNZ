/**
 * A release's notes page and its index line (issue #4983).
 *
 * v0.13.2 was cut by hand in one commit that rolled the changelog and the
 * upgrade guide, wrote `docs/releases/v0.13.2.md` and listed it in the release
 * index. #4465 automated only the changelog half. `release:cut prepare` now
 * writes the notes stub and its index line through these helpers (the upgrade
 * guide is folded by `upgrade-docs.mjs`), and `release:cut publish` refuses a
 * commit whose page is missing or still the stub.
 *
 * Pure text functions only: no file system, git or network access.
 */
import {
  AFTER_DEPLOY_TITLE,
  appendDeploySteps,
  DEPLOY_STEPS_INTRO,
  deployStepsBlock,
  findDeploySteps,
} from "../lib/deploy-fragments.mjs";
import { githubHeadingAnchor } from "../lib/github-heading-anchor.mjs";
import { locateSection, toLines } from "./compile-changelog.mjs";

/** One notes page per release, indexed by `RELEASE_NOTES_INDEX_PATH`. */
export const RELEASE_NOTES_DIR = "docs/releases";
export const RELEASE_NOTES_INDEX_PATH = `${RELEASE_NOTES_DIR}/README.md`;
/** The index section that lists published notes, newest first. */
export const PUBLISHED_NOTES_HEADING = "## Published release notes";

/**
 * The line a notes stub carries until someone writes the page. `publish`
 * refuses while it is present anywhere in the page.
 */
export const RELEASE_NOTES_UNFINISHED_MARKER = "<!-- release-notes:unfinished -->";
/** The stub's visible note and placeholder; deleting only the marker must not publish them. */
const STUB_NOTE_LEAD = "> **Unfinished stub written by `release:cut prepare`.**";
const STUB_PLACEHOLDER_LEAD = "Placeholder: summarise";
const STUB_PARTS = [
  { text: RELEASE_NOTES_UNFINISHED_MARKER, label: "the unfinished marker" },
  { text: STUB_NOTE_LEAD, label: "the \"Unfinished stub\" note" },
  { text: STUB_PLACEHOLDER_LEAD, label: "the placeholder paragraph" },
];

/** The repository-relative path of `version`'s notes page. */
export function releaseNotesPath(version) {
  return `${RELEASE_NOTES_DIR}/v${version}.md`;
}

/** The notes page's section for the release's after-deploy steps (#5379). */
export const NOTES_DEPLOY_STEPS_HEADING = `## ${AFTER_DEPLOY_TITLE}`;

/** The notes page's after-deploy section for `items` (rendered steps), as lines. */
function notesDeploySection(items) {
  return [NOTES_DEPLOY_STEPS_HEADING, "", DEPLOY_STEPS_INTRO, "", ...deployStepsBlock(items), ""];
}

/**
 * The stub `docs/releases/v<version>.md` starts as: the version, date and
 * release type, links to its changelog and upgrade-guide sections, and
 * `RELEASE_NOTES_UNFINISHED_MARKER` until someone writes the overview. With
 * `deployItems` (rendered after-deploy steps, #5379) it ends with
 * `NOTES_DEPLOY_STEPS_HEADING`, which `release:cut publish` reads.
 */
export function releaseNotesStub({ version, previousTag, date, bump, changelogHeading, upgradeHeading, deployItems = [] }) {
  const after = previousTag ? `, the first release after \`${previousTag}\`` : "";
  const changelogTitle = changelogHeading.replace(/^##\s+/, "");
  const upgradeTitle = upgradeHeading.replace(/^##\s+/, "");
  return [
    `# Release v${version}`,
    "",
    RELEASE_NOTES_UNFINISHED_MARKER,
    "",
    `${STUB_NOTE_LEAD} Replace the placeholder`,
    "> below with this release's overview, then delete this note and the marker",
    "> comment above it. `release:cut publish` refuses while any of them is here.",
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
    `${STUB_PLACEHOLDER_LEAD} what operators, treasurers and committees need to know,`,
    "from the changelog section linked above.",
    "",
    ...(deployItems.length > 0 ? notesDeploySection(deployItems) : []),
  ].join("\n");
}

/**
 * `notes` (a written or stub notes page) with `items` added to its
 * after-deploy steps: inside its block when it has one, otherwise as a new
 * `NOTES_DEPLOY_STEPS_HEADING` section at the end (#5379, `prepare --amend`).
 */
export function fileNotesDeploySteps(notes, items) {
  if (findDeploySteps(notes) !== null) return appendDeploySteps(notes, items);
  return `${notes.replace(/\s*$/, "")}\n\n${notesDeploySection(items).join("\n")}`;
}

/**
 * What of the stub's own text `notes` still carries, as labels: the marker, the
 * "Unfinished stub" note and the placeholder paragraph. Empty once someone has
 * written the page, so deleting the marker alone does not pass `publish`.
 */
export function unfinishedStubParts(notes) {
  return STUB_PARTS.filter((part) => notes.includes(part.text)).map((part) => part.label);
}

/** Whether `index` (the release index) already links `version`'s page. */
export function releaseNotesIndexLists(index, version) {
  return toLines(index).some((line) => line.includes(`](v${version}.md)`));
}

/**
 * `index` (the release index) with `version`'s page added as the first line of
 * "Published release notes". Refuses an index without that section, or one
 * that already lists the page.
 */
export function addReleaseNotesIndexLine({ index, version, date, bump }) {
  const lines = toLines(index);
  const page = `v${version}.md`;
  if (releaseNotesIndexLists(index, version)) {
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
