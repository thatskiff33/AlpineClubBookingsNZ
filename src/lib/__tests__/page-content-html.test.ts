import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  pageContentFindUnique: vi.fn(),
  pageContentFindMany: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    pageContent: {
      findUnique: mocks.pageContentFindUnique,
      findMany: mocks.pageContentFindMany,
    },
  },
}));

import {
  getPublishedPageContentByPath,
  getSanitizedPageContentByPath,
  isCmsPagePathPublished,
  listPublishedCmsPagePaths,
  listWebsiteMenuPages,
  pageContentHtmlToPlainText,
  sanitizePageContentHtml,
} from "../page-content-html";

describe("sanitizePageContentHtml", () => {
  it("keeps allowed structural markup", () => {
    const html = '<h2>Rules</h2><p class="lead">Be <strong>kind</strong>.</p>';
    expect(sanitizePageContentHtml(html)).toBe(html);
  });

  it("keeps details/summary accordions, including the open state (#992)", () => {
    const closed =
      "<details><summary>How do I book?</summary><p>A</p></details>";
    expect(sanitizePageContentHtml(closed)).toBe(closed);

    const open =
      '<details open><summary class="faq-q">How do I book?</summary><p>A</p></details>';
    expect(sanitizePageContentHtml(open)).toBe(open);
  });

  it("strips disallowed attributes and handlers from details/summary", () => {
    expect(
      sanitizePageContentHtml(
        '<details ontoggle="alert(1)" style="position:fixed" name="grp">' +
          '<summary onclick="alert(1)" id="s" open>Q</summary><p>A</p></details>',
      ),
    ).toBe("<details><summary>Q</summary><p>A</p></details>");
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
    expect(sanitizePageContentHtml('<a href="javascript:alert(1)">x</a>')).toBe(
      '<a rel="noopener noreferrer">x</a>',
    );
    expect(sanitizePageContentHtml('<a href="https://example.nz">x</a>')).toBe(
      '<a href="https://example.nz" rel="noopener noreferrer">x</a>',
    );
  });

  it("rejects protocol-relative image sources", () => {
    // The protocol-relative src is stripped; the alt is backfilled from the
    // filename (#1947), so a stripped-src image is not announced as its raw src.
    expect(sanitizePageContentHtml('<img src="//evil.example/x.png" />')).toBe(
      '<img alt="x" />',
    );
    expect(sanitizePageContentHtml('<img src="/branding/lodge.jpg" />')).toBe(
      '<img src="/branding/lodge.jpg" alt="lodge" />',
    );
  });

  it("keeps uploaded image library URLs but strips data: URIs (#731)", () => {
    expect(
      sanitizePageContentHtml('<img src="/api/images/abc123" alt="Hut" />'),
    ).toBe('<img src="/api/images/abc123" alt="Hut" />');

    expect(
      sanitizePageContentHtml(
        '<img src="https://example.nz/api/images/abc123" alt="Hut" />',
      ),
    ).toBe('<img src="https://example.nz/api/images/abc123" alt="Hut" />');

    expect(
      sanitizePageContentHtml(
        '<img src="data:image/png;base64,aGVsbG8=" alt="Hut" />',
      ),
    ).toBe('<img alt="Hut" />');
  });

  it("converts img style width/height to attributes", () => {
    expect(
      sanitizePageContentHtml(
        '<img src="/api/images/abc123" alt="Hut" style="width: 320px; height: 180px; border: 1px solid red;" />',
      ),
    ).toBe(
      '<img src="/api/images/abc123" alt="Hut" width="320" height="180" />',
    );
  });

  it("keeps safe svg polygon geometry/presentation and strips handlers, styles, and disallowed attributes", () => {
    const input =
      '<svg viewBox="0 0 100 100" width="100" height="100">' +
      '<polygon points="50,0 100,100 0,100" fill="red" stroke="black" ' +
      'stroke-width="2" onclick="alert(1)" style="fill:blue" id="p1" />' +
      "</svg>";

    const sanitized = sanitizePageContentHtml(input);

    // Geometry + presentation attributes survive.
    expect(sanitized).toContain("<polygon");
    expect(sanitized).toContain('points="50,0 100,100 0,100"');
    expect(sanitized).toContain('fill="red"');
    expect(sanitized).toContain('stroke="black"');
    expect(sanitized).toContain('stroke-width="2"');

    // The svg wrapper (with its lower-cased viewbox) is preserved.
    expect(sanitized).toContain('<svg viewbox="0 0 100 100"');

    // Event handlers, inline styles, and other disallowed attributes go.
    expect(sanitized).not.toContain("onclick");
    expect(sanitized).not.toContain("alert(1)");
    expect(sanitized).not.toContain("style=");
    expect(sanitized).not.toContain('id="p1"');

    // Sanitizing an already-sanitized value is a no-op (idempotent).
    expect(sanitizePageContentHtml(sanitized)).toBe(sanitized);
  });

  /**
   * The trailing `.trim()` is load-bearing for callers, not cosmetic: the public
   * hero pages decide between the HTML sink and an escaped text child on the
   * truthiness of the stored header, and it is this guarantee that means a header
   * of nothing but whitespace can never present itself as content (#2819). Both
   * the admin write path and the published read path run values through here, so
   * this is where the rule belongs — the pages' own `.trim()` is defence in depth
   * against some future reader that skips this function.
   *
   * `<p>&nbsp;</p>` is deliberately in the list as a NON-empty case: what a
   * rich-text editor produces for an "empty" paragraph is real markup, and it
   * takes the stored branch. The guarantee is about whitespace, not about
   * emptiness as an author might perceive it.
   */
  it("collapses whitespace-only input to the empty string", () => {
    expect(sanitizePageContentHtml("   ")).toBe("");
    expect(sanitizePageContentHtml("\t\n ")).toBe("");
    expect(sanitizePageContentHtml("\f\r\n")).toBe("");
    expect(sanitizePageContentHtml("  <script>alert(1)</script>  ")).toBe("");
    expect(sanitizePageContentHtml("  <p>ok</p>  ")).toBe("<p>ok</p>");
    expect(sanitizePageContentHtml("<p>&nbsp;</p>")).not.toBe("");
  });
});

