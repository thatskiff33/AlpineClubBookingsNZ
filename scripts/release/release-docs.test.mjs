import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  addReleaseNotesIndexLine,
  fileUpgradeSteps,
  hasUpgradeSection,
  NO_UPGRADE_STEPS,
  planReleaseDocs,
  RELEASE_NOTES_UNFINISHED_MARKER,
  releaseNotesStub,
  stepsAddedToReleasedSections,
  unreleasedUpgradeSteps,
  upgradeGuideHeading,
  writeReleaseDocs,
} from "./release-docs.mjs";

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
const HEADING = upgradeGuideHeading("v0.13.2", "0.14.0");

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
    expect(upgradeGuideHeading(null, "0.1.0")).toBe("## v0.1.0");
  });

  it("files every waiting step under the version, below a fresh empty Unreleased", () => {
    const { guide, action, steps } = fileUpgradeSteps({ guide: FULL, heading: HEADING });

    expect(action).toBe("roll");
    expect(steps).toBe(2);
    expect(guide.startsWith(INTRO)).toBe(true);
    expect(guide.endsWith(RELEASED)).toBe(true);
    expect(guide).toContain(`## Unreleased\n\n---\n\n${HEADING}\n\n`);
    expect(unreleasedUpgradeSteps(guide)).toEqual([]);
    expect(sectionBody(guide, HEADING)).toBe([...STEP_A, "", ...STEP_B].join("\n"));
    // Nothing lost or duplicated.
    expect(stepTitles(guide).sort()).toEqual(stepTitles(FULL).sort());
  });

  it("still writes the version's section, saying there are no steps, when Unreleased is empty", () => {
    const { guide, action, steps } = fileUpgradeSteps({ guide: EMPTY, heading: HEADING });

    expect(action).toBe("roll");
    expect(steps).toBe(0);
    expect(sectionBody(guide, HEADING)).toBe(NO_UPGRADE_STEPS);
    expect(unreleasedUpgradeSteps(guide)).toEqual([]);
    expect(guide.endsWith(RELEASED)).toBe(true);
  });

  it("refuses a guide with no Unreleased heading rather than guessing where steps go", () => {
    const missing = FULL.replace("## Unreleased", "## Pending");
    expect(() => fileUpgradeSteps({ guide: missing, heading: HEADING })).toThrow(/has no "## Unreleased" heading/);
    expect(unreleasedUpgradeSteps(missing)).toBeNull();
  });

  it("rolls a version's section only once", () => {
    const { guide } = fileUpgradeSteps({ guide: FULL, heading: HEADING });
    expect(() => fileUpgradeSteps({ guide, heading: HEADING })).toThrow(/only rolled once/);
  });

  it("never rewrites a released section, whatever the roll or fold", () => {
    const rolled = fileUpgradeSteps({ guide: FULL, heading: HEADING }).guide;
    const late = rolled.replace("## Unreleased\n\n", `## Unreleased\n\n### A late step (#4700)\n\nDo it.\n\n`);
    const folded = fileUpgradeSteps({ guide: late, heading: HEADING, amend: true }).guide;
    for (const guide of [rolled, folded, fileUpgradeSteps({ guide: EMPTY, heading: HEADING }).guide]) {
      expect(guide.endsWith(RELEASED)).toBe(true);
      expect(guide.startsWith(INTRO)).toBe(true);
    }
    // A late step cannot be folded into an older, released section.
    expect(() => fileUpgradeSteps({ guide: late, heading: "## v0.13.1 → v0.13.2", amend: true })).toThrow(
      /not the section directly below "## Unreleased"/,
    );
  });
});

