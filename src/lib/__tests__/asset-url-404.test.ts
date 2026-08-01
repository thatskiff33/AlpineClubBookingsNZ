import { describe, expect, it } from "vitest";
import { unstable_doesMiddlewareMatch as unstable_doesProxyMatch } from "next/experimental/testing/server";
import { getPathMatch } from "next/dist/shared/lib/router/utils/path-match";
import { autoImplementMethods } from "next/dist/server/route-modules/app-route/helpers/auto-implement-methods";
import {
  ASSET_EXTENSION_MISS_SOURCE,
  ASSET_NOT_FOUND_PATH,
  ASSET_NOT_FOUND_REWRITES,
  ASSET_URL_EXTENSIONS,
  NEXT_STATIC_MISS_SOURCE,
} from "@/lib/asset-url-404";
import * as assetNotFoundRoute from "@/app/asset-not-found/route";
import { config } from "../../proxy";

/**
 * The standing invariant this file exists to hold (#2404):
 *
 *   **No URL may reach a page render without the proxy having minted a CSP
 *   nonce for it.**
 *
 * Production CSP is nonce-only (`script-src 'self' 'nonce-…'`, `src/lib/csp.ts`)
 * and the nonce comes from `src/proxy.ts`, which by design does not run on
 * static-asset shapes. Before this work a MISS on one of those shapes fell
 * through to the `(website)/[...slug]` CMS catch-all and rendered the club's 404
 * document anyway: measured on the merged #2434 build, `GET /foo.png` answered
 * 404 with ~29KB of `text/html`, **no `Content-Security-Policy` header** and
 * **19 unnonced inline `<script>` tags**, every one of them then blocked by
 * `Caddyfile`'s nonce-free `default-src 'self'` fallback.
 *
 * `scripts/ci/check-prerendered-script-nonces.mjs` cannot see this class at all —
 * it reads emitted prerender HTML, and these responses are rendered per request.
 * So the property is pinned here instead, at the level where it is decided:
 * every shape is covered by exactly one of three mechanisms, and a shape covered
 * by none is the bug.
 *
 * `e2e/asset-url-404.spec.ts` measures the same shapes on the wire against a
 * running server; this suite is what fails without a stack, in the ordinary
 * `npm test` run, the moment the matcher or the rewrite rules stop agreeing.
 */

/** How a given URL shape is kept away from an unnonced page render. */
type Coverage =
  /** `src/proxy.ts` runs: a nonce is minted and the CSP header is set. */
  | "proxy"
  /** An `afterFiles` rewrite terminates it with an empty 404, no document. */
  | "asset-404"
  /** Under `/api`: terminated as JSON by a route handler, never a document. */
  | "api-json"
  /** The image optimiser: a real handler that answers a short 400, never HTML. */
  | "image-optimiser";

const matchesNextStaticMiss = getPathMatch(NEXT_STATIC_MISS_SOURCE);
const matchesAssetExtensionMiss = getPathMatch(ASSET_EXTENSION_MISS_SOURCE);

function coverageFor(pathname: string): Coverage[] {
  const covers: Coverage[] = [];

  if (unstable_doesProxyMatch({ config, nextConfig: {}, url: pathname })) {
    covers.push("proxy");
  }
  if (
    matchesNextStaticMiss(pathname) !== false ||
    matchesAssetExtensionMiss(pathname) !== false
  ) {
    covers.push("asset-404");
  }
  if (pathname === "/api" || pathname.startsWith("/api/")) {
    covers.push("api-json");
  }
  if (pathname === "/_next/image") {
    covers.push("image-optimiser");
  }

  return covers;
}

/**
 * Every shape measured while fixing #2404, and the mechanisms that must cover
 * it. Several rows carry TWO — that is the layering working, not redundancy to
 * be tidied away: the proxy nonces the response, and the rewrite stops it being
 * a 29KB document in the first place.
 *
 * Read the `asset-404` rows as "cannot render a document", NOT as "returns 404".
 * `/branding/logo.example.png` is a real file, served by the filesystem stage
 * that Next checks BEFORE any `afterFiles` rewrite, so the rule is never
 * consulted for it. That ordering is what keeps real assets working and is
 * asserted on the wire in `e2e/asset-url-404.spec.ts`, which a route table
 * cannot show.
 */
