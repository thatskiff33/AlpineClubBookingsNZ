import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { planReleaseDocs } from "./cut-release.mjs";
import {
  addReleaseNotesIndexLine,
  RELEASE_NOTES_UNFINISHED_MARKER,
  releaseNotesIndexLists,
  releaseNotesStub,
  unfinishedStubParts,
} from "./release-notes.mjs";
import { hasUpgradingSection, upgradingReleaseHeading } from "./upgrade-docs.mjs";

// The release-notes stub and index line (#4983), and the plan `release:cut
// prepare` makes from them and the upgrade-guide fold (`planReleaseDocs`).

const HEADING = upgradingReleaseHeading("0.13.2", "0.14.0");
const GUIDE = [
  "# Upgrading",
  "",
  "## Unreleased",
  "",
  "### Reconnect Xero once (#4600)",
  "",
  "Open Admin → Xero and reconnect.",
  "",
  "### Run the pre-deploy check (#4601)",
  "",
  "Run it.",
  "",
  "---",
  "",
  "## v0.13.1 → v0.13.2",
  "",
  "### An older step (#1000)",
  "",
].join("\n");

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

  it("is unfinished while any of the marker, the stub note or the placeholder remains", () => {
    expect(unfinishedStubParts(stub)).toEqual(["the unfinished marker", 'the "Unfinished stub" note', "the placeholder paragraph"]);
    // Deleting only the marker line must not let the rest of the stub publish.
    const markerGone = stub.replace(`${RELEASE_NOTES_UNFINISHED_MARKER}\n`, "");
    expect(unfinishedStubParts(markerGone)).toEqual(['the "Unfinished stub" note', "the placeholder paragraph"]);
    const written = markerGone
      .split("\n")
      .filter((line) => !/^> \*\*Unfinished stub|^> (below|comment above)/.test(line) && !/^(Placeholder:|from the changelog section)/.test(line))
      .join("\n");
    expect(unfinishedStubParts(written)).toEqual([]);
    expect(unfinishedStubParts(`${written}\nPlaceholder: summarise this.\n`)).toEqual(["the placeholder paragraph"]);
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

  it("says whether the index already links a version's page, by the page's own link", () => {
    expect(releaseNotesIndexLists(INDEX, "0.13.2")).toBe(true);
    expect(releaseNotesIndexLists(INDEX, "0.14.0")).toBe(false);
    // v0.13.2.md is not v0.13.20.md.
    expect(releaseNotesIndexLists(INDEX, "0.13.20")).toBe(false);
  });
});

describe("planReleaseDocs on a directory (#4983)", () => {
  const INDEX = "# Release notes\n\n## Published release notes\n\n- [v0.13.2](v0.13.2.md) — older.\n";
  let root;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "release-docs-"));
    fs.mkdirSync(path.join(root, "docs", "releases"), { recursive: true });
    fs.writeFileSync(path.join(root, "docs", "UPGRADING.md"), GUIDE);
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
    expect(fs.readFileSync(path.join(root, "docs", "UPGRADING.md"), "utf8")).toBe(GUIDE);
    expect(fs.existsSync(path.join(root, "docs", "releases", "v0.14.0.md"))).toBe(false);

    for (const file of docs.files) fs.writeFileSync(path.join(root, file.relative), file.text);
    expect(hasUpgradingSection(fs.readFileSync(path.join(root, "docs", "UPGRADING.md"), "utf8"), HEADING)).toBe(true);
    // A second prepare refuses rather than writing a second heading or page.
    expect(() => plan()).toThrow(/v0\.14\.0\.md already exists; a release's notes page is only written once/);
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
