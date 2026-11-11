import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The `<head>` half of the pre-setup holding screen (#2420 review finding F1).
 *
 * The gate in `src/proxy.ts` answers 503 for every public-website address until
 * setup is complete — but its matcher used to skip any request carrying
 * `next-router-prefetch` or `purpose: prefetch`, ordinary request headers anyone
 * can set, so `curl -H 'Purpose: prefetch' https://club/about` reached the app
 * directly. #2404 deleted that exemption outright (owner decision, 1 Aug 2026),
 * and no header now takes a URL outside the proxy.
 *
 * This guard is not demoted by that, because the gate answers only for a path
 * `isPublicWebsitePath()` CLAIMS. An asset-extension path is deliberately not
 * claimed — the holding screen is an HTML document and must never be the answer
 * to a request for an image — so any such URL that still reaches a render
 * arrives with no gate in front of it. `/API/x.png` is the live example: Next's
 * route table is case-sensitive, so it matches no `/api` route and the
 * `(website)` catch-all renders it. The head that ships for it must be as
 * uniform as the one the 503 would have carried.
 *
 * `(website)/layout.tsx` substitutes the holding screen for `{children}` on
 * those requests, which suppresses the BODY only: in next@16.2.11 the document
 * head is a separate flight slot from the page's seed data, so
 * `generateMetadata()` still runs and still emits `<title>` and
 * `<meta name="description">`. Pre-setup that let an anonymous prober with a
 * slug wordlist read an unlaunched club's page inventory, each page's title, and
 * its header text — at the time including pages never published, because
 * `/contact` and `/join` looked their content up with no `published === false`
 * filter (closed by #2440's shared published-filtering read).
 *
 * So the property under test is UNIFORMITY, not "misses are hidden": pre-setup,
 * a page that exists, a page that does not, and a page that exists but is
 * unpublished must all answer with the same neutral holding-screen head. A guard
 * that fired only on the miss path would be the same oracle inverted.
 */

const mocks = vi.hoisted(() => ({
  themeState: vi.fn(),
  clubIdentity: vi.fn(),
  getPage: vi.fn(),
  buildBody: vi.fn(),
  defaultLodgeId: vi.fn(),
  notFound: vi.fn(() => {
    throw new Error("NEXT_HTTP_ERROR_FALLBACK;404");
  }),
}));

vi.mock("next/navigation", () => ({ notFound: mocks.notFound }));
vi.mock("@/lib/public-layout-config", () => ({
  getCachedClubIdentity: mocks.clubIdentity,
  getCachedWebsiteThemeRenderState: mocks.themeState,
}));
// Shared factory mirrors the real published filter (#2440).
vi.mock("@/lib/page-content-html", async () => {
  const { pageContentHtmlModuleMock } = await import(
    "@/lib/__tests__/helpers/page-content-html-mock"
  );
  return pageContentHtmlModuleMock(mocks.getPage, {
    pageContentHtmlToPlainText: (html: string) => html,
  });
});
vi.mock("@/lib/page-content-embeds", () => ({
  buildEmbeddedBody: mocks.buildBody,
}));
vi.mock("@/lib/lodges", () => ({ getDefaultLodgeId: mocks.defaultLodgeId }));
vi.mock("@/components/website/embedded-page-content-parts", () => ({
  EmbeddedPageContentParts: () => null,
}));
vi.mock("@/components/website/contact-page-client", () => ({
  ContactPageClient: () => null,
}));
vi.mock("@/components/website/join-apply-page-client", () => ({
  JoinApplyPageClient: () => null,
}));

import { SETUP_IN_PROGRESS_COPY } from "@/lib/setup-in-progress-screen";
import { generateMetadata as slugMetadata } from "@/app/(website)/[...slug]/page";
import { generateMetadata as homeMetadata } from "@/app/(website)/page";
import { generateMetadata as contactMetadata } from "@/app/(website)/contact/page";
import { generateMetadata as joinMetadata } from "@/app/(website)/join/page";
import { generateMetadata as joinApplyMetadata } from "@/app/(website)/join/apply/page";

const publishedPage = {
  id: "page-1",
  slug: "about",
  caption: "About",
  menuTitle: "About",
  title: "Secret Committee Handbook",
  headerText: "<p>Header text nobody outside the club should read yet</p>",
  path: "/about",
  sortOrder: 1,
  contentHtml: "<p>Body</p>",
  published: true,
};

/**
 * Every `(website)` metadata entry point, called the way Next calls it.
 * `[...slug]` is the only one that takes params.
 */
const metadataRoutes = [
  ["/", () => homeMetadata()],
  ["/contact", () => contactMetadata()],
  ["/join", () => joinMetadata()],
  ["/join/apply", () => joinApplyMetadata()],
  ["/<cms-slug>", () => slugMetadata({ params: Promise.resolve({ slug: ["about"] }) })],
] as const;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.clubIdentity.mockResolvedValue({ name: "Example Alpine Club" });
  mocks.buildBody.mockResolvedValue([]);
  mocks.defaultLodgeId.mockResolvedValue("lodge-1");
});