const shapes: ReadonlyArray<readonly [string, Coverage[]]> = [
  // Ordinary pages and page-shaped misses.
  ["/", ["proxy"]],
  ["/about", ["proxy"]],
  ["/definitely-missing", ["proxy"]],
  ["/wp-admin/setup-config.php", ["proxy"]],
  ["/admin/nope", ["proxy"]],
  // The prefix anchors added in #2404. `api` and `_next/static` were bare
  // prefixes, so these page-shaped URLs were skipped by the proxy and answered
  // with 18 unnonced inline scripts and no CSP header at all.
  ["/apixyz", ["proxy"]],
  ["/apiary/tour", ["proxy"]],
  ["/_next/staticfoo", ["proxy"]],
  ["/_next/imagemap", ["proxy"]],
  ["/_next/image/x", ["proxy"]],
  ["/_next/static", ["proxy", "asset-404"]],
  // Asset-shaped URLs: nonced by the proxy AND kept away from a render.
  ["/foo.png", ["proxy", "asset-404"]],
  ["/foo.jpg", ["proxy", "asset-404"]],
  ["/foo.jpeg", ["proxy", "asset-404"]],
  ["/foo.gif", ["proxy", "asset-404"]],
  ["/foo.webp", ["proxy", "asset-404"]],
  ["/foo.svg", ["proxy", "asset-404"]],
  ["/foo.ico", ["proxy", "asset-404"]],
  ["/favicon.ico", ["proxy", "asset-404"]],
  ["/logo.png", ["proxy", "asset-404"]],
  ["/wp-content/uploads/x.jpg", ["proxy", "asset-404"]],
  ["/branding/favicon.ico", ["proxy", "asset-404"]],
  ["/branding/logo.example.png", ["proxy", "asset-404"]],
  ["/_next/static/chunks/nope.js", ["asset-404"]],
  // An extension nobody listed. It renders the club's 404 page rather than an
  // empty one — a wasted render, and NOT a missing nonce. This row is the point
  // of the layering: the extension list is allowed to go stale.
  ["/foo.avif", ["proxy"]],
  // Case variants. This matcher is compiled case-SENSITIVELY and Next's
  // rewrites case-INSENSITIVELY, which is exactly how `/API/x.png` used to fall
  // between the two and answer 404 with ~29KB of unnonced HTML.
  ["/API/x.png", ["proxy"]],
  ["/Api/does-not-exist.png", ["proxy"]],
  ["/FOO.PNG", ["proxy", "asset-404"]],
  // `/api`: src/app/api/[[...unmatched]]/route.ts answers JSON.
  ["/api", ["api-json"]],
  ["/api/does-not-exist", ["api-json"]],
  ["/api/does-not-exist.png", ["api-json"]],
  ["/api/health", ["api-json"]],
  // The image optimiser answers its own short plain-text 400, never a document.
  // Measured: 27-57 bytes, no `<script>`, while a real optimise still 200s.
  ["/_next/image", ["image-optimiser"]],
];

describe("no URL reaches a page render without a CSP nonce (#2404)", () => {
  it.each(shapes)("%s is covered by %s", (pathname, expected) => {
    expect(
      coverageFor(pathname),
      `${pathname} must be covered by exactly these mechanisms`,
    ).toEqual(expected);
  });

  it("has no shape covered by nothing", () => {
    const uncovered = shapes.filter(
      ([pathname]) => coverageFor(pathname).length === 0,
    );

    expect(uncovered).toEqual([]);
  });
});

describe("the /api namespace is carved out of the asset rewrites (#2405 parity)", () => {
  /**
   * A path under a module-gated prefix that no handler claims must answer the
   * SAME bytes and the same headers whether the module is on or off, or one
   * anonymous request reads off which optional modules a club runs. With the
   * module off `src/proxy.ts` answers `{"error":"Not found"}` as
   * `application/json`; with it on the request reaches
   * `src/app/api/[[...unmatched]]/route.ts`, which answers the same thing.
   *
   * Sending an asset-shaped `/api` URL to the empty-bodied asset 404 instead
   * would reopen exactly that oracle: no `content-type` with the module on, a
   * JSON one with it off.
   */
  it.each([
    "/api/chores/zzz.png",
    "/api/admin/lockers/1.svg",
    "/api/images/uploaded/photo.jpg",
  ])("%s is not claimed by the asset rewrites", (pathname) => {
    expect(matchesAssetExtensionMiss(pathname)).toBe(false);
    expect(matchesNextStaticMiss(pathname)).toBe(false);
  });

  it.each(["/apiary-photo.png", "/api.png", "/apis/logo.png"])(
    "still claims %s, which is not an API path at all",
    (pathname) => {
      // The lookahead is anchored on a segment boundary, so it must not swallow
      // an ordinary file whose name merely begins with the letters "api".
      // `/api.png` is the sharp one: it is a file called `api.png` at the root,
      // not anything under the `/api` namespace, and Next's router treats it as
      // such.
      expect(matchesAssetExtensionMiss(pathname)).not.toBe(false);
    },
  );
});

