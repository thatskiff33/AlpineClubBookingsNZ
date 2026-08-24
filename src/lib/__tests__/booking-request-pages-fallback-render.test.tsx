// @vitest-environment jsdom

import { render } from "@/lib/__tests__/support/club-time-render";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { starterPageContent } from "../../../prisma/starter-page-content";
import {
  BUILT_IN_DYNAMIC_PAGE_SLUGS,
  PER_REQUEST_WEBSITE_ROUTES,
} from "@/lib/public-website-paths";

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
    name: "Test Alpine Club",
    lodgeName: LODGE_NAME,
    hutLeaderLabel: "Hut Leader",
    lodgeCapacity: 20,
  }),
  getCachedDefaultLodgeCapacity: async () => 47,
}));

// The forms fetch on mount; nothing here asserts on their contents.
vi.stubGlobal(
  "fetch",
  vi.fn(async () => ({ ok: true, json: async () => ({}) })),
);

/**
 * A lodge name carrying markup a club could plausibly type, and which a sanitiser
 * has never seen — `lodgeName` is a free-text club identity field, not page HTML.
 */
const LODGE_NAME = 'Test Lodge <img src=x onerror="alert(1)">';

import BookingRequestsPage from "@/app/(website-dynamic)/booking-requests/page";
import SchoolBookingsPage from "@/app/(website-dynamic)/school-bookings/page";

/**
 * The hero section — the only part of either page under test here.
 *
 * The scoping is load-bearing, and it was measured rather than assumed: both forms
 * restate the hero's sentence in their own copy, interpolating the same
 * club-set `lodgeName` (`booking-request-form.tsx:242`,
 * `school-booking-form.tsx:249`, and again at :227/:236/:389). So the payload
 * appears in `container.textContent` whether or not the hero rendered its fallback
 * at all, and a page-wide "contains the payload" assertion would pass vacuously —
 * including on the very regression this suite exists to catch, where the hero hands
 * the sentence back to `dangerouslySetInnerHTML`. Reading the hero's own element
 * makes each assertion about the branch it names.
 *
 * Absence of a live `<img>` is still asserted page-wide, because there the whole
 * document is the claim: no branch anywhere may parse that value as markup.
 */
function hero(container: HTMLElement): HTMLElement {
  const section = container.querySelector<HTMLElement>("section.dynamic-header");
  expect(section, "the page must render its hero section").not.toBeNull();
  return section!;
}

/** A published row, with whatever header text the case under test needs. */
function publishedRow(headerText: string) {
  return {
    slug: "x",
    caption: "Cap",
    menuTitle: "",
    title: "Title",
    headerText,
    path: "/x",
    sortOrder: 1,
    contentHtml: "",
    published: true,
  };
}

/**
 * What each page does when its `PageContent` row is missing or unpublished
 * (#2818 decisions 1 and 6).
 *
 * This is not an edge case: it is the state every deployment is in between
 * upgrading the code and running the backfill migration, and the state a club
 * lands in if the row is ever hidden. The page must still render its form — the
 * feature cannot depend on a CMS row existing — and, crucially, the composed
 * fallback header must render as TEXT.
 *
 * That last point is the whole of decision 6. The fallback interpolates
 * `lodgeName`, which no sanitiser has touched, and the original code passed it to
 * `dangerouslySetInnerHTML` under a comment claiming it was "sanitised on read".
 * The comment described the OTHER branch.
 */