// Every <img> reaching the DOM through sanitised page content — the
// standalone-<img> html parts (dangerouslySetInnerHTML) and page.headerText —
// must carry an alt attribute so screen readers never fall back to announcing
// the raw src (e.g. a base64 hero/logo). The {{photo-gallery}} token path is
// covered separately by the embeds/photo-gallery-token suites.
describe("sanitizePageContentHtml — alt-text backfill (#1947)", () => {
  it("backfills a missing alt from the src filename", () => {
    expect(
      sanitizePageContentHtml('<img src="/api/images/Lodge_Winter-Sunset.jpg" />'),
    ).toBe('<img src="/api/images/Lodge_Winter-Sunset.jpg" alt="Lodge Winter Sunset" />');
  });

  it("backfills an explicit empty alt for a data: <img> with no filename (decorative, not the src)", () => {
    // A base64 hero/logo has no filename to derive; an explicit alt="" marks it
    // decorative and silences the screen reader, rather than reading the blob.
    // (The CMS default separately strips the data: src.)
    expect(
      sanitizePageContentHtml(
        '<img src="data:image/png;base64,iVBORw0KGgoAAAANSU" />',
      ),
    ).toBe('<img alt="" />');
    // With the display variant that keeps data: srcs, the alt="" is still added.
    expect(
      sanitizePageContentHtml(
        '<img src="data:image/png;base64,iVBORw0KGgoAAAANSU" />',
        { restrictImgSrc: true },
      ),
    ).toBe('<img src="data:image/png;base64,iVBORw0KGgoAAAANSU" alt="" />');
  });

  it("leaves an existing alt untouched, including an explicit empty alt", () => {
    expect(
      sanitizePageContentHtml('<img src="/api/images/hut.jpg" alt="Hut at dusk" />'),
    ).toBe('<img src="/api/images/hut.jpg" alt="Hut at dusk" />');
    // Present-but-empty alt is the author's decorative decision — preserved.
    expect(
      sanitizePageContentHtml('<img src="/api/images/divider.png" alt="" />'),
    ).toBe('<img src="/api/images/divider.png" alt="" />');
  });
});
// Issue #161 (ADR-003 residual): the lobby display's img-src CSP is tightened
// to 'self' data:, so its authoring/render path opts into a stricter <img> src
// constraint via { restrictImgSrc: true }. The CMS's own default (this option
// omitted) is the public-site page-content trust model and MUST stay exactly
// as covered by the describe block above — these tests only exercise the flag.
describe("sanitizePageContentHtml — display img-src restriction (issue #161)", () => {
  it("keeps the CMS default unaffected when the option is omitted (regression guard)", () => {
    // Mirrors the "keeps uploaded image library URLs but strips data: URIs"
    // case above: an absolute https image is still allowed by default.
    expect(
      sanitizePageContentHtml(
        '<img src="https://example.nz/api/images/abc123" alt="Hut" />',
      ),
    ).toBe('<img src="https://example.nz/api/images/abc123" alt="Hut" />');
  });

  it("blocks an absolute https <img> src (the ADR-003 exfiltration vector)", () => {
    expect(
      sanitizePageContentHtml(
        '<img src="https://evil.example/beacon.gif" alt="x" />',
        { restrictImgSrc: true },
      ),
    ).toBe('<img alt="x" />');
  });

  it("blocks a protocol-relative <img> src", () => {
    // src stripped; alt backfilled from the filename (#1947).
    expect(
      sanitizePageContentHtml('<img src="//evil.example/beacon.gif" />', {
        restrictImgSrc: true,
      }),
    ).toBe('<img alt="beacon" />');
  });

  it("keeps a relative / root-absolute <img> src (matches img-src 'self')", () => {
    expect(
      sanitizePageContentHtml('<img src="/api/images/abc123" alt="Hut" />', {
        restrictImgSrc: true,
      }),
    ).toBe('<img src="/api/images/abc123" alt="Hut" />');
  });

  it("keeps a data: <img> src (the CMS default strips it; the display variant keeps it)", () => {
    expect(
      sanitizePageContentHtml(
        '<img src="data:image/png;base64,aGVsbG8=" alt="Hut" />',
        { restrictImgSrc: true },
      ),
    ).toBe('<img src="data:image/png;base64,aGVsbG8=" alt="Hut" />');
  });

  it("still strips <script> and event handlers (CMS trust model unchanged by the flag)", () => {
    expect(
      sanitizePageContentHtml(
        '<p onclick="alert(1)">ok</p><script>alert(1)</script>',
        { restrictImgSrc: true },
      ),
    ).toBe("<p>ok</p>");
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
    // The header <img> loses its onerror handler; its missing alt is backfilled
    // from the src filename ("x") so screen readers do not announce the raw src
    // on the header image path (#1947).
    expect(page?.headerText).toBe('<img src="x" alt="x" />Welcome');
  });

  // The reader-level half of the whitespace guarantee above, and the reason the
  // public hero pages never see a whitespace-only header however a row was
  // written (#2819). `getPublishedPageContentByPath()` returns this same record,
  // so pinning it here covers both readers.
  it("reads a whitespace-only stored header back as the empty string", async () => {
    mocks.pageContentFindUnique.mockResolvedValue({
      id: "page-1",
      slug: "join",
      caption: "Join",
      menuTitle: "Join",
      title: "Join",
      headerText: "   ",
      path: "/join",
      sortOrder: 10,
      contentHtml: "<p>ok</p>",
    });

    const page = await getSanitizedPageContentByPath("/join");

    expect(page?.headerText).toBe("");
  });
});