describe("the proxy matcher stays the total CSP floor", () => {
  /**
   * Pinned deliberately. Every alternative in this lookahead is a namespace the
   * proxy does NOT run on, so each one needs its own answer to "what stops a
   * miss here rendering an unnonced document" — recorded in the JSDoc above
   * `config` in `src/proxy.ts`. Changing this string means re-deciding the
   * coverage table above, not just updating the expectation.
   *
   * It is a LITERAL because Next extracts `export const config` from the
   * middleware source statically and cannot evaluate an imported constant or a
   * template literal, so it can never be derived from `ASSET_URL_EXTENSIONS`.
   */
  it("excludes only the three namespaces that have been paid for", () => {
    expect((config.matcher[0] as { source: string }).source).toBe(
      "/((?!api(?:/|$)|_next/static/|_next/image$).*)",
    );
  });

  it("no longer excludes anything by file extension", () => {
    // The regression this guards is subtle and was a live hole: an
    // extension-shaped exclusion here is compiled case-sensitively while the
    // rewrites that were meant to cover it are compiled case-insensitively, so
    // `/API/x.png` matched neither. Excluding by namespace instead removes the
    // whole class.
    const source = (config.matcher[0] as { source: string }).source;

    for (const extension of ASSET_URL_EXTENSIONS) {
      expect(source, `matcher must not skip paths by .${extension}`).not.toContain(
        extension,
      );
    }
  });

  it("ships a route at the destination", async () => {
    // A rewrite to a path with no route is a 404 rendered by the CMS catch-all —
    // i.e. silently the very bug this fixes, with an extra hop.
    const { existsSync } = await import("node:fs");
    const { join } = await import("node:path");

    expect(
      existsSync(
        join(process.cwd(), "src/app", ASSET_NOT_FOUND_PATH, "route.ts"),
      ),
    ).toBe(true);
  });

  it("points every rewrite at the terminal route", () => {
    expect(ASSET_NOT_FOUND_REWRITES.map((rule) => rule.destination)).toEqual([
      ASSET_NOT_FOUND_PATH,
      ASSET_NOT_FOUND_PATH,
    ]);
    // The destination must not be asset-shaped, or it would rewrite to itself.
    expect(matchesAssetExtensionMiss(ASSET_NOT_FOUND_PATH)).toBe(false);
  });
});

/**
 * The terminal handler itself. The body being EMPTY is the whole security
 * property — with no document there is nothing a nonce-less policy has to
 * permit — so it is asserted rather than left implied, on every verb.
 */
describe("the asset 404 answers nothing at all", () => {
  const exportedMethods = [
    "GET",
    "POST",
    "PUT",
    "PATCH",
    "DELETE",
    "OPTIONS",
  ] as const;

  function servedHandler(method: string) {
    // Resolved through Next's own verb resolver, so HEAD is tested as it is
    // SERVED (derived from GET) rather than as the file happens to spell it.
    const handlers = autoImplementMethods(assetNotFoundRoute) as unknown as Record<
      string,
      () => Response
    >;
    return handlers[method];
  }

  it.each([...exportedMethods, "HEAD"])(
    "%s returns an empty 404 with no content-type",
    async (method) => {
      const response = servedHandler(method)();

      expect(response.status).toBe(404);
      expect(response.headers.get("content-type")).toBeNull();
      await expect(response.text()).resolves.toBe("");
    },
  );

  it("does not hand-write HEAD, so HEAD cannot drift from GET", () => {
    expect("HEAD" in assetNotFoundRoute).toBe(false);
    expect(servedHandler("HEAD")).toBe(assetNotFoundRoute.GET);
  });

  it("carries the app's own security headers and a nonce-free policy", () => {
    // Set here rather than left to Caddyfile so the property holds in dev, in
    // the E2E stack, and in any deployment that does not front the app with our
    // reverse proxy. `default-src 'none'` is tighter than the edge's
    // set-if-absent `default-src 'self'`, and needs no nonce — so unlike the
    // page-render path it cannot rot.
    const response = assetNotFoundRoute.GET();

    expect(response.headers.get("Content-Security-Policy")).toBe(
      "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
    );
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("X-Frame-Options")).toBe("DENY");
    expect(response.headers.get("Referrer-Policy")).toBe(
      "strict-origin-when-cross-origin",
    );
  });
});