describe("the form pages render without a PageContent row (#2818)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getPublishedPageContentByPath.mockResolvedValue(null);
    mocks.buildEmbeddedBody.mockResolvedValue([]);
  });

  it.each([
    ["booking requests", BookingRequestsPage, "Request a stay"],
    ["school bookings", SchoolBookingsPage, "For schools & groups"],
  ])(
    "renders the bare %s form and its default heading",
    async (_label, Page, caption) => {
      const { container } = render(await Page());

      expect(container.textContent).toContain(caption);
      // The form itself, not just the chrome: each renders a submit control.
      expect(container.querySelector("form, input, button")).not.toBeNull();
    },
  );

  it.each([
    ["booking requests", BookingRequestsPage],
    ["school bookings", SchoolBookingsPage],
  ])(
    "escapes the composed %s fallback rather than parsing it as HTML",
    async (_label, Page) => {
      const { container } = render(await Page());
      const header = hero(container);

      // The dangerous half of the club-set value must appear as visible TEXT in
      // the hero itself (see `hero()` for why the page-wide read proves nothing)...
      expect(header.textContent).toContain("<img src=x");
      // ...as ESCAPED markup in the serialised DOM, never as a live element.
      // Asserting on the escaped form rather than on the absence of the string
      // `onerror=` matters: those characters legitimately survive INSIDE the
      // escaped text, and it is the `&lt;` around them that makes them inert.
      expect(header.innerHTML).toContain("&lt;img src=x");
      expect(header.innerHTML).not.toContain("<img");
      expect(container.querySelector("img")).toBeNull();
    },
  );

  it.each([
    ["booking requests", BookingRequestsPage],
    ["school bookings", SchoolBookingsPage],
  ])(
    "still uses the HTML sink for a genuine stored %s header",
    async (_label, Page) => {
      // The other branch must keep working: stored `headerText` is admin HTML,
      // sanitised on write and again on read, and clubs format it.
      mocks.getPublishedPageContentByPath.mockResolvedValue(
        publishedRow("<p>Real <strong>stored</strong> copy.</p>"),
      );

      const { container } = render(await Page());

      expect(hero(container).querySelector("strong")?.textContent).toBe("stored");
    },
  );

  /**
   * A row that EXISTS but carries no header — the state a club reaches by clearing
   * the field in Site Appearance & Content, which the admin API accepts
   * (`headerText: z.string()`, with no minimum). This is the REACHABLE half of the
   * empty branch, distinct from the missing-row cases above: the rest of the page
   * still comes from the row, and only the header falls through. Pinning it is what
   * makes the security surface doc's claim about a cleared field testable.
   */
  it.each([
    ["booking requests", BookingRequestsPage],
    ["school bookings", SchoolBookingsPage],
  ])(
    "falls back to escaped text on a %s row whose header was cleared",
    async (_label, Page) => {
      mocks.getPublishedPageContentByPath.mockResolvedValue(publishedRow(""));

      const { container } = render(await Page());
      const header = hero(container);

      // The row supplied the rest of the hero, so this also proves the fallback is
      // reached for the header ALONE rather than because the page gave up on the row.
      expect(header.textContent).toContain("Cap");
      expect(header.textContent).toContain("<img src=x");
      expect(header.innerHTML).toContain("&lt;img src=x");
      expect(header.innerHTML).not.toContain("<img");
      expect(container.querySelector("img")).toBeNull();
    },
  );

  /**
   * A header of nothing but whitespace. The pages guard the sink with
   * `headerText.trim()`, and this is the only test of that half — so be exact about
   * what it proves. The fallback IS reached, which is the point: whitespace is
   * treated as empty rather than handed to the sink.
   *
   * It is not a production state. `getPublishedPageContentByPath()` sanitises
   * `headerText` on read with `sanitizePageContentHtml()`, which ends in `.trim()`,
   * and the admin write path sanitises with the same function before storing — so
   * `'   '` can be neither written nor read. It is kept as defence in depth against
   * some future reader that skips that sanitiser.
   */
  it.each([
    ["booking requests", BookingRequestsPage],
    ["school bookings", SchoolBookingsPage],
  ])(
    "treats an untrimmed whitespace-only %s header as empty (defence in depth)",
    async (_label, Page) => {
      mocks.getPublishedPageContentByPath.mockResolvedValue(publishedRow("   "));

      const { container } = render(await Page());
      const header = hero(container);

      // A `<p>` holding the payload as text is the fallback branch; the sink branch
      // renders a `<div>` instead, so the tag is what tells the two apart.
      expect(header.querySelector("p")?.textContent).toContain("<img src=x");
      expect(header.innerHTML).toContain("&lt;img src=x");
      expect(container.querySelector("img")).toBeNull();
    },
  );
});

describe("the built-in dynamic page allowlist stays honest (#2818 decision 2)", () => {
  it("names only slugs a real per-request route serves", () => {
    // A slug on this list may carry a nav link, so an entry with no route behind
    // it is a link to a 404. Checked against the census the render-mode gate
    // keeps equal to the route tree.
    for (const slug of BUILT_IN_DYNAMIC_PAGE_SLUGS) {
      expect(
        PER_REQUEST_WEBSITE_ROUTES as readonly string[],
        `${slug} must be served by a (website-dynamic) route`,
      ).toContain(`/${slug}`);
    }
  });

  it("names only slugs that have a seeded PageContent row", () => {
    // The menu entry comes from a row, so a slug with no row could never be
    // listed and being on the list would be misleading.
    const seeded = new Set(starterPageContent.map((page) => page.slug));
    for (const slug of BUILT_IN_DYNAMIC_PAGE_SLUGS) {
      expect(seeded, `${slug} must have a starter row`).toContain(slug);
    }
  });

  it("seeds every allowlisted page unlisted, so advertising stays opt-in", () => {
    for (const slug of BUILT_IN_DYNAMIC_PAGE_SLUGS) {
      const page = starterPageContent.find((entry) => entry.slug === slug);
      expect(page!.menuTitle, `${slug} must seed an empty menu title`).toBe("");
    }
  });

  it("is not empty, so the assertions above are not vacuous", () => {
    expect(BUILT_IN_DYNAMIC_PAGE_SLUGS.size).toBeGreaterThan(0);
  });
});