describe("guarding released sections and odd guides (#4983)", () => {
  it("finds a step that landed in a released section, ignoring the untagged one and reworded prose", () => {
    const rolled = fileUpgradeSteps({ guide: FULL, heading: HEADING }).guide;
    expect(stepsAddedToReleasedSections({ guide: rolled, releasedGuide: FULL, untaggedHeading: HEADING })).toEqual([]);
    const reworded = rolled.replace("Already shipped; never rewritten.", "Already shipped.");
    expect(stepsAddedToReleasedSections({ guide: reworded, releasedGuide: FULL, untaggedHeading: HEADING })).toEqual([]);
    const merged = rolled.replace("Already shipped; never rewritten.\n", "Already shipped; never rewritten.\n\n### Late (#4800)\n\nDo it.\n");
    expect(stepsAddedToReleasedSections({ guide: merged, releasedGuide: FULL, untaggedHeading: HEADING })).toEqual(["### Late (#4800)"]);
  });

  it("refuses a guide with a ## line inside a code block rather than splitting the block", () => {
    const fenced = FULL.replace("Open Admin → Xero and reconnect.", "```md\n## Example heading\n```");
    expect(() => fileUpgradeSteps({ guide: fenced, heading: HEADING })).toThrow(/docs\/UPGRADING\.md:\d+ has a "## " line inside a code block/);
  });

  it("recognises the no-steps line even after someone reflows it", () => {
    const empty = fileUpgradeSteps({ guide: EMPTY, heading: HEADING }).guide;
    const reflowed = empty.replace(NO_UPGRADE_STEPS, NO_UPGRADE_STEPS.replace(": ", ":\n"));
    const late = reflowed.replace("## Unreleased\n\n", "## Unreleased\n\n### Late (#4800)\n\nDo it.\n\n");
    const { guide } = fileUpgradeSteps({ guide: late, heading: HEADING, amend: true });
    expect(sectionBody(guide, HEADING)).toBe("### Late (#4800)\n\nDo it.");
  });
});

describe("upgrade-guide fold for prepare --amend (#4983)", () => {
  const rolled = fileUpgradeSteps({ guide: FULL, heading: HEADING }).guide;
  const LATE = ["### A late step (#4700)", "", "Do it."];
  const withLate = rolled.replace("## Unreleased\n\n", `## Unreleased\n\n${LATE.join("\n")}\n\n`);

  it("moves late steps to the end of the untagged version's section", () => {
    const { guide, action, steps } = fileUpgradeSteps({ guide: withLate, heading: HEADING, amend: true });

    expect(action).toBe("fold");
    expect(steps).toBe(1);
    expect(unreleasedUpgradeSteps(guide)).toEqual([]);
    expect(sectionBody(guide, HEADING)).toBe([...STEP_A, "", ...STEP_B, "", ...LATE].join("\n"));
    expect(stepTitles(guide).sort()).toEqual(stepTitles(withLate).sort());
  });

  it("replaces the no-steps line when the first steps arrive late", () => {
    const empty = fileUpgradeSteps({ guide: EMPTY, heading: HEADING }).guide;
    const late = empty.replace("## Unreleased\n\n", `## Unreleased\n\n${LATE.join("\n")}\n\n`);
    const { guide } = fileUpgradeSteps({ guide: late, heading: HEADING, amend: true });
    expect(sectionBody(guide, HEADING)).toBe(LATE.join("\n"));
    expect(guide).not.toContain(NO_UPGRADE_STEPS);
  });

  it("changes nothing when no step is waiting", () => {
    expect(fileUpgradeSteps({ guide: rolled, heading: HEADING, amend: true })).toEqual({ guide: rolled, action: "none", steps: 0 });
  });

  it("rolls instead when --amend finds the version's section was never written", () => {
    expect(fileUpgradeSteps({ guide: FULL, heading: HEADING, amend: true }).action).toBe("roll");
  });
});

