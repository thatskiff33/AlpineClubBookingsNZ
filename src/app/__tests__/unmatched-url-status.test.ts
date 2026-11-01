import { existsSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { autoImplementMethods } from "next/dist/server/route-modules/app-route/helpers/auto-implement-methods";

/**
 * Status codes for URLs nothing serves (#2405).
 *
 * The issue reported a soft 404: unmatched URLs answering `200 OK` while
 * showing the "page not found" screen, so search engines index dead addresses
 * and monitoring cannot tell a missing page from a working one. Two things came
 * out of measuring it, and both are pinned here.
 *
 * 1. The PAGE class was already right. `(website)/[...slug]` claims every
 *    human-plausible mistyped or bot-probed URL and calls `notFound()`; Next's
 *    `HTTPAccessFallbackBoundary` catches that during the render and sets 404.
 *    The reported 200s came from a staging stack that had never completed
 *    site-style setup — see the layout note below. These cases stop the
 *    `notFound()` calls being deleted or narrowed.
 * 2. The API class was wrong, in every configuration. `/api/<anything>` that no
 *    handler claimed fell through to that same CMS PAGE catch-all, so a JSON
 *    client was handed ~23KB of `text/html`. `api/[[...unmatched]]/route.ts` now
 *    terminates those URLs with JSON, bare `/api` included.
 *
 * The "still 200" cases are as load-bearing as the 404s: a change that 404s a
 * published page, or that swallows a real API route, is far worse than the bug.
 *
 * The PRE-SETUP state is pinned here too. On a club whose `ClubTheme.completedAt`
 * is NULL the layout answers with its holding screen rather than the page, and
 * this route deliberately does not raise the miss in that state — a 404 from
 * `generateMetadata()` escapes the layout (the root not-found boundary sits
 * above it), so misses would 404 while published pages still rendered the
 * holding screen, and an anonymous visitor could read off an unlaunched site's
 * page list. #2420 has since answered the wider question by putting a 503 gate
 * in `src/proxy.ts` ahead of the render; these cases stay because a shape the
 * gate does not CLAIM still reaches this route — an asset-extension URL that no
 * route serves, which the gate refuses on purpose — and the oracle must not open
 * for it either.
 */

const mocks = vi.hoisted(() => {
  class NotFoundSignal extends Error {
    constructor() {
      super("NEXT_HTTP_ERROR_FALLBACK;404");
      this.name = "NotFoundSignal";
    }
  }

  return {
    NotFoundSignal,
    getPage: vi.fn(),
    clubIdentity: vi.fn(),
    themeRenderState: vi.fn(),
    buildBody: vi.fn(),
    // The real `notFound()` throws, and callers rely on it never returning.
    // A mock that returned instead would let the code under test carry on down
    // a path it never takes in production, and pass vacuously.
    notFound: vi.fn(() => {
      throw new NotFoundSignal();
    }),
  };
});

const { NotFoundSignal, notFound } = mocks;

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({ notFound: mocks.notFound }));
// The shared factory mirrors the real published filter (#2440) so the
// route-level scenarios below keep exercising the same hidden-page semantics.
vi.mock("@/lib/page-content-html", async () => {
  const { pageContentHtmlModuleMock } = await import(
    "@/lib/__tests__/helpers/page-content-html-mock"
  );
  return pageContentHtmlModuleMock(mocks.getPage, {
    pageContentHtmlToPlainText: (html: string) => html,
  });
});
vi.mock("@/lib/public-layout-config", () => ({
  getCachedClubIdentity: mocks.clubIdentity,
  getCachedWebsiteThemeRenderState: mocks.themeRenderState,
}));
vi.mock("@/lib/page-content-embeds", () => ({
  buildEmbeddedBody: mocks.buildBody,
}));
vi.mock("@/components/website/embedded-page-content-parts", () => ({
  EmbeddedPageContentParts: () => null,
}));

