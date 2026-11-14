// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The hero header of the three established website pages: `/join`, `/join/apply`
 * and `/contact` (#2819).
 *
 * Each page has two header branches, and only ONE of them may be an HTML sink:
 *  - a genuine stored `PageContent.headerText` is admin-authored HTML, sanitised
 *    on write and again on read, and clubs format it — it keeps rendering through
 *    `dangerouslySetInnerHTML`;
 *  - the fallback is a sentence this application COMPOSES, on two of the three
 *    pages by interpolating the club identity, which no sanitiser has ever seen.
 *    It must render as an escaped React text child.
 *
 * The fallback branch was previously unreachable in a seeded deployment, which is
 * exactly why it needs pinning here rather than left to starter data: these tests
 * deliberately remove or blank the row, which is the state a deployment is in
 * before its content is seeded, and the state a club reaches by clearing the
 * field. The same fix landed on the two newer form pages in #2818; that suite is
 * `booking-request-pages-fallback-render.test.tsx`.
 *
 * This file pins rendered BEHAVIOUR, which is the right level for the escaping
 * and for the branch each input takes. It cannot state the underlying rule
 * exactly — a sink handed a sentence that interpolates nothing renders the same
 * DOM as a text child — so the rule itself is pinned over the page SOURCE, for all
 * five heroes at once, in `src/app/__tests__/website-hero-header-sink-contract.test.ts`.
 */

/**
 * A club name carrying markup a club could plausibly type into Club Identity. It
 * is a free-text settings field, not page HTML, so nothing sanitises it.
 *
 * Declared through `vi.hoisted` so the mock factory below and the assertions read
 * the same value regardless of hoisting order.
 */
const identity = vi.hoisted(() => ({
  name: 'Test Alpine Club <img src=x onerror="alert(1)">',
}));

const mocks = vi.hoisted(() => ({
  getPublishedPageContentByPath: vi.fn(),
  buildEmbeddedBody: vi.fn(),
}));

vi.mock("server-only", () => ({}));

vi.mock("@/lib/page-content-html", () => ({
  getPublishedPageContentByPath: mocks.getPublishedPageContentByPath,
  pageContentHtmlToPlainText: (html: string) => html.replace(/<[^>]*>/g, ""),
}));

vi.mock("@/lib/page-content-embeds", () => ({
  buildEmbeddedBody: mocks.buildEmbeddedBody,
}));

vi.mock("@/lib/website-setup-metadata", () => ({
  setupInProgressMetadata: async () => null,
}));

vi.mock("@/lib/public-layout-config", () => ({
  getCachedClubIdentity: async () => ({
    name: identity.name,
    socialLinks: {},
    publicUrl: "https://club.example.org",
  }),
}));

vi.mock("@/lib/lodges", () => ({
  getDefaultLodgeId: async () => "lodge-1",
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    lodge: { findUnique: async () => ({ name: "Lodge", address: null }) },
    publicContentSettings: {
      findUnique: async () => ({ contactCommitteeRoleKey: null }),
    },
  },
}));

// The page bodies are not under test here; each is reduced to a marker so the
// assertions below see only the hero.
vi.mock("@/components/website/embedded-page-content-parts", () => ({
  EmbeddedPageContentParts: () => <div>CMS body rendered</div>,
}));

vi.mock("@/components/website/contact-page-client", () => ({
  ContactPageClient: () => <div>Contact form rendered</div>,
}));

vi.mock("@/components/website/join-apply-page-client", () => ({
  JoinApplyPageClient: () => <div>Application form rendered</div>,
}));

import ContactPage from "@/app/(website)/contact/page";
import JoinApplyPage from "@/app/(website)/join/apply/page";
import JoinPage from "@/app/(website)/join/page";

type PageComponent = () => Promise<ReactElement>;

