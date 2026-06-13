import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  pageContentFindUnique: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    pageContent: {
      findUnique: mocks.pageContentFindUnique,
    },
  },
}));

import {
  getSanitizedPageContentByPath,
  pageContentHtmlToPlainText,
  sanitizePageContentHtml,
} from "@/lib/page-content-html";

describe("sanitizePageContentHtml", () => {
  it("keeps allowed structural markup", () => {
    const html = '<h2>Rules</h2><p class="lead">Be <strong>kind</strong>.</p>';
    expect(sanitizePageContentHtml(html)).toBe(html);
  });

  it("strips script tags and their content", () => {
    expect(
      sanitizePageContentHtml('<p>ok</p><script>alert("x")</script>'),
    ).toBe("<p>ok</p>");
  });

  it("strips style tags and their content", () => {
    expect(
      sanitizePageContentHtml("<style>body{display:none}</style><p>ok</p>"),
    ).toBe("<p>ok</p>");
  });

  it("strips inline event handlers and style attributes", () => {
    expect(
      sanitizePageContentHtml(
        '<p onclick="alert(1)" style="position:fixed">ok</p>',
      ),
    ).toBe("<p>ok</p>");
  });

  it("strips javascript: links and forces rel on anchors", () => {
    expect(
      sanitizePageContentHtml('<a href="javascript:alert(1)">x</a>'),
    ).toBe('<a rel="noopener noreferrer">x</a>');
    expect(sanitizePageContentHtml('<a href="https://example.nz">x</a>')).toBe(
      '<a href="https://example.nz" rel="noopener noreferrer">x</a>',
    );
  });

  it("rejects protocol-relative image sources", () => {
    expect(sanitizePageContentHtml('<img src="//evil.example/x.png" />')).toBe(
      "<img />",
    );
    expect(sanitizePageContentHtml('<img src="/branding/lodge.jpg" />')).toBe(
      '<img src="/branding/lodge.jpg" />',
    );
  });
});

describe("pageContentHtmlToPlainText", () => {
  it("strips markup and collapses whitespace", () => {
    expect(
      pageContentHtmlToPlainText("<p>Lodge   rules</p>\n<p>and notes</p>"),
    ).toBe("Lodge rules and notes");
  });
});

describe("getSanitizedPageContentByPath", () => {
  beforeEach(() => {
    mocks.pageContentFindUnique.mockReset();
  });

  it("returns null when no record exists", async () => {
    mocks.pageContentFindUnique.mockResolvedValue(null);
    await expect(getSanitizedPageContentByPath("/missing")).resolves.toBeNull();
  });

  it("sanitises both contentHtml and headerText on read", async () => {
    mocks.pageContentFindUnique.mockResolvedValue({
      id: "page-1",
      slug: "about",
      caption: "About",
      menuTitle: "About",
      title: "About",
      headerText: '<img src="x" onerror="alert(1)">Welcome',
      path: "/about",
      sortOrder: 10,
      contentHtml: "<p>ok</p><script>alert(1)</script>",
    });

    const page = await getSanitizedPageContentByPath("/about");

    expect(page?.contentHtml).toBe("<p>ok</p>");
    expect(page?.headerText).toBe('<img src="x" />Welcome');
  });
});
