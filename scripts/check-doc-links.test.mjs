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
