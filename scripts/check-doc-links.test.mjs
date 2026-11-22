import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { checkFile, collectAnchors } from "./check-doc-links.mjs";

let dir;
afterEach(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

/** The broken targets `docs:linkcheck` reports for `text` in `doc.md`, beside `files`. */
function brokenTargets(text, files = []) {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "doc-links-"));
  for (const file of files) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), "# Title\n");
  }
  const doc = path.join(dir, "doc.md");
  fs.writeFileSync(doc, text);
  const problems = [];
  checkFile(doc, new Map([[path.resolve(doc), collectAnchors(doc)]]), problems);
  return problems.map((p) => p.target);
}

describe("check-doc-links: an image wrapped in a link (#5214)", () => {
  it("checks the outer link target as well as the image", () => {
    expect(brokenTargets("[![alt](img/a.png)](docs/A.md)\n", ["img/a.png"])).toEqual(["docs/A.md"]);
    expect(brokenTargets("[![alt](img/a.png)](docs/A.md)\n", ["docs/A.md"])).toEqual(["img/a.png"]);
    expect(brokenTargets("[![alt](img/a.png)](docs/A.md)\n", ["img/a.png", "docs/A.md"])).toEqual([]);
  });
});

describe("check-doc-links: fences close as the changelog compiler closes them (#5214)", () => {
  it("keeps a `~~~` line inside a backtick fence as code", () => {
    const text = "```md\n~~~\n[example](missing/inside.md)\n~~~\n```\n[real](missing/after.md)\n";
    expect(brokenTargets(text)).toEqual(["missing/after.md"]);
  });

  it("keeps a `~~~` line inside a tilde fence's backtick content as code", () => {
    const text = "~~~md\n```\n[example](missing/inside.md)\n```\n~~~\n[real](missing/after.md)\n";
    expect(brokenTargets(text)).toEqual(["missing/after.md"]);
  });

  it("does not take headings inside a fence as anchors", () => {
    expect(brokenTargets("```\n# Fenced\n```\n[a](#fenced)\n")).toEqual(["#fenced"]);
    expect(brokenTargets("# Real\n[a](#real)\n")).toEqual([]);
  });

  it("still takes an id from a raw HTML block as an anchor", () => {
    expect(brokenTargets('<a id="kept"></a>\n\n[a](#kept)\n')).toEqual([]);
  });
});
