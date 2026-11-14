import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { collectAnchors } from "../check-doc-links.mjs";
import { MAX_RELEASE_NOTES_CHARS, releaseBody } from "../release/cut-release.mjs";
import { githubHeadingAnchor } from "./github-heading-anchor.mjs";

let tmpDir;
afterEach(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = undefined;
});

/** The anchors `docs:linkcheck` accepts for a Markdown file holding `text`. */
function linkCheckAnchors(text) {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "heading-anchor-"));
  const file = path.join(tmpDir, "doc.md");
  fs.writeFileSync(file, text);
  return collectAnchors(file);
}

describe("githubHeadingAnchor", () => {
  it("slugs release headings the way GitHub does", () => {
    expect(githubHeadingAnchor("## 0.13.3 - 2026-10-31")).toBe("0133---2026-10-31");
    expect(githubHeadingAnchor("## Unreleased")).toBe("unreleased");
  });

  it("slugs a heading's rendered text, not its inline markup", () => {
    expect(githubHeadingAnchor("## `v0.13.2` → v0.14.0")).toBe("v0132--v0140");
    expect(githubHeadingAnchor("### See [the guide](docs/x.md) for `pnpm`")).toBe("see-the-guide-for-pnpm");
    expect(githubHeadingAnchor("## Closing hashes ##")).toBe("closing-hashes");
  });

  // The `code` + arrow heading is the shape of docs/UPGRADING.md's sections;
  // the link and closing-hash headings are where a slugger that skipped the
  // markup stripping used to drift from docs:linkcheck.
  it.each([
    ["## `v0.13.2` → v0.14.0", "v0132--v0140"],
    ["## [0.14.0](https://example.org/r/0.14.0) - 2026-11-01", "0140---2026-11-01"],
    ["## 0.14.0 - 2026-11-01 ##", "0140---2026-11-01"],
  ])("gives the release tool's link and docs:linkcheck the same anchor for %s", (heading, anchor) => {
    const body = `- ${"a".repeat(MAX_RELEASE_NOTES_CHARS)}`;
    const repo = { host: "github.com", owner: "o", name: "r" };
    const { kind, text } = releaseBody({ section: { heading, body }, tag: "v0.14.0", repo });
    expect(kind).toBe("short");

    const linkedAnchor = /CHANGELOG\.md#([^)\s]+)\)/.exec(text)?.[1];
    expect(linkedAnchor).toBe(anchor);
    expect(linkCheckAnchors(`# Changelog\n\n${heading}\n\n${body}\n`)).toContain(linkedAnchor);
  });
});
