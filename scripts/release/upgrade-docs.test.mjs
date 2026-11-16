import { spawnSync } from "node:child_process";
import path from "node:path";

import { UNRELEASED_LINK_SEARCH } from "./cut-release.mjs";
import {
  foldUpgradingUnreleased,
  hasUpgradingSection,
  markdownHeadings,
  NO_UPGRADE_STEPS,
  releasedSectionStepsProblem,
  UNRELEASED_LINK,
  unreleasedBlock,
  upgradingReleaseHeading,
} from "./upgrade-docs.mjs";

// The #4983 behaviour of upgrade-docs.mjs (#4979): the fold for a full, empty
// and missing "## Unreleased", the --amend fold of late steps, the guard on
// released sections and the link census. The layout and runbook rules are the
// census's (src/lib/__tests__/upgrade-docs-scope.test.ts).

// Upgrade-guide fixtures shaped like docs/UPGRADING.md: introductory text, a
// generic procedure closed by a rule, `## Unreleased`, then released sections.

const INTRO = [
  "# Upgrading",
  "",
  "Introductory text that the roll must leave alone.",
  "",
  "## Generic upgrade procedure",
  "",
  "1. Back up.",
  "",
  "---",
  "",
].join("\n");

const RELEASED = [
  "## v0.13.1 → v0.13.2",
  "",
  "### An older step (#1000)",
  "",
  "Already shipped; never rewritten.",
  "",
  "---",
  "",
  "## v0.13.0 → v0.13.1",
  "",
  "### An even older step (#900)",
  "",
].join("\n");

const STEP_A = ["### Reconnect Xero once (#4600)", "", "Open Admin → Xero and reconnect."];
const STEP_B = ["### Run the pre-deploy check (#4601)", "", "Run `pnpm run predeploy:check`."];

function guideWith(unreleasedBody) {
  return `${INTRO}## Unreleased\n\n${unreleasedBody}${unreleasedBody ? "\n\n" : ""}---\n\n${RELEASED}`;
}

const FULL = guideWith([...STEP_A, "", ...STEP_B].join("\n"));
const EMPTY = guideWith("");
const HEADING = upgradingReleaseHeading("0.13.2", "0.14.0");
const VERSIONS = { fromVersion: "0.13.2", toVersion: "0.14.0" };
/** The guide folded for v0.14.0. */
const fold = (guide, amend = false) => foldUpgradingUnreleased(guide, { ...VERSIONS, amend });
const waiting = (guide) => unreleasedBlock(guide).hasSteps;
/** The late step titles `releasedSectionStepsProblem` names for v0.14.0, or none. */
function lateSteps(args) {
  const problem = releasedSectionStepsProblem({ ...args, previousTag: "v0.13.2" });
  return problem === null ? [] : /did not have \((.*)\)\. Their changes/.exec(problem)[1].split("; ");
}

/** The `## ` section headed `heading`, without the heading, rule or blank edges. */
function sectionBody(guide, heading) {
  const lines = guide.split("\n");
  const start = lines.indexOf(heading);
  const after = lines.slice(start + 1);
  const end = after.findIndex((line) => line.startsWith("## "));
  return after
    .slice(0, end < 0 ? after.length : end)
    .join("\n")
    .replace(/\n*---\n*$/, "")
    .trim();
}

const stepTitles = (guide) => guide.split("\n").filter((line) => line.startsWith("### "));

describe("upgrade-guide heading roll (#4983)", () => {
  it("names the step from the previous tag to the new version with a real arrow", () => {
    expect(HEADING).toBe("## v0.13.2 → v0.14.0");
    expect(upgradingReleaseHeading(null, "0.1.0")).toBe("## v0.1.0");
  });

  it("files every waiting step under the version, below a fresh empty Unreleased", () => {
    expect(unreleasedBlock(FULL).stepTitles).toEqual([STEP_A[0], STEP_B[0]]);
    const guide = fold(FULL);

    expect(guide.startsWith(INTRO)).toBe(true);
    expect(guide.endsWith(RELEASED)).toBe(true);
    expect(guide).toContain(`## Unreleased\n\n---\n\n${HEADING}\n\n`);
    expect(waiting(guide)).toBe(false);
    expect(sectionBody(guide, HEADING)).toBe([...STEP_A, "", ...STEP_B].join("\n"));
    // Nothing lost or duplicated.
    expect(stepTitles(guide).sort()).toEqual(stepTitles(FULL).sort());
  });

  it("still writes the version's section, saying there are no steps, when Unreleased is empty", () => {
    const guide = fold(EMPTY);

    expect(sectionBody(guide, HEADING)).toBe(NO_UPGRADE_STEPS);
    expect(waiting(guide)).toBe(false);
    expect(guide.endsWith(RELEASED)).toBe(true);
  });

  it("refuses a guide with no Unreleased heading rather than guessing where steps go", () => {
    const missing = FULL.replace("## Unreleased", "## Pending");
    expect(() => fold(missing)).toThrow(/must have exactly one "## Unreleased" heading/);
    expect(unreleasedBlock(missing)).toBeNull();
  });

  it("rolls a version's section only once", () => {
    const guide = fold(FULL);
    expect(hasUpgradingSection(guide, HEADING)).toBe(true);
    expect(() => fold(guide)).toThrow(/already has "## v0\.13\.2 → v0\.14\.0"/);
  });

  it("never rewrites a released section, whatever the roll or fold", () => {
    const rolled = fold(FULL);
    const late = rolled.replace("## Unreleased\n\n", `## Unreleased\n\n### A late step (#4700)\n\nDo it.\n\n`);
    const folded = fold(late, true);
    for (const guide of [rolled, folded, fold(EMPTY)]) {
      expect(guide.endsWith(RELEASED)).toBe(true);
      expect(guide.startsWith(INTRO)).toBe(true);
    }
    // A late step cannot be folded into an older, released section.
    expect(() => foldUpgradingUnreleased(late, { fromVersion: "0.13.1", toVersion: "0.13.2", amend: true })).toThrow(
      /not the section directly below "## Unreleased"/,
    );
  });
});