describe("release-notes stub and index line (#4983)", () => {
  const stub = releaseNotesStub({
    version: "0.14.0",
    previousTag: "v0.13.2",
    date: "2026-11-20",
    bump: "minor",
    changelogHeading: "## 0.14.0 - 2026-11-20",
    upgradeHeading: HEADING,
  });

  it("carries the unfinished marker and links the version's changelog and upgrade sections", () => {
    expect(stub.split("\n")[0]).toBe("# Release v0.14.0");
    expect(stub).toContain(RELEASE_NOTES_UNFINISHED_MARKER);
    expect(stub).toContain("../../CHANGELOG.md#0140---2026-11-20");
    expect(stub).toContain("../UPGRADING.md#v0132--v0140");
    expect(stub).toContain("a minor release, the first release after `v0.13.2`");
  });

  const INDEX = [
    "# Release notes",
    "",
    "## Published release notes",
    "",
    "- [v0.13.2](v0.13.2.md) — 2026-07-23 patch public reference release.",
    "",
    "## Drafts",
    "",
  ].join("\n");

  it("lists the new page first under Published release notes", () => {
    const index = addReleaseNotesIndexLine({ index: INDEX, version: "0.14.0", date: "2026-11-20", bump: "minor" });
    expect(index).toBe(
      INDEX.replace(
        "- [v0.13.2]",
        "- [v0.14.0](v0.14.0.md) — 2026-11-20 minor public reference release.\n- [v0.13.2]",
      ),
    );
    expect(() => addReleaseNotesIndexLine({ index, version: "0.14.0", date: "2026-11-20", bump: "minor" })).toThrow(/already lists/);
    expect(() => addReleaseNotesIndexLine({ index: "# Release notes\n", version: "0.14.0", date: "x", bump: "minor" })).toThrow(
      /no "## Published release notes" section/,
    );
  });
});

describe("planReleaseDocs on a directory (#4983)", () => {
  const INDEX = "# Release notes\n\n## Published release notes\n\n- [v0.13.2](v0.13.2.md) — older.\n";
  let root;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "release-docs-"));
    fs.mkdirSync(path.join(root, "docs", "releases"), { recursive: true });
    fs.writeFileSync(path.join(root, "docs", "UPGRADING.md"), FULL);
    fs.writeFileSync(path.join(root, "docs", "releases", "README.md"), INDEX);
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  const plan = (amend = false) =>
    planReleaseDocs({
      repoRoot: root,
      version: "0.14.0",
      previousTag: "v0.13.2",
      date: "2026-11-20",
      bump: "minor",
      changelogHeading: "## 0.14.0 - 2026-11-20",
      amend,
    });

  it("plans the roll, the stub and the index line without writing anything", () => {
    const docs = plan();
    expect(docs.files.map((file) => file.relative)).toEqual(["docs/UPGRADING.md", "docs/releases/v0.14.0.md", "docs/releases/README.md"]);
    expect(docs.describe).toEqual([
      'docs/UPGRADING.md: rename "## Unreleased" to "## v0.13.2 → v0.14.0" (2 step(s)), with a fresh empty "## Unreleased" above it',
      "docs/releases/v0.14.0.md: new notes stub, marked unfinished until it is written",
      'docs/releases/README.md: list v0.14.0 first under "Published release notes"',
    ]);
    expect(fs.readFileSync(path.join(root, "docs", "UPGRADING.md"), "utf8")).toBe(FULL);
    expect(fs.existsSync(path.join(root, "docs", "releases", "v0.14.0.md"))).toBe(false);

    writeReleaseDocs(root, docs.files);
    expect(hasUpgradeSection(fs.readFileSync(path.join(root, "docs", "UPGRADING.md"), "utf8"), HEADING)).toBe(true);
    // A second prepare refuses rather than writing a second heading or page.
    expect(() => plan()).toThrow(/only rolled once/);
    // --amend with nothing waiting and the page already written changes nothing.
    expect(plan(true).files).toEqual([]);
  });

  it("refuses to overwrite a notes page that already exists", () => {
    fs.writeFileSync(path.join(root, "docs", "releases", "v0.14.0.md"), "# Written by hand\n");
    expect(() => plan()).toThrow(/v0\.14\.0\.md already exists/);
    const docs = plan(true);
    expect(docs.files.map((file) => file.relative)).toEqual(["docs/UPGRADING.md"]);
  });
});
