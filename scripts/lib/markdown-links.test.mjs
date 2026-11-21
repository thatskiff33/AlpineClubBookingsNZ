import { describe, expect, it } from "vitest";

import { inlineLinkTargets } from "./markdown-links.mjs";

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
});
