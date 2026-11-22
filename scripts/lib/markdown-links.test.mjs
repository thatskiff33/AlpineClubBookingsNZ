import { describe, expect, it } from "vitest";

import { inlineLinkTargets, maskCode, refDefTargets } from "./markdown-links.mjs";

const targets = (line) => inlineLinkTargets(line).map(({ target }) => target);

describe("inlineLinkTargets (#5214)", () => {
  it("yields both targets of an image wrapped in a link, at their real offsets", () => {
    const line = "[![alt](../img/a.png)](../docs/A.md)";
    expect(inlineLinkTargets(line)).toEqual([
      { start: line.indexOf("../img/a.png"), target: "../img/a.png" },
      { start: line.indexOf("../docs/A.md"), target: "../docs/A.md" },
    ]);
    expect(targets('[![alt](a.png "title")](b.md "t")')).toEqual(["a.png", "b.md"]);
  });

  it("still finds plain links, images, bracketed targets and titles, in line order", () => {
    expect(targets('See [a](x.md "t"), ![i](<my img.png>) and [b](y.md#h).')).toEqual([
      "x.md",
      "<my img.png>",
      "y.md#h",
    ]);
    expect(targets("no links [here] or ![there]")).toEqual([]);
  });

  it("finds a link whose text wraps, but not one split by a blank line", () => {
    expect(targets("[hut leader\n  guide](../docs/g.md#x)")).toEqual(["../docs/g.md#x"]);
    expect(targets("[a](\n  b.md)")).toEqual(["b.md"]);
    expect(targets("[a\n\n  b](c.md)")).toEqual([]);
  });

  it("gives a link nested in an image's alt text and the image distinct offsets", () => {
    const text = "![see [x](../docs/y.md)](../img/a.png)";
    expect(inlineLinkTargets(text)).toEqual([
      { start: text.indexOf("../docs/y.md"), target: "../docs/y.md" },
      { start: text.indexOf("../img/a.png"), target: "../img/a.png" },
    ]);
  });

  it("treats an escaped bracket as text", () => {
    expect(targets("\\[not](a.md) [yes](b.md)")).toEqual(["b.md"]);
  });
});

describe("refDefTargets (#5214)", () => {
  it("reads plain, angle-bracket and next-line definitions at their offsets", () => {
    const text = "[a]: x.md\n  [b]: <my file.md> \"t\"\n[c]:\n   y.md\nnot [d]: z.md";
    expect(refDefTargets(text)).toEqual([
      { start: text.indexOf("x.md"), target: "x.md" },
      { start: text.indexOf("<my file.md>"), target: "<my file.md>" },
      { start: text.indexOf("y.md"), target: "y.md" },
    ]);
  });

  it("takes a next-line target only when that line holds the target and at most a title", () => {
    const text = "[a]:\n  x.md \"t\"\n[b]:\n  <y z.md> (t)\n[c]:\n  w.md 'u'  ";
    expect(refDefTargets(text).map(({ target }) => target)).toEqual(["x.md", "<y z.md>", "w.md"]);
    // A bare `[note]:` followed by a sentence lends no word of it as a target.
    expect(refDefTargets("[note]:\nSee below")).toEqual([]);
    expect(refDefTargets("[note]:\nsee.md and more")).toEqual([]);
    expect(refDefTargets("[note]:\n  a.md title-without-quotes")).toEqual([]);
  });

  it("leaves a prose line shaped like a definition alone", () => {
    expect(refDefTargets("[Label]: some text here")).toEqual([]);
    expect(refDefTargets("[Label]: x.md, which explains it")).toEqual([]);
    // A CRLF line ending still ends the target's line.
    expect(refDefTargets("[a]: x.md\r\n")).toEqual([{ start: 5, target: "x.md" }]);
  });
});

describe("maskCode (#5214)", () => {
  it("blanks fences and code spans without moving any offset", () => {
    const text = "a `[x](y)` b\n```\n[z](w)\n```\n[k](v)";
    const masked = maskCode(text);
    expect(masked).toHaveLength(text.length);
    expect(masked.split("\n").map((line) => line.length)).toEqual(text.split("\n").map((line) => line.length));
    expect(inlineLinkTargets(masked).map(({ target }) => target)).toEqual(["v"]);
    // A code span may wrap, but a blank line ends it.
    expect(maskCode("`[a\n](b)` [c](d)")).toBe("   \n      [c](d)");
    expect(maskCode("`x\n\n[c](d)`")).toBe("`x\n\n[c](d)`");
  });

  it("closes a fence only on its own marker and length, as the shared block scanner does", () => {
    const text = [
      "[before](a.md)",
      "````md",
      "~~~",
      "[example](b.md)",
      "```",
      "[still example](c.md)",
      "````",
      "[after](d.md)",
    ].join("\n");
    const masked = maskCode(text);
    expect(masked).toHaveLength(text.length);
    expect(inlineLinkTargets(masked).map(({ target }) => target)).toEqual(["a.md", "d.md"]);
  });
});
