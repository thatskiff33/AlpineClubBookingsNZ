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
 *    `package.json`'s version without saying it is release-agnostic;
 *  - a migration the ledger declares `windowed` that the runbook's windowed
 *    section (§2.4) does not name: a window is run from that section alone.
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
  runbookWindowedProblems,
  unreleasedBlock,
  UPGRADE_CHECKLIST_HEADING,
  upgradeDocsProblems,
  UPGRADING_GUIDE_HEADINGS,
  UPGRADING_PATH,
  upgradingLayoutProblems,
  windowedLedgerMigrations,
} from "../../../scripts/release/upgrade-docs.mjs";

const LEDGER_PATH = "docs/BLUE_GREEN_MIGRATION_SAFETY.tsv";

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

  it("name every migration the ledger declares windowed in the runbook's windowed section", () => {
    expect(runbookWindowedProblems(read(LEDGER_PATH), read(RUNBOOK_PATH))).toEqual([]);
  });

  it("still find windowed ledger rows to check", () => {
    // A floor, not a census: the count grows with each windowed migration, and
    // without it the check above is vacuous the moment the column parse breaks.
    // 12 rows were windowed when this census was written.
    expect(windowedLedgerMigrations(read(LEDGER_PATH)).length).toBeGreaterThanOrEqual(12);
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
      upgradeDocsProblems({ upgradingText: null, runbookText: runbook("Up to `v0.1.0`."), releaseVersion: null }),
    ).toEqual([]);
  });
});

describe("runbookWindowedProblems", () => {
  const ledger = [
    "# migration_name\tphase\tprevious_expand_release\told_code_compatible\tlock_impact_plan",
    "20260101010000_expand_a\texpand\tn/a\tyes\tAdditive.",
    "20260101020000_contract_b\tcontract\t20260101010000_expand_a\twindowed\tWindowed.",
    "20260101030000_contract_c\tcontract\tn/a\twindowed\tAlso windowed.",
  ].join("\n");
  const runbookWith = (...bullets: string[]) =>
    [
      "# Runbook",
      "",
      "## 2. Migrate",
      "",
      "### 2.4 Windowed migration deploy sequence",
      "",
      ...bullets,
      "",
      "#### 2.4.1 Detail",
      "",
      "Text.",
      "",
      "### 2.5 Next",
      "",
      "20260101030000_contract_c is named here, outside the window section.",
    ].join("\n");

  it("reads only the windowed rows, in file order, ignoring the header", () => {
    expect(windowedLedgerMigrations(ledger)).toEqual(["20260101020000_contract_b", "20260101030000_contract_c"]);
  });

  it("accepts a section that names every windowed migration, sub-sections included", () => {
    const runbook = runbookWith("- `20260101020000_contract_b`", "- `20260101030000_contract_c`");
    expect(runbookWindowedProblems(ledger, runbook)).toEqual([]);
  });

  it("names a windowed migration the section leaves out, even when a later section mentions it", () => {
    expect(runbookWindowedProblems(ledger, runbookWith("- `20260101020000_contract_b`"))).toEqual([
      expect.stringContaining("does not name the windowed migration 20260101030000_contract_c"),
    ]);
  });

  it("reports a runbook with no windowed section", () => {
    expect(runbookWindowedProblems(ledger, "# Runbook\n\n## 2. Migrate\n")).toEqual([
      expect.stringContaining("has no"),
    ]);
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

  it("ends the lines it adds the way the heading it replaces ends, so a CRLF checkout is not left mixed", () => {
    const crlf = text.replace(/\n/g, "\r\n");
    const folded = foldUpgradingUnreleased(crlf, { fromVersion: "0.2.0", toVersion: "0.3.0" });
    expect(folded.split("\n").slice(0, -1).every((line) => line.endsWith("\r"))).toBe(true);
    expect(upgradingLayoutProblems(folded)).toEqual([]);
    expect(unreleasedBlock(folded)).toMatchObject({ hasSteps: false });
    expect(foldUpgradingUnreleased(text, { fromVersion: "0.2.0", toVersion: "0.3.0" })).not.toContain("\r");
  });

  it("refuses to fold into a heading that already exists", () => {
    expect(() => foldUpgradingUnreleased(text, { fromVersion: "0.1.0", toVersion: "0.2.0" })).toThrow(
      /already has "## v0\.1\.0 → v0\.2\.0"/,
    );
  });
});
