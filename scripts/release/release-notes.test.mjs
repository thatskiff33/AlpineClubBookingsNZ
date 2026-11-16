import {
  addReleaseNotesIndexLine,
  RELEASE_NOTES_UNFINISHED_MARKER,
  releaseNotesIndexLists,
  releaseNotesStub,
  unfinishedStubParts,
} from "./release-notes.mjs";
import { upgradingReleaseHeading } from "./upgrade-docs.mjs";

// The release-notes stub and index line (#4983). The plan `release:cut prepare`
// makes from them (`planReleaseDocs`) is tested beside it in cut-release.test.mjs.

const HEADING = upgradingReleaseHeading("0.13.2", "0.14.0");

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