describe("getPublishedPageContentByPath (#2440)", () => {
  const baseRecord = {
    id: "page-1",
    slug: "contact",
    caption: "Get in touch",
    menuTitle: "Contact",
    title: "Draft contact page",
    headerText: "<p>Draft header</p>",
    path: "/contact",
    sortOrder: 10,
    contentHtml: "<p>Draft body</p>",
  };

  beforeEach(() => {
    mocks.pageContentFindUnique.mockReset();
  });

  it("returns null when no record exists", async () => {
    mocks.pageContentFindUnique.mockResolvedValue(null);
    await expect(
      getPublishedPageContentByPath("/missing"),
    ).resolves.toBeNull();
  });

  it("hides an unpublished (draft) page entirely", async () => {
    mocks.pageContentFindUnique.mockResolvedValue({
      ...baseRecord,
      published: false,
    });
    await expect(
      getPublishedPageContentByPath("/contact"),
    ).resolves.toBeNull();
  });

  it("returns a published page unchanged", async () => {
    mocks.pageContentFindUnique.mockResolvedValue({
      ...baseRecord,
      published: true,
    });
    const page = await getPublishedPageContentByPath("/contact");
    expect(page?.title).toBe("Draft contact page");
    expect(page?.published).toBe(true);
  });

  it("keeps a legacy row with no published value visible", async () => {
    // Only an explicit false hides a page — rows written before the column
    // existed default to visible, matching the catch-all's historic semantics.
    mocks.pageContentFindUnique.mockResolvedValue({
      ...baseRecord,
      published: null,
    });
    const page = await getPublishedPageContentByPath("/contact");
    expect(page?.title).toBe("Draft contact page");
  });
});