/** A published row, with whatever header text the case under test needs. */
function publishedRow(path: string, headerText: string) {
  return {
    id: "page-1",
    slug: path.replace(/^\//, "") || "home",
    caption: "Stored caption",
    menuTitle: "Stored",
    title: "Stored title",
    headerText,
    path,
    sortOrder: 1,
    contentHtml: "",
    published: true,
  };
}

/**
 * The element that actually holds the fallback sentence — the innermost one, so
 * the wrapper `div`s of the hero cannot mask the answer.
 *
 * Its tag is a real signal but a WEAK one, and it is worth being exact about how
 * weak. An escaped text child sits in the `<p>` this fix introduced, so a revert
 * that also restores the `<div>` fails here. A revert that keeps the `<p>` and
 * moves the sentence into an HTML sink on it does not: on the two pages whose
 * fallback interpolates identity the escaping assertions above catch that anyway,
 * but on `/contact`, which interpolates nothing, the resulting DOM is identical.
 * The exact guard for that page is therefore a source-level one,
 * `src/app/__tests__/website-hero-header-sink-contract.test.ts`, which bans the
 * composed sentence from a sink expression outright. This assertion stays because
 * it pins the rendered shape all three pages actually ship.
 */
function fallbackHolder(container: HTMLElement, snippet: string) {
  return Array.from(container.querySelectorAll("*")).find(
    (element) =>
      element.children.length === 0 && element.textContent?.includes(snippet),
  );
}

/** Page, its composed fallback's distinctive opening, and whether it interpolates identity. */
const PAGES: Array<[string, PageComponent, string, boolean]> = [
  ["/join", JoinPage as PageComponent, "How to become a member of the", true],
  [
    "/join/apply",
    JoinApplyPage as PageComponent,
    "Enter your details, nominate two current",
    true,
  ],
  [
    "/contact",
    ContactPage as PageComponent,
    "Have a question about the club",
    false,
  ],
];

const IDENTITY_PAGES = PAGES.filter(([, , , interpolates]) => interpolates);

describe("website hero fallbacks render as escaped text (#2819)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getPublishedPageContentByPath.mockResolvedValue(null);
    mocks.buildEmbeddedBody.mockResolvedValue([]);
  });

  afterEach(() => {
    cleanup();
  });

  /**
   * `IDENTITY_PAGES` is what selects the escaping assertions below, and it is
   * derived from a flag written by hand in `PAGES`. Left unchecked, a later edit
   * that made the `/contact` sentence name the club — the obvious way to bring it
   * into line with its two siblings — would leave the flag on `false`, and the
   * escaping assertions would silently never run for the page whose rendered DOM
   * cannot betray a restored sink. So the flag is pinned against what each page
   * actually renders: get it wrong in either direction and this fails.
   */
  it.each(PAGES)(
    "keeps the recorded identity-interpolation of %s honest",
    async (path, Page, _snippet, interpolates) => {
      const { container } = render(await Page());

      expect(
        container.textContent?.includes("<img src=x"),
        `${path} ${interpolates ? "no longer" : "now"} interpolates the club identity — update its PAGES flag`,
      ).toBe(interpolates);
    },
  );

  it.each(IDENTITY_PAGES)(
    "escapes a markup-shaped club name in the %s fallback rather than parsing it",
    async (_path, Page) => {
      const { container } = render(await Page());

      // The dangerous half of the club-set value appears as visible TEXT...
      expect(container.textContent).toContain("<img src=x");
      // ...as ESCAPED markup in the serialised DOM, never as a live element.
      // Asserting on the escaped form rather than on the absence of `onerror=`
      // matters: those characters legitimately survive inside the escaped text,
      // and it is the `&lt;` around them that makes them inert.
      expect(container.innerHTML).toContain("&lt;img src=x");
      expect(container.innerHTML).not.toContain("<img");
      expect(container.querySelector("img")).toBeNull();
    },
  );

  it.each(PAGES)(
    "renders the %s fallback as a text child, not through the HTML sink",
    async (path, Page, snippet) => {
      const { container } = render(await Page());

      const holder = fallbackHolder(container, snippet);

      expect(holder, `no element carries the ${path} fallback`).toBeDefined();
      expect(holder!.tagName).toBe("P");
    },
  );

  /**
   * A row that EXISTS but carries no header — the state a club reaches by
   * clearing the field in Site Appearance & Content, which the admin API accepts
   * (`headerText: z.string()`, no minimum). Distinct from the missing-row cases
   * above: the page's other fields come from the row and the body renders, and
   * only the header falls through. This is the reachable half of the "empty"
   * branch, and pinning it is what makes the security doc's claim testable.
   */
  it.each(PAGES)(
    "falls back to escaped text on a %s row whose header was cleared",
    async (path, Page, snippet) => {
      mocks.getPublishedPageContentByPath.mockResolvedValue(
        publishedRow(path, ""),
      );

      const { container } = render(await Page());

      const holder = fallbackHolder(container, snippet);

      expect(holder, `no element carries the ${path} fallback`).toBeDefined();
      expect(holder!.tagName).toBe("P");
      expect(container.querySelector("img")).toBeNull();
    },
  );

  /**
   * The pages guard the sink with `headerText.trim()`, and this is the only test
   * of the `.trim()` half — so be exact about what it does and does not prove.
   *
   * It is NOT a production state. `getPublishedPageContentByPath()` sanitises
   * `headerText` on read with `sanitizePageContentHtml()`, which ends in
   * `.trim()`, and the admin write path sanitises with the same function before
   * storing — so a whitespace-only header can be neither written nor read, and
   * measured against the real sanitiser `'   '` and `'\t\n '` both become `''`.
   * A stored `''` was already falsy under the previous `||` guard, so `.trim()`
   * changes NO rendered output on any reachable input and there is no
   * operator-visible behaviour change to describe.
   *
   * It is kept as defence in depth, against a header value that reaches a page
   * without passing that sanitiser — `listEditablePageContent()` does not trim,
   * and a future reader need not either. What it pins is that if such a value
   * ever arrives, whitespace is treated as empty rather than handed to the sink.
   * The escaping and text-child properties are pinned on the reachable branches
   * above; this case only needs to show which branch is taken.
   */
  it.each(PAGES)(
    "treats an untrimmed whitespace-only %s header as empty (defence in depth)",
    async (path, Page, snippet) => {
      mocks.getPublishedPageContentByPath.mockResolvedValue(
        publishedRow(path, "   "),
      );

      const { container } = render(await Page());

      const holder = fallbackHolder(container, snippet);

      expect(holder, `no element carries the ${path} fallback`).toBeDefined();
      expect(holder!.tagName).toBe("P");
    },
  );

  it.each(PAGES)(
    "still renders a genuine stored %s header through the HTML sink",
    async (path, Page, snippet) => {
      // The other branch must keep working unchanged: stored `headerText` is
      // admin HTML, sanitised on write and again on read, and clubs format it.
      // This is also the branch every seeded deployment is on today, so it is
      // what proves the visible page did not change.
      mocks.getPublishedPageContentByPath.mockResolvedValue(
        publishedRow(path, "<p>Real <strong>stored</strong> copy.</p>"),
      );

      const { container } = render(await Page());

      expect(container.querySelector("strong")?.textContent).toBe("stored");
      // The fallback must not appear alongside it.
      expect(container.textContent).not.toContain(snippet);
    },
  );
});
