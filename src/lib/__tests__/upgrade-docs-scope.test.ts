/**
 * The upgrade documents stay scoped to the release being cut (#4979).
 *
 * WHY THIS FILE EXISTS. `docs/PRODUCTION_UPGRADE_RUNBOOK.md` described the
 * v0.10 upgrade for three releases after v0.10, and a release-specific section
 * sat above `docs/UPGRADING.md`'s `## Unreleased` block where the release fold
 * would leave it behind. Nothing in the release process looked at either.
 * `release:cut prepare` now refuses while the rules in
 * `scripts/release/upgrade-docs.mjs` are broken; this census fails the pull
 * request that breaks one, so the refusal never meets a release by surprise.
 *
 * WHAT IT CATCHES:
 *
 *  - a second `## Unreleased`, or none;
 *  - any `## ` section above `## Unreleased` other than the guide's fixed
 *    sections, in order, and any heading there that cites an issue;
 *  - a runbook whose opening paragraph names a release older than
 *    `package.json`'s version without saying it is release-agnostic.
 *
 * WHAT IT IS NOT. It does not judge the content of a release's steps or of the
 * checklist; the release checklist in `docs/MAINTENANCE.md` asks a person to.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  foldUpgradingUnreleased,
  markdownHeadings,
  RUNBOOK_PATH,
  RUNBOOK_RELEASE_AGNOSTIC_MARKER,
  runbookScope,
  runbookScopeProblem,
  unreleasedBlock,
  UPGRADE_CHECKLIST_HEADING,
  upgradeDocsProblems,
  UPGRADING_GUIDE_HEADINGS,
  UPGRADING_PATH,
  upgradingLayoutProblems,
} from "../../../scripts/release/upgrade-docs.mjs";

const read = (relative: string) => readFileSync(path.join(process.cwd(), relative), "utf8");

const GUIDE_TOP = ["# Upgrading", "", "Intro.", "", ...UPGRADING_GUIDE_HEADINGS.flatMap((line) => [line, "", "Text.", ""])];

function guide(...rest: string[]) {
  return [...GUIDE_TOP, ...rest].join("\n");
}

function runbook(opening: string) {
  return ["# Production Upgrade Runbook", "", opening, "", "## 0. Scope", "", "Mentions v0.1.0 later."].join("\n");
}

describe("the committed upgrade documents", () => {
  it("keep every release-specific section of the guide inside ## Unreleased", () => {
    expect(upgradingLayoutProblems(read(UPGRADING_PATH))).toEqual([]);
  });

  it("keep the runbook's scope no older than package.json's version", () => {
    const { version } = JSON.parse(read("package.json")) as { version: string };
    expect(runbookScopeProblem(read(RUNBOOK_PATH), version)).toBeNull();
  });
});

describe("upgradingLayoutProblems", () => {
  it("accepts the fixed sections followed by the block", () => {
    expect(upgradingLayoutProblems(guide("## Unreleased", "", "### Something (#1)", ""))).toEqual([]);
  });

  it("rejects a release-specific section above the block", () => {
    const text = guide("### Review this first (#4457)", "", "## Unreleased", "");
    expect(upgradingLayoutProblems(text)).toEqual([expect.stringContaining('"### Review this first (#4457)"')]);
  });

  it("rejects an extra ## section above the block, and names it", () => {
    const [problem] = upgradingLayoutProblems(guide("## Review this first", "", "## Unreleased", ""));
    expect(problem).toContain('unexpected: "## Review this first"');
  });

  it("rejects a missing or a repeated block", () => {
    expect(upgradingLayoutProblems(guide())).toEqual([expect.stringContaining("it has 0")]);
    expect(upgradingLayoutProblems(guide("## Unreleased", "## Unreleased"))).toEqual([
      expect.stringContaining("it has 2"),
    ]);
  });

  it("ignores headings inside fenced code", () => {
    const text = guide("```bash", "## Unreleased", "# (#12) a shell comment", "```", "## Unreleased", "");
    expect(upgradingLayoutProblems(text)).toEqual([]);
    expect(markdownHeadings("~~~\n## not a heading\n~~~\n## a heading")).toEqual([
      { level: 2, line: "## a heading", index: 3 },
    ]);
  });
});

describe("runbookScope and runbookScopeProblem", () => {
  it("treats the marker as release-agnostic even when a line break splits it", () => {
    const opening = "Takes a deployment across releases. This runbook is\nrelease-agnostic: it names none.";
    expect(runbookScope(runbook(opening))).toEqual({ agnostic: true });
    expect(runbookScopeProblem(runbook(opening), "9.9.9")).toBeNull();
  });

  it("reads the newest release the opening names, and only the opening", () => {
    const text = runbook("From a `v0.9.0`-era release up to `v0.10.0`.");
    expect(runbookScope(text)).toEqual({ agnostic: false, version: "0.10.0" });
  });

  it("calls a scope older than the current release stale", () => {
    const text = runbook("From `v0.9.0` up to `v0.10.0`.");
    expect(runbookScopeProblem(text, "0.13.2")).toContain("v0.10.0, older than v0.13.2");
    expect(runbookScopeProblem(text, "0.10.0")).toBeNull();
  });

  it("calls an opening that names nothing and lacks the marker a problem", () => {
    expect(runbookScopeProblem(runbook("Takes a deployment somewhere."), "0.1.0")).toContain(
      RUNBOOK_RELEASE_AGNOSTIC_MARKER,
    );
  });

  it("skips the runbook comparison when there is no released version", () => {
    expect(
      upgradeDocsProblems({ upgradingText: null, runbookText: runbook("Up to `v0.1.0`."), releasedVersion: null }),
    ).toEqual([]);
  });
});

describe("foldUpgradingUnreleased", () => {
  const text = guide("## Unreleased", "", UPGRADE_CHECKLIST_HEADING, "", "1. A step.", "", "---", "", "## v0.1.0 → v0.2.0", "");

  it("renames the block and leaves a fresh, empty ## Unreleased above it", () => {
    const folded = foldUpgradingUnreleased(text, { fromVersion: "0.2.0", toVersion: "0.3.0" });
    expect(folded).toContain(["## Unreleased", "", "---", "", "## v0.2.0 → v0.3.0", "", UPGRADE_CHECKLIST_HEADING].join("\n"));
    expect(upgradingLayoutProblems(folded)).toEqual([]);
    expect(unreleasedBlock(folded)).toMatchObject({ hasSteps: false, opensWithChecklist: false });
  });

  it("reports the block's steps and whether the checklist opens it", () => {
    expect(unreleasedBlock(text)).toMatchObject({ hasSteps: true, opensWithChecklist: true });
  });

  it("refuses to fold into a heading that already exists", () => {
    expect(() => foldUpgradingUnreleased(text, { fromVersion: "0.1.0", toVersion: "0.2.0" })).toThrow(
      /already has "## v0\.1\.0 → v0\.2\.0"/,
    );
  });
});