describe("listWebsiteMenuPages", () => {
  beforeEach(() => {
    mocks.pageContentFindMany.mockReset();
  });

  it("queries only published pages and keeps those with a menu title", async () => {
    mocks.pageContentFindMany.mockResolvedValue([
      { slug: "about", menuTitle: "About", title: "About", path: "/about" },
      { slug: "secret", menuTitle: "", title: "Secret", path: "/secret" },
    ]);

    const pages = await listWebsiteMenuPages();

    expect(mocks.pageContentFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { published: true } }),
    );
    expect(pages.map((page) => page.slug)).toEqual(["about"]);
  });

  // #2352 slice-1 review. The slice reserved every first segment that belongs to
  // another route group, so a row saved before that rule can still be published
  // while the catch-all refuses to serve it. Published plus a menu title is no
  // longer enough to be advertised: the header and the mobile drawer would keep a
  // nav link pointing at a 404, with no signal to the visitor or the operator.
  it("drops a published page whose slug is now a reserved prefix", async () => {
    mocks.pageContentFindMany.mockResolvedValue([
      { slug: "about", menuTitle: "About", title: "About", path: "/about" },
      {
        slug: "lodge/history",
        menuTitle: "Lodge History",
        title: "Lodge History",
        path: "/lodge/history",
      },
      {
        slug: "notices/archive",
        menuTitle: "Notice Archive",
        title: "Notice Archive",
        path: "/notices/archive",
      },
      { slug: "pay", menuTitle: "Pay", title: "Pay", path: "/pay" },
      // A reserved word deeper in the slug is NOT reserved by this rule — only the
      // first segment is, because that is the only one the classifier reads.
      {
        slug: "trips/pay",
        menuTitle: "Trip Payments",
        title: "Trip Payments",
        path: "/trips/pay",
      },
    ]);

    const pages = await listWebsiteMenuPages();

    expect(pages.map((page) => page.slug)).toEqual(["about", "trips/pay"]);
  });

  // #2818: the reserved-WORD hazard, one segment deeper than the slice-1 rule.
  // A row at `trips/booking-requests` passes `isCmsServablePageSlug` (the
  // route-group check looks at the first segment only), but the catch-all loader
  // hard-404s any slug containing `booking-requests`/`school-bookings`. Without
  // the `!isReservedPageSlug` half of filter 3 the header would advertise a link
  // to that 404 — the exact class slice 1 closed for reserved first segments.
  it("drops a published page whose slug contains a reserved word in a non-leading segment", async () => {
    mocks.pageContentFindMany.mockResolvedValue([
      { slug: "about", menuTitle: "About", title: "About", path: "/about" },
      {
        slug: "trips/booking-requests",
        menuTitle: "Trip Requests",
        title: "Trip Requests",
        path: "/trips/booking-requests",
      },
      {
        slug: "info/school-bookings",
        menuTitle: "Info",
        title: "Info",
        path: "/info/school-bookings",
      },
    ]);

    const pages = await listWebsiteMenuPages();

    expect(pages.map((page) => page.slug)).toEqual(["about"]);
  });

  // #2818 decisions 1 and 2. The two form pages live in `(website-dynamic)`, so
  // `isCmsServablePageSlug` refuses them — a real code-backed route serves each
  // address, but the catch-all will never store one. Advertising them is opt-in:
  // the seeded rows carry an EMPTY menu title, so a club that does nothing keeps
  // the unlisted behaviour of #2421.
  it.each(["booking-requests", "school-bookings"])(
    "keeps %s out of the nav while its menu title is empty",
    async (slug) => {
      mocks.pageContentFindMany.mockResolvedValue([
        { slug: "about", menuTitle: "About", title: "About", path: `/about` },
        { slug, menuTitle: "", title: "Form", path: `/${slug}` },
      ]);

      const pages = await listWebsiteMenuPages();

      expect(pages.map((page) => page.slug)).toEqual(["about"]);
    },
  );

  it.each(["booking-requests", "school-bookings"])(
    "lists %s once the club sets a menu title, even though the catch-all refuses the slug",
    async (slug) => {
      // The decoupling itself. Before `BUILT_IN_DYNAMIC_PAGE_SLUGS` the only way
      // to get a menu entry here was to move the page into the fixed-nonce route
      // group, which is the CSP widening decision 2 reversed.
      mocks.pageContentFindMany.mockResolvedValue([
        { slug, menuTitle: "Request a stay", title: "Form", path: `/${slug}` },
      ]);

      const pages = await listWebsiteMenuPages();

      expect(pages.map((page) => page.slug)).toEqual([slug]);
      expect(pages[0]!.menuTitle).toBe("Request a stay");
    },
  );

  it("does not list a whitespace-only menu title as an opt-in", async () => {
    mocks.pageContentFindMany.mockResolvedValue([
      {
        slug: "booking-requests",
        menuTitle: "   ",
        title: "Form",
        path: "/booking-requests",
      },
    ]);

    expect(await listWebsiteMenuPages()).toEqual([]);
  });

  it("does not let the allowlist widen to any other per-request page", async () => {
    // `/hut-leader-instructions` is `(website-dynamic)` too, and must stay
    // unlistable: it is PIN-gated and per-assignment, so a nav link would refuse
    // everyone who followed it. This is why the allowlist is written down rather
    // than derived from PER_REQUEST_WEBSITE_ROUTES.
    mocks.pageContentFindMany.mockResolvedValue([
      {
        slug: "hut-leader-instructions",
        menuTitle: "Hut Leader",
        title: "Hut Leader",
        path: "/hut-leader-instructions",
      },
    ]);

    expect(await listWebsiteMenuPages()).toEqual([]);
  });

  it("still drops an UNPUBLISHED built-in form page, because the query filters first", async () => {
    // The allowlist relaxes filter 3 only. `published` is enforced in the query,
    // and these rows cannot be unpublished through any supported write path
    // (`canUnpublishPage`), so this pins that the relaxation did not reach it.
    mocks.pageContentFindMany.mockResolvedValue([]);

    expect(await listWebsiteMenuPages()).toEqual([]);
    expect(mocks.pageContentFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { published: true } }),
    );
  });
});