import DynamicWebsitePage, {
  generateMetadata,
} from "@/app/(website)/[...slug]/page";
import * as unmatchedApi from "@/app/api/[[...unmatched]]/route";
import { getFeatureFlagBlockResponse } from "@/proxy";

const publishedPage = {
  id: "page-1",
  slug: "about",
  caption: "About",
  menuTitle: "About",
  title: "About the Club",
  headerText: "<p>Who we are</p>",
  path: "/about",
  sortOrder: 1,
  contentHtml: "<p>Body</p>",
  published: true,
};

function props(...slug: string[]) {
  return { params: Promise.resolve({ slug }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.clubIdentity.mockResolvedValue({ name: "Example Alpine Club" });
  // The ordinary case: a club that has finished site-style setup, which is
  // every club running normally.
  mocks.themeRenderState.mockResolvedValue({ isComplete: true });
  mocks.buildBody.mockResolvedValue([]);
});

/**
 * Every unmatched shape the issue measured. They do not all reach the database:
 * `/.env` and `/foo\0bar` are rejected by the slug rules and `/admin/nope` and
 * `/wp-admin/...` by the reserved-prefix rules, while `/definitely-missing` is
 * a well-formed slug that simply has no row. The real `isValidPageSlug` and
 * `isReservedPageSlug` are deliberately NOT mocked so each shape travels its
 * own path; all six must still end at `notFound()`.
 */
const unmatchedPageUrls: ReadonlyArray<readonly [string, string[]]> = [
  ["/definitely-missing", ["definitely-missing"]],
  ["/wp-admin/setup-config.php", ["wp-admin", "setup-config.php"]],
  ["/.env", [".env"]],
  ["/admin/nope", ["admin", "nope"]],
  // `/foo%00bar` as Next hands it to the segment: percent-decoded, embedded
  // NUL and all. Written as an escape so no raw NUL byte sits in the source.
  ["/foo%00bar", ["foo\u0000bar"]],
];

describe("unmatched page URLs resolve to a 404, not a soft 200", () => {
  it.each(unmatchedPageUrls)(
    "%s raises notFound() from generateMetadata",
    async (_label, slug) => {
      mocks.getPage.mockResolvedValue(null);

      await expect(generateMetadata(props(...slug))).rejects.toBeInstanceOf(
        NotFoundSignal,
      );
      expect(notFound).toHaveBeenCalled();
    },
  );

  it.each(unmatchedPageUrls)(
    "%s raises notFound() from the page component too",
    async (_label, slug) => {
      mocks.getPage.mockResolvedValue(null);

      await expect(DynamicWebsitePage(props(...slug))).rejects.toBeInstanceOf(
        NotFoundSignal,
      );
      expect(notFound).toHaveBeenCalled();
    },
  );

  it("404s a CMS page the admin has unpublished, like a missing one", async () => {
    mocks.getPage.mockResolvedValue({ ...publishedPage, published: false });

    await expect(generateMetadata(props("about"))).rejects.toBeInstanceOf(
      NotFoundSignal,
    );
  });
});

describe("a published CMS page still answers 200", () => {
  it("returns real metadata rather than raising notFound()", async () => {
    mocks.getPage.mockResolvedValue(publishedPage);

    const metadata = await generateMetadata(props("about"));

    expect(notFound).not.toHaveBeenCalled();
    expect(metadata.title).toBe("About the Club");
  });

  it("renders the page component rather than raising notFound()", async () => {
    mocks.getPage.mockResolvedValue(publishedPage);

    await expect(DynamicWebsitePage(props("about"))).resolves.toBeTruthy();
    expect(notFound).not.toHaveBeenCalled();
  });

  // No test pins the React `cache()` memo on `loadPublishedPage`. It only
  // memoises inside a request scope, which a unit test does not have, so a
  // call-count assertion would fail against correct code and pass against
  // broken code; a regex over the source passes on dead code and fails on a
  // rename, which is worse than nothing. The memo is a cost optimisation with
  // no behavioural contract to pin — it is observable in the running app as one
  // `PageContent` read per CMS page render, and that is where to check it.
});

/**
 * The pre-setup state at the ROUTE level, asserted so it stays uniform (#2405
 * security review).
 *
 * With `ClubTheme.completedAt` NULL, the shared public chrome
 * (`src/components/website/website-chrome.tsx`) returns its "Site
 * setup in progress" screen instead of `{children}`: the page component never
 * runs, and misses and real pages are answered identically. A `notFound()` from
 * `generateMetadata()` would break out of that — the root not-found boundary
 * sits ABOVE both public layouts — so unknown paths would answer 404 while published
 * pages still rendered the holding screen. That difference is an enumeration
 * oracle: an anonymous visitor could walk an unlaunched club's site and learn
 * exactly which pages exist, and the 404 body would serve database-backed
 * content the club has not published yet.
 *
 * #2420 answered the wider "what should an unconfigured site say" question in
 * the proxy — 503 with the holding screen, before the render — so an ordinary
 * document request no longer reaches this code pre-setup at all. That did NOT
 * make these cases redundant, and its review round made them stricter.
 *
 * Stricter how: the guard used to consult the setup state only INSIDE
 * `if (!page)`, and that half-measure was the same oracle inverted. Pre-setup a
 * miss returned the bare club name while a HIT still returned the page's own
 * title and header text — and a request could reach this code by skipping the
 * proxy matcher's prefetch exemption. Suppressing `{children}` in the layout does
 * not help, because next@16.2.11 builds the document head as a separate flight
 * slot from the page's seed data, so metadata is produced even when the component
 * never runs.
 *
 * #2404 CLOSED the header route in — the matcher's prefetch exemption is gone
 * outright, so no header a caller can set skips the proxy — and every case below
 * still stands, because the gate has a second precondition. It answers only for
 * a path `isPublicWebsitePath()` claims, and asset-extension paths are refused
 * on purpose: the holding screen is an HTML document and must never answer a
 * request for an image. A URL of that shape that no route claims still reaches
 * this code with no gate in front of it — `/API/x.png`, which the asset
 * rewrites exclude along with the rest of `/api` and which then matches no
 * `/api` route either, because Next's route table is case-sensitive. The point
 * of this suite is that the answer must be
 * uniform whether or not the gate ran.
 *
 * The property is therefore UNIFORMITY, not "misses are hidden": pre-setup,
 * hit, miss and unpublished must be indistinguishable. Full coverage of that
 * across every `(website)` page lives in
 * `src/lib/__tests__/website-metadata-setup-gate.test.ts`; the status contract
 * lives in `src/lib/__tests__/setup-gate.test.ts`.
 */
describe("a club that has not finished site-style setup discloses nothing", () => {
  beforeEach(() => {
    mocks.themeRenderState.mockResolvedValue({ isComplete: false });
  });

  it("does not raise notFound() for an unknown page — the holding screen answers", async () => {
    mocks.getPage.mockResolvedValue(null);

    const metadata = await generateMetadata(props("definitely-missing"));

    expect(notFound).not.toHaveBeenCalled();
    expect(metadata.title).toBe("Site setup in progress");
  });

  it("does not raise notFound() for an unpublished page either", async () => {
    mocks.getPage.mockResolvedValue({ ...publishedPage, published: false });

    const metadata = await generateMetadata(props("about"));

    expect(metadata.title).toBe("Site setup in progress");
    expect(notFound).not.toHaveBeenCalled();
  });

  it("gives a PUBLISHED page the same answer, so existence cannot be read off", async () => {
    mocks.getPage.mockResolvedValue(publishedPage);

    const metadata = await generateMetadata(props("about"));

    expect(notFound).not.toHaveBeenCalled();
    expect(metadata.title).toBe("Site setup in progress");
    expect(JSON.stringify(metadata)).not.toContain("About the Club");
  });

  it("does not even look the page up", async () => {
    // The check runs first, so an unlaunched club issues no PageContent read at
    // all for a probed URL — there is nothing to time, either.
    mocks.getPage.mockResolvedValue(publishedPage);

    await generateMetadata(props("about"));

    expect(mocks.getPage).not.toHaveBeenCalled();
  });
});

/**
 * The handler Next actually runs for a verb on this route, rather than the
 * export list. `autoImplementMethods()` is the framework's own resolver
 * (`route-modules/app-route/module.js` calls it for every request), so putting
 * it in front of the assertions means HEAD is tested as it is SERVED — derived
 * from GET — instead of as the file happens to spell it.
 */
function routeHandlerFor(method: string) {
  const handlers = autoImplementMethods(unmatchedApi) as unknown as Record<
    string,
    () => Response
  >;
  return handlers[method];
}

describe("unmatched /api URLs answer JSON, not the website's HTML", () => {
  const exportedMethods = [
    "GET",
    "POST",
    "PUT",
    "PATCH",
    "DELETE",
    "OPTIONS",
  ] as const;

  it.each(exportedMethods)("%s returns 404 with a JSON body", async (method) => {
    const response = unmatchedApi[method]();

    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/json");
    await expect(response.json()).resolves.toEqual({ error: "Not found" });
  });

  it("covers bare /api as well, by being an OPTIONAL catch-all", () => {
    // A required catch-all (`[...unmatched]`) matches one segment or more, so
    // `/api` and `/api/` fell through to the CMS page and were answered with
    // ~23KB of text/html on a configured club — and with the holding screen's
    // 200 on an unconfigured one. Routing is a filesystem fact, so this is the
    // level at which it can be pinned without a running server; the E2E suite
    // asks the real server for both URLs.
    const apiDir = path.join(process.cwd(), "src/app/api");

    expect(existsSync(path.join(apiDir, "[[...unmatched]]/route.ts"))).toBe(
      true,
    );
    expect(existsSync(path.join(apiDir, "[...unmatched]"))).toBe(false);
    // Nothing may sit at /api itself, or it would claim the bare path first.
    expect(existsSync(path.join(apiDir, "route.ts"))).toBe(false);
    expect(existsSync(path.join(apiDir, "page.tsx"))).toBe(false);
  });

  it("does not hand-write HEAD, so HEAD carries GET's headers", () => {
    // A hand-written `new NextResponse(null, { status: 404 })` carried NO
    // content-type, while the module gate answers HEAD with its JSON response
    // and its content-type. That single header difference let one anonymous
    // HEAD request read off whether an optional module was switched on.
    // Next fills HEAD in from GET and strips the body downstream, which keeps
    // the headers identical by construction.
    expect("HEAD" in unmatchedApi).toBe(false);
    expect(routeHandlerFor("HEAD")).toBe(unmatchedApi.GET);
  });

  /**
   * Byte-for-byte parity with the module gate, driven over EVERY verb.
   *
   * A caller must not be able to tell a route that does not exist from one a
   * disabled module is hiding — otherwise a single anonymous request reads off
   * which optional modules a club runs. Compared as raw text rather than parsed
   * JSON on purpose: parsing hides key order and whitespace, and both paths
   * have to agree on the bytes, not just the meaning. The content-type is
   * compared for the same reason — it was the header the old hand-written HEAD
   * got wrong.
   */
  describe("is indistinguishable from a path hidden by a disabled module", () => {
    const choresOff = { chores: false } as never;
    // HEAD included: it is the verb the oracle was found on, and going through
    // `routeHandlerFor` compares what Next ACTUALLY runs rather than what the
    // module happens to export. The framework strips a HEAD body on the way out
    // for the gate response too, so the headers are the thing that has to match.
    const servedMethods = [
      "GET",
      "HEAD",
      "POST",
      "PUT",
      "PATCH",
      "DELETE",
      "OPTIONS",
    ] as const;

    it.each(servedMethods)("%s matches the gate exactly", async (method) => {
      const gated = getFeatureFlagBlockResponse(
        "/api/chores/zzz",
        choresOff,
        method,
      );
      const unmatched = routeHandlerFor(method)();

      expect(gated).not.toBeNull();
      expect(gated!.status).toBe(unmatched.status);
      expect(gated!.headers.get("content-type")).toBe(
        unmatched.headers.get("content-type"),
      );
      await expect(gated!.text()).resolves.toBe(await unmatched.text());
    });

    it("carries no `vary` of its own — the known, accepted difference", () => {
      // Recorded as a measurement rather than left to prose, because the doc
      // (`docs/SECURITY-ATTACK-SURFACE.md`, "known and accepted") states it and
      // a claim in that file has to be checkable.
      //
      // The gate answers from middleware and the reply never enters the render
      // pipeline. With the module ON the same address is served by an app route
      // handler, and `base-server.js`'s `setVaryHeader` appends
      // `vary: RSC, Next-Router-State-Tree, …` for every app path before any
      // handler runs — so the module-ON reply carries a `vary` this one does
      // not. Only the middleware half is measurable here; the route-handler half
      // is traced through the framework, not asserted, and that asymmetry is
      // stated in the doc rather than papered over.
      const gated = getFeatureFlagBlockResponse("/api/chores/zzz", choresOff);

      expect(gated!.headers.get("vary")).toBeNull();
    });

    it.each(["PROPFIND", "TRACE", "MKCOL"])(
      "%s gets the same bare 400 the framework gives a live route",
      async (method) => {
        // Next's app-route module rejects any verb outside its seven standard
        // ones with `new Response(null, { status: 400 })` BEFORE resolving a
        // handler (`route-modules/app-route/module.js`), so with the module ON
        // that is what `/api/chores/zzz` answers. The gate used to answer the
        // JSON 404 instead, which made the module's state readable: 400 means
        // on, 404 means off. It now mirrors the framework.
        const gated = getFeatureFlagBlockResponse(
          "/api/chores/zzz",
          choresOff,
          method,
        );

        expect(gated!.status).toBe(400);
        expect(gated!.headers.get("content-type")).toBeNull();
        await expect(gated!.text()).resolves.toBe("");
      },
    );

    it("keeps the empty 404 for other verbs on gated PAGE paths", async () => {
      // The 400 mirrors the ROUTE-HANDLER contract. A page is served by a
      // different Next module with different verb handling, so for any verb but
      // a page-shaped GET or HEAD (which get a titled document, #4466, below) the
      // gate keeps its bodyless 404 rather than asserting a parity nobody measured.
      const gated = getFeatureFlagBlockResponse(
        "/admin/chores",
        choresOff,
        "PROPFIND",
      );

      expect(gated!.status).toBe(404);
      expect(gated!.headers.get("content-type")).toBeNull();
      await expect(gated!.text()).resolves.toBe("");
    });

    it.each(["GET", "HEAD"])(
      "answers a page-shaped %s with a titled, language-tagged document (#4466)",
      async (method) => {
        // An empty 404 renders as a blank page with no title and no language,
        // which is what a browser following a link to a switched-off feature
        // showed. Same status; now a document a person can read.
        const gated = getFeatureFlagBlockResponse("/admin/chores", choresOff, method);

        expect(gated!.status).toBe(404);
        expect(gated!.headers.get("content-type")).toBe("text/html; charset=utf-8");
        const body = await gated!.text();
        expect(body).toMatch(/^<!doctype html>\n<html lang="en">/);
        expect(body).toContain("<title>Page not found</title>");
        // Fixed words: nothing names the module that is switched off.
        expect(body.toLowerCase()).not.toContain("chore");
        expect(body).not.toMatch(/<script|<style|style=/);
      },
    );
  });
});