describe("pre-setup, no (website) page describes itself in the document head", () => {
  beforeEach(() => {
    mocks.themeState.mockResolvedValue({ isComplete: false, css: "" });
  });

  it.each(metadataRoutes)(
    "%s answers the neutral holding-screen head when the page EXISTS",
    async (_label, run) => {
      mocks.getPage.mockResolvedValue(publishedPage);

      const metadata = await run();

      expect(metadata.title).toBe(SETUP_IN_PROGRESS_COPY.eyebrow);
      expect(metadata.description).toBeUndefined();
      expect(metadata.robots).toEqual({ index: false, follow: false });
    },
  );

  it.each(metadataRoutes)(
    "%s answers the same head when the page does NOT exist",
    async (_label, run) => {
      mocks.getPage.mockResolvedValue(null);

      const metadata = await run();

      expect(metadata.title).toBe(SETUP_IN_PROGRESS_COPY.eyebrow);
      expect(mocks.notFound).not.toHaveBeenCalled();
    },
  );

  it.each(metadataRoutes)(
    "%s answers the same head for an UNPUBLISHED page",
    async (_label, run) => {
      // /contact and /join read their content with no published filter, so this
      // is the case that leaked hardest before the fix.
      mocks.getPage.mockResolvedValue({ ...publishedPage, published: false });

      const metadata = await run();

      expect(metadata.title).toBe(SETUP_IN_PROGRESS_COPY.eyebrow);
    },
  );

  it("never discloses a real title or header text on any path", async () => {
    for (const page of [publishedPage, { ...publishedPage, published: false }, null]) {
      mocks.getPage.mockResolvedValue(page);

      for (const [, run] of metadataRoutes) {
        const serialised = JSON.stringify(await run());

        expect(serialised).not.toContain("Secret Committee Handbook");
        expect(serialised).not.toContain("Header text nobody outside");
      }
    }
  });

  it("matches the <title> of the 503 document byte for byte", async () => {
    // The gated response and the ungated one must describe the same screen; the
    // 503 document titles itself with the same string.
    mocks.getPage.mockResolvedValue(publishedPage);

    expect((await homeMetadata()).title).toBe(SETUP_IN_PROGRESS_COPY.eyebrow);
  });

  it("reads the setup state through the layout's own cache, not a new query", async () => {
    mocks.getPage.mockResolvedValue(publishedPage);

    await homeMetadata();

    expect(mocks.themeState).toHaveBeenCalledTimes(1);
  });
});

describe("with setup complete, metadata is exactly as before", () => {
  beforeEach(() => {
    mocks.themeState.mockResolvedValue({ isComplete: true, css: "" });
  });

  it("returns a published CMS page's own title and description", async () => {
    mocks.getPage.mockResolvedValue(publishedPage);

    const metadata = await slugMetadata({
      params: Promise.resolve({ slug: ["about"] }),
    });

    expect(metadata.title).toBe("Secret Committee Handbook");
    expect(mocks.notFound).not.toHaveBeenCalled();
  });

  it("still raises notFound() for a CMS miss", async () => {
    mocks.getPage.mockResolvedValue(null);

    await expect(
      slugMetadata({ params: Promise.resolve({ slug: ["definitely-missing"] }) }),
    ).rejects.toThrow("NEXT_HTTP_ERROR_FALLBACK;404");
  });

  it("still returns the home page's own title", async () => {
    mocks.getPage.mockResolvedValue(publishedPage);

    expect((await homeMetadata()).title).toBe("Secret Committee Handbook");
  });

  it("still falls back to the static titles on the fixed routes", async () => {
    mocks.getPage.mockResolvedValue(null);

    expect((await contactMetadata()).title).toBe("Contact Us");
    expect((await joinMetadata()).title).toBe("Join the Club");
    expect((await joinApplyMetadata()).title).toBe("Apply for Membership");
  });
});

/**
 * The behavioural cases above only cover the pages that exist today. This is
 * what stops a NEW public page reopening the hole: any page that exports
 * `generateMetadata` must route through the shared helper.
 *
 * BOTH public route groups are walked. The D1 narrowing (3 Aug 2026) moved
 * `/hut-leader-instructions`, `/join/[code]` and `/join/verify/[token]` into
 * `src/app/(website-dynamic)`, and walking `(website)` alone would have left half
 * the public website uncovered: the render-mode census forces a new page there to be
 * placed deliberately, but nothing would have required its HEAD to be gated, so a
 * `generateMetadata` reading club content could have disclosed a real `<title>`
 * pre-setup while the chrome suppressed the body. Same shape as
 * `setup-gate.test.ts`'s `PUBLIC_WEBSITE_GROUPS`.
 */
const PUBLIC_WEBSITE_GROUPS = ["src/app/(website)", "src/app/(website-dynamic)"];

describe("every public website page keeps the head gated", () => {
  it("calls setupInProgressMetadata() from each generateMetadata", () => {
    const pages: string[] = [];

    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.name === "page.tsx") {
          pages.push(full);
        }
      }
    };

    for (const group of PUBLIC_WEBSITE_GROUPS) {
      walk(path.join(process.cwd(), group));
    }

    const ungated = pages.filter((file) => {
      const source = readFileSync(file, "utf8");
      // A page with no generateMetadata inherits the root layout's, which never
      // reads club content, so it has nothing to disclose.
      if (!source.includes("export async function generateMetadata")) {
        return false;
      }
      return !source.includes("setupInProgressMetadata()");
    });

    expect(ungated.map((file) => path.relative(process.cwd(), file))).toEqual(
      [],
    );
    // Guards the walk itself: an empty page list would pass vacuously, and so would
    // one that silently covered only the first group.
    expect(pages.length).toBeGreaterThan(3);
    for (const group of PUBLIC_WEBSITE_GROUPS) {
      expect(
        pages.filter((file) =>
          path.relative(process.cwd(), file).split(path.sep).join("/").startsWith(group),
        ).length,
        `${group} contributed no pages to the walk`,
      ).toBeGreaterThan(0);
    }
  });
});