describe("listPublishedCmsPagePaths excludes the built-in dynamic pages (#2818 decision 4)", () => {
  beforeEach(() => {
    mocks.pageContentFindMany.mockReset();
  });

  it("never warms a page that is never stored, so no CRITICAL_PUBLIC_ROUTES entry is needed", async () => {
    // The warm-up census cross-check is what turned CI red on the first cut: a
    // discovered route with no declaration fails it. These two must not be
    // discovered at all — they are `force-dynamic`, so warming them would fill
    // nothing. The menu asks a WIDER question than this on purpose, and this test
    // is what stops the two questions being merged back together.
    mocks.pageContentFindMany.mockResolvedValue([
      { slug: "about", path: "/about" },
      { slug: "booking-requests", path: "/booking-requests" },
      { slug: "school-bookings", path: "/school-bookings" },
    ]);

    expect(await listPublishedCmsPagePaths()).toEqual(["/about"]);
  });
});

describe("listPublishedCmsPagePaths (#2566 warm-up discovery)", () => {
  beforeEach(() => {
    mocks.pageContentFindMany.mockReset();
  });

  it("asks the database for published pages only, so a draft is never warmed", async () => {
    mocks.pageContentFindMany.mockResolvedValue([
      { slug: "about", path: "/about" },
      { slug: "faq", path: "/faq" },
    ]);

    const paths = await listPublishedCmsPagePaths();

    expect(mocks.pageContentFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { published: true } }),
    );
    expect(paths).toEqual(["/about", "/faq"]);
  });

  it("keeps an unadvertised page and drops one the website will not serve", async () => {
    // No menuTitle is "not in the navigation", not "unpublished": a visitor
    // following a direct link still pays the cold render. An address under another
    // route group's prefix is a different matter — the catch-all refuses it, so
    // warming it would only ever store a 404.
    mocks.pageContentFindMany.mockResolvedValue([
      { slug: "unlisted", path: "/unlisted" },
      { slug: "lodge/history", path: "/lodge/history" },
      { slug: "pay", path: "/pay" },
    ]);

    await expect(listPublishedCmsPagePaths()).resolves.toEqual(["/unlisted"]);
  });
});

describe("isCmsPagePathPublished (#2566 unpublished-during-warmup race)", () => {
  beforeEach(() => {
    mocks.pageContentFindUnique.mockReset();
  });

  it("distinguishes still-published from hidden, missing, and unservable", async () => {
    mocks.pageContentFindUnique.mockResolvedValue({
      slug: "about",
      published: true,
    });
    await expect(isCmsPagePathPublished("/about")).resolves.toBe(true);

    mocks.pageContentFindUnique.mockResolvedValue({
      slug: "about",
      published: false,
    });
    await expect(isCmsPagePathPublished("/about")).resolves.toBe(false);

    mocks.pageContentFindUnique.mockResolvedValue(null);
    await expect(isCmsPagePathPublished("/about")).resolves.toBe(false);

    mocks.pageContentFindUnique.mockResolvedValue({
      slug: "lodge/history",
      published: true,
    });
    await expect(isCmsPagePathPublished("/lodge/history")).resolves.toBe(false);
  });
});