describe("guarding released sections and odd guides (#4983)", () => {
  it("finds a step that landed in a released section, ignoring the untagged one and reworded prose", () => {
    const rolled = fold(FULL);
    expect(lateSteps({ guide: rolled, releasedGuide: FULL, untaggedHeading: HEADING })).toEqual([]);
    const reworded = rolled.replace("Already shipped; never rewritten.", "Already shipped.");
    expect(lateSteps({ guide: reworded, releasedGuide: FULL, untaggedHeading: HEADING })).toEqual([]);
    const merged = rolled.replace("Already shipped; never rewritten.\n", "Already shipped; never rewritten.\n\n### Late (#4800)\n\nDo it.\n");
    expect(lateSteps({ guide: merged, releasedGuide: FULL, untaggedHeading: HEADING })).toEqual(["### Late (#4800)"]);
  });

  it("does not call a release section that arrives whole between two tags late", () => {
    // A fork merging an upstream tag, or a docs pull request backfilling a missing release.
    const rolled = fold(FULL);
    const section = "## v0.12.2 → v0.13.0\n\n### Upstream step (#600)\n\nDo it.\n\n---\n\n";
    const arrived = rolled.replace("## v0.13.1 → v0.13.2", `${section}## v0.13.1 → v0.13.2`);
    expect(stepTitles(arrived)).toContain("### Upstream step (#600)");
    expect(lateSteps({ guide: arrived, releasedGuide: FULL, untaggedHeading: HEADING })).toEqual([]);
    // A late step in a section the tag already had is still caught beside it.
    const alsoLate = arrived.replace("Already shipped; never rewritten.\n", "Already shipped; never rewritten.\n\n### Late (#4800)\n\nDo it.\n");
    expect(lateSteps({ guide: alsoLate, releasedGuide: FULL, untaggedHeading: HEADING })).toEqual(["### Late (#4800)"]);
  });

  it("counts steps per section: a late step under a title other releases use is caught, a retitle is not", () => {
    // `### Post-upgrade actions` and `### Before deployment` repeat across release sections of the real guide.
    const repeated = FULL.replace("### An older step (#1000)", "### Post-upgrade actions").replace("### An even older step (#900)", "### Post-upgrade actions");
    const rolled = fold(repeated);
    const judge = (guide) => lateSteps({ guide, releasedGuide: repeated, untaggedHeading: HEADING });
    expect(judge(rolled)).toEqual([]);

    const late = rolled.replace("Already shipped; never rewritten.\n", "Already shipped; never rewritten.\n\n### Post-upgrade actions\n\nDo it.\n");
    expect(judge(late)).toEqual(["### Post-upgrade actions"]);

    // Rewording a released step's title adds no step, so it is not late.
    expect(judge(rolled.replace("### Post-upgrade actions", "### Post-upgrade actions (typo fixed)"))).toEqual([]);
    // A retitle beside a real late step is still caught: the section gained a step. Which of the
    // two titles is the new one cannot be told from text, so one is named and the message says why.
    const both = late.replace("### Post-upgrade actions\n\nAlready", "### Post-upgrade actions (typo fixed)\n\nAlready");
    expect(judge(both)).toHaveLength(1);
  });

  it("judges a first release's section, headed without an arrow, like any other", () => {
    const first = FULL.replace(RELEASED, "## v0.1.0\n\n### First step (#10)\n\nDo it.\n");
    const grown = first.replace("### First step (#10)\n\nDo it.\n", "### First step (#10)\n\nDo it.\n\n### Late (#4800)\n\nDo it.\n");
    expect(lateSteps({ guide: grown, releasedGuide: first, untaggedHeading: HEADING })).toEqual(["### Late (#4800)"]);
    expect(releasedSectionStepsProblem({ guide: grown, releasedGuide: first, untaggedHeading: HEADING, previousTag: "v0.1.0" })).toMatch(
      /in a section already released, which v0\.1\.0 did not have \(### Late \(#4800\)\)/,
    );
    // No tag to compare with is never a problem.
    expect(releasedSectionStepsProblem({ guide: grown, releasedGuide: null, untaggedHeading: HEADING, previousTag: null })).toBeNull();
  });

  it("reads a ## line inside a code block as text, carrying it with its step", () => {
    const fenced = FULL.replace("Open Admin → Xero and reconnect.", "```md\n## Example heading\n```");
    expect(fold(fenced)).toBe(fenced.replace("## Unreleased\n", `## Unreleased\n\n---\n\n${HEADING}\n`));
    expect(markdownHeadings(fenced).map((heading) => heading.line)).not.toContain("## Example heading");
  });

  it("finds the end of a fence that holds a shorter fence, a tilde fence, or a fence of the other kind", () => {
    // A single toggle closes the outer block at the inner fence and reads "## Example heading" as a heading.
    const blocks = [
      "````md\n```\n## Example heading\n```\n````",
      "~~~md\n## Example heading\n~~~",
      "~~~md\n```\n## Example heading\n```\n~~~",
      "```md\n~~~\n## Example heading\n~~~\n```",
    ];
    for (const block of blocks) {
      const fenced = FULL.replace("Open Admin → Xero and reconnect.", block);
      expect(markdownHeadings(fenced).map((heading) => heading.line), block).not.toContain("## Example heading");
      // A late step joins the end of the release's section, after the whole block.
      const late = fold(fenced).replace("## Unreleased\n\n", "## Unreleased\n\n### Late (#4800)\n\nDo it.\n\n");
      expect(fold(late, true), block).toContain(`${block}\n\n${STEP_B.join("\n")}\n\n### Late (#4800)\n\nDo it.\n\n---\n\n## v0.13.1`);
    }
    // A CRLF checkout folds without mixing line endings.
    const crlf = FULL.replace(/\n/g, "\r\n");
    expect(fold(crlf)).toBe(crlf.replace("## Unreleased\r\n", `## Unreleased\r\n\r\n---\r\n\r\n${HEADING}\r\n`));
  });

  it("recognises the no-steps line even after someone reflows it", () => {
    const empty = fold(EMPTY);
    const reflowed = empty.replace(NO_UPGRADE_STEPS, NO_UPGRADE_STEPS.replace(": ", ":\n"));
    const late = reflowed.replace("## Unreleased\n\n", "## Unreleased\n\n### Late (#4800)\n\nDo it.\n\n");
    expect(sectionBody(fold(late, true), HEADING)).toBe("### Late (#4800)\n\nDo it.");
  });
});

describe("links to the upgrade guide's Unreleased heading (#4983)", () => {
  it("names no tracked document, so a release can be prepared and a roll never orphans a link", () => {
    // Not spelled out whole: this file is tracked and the search below would find it.
    expect(UNRELEASED_LINK.startsWith("UPGRADING.md")).toBe(true);
    expect(UNRELEASED_LINK.endsWith("#unreleased")).toBe(true);
    const found = spawnSync("git", UNRELEASED_LINK_SEARCH, { cwd: path.resolve(import.meta.dirname, "..", ".."), encoding: "utf8" });
    // git grep exits 1 for no match; anything above that is a failure of the search itself.
    expect(found.status, found.stderr).toBeLessThanOrEqual(1);
    expect(
      found.stdout.split("\n").filter(Boolean),
      `These link to ${UNRELEASED_LINK}. After a release is cut that heading is empty, so link the step's own heading instead (its anchor does not move).`,
    ).toEqual([]);
  });
});

describe("upgrade-guide fold for prepare --amend (#4983)", () => {
  const rolled = fold(FULL);
  const LATE = ["### A late step (#4700)", "", "Do it."];
  const withLate = rolled.replace("## Unreleased\n\n", `## Unreleased\n\n${LATE.join("\n")}\n\n`);

  it("moves late steps to the end of the untagged version's section", () => {
    expect(unreleasedBlock(withLate).stepTitles).toEqual([LATE[0]]);
    const guide = fold(withLate, true);

    expect(waiting(guide)).toBe(false);
    expect(sectionBody(guide, HEADING)).toBe([...STEP_A, "", ...STEP_B, "", ...LATE].join("\n"));
    expect(stepTitles(guide).sort()).toEqual(stepTitles(withLate).sort());
  });

  it("replaces the no-steps line when the first steps arrive late", () => {
    const empty = fold(EMPTY);
    const late = empty.replace("## Unreleased\n\n", `## Unreleased\n\n${LATE.join("\n")}\n\n`);
    const guide = fold(late, true);
    expect(sectionBody(guide, HEADING)).toBe(LATE.join("\n"));
    expect(guide).not.toContain(NO_UPGRADE_STEPS);
  });

  it("changes nothing when no step is waiting", () => {
    expect(fold(rolled, true)).toBe(rolled);
  });

  it("rolls instead when --amend finds the version's section was never written", () => {
    expect(fold(FULL, true)).toBe(fold(FULL));
  });
});

