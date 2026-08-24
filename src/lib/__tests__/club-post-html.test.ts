import { describe, expect, it } from "vitest";

import {
  clubPostHtmlToText,
  clubPostImageIds,
  sanitiseClubPostHtml,
} from "@/lib/club-post-html";

/**
 * Board post sanitising (epic #2992).
 *
 * The board went from plain text React escaped to HTML rendered as markup, so
 * this module is the whole of what stands between a member's submission and
 * every other member's browser. The tests are weighted accordingly: what gets
 * DROPPED matters more than what survives.
 */

describe("sanitiseClubPostHtml", () => {
  it("keeps the formatting the composer offers", () => {
    const html =
      '<p style="text-align:justify"><b>Bold</b> <i>italic</i> <u>under</u></p>';
    const out = sanitiseClubPostHtml(html);
    expect(out).toContain("<b>Bold</b>");
    expect(out).toContain("<i>italic</i>");
    expect(out).toContain("<u>under</u>");
    expect(out).toContain("text-align:justify");
  });

  it("keeps a colour class, and strips every class that is not one", () => {
    // Colour travels as post_message_* classes (owner request, 25 Aug 2026),
    // because the browser serialises inline hex to rgb() and the style
    // allowlist was silently dropping every colour a member picked. The class
    // list is CLOSED: a member cannot borrow app or Tailwind classes.
    const out = sanitiseClubPostHtml(
      '<span class="post_message_red bg-destructive admin">Red</span>',
    );
    expect(out).toBe('<span class="post_message_red">Red</span>');
  });

  it("keeps legacy inline colour in both spellings the wild contains", () => {
    // Posts written before the class change stored hex; the browser-serialised
    // rgb() form also exists. Mirrors from older composers send both.
    expect(
      sanitiseClubPostHtml('<span style="color:#b42318">x</span>'),
    ).toContain("#b42318");
    expect(
      sanitiseClubPostHtml('<span style="color: rgb(180, 35, 24);">x</span>'),
    ).toContain("rgb(180, 35, 24)");
  });

  it("keeps an offered colour, size and family", () => {
    const html =
      '<span style="color:#b42318;font-size:20pt;font-family:serif">x</span>';
    const out = sanitiseClubPostHtml(html);
    expect(out).toContain("color:#b42318");
    expect(out).toContain("font-size:20pt");
    expect(out).toContain("font-family:serif");
  });

  it("drops a script tag AND its text", () => {
    const out = sanitiseClubPostHtml('<p>hi</p><script>alert(1)</script>');
    expect(out).toBe("<p>hi</p>");
    expect(out).not.toContain("alert");
  });

  it("drops an event handler attribute", () => {
    const out = sanitiseClubPostHtml('<p onclick="alert(1)">hi</p>');
    expect(out).toBe("<p>hi</p>");
  });

  it("drops a javascript: link but keeps its text", () => {
    // The words a member wrote should survive even when the link cannot.
    const out = sanitiseClubPostHtml(
      '<a href="javascript:alert(1)">click me</a>',
    );
    expect(out).not.toContain("javascript");
    expect(out).toContain("click me");
  });

  it("forces outbound links to open away and not reach back", () => {
    const out = sanitiseClubPostHtml('<a href="https://example.test">x</a>');
    expect(out).toContain('target="_blank"');
    expect(out).toContain("noopener");
  });

  it("drops a colour the composer never offered", () => {
    // A free colour value is how a member ends up with white on white, or a
    // value that vanishes against one of the two themes.
    const out = sanitiseClubPostHtml('<span style="color:#ffffff">x</span>');
    expect(out).not.toContain("color");
  });

  it("drops a style declaration smuggled after an allowed one", () => {
    // The anchoring test: an unanchored pattern would accept this on the
    // strength of the leading colour.
    const out = sanitiseClubPostHtml(
      '<span style="color:#b42318;position:fixed;top:0">x</span>',
    );
    expect(out).toContain("color:#b42318");
    expect(out).not.toContain("position");
  });

  it("drops a font size outside the offered set", () => {
    const out = sanitiseClubPostHtml('<span style="font-size:400pt">x</span>');
    expect(out).not.toContain("font-size");
  });

  it("keeps an image served by this deployment", () => {
    const src = `/api/club-posts/images/${"a".repeat(32)}`;
    const out = sanitiseClubPostHtml(`<img src="${src}" alt="lodge">`);
    expect(out).toContain(src);
  });

  it.each([
    ["a remote tracking pixel", "https://tracker.test/p.gif"],
    ["a data: payload", "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4="],
    ["a traversal attempt", "/api/club-posts/images/../../../etc/passwd"],
    ["a malformed id", "/api/club-posts/images/not-a-real-id"],
  ])("drops an image pointing at %s", (_label, src) => {
    const out = sanitiseClubPostHtml(`<img src="${src}">`);
    expect(out).not.toContain("<img");
  });

  it("returns empty for a body that is only markup", () => {
    expect(sanitiseClubPostHtml("<script>alert(1)</script>")).toBe("");
    expect(sanitiseClubPostHtml("   ")).toBe("");
  });
});

describe("clubPostHtmlToText", () => {
  it("turns block boundaries into newlines rather than running them together", () => {
    expect(clubPostHtmlToText("<p>one</p><p>two</p>")).toBe("one\ntwo");
  });

  it("keeps the words of formatting it strips", () => {
    expect(clubPostHtmlToText("<p><b>Chains</b> needed</p>")).toBe(
      "Chains needed",
    );
  });

  it("collapses the blank-line runs block substitution creates", () => {
    expect(clubPostHtmlToText("<p>a</p><br><br><br><p>b</p>")).toBe("a\n\nb");
  });

  it("is empty for an empty body", () => {
    expect(clubPostHtmlToText("")).toBe("");
  });
});

describe("clubPostImageIds", () => {
  it("finds each referenced image once", () => {
    const a = "a".repeat(32);
    const b = "b".repeat(32);
    const html = `<img src="/api/club-posts/images/${a}"><img src="/api/club-posts/images/${b}"><img src="/api/club-posts/images/${a}">`;
    expect(clubPostImageIds(html)).toEqual([a, b]);
  });

  it("finds none in a body with no images", () => {
    expect(clubPostImageIds("<p>hello</p>")).toEqual([]);
  });
});
