import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  unstable_doesMiddlewareMatch as unstable_doesProxyMatch,
  unstable_getResponseFromNextConfig,
  getRewrittenUrl,
  isRewrite,
} from "next/experimental/testing/server";
import { getPathMatch } from "next/dist/shared/lib/router/utils/path-match";
import { prepareDestination } from "next/dist/shared/lib/router/utils/prepare-destination";
import { modifyRouteRegex } from "next/dist/lib/redirect-status";
import { getRouteRegex } from "next/dist/shared/lib/router/utils/route-regex";
import { autoImplementMethods } from "next/dist/server/route-modules/app-route/helpers/auto-implement-methods";
import {
  ASSET_MISS_SOURCE,
  ASSET_NOT_FOUND_PATH,
  ASSET_NOT_FOUND_REWRITES,
  ASSET_URL_EXTENSIONS,
  NEXT_STATIC_MISS_SOURCE,
  UPLOADED_IMAGE_URL_PREFIX,
} from "@/lib/asset-url-404";
import { IMAGES_ROOT, imagePublicUrl } from "@/lib/image-storage";
import {
  FEATURE_ROUTE_RULES,
  getRequiredFeaturesForPath,
} from "@/config/feature-routes";
import { MODULE_KEYS } from "@/config/modules";
import type { FeatureFlags } from "@/config/schema";
import { isPublicWebsitePath } from "@/lib/setup-gate";
import * as assetNotFoundRoute from "@/app/asset-not-found/route";
import nextConfig from "../../../next.config";
import { config, getFeatureFlagBlockResponse } from "../../proxy";

/**
 * The standing invariant this file exists to hold (#2404):
 *
 *   **No URL may reach a page render without the proxy having minted a CSP
 *   nonce for it — and nothing put in place to hold that may shadow a URL a
 *   real route is there to serve.**
 *
 * Production CSP is nonce-only (`script-src 'self' 'nonce-…'`, `src/lib/csp.ts`)
 * and the nonce comes from `src/proxy.ts`. Until #2404 its matcher skipped every
 * static-asset shape, so a MISS on one fell through to the `(website)/[...slug]`
 * CMS catch-all and rendered the club's 404 document unnonced and with no CSP
 * header at all.
 *
 * #2404 closed that from both directions, and the coverage table below is where
 * the two are reconciled. The `afterFiles` rewrites remove the DOCUMENT from an
 * asset-shaped miss, and the matcher's extension exclusion was then dropped
 * (owner decision, 1 Aug 2026) so the proxy also runs on those shapes and can
 * attach a policy at all. Most asset rows are therefore covered TWICE now, which
 * is the intended end state rather than redundancy: either layer alone would hold
 * the invariant, and a shape covered by neither is still the bug.
 *
 * `scripts/ci/check-prerendered-script-nonces.mjs` cannot see this class — it
 * reads emitted prerender HTML, and these responses render per request. So the
 * property is pinned here, at the level where it is decided: every shape is
 * covered by exactly one set of mechanisms, and a shape covered by none is the
 * bug.
 *
 * Resolved through Next's OWN routing primitives, and at three depths, because
 * each catches a different mutation:
 *  • `resolveRewrites()` compiles the SHIPPED rule array on the fly with the
 *    exact options `next/dist/server/lib/router-utils/filesystem.js` uses and
 *    substitutes destinations through the real `prepareDestination()`, so
 *    deleting, reordering or rewording a rule changes the answer here;
 *  • `unstable_getResponseFromNextConfig()` runs the REAL `next.config.ts`
 *    through Next's own `loadCustomRoutes()` + rewrite pipeline, so a rule the
 *    framework would reject, or a config that stops shipping the rules at all,
 *    fails rather than passing on a restatement; and
 *  • `unstable_doesMiddlewareMatch()` decides matcher coverage.
 *
 * `e2e/asset-url-404.spec.ts` then measures the same shapes on the wire against
 * the running container; this suite is what fails without a stack, in the
 * ordinary `pnpm test` run, the moment the matcher and the rewrites stop agreeing.
 */

/**
 * `experimental.caseSensitiveRoutes` is what `filesystem.js` passes as
 * path-to-regexp's `sensitive` when it compiles a rewrite
 * (`buildCustomRoute(…, opts.config.experimental.caseSensitiveRoutes)`), so it is
 * read from the real config here rather than assumed. Flipping it on would make
 * `/API/x.png` stop matching the `/api` rule and fall through to the general one,
 * which the `/API/…` rows below then fail on — that is deliberate: the case seam
 * is closed by a case-INSENSITIVE rewrite, and the flag would reopen it.
 */
const CASE_SENSITIVE_ROUTES = (
  nextConfig.experimental as { caseSensitiveRoutes?: boolean } | undefined
)?.caseSensitiveRoutes;

/**
 * A compiled copy of a SHIPPED rule. Built from `ASSET_NOT_FOUND_REWRITES` on the
 * fly — never from a restatement — so removing a rule removes its coverage here
 * and every shape that relied on it fails.
 */
const compiledRewrites = ASSET_NOT_FOUND_REWRITES.map((rule) => ({
  ...rule,
  match: getPathMatch(rule.source, {
    // Byte-for-byte the options `filesystem.js`'s `buildCustomRoute` uses for an
    // `afterFiles` rewrite. Anything less and this suite would be testing a
    // regex Next never compiles.
    strict: true,
    removeUnnamedParams: true,
    regexModifier: (regex: string) => modifyRouteRegex(regex, undefined),
    sensitive: CASE_SENSITIVE_ROUTES,
  }),
}));

/**
 * What Next would do with a URL after the rewrites, or `null` when no rule
 * claims it.
 *
 * Resolved in the SAME ORDER Next applies the rules — a test that evaluated
 * them as an unordered set would pass on a list whose order had been swapped.
 *
 * `search` is threaded through because the rewritten-QUERY header is decided by
 * it and by nothing else: `resolve-routes.js` compares
 * `parsedUrl.search !== parsedDestination.search` INDEPENDENTLY of the pathname
 * comparison, and `prepareDestination()` gives a query-less destination an empty
 * search, so any claimed URL carrying a query string sets that header. Resolving
 * with a hard-coded empty query — as this harness used to — cannot see it.
 */
function resolveRewrite(
  pathname: string,
  search = "",
): { destination: string; setsPathHeader: boolean; setsQueryHeader: boolean } | null {
  const query = Object.fromEntries(new URLSearchParams(search));

  for (const rule of compiledRewrites) {
    const params = rule.match(pathname);
    if (params === false) continue;

    const { parsedDestination } = prepareDestination({
      appendParamsToQuery: true,
      destination: rule.destination,
      params,
      query,
    });

    const destinationSearch = parsedDestination.search ?? "";

    return {
      destination: parsedDestination.pathname,
      setsPathHeader: pathname !== parsedDestination.pathname,
      setsQueryHeader: search !== destinationSearch,
    };
  }

  return null;
}

/** The pathname Next would route to, or `null` when no rule claims the URL. */
function resolveRewrites(pathname: string): string | null {
  return resolveRewrite(pathname)?.destination ?? null;
}

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

function rewriteCoverage(pathname: string): Coverage | null {
  const destination = resolveRewrites(pathname);

  if (destination === null) return null;
  if (destination === ASSET_NOT_FOUND_PATH) return "asset-404";

  throw new Error(
    `${pathname} is rewritten to ${destination}, which is not the terminal — ` +
      `every rewrite must be classified, not assumed benign`,
  );
}

function coverageFor(pathname: string): Coverage[] {
  const covers: Coverage[] = [];

  if (unstable_doesProxyMatch({ config, nextConfig: {}, url: pathname })) {
    covers.push("proxy");
  }

  const rewrite = rewriteCoverage(pathname);
  if (rewrite) {
    covers.push(rewrite);
  }

  // Only counted when no rewrite claimed the URL first — a terminating rewrite
  // is applied before the dynamic catch-all, so it decides. Case-sensitively,
  // because Next's own route table is: `/API/x.png` matches no `/api` route at
  // all and falls to the CMS catch-all instead.
  if (rewrite === null && (pathname === "/api" || pathname.startsWith("/api/"))) {
    covers.push("api-json");
  }

  if (pathname === "/_next/image") {
    covers.push("image-optimiser");
  }

  return covers;
}

/**
 * Every shape measured while fixing #2404, with the mechanisms that must cover
 * it.
 *
 * Read the `asset-404` rows as "cannot render a document", NOT as "returns 404":
 * `/branding/logo.example.png` is a real file, served by the filesystem stage
 * that Next checks BEFORE any `afterFiles` rewrite, so the rule is never
 * consulted for it. That ordering is what keeps real assets working, and it is a
 * runtime fact a route table cannot show — `e2e/asset-url-404.spec.ts` asserts it
 * against the running server instead.
 */
const shapes: ReadonlyArray<readonly [string, Coverage[]]> = [
  // Ordinary pages and page-shaped misses: the proxy runs, so the 404 document
  // these render is nonced like any other page.
  ["/", ["proxy"]],
  ["/about", ["proxy"]],
  ["/definitely-missing", ["proxy"]],
  ["/wp-admin/setup-config.php", ["proxy"]],
  ["/admin/nope", ["proxy"]],
  // #2420's F3 anchors, kept honest here as well.
  ["/apiary", ["proxy"]],
  ["/api-docs", ["proxy"]],
  // The two bare prefixes #2404 anchored — the same class as F3, one namespace
  // over. Both were measured answering 404 with unnonced inline scripts and no
  // CSP header at all.
  ["/_next/staticfoo", ["proxy"]],
  ["/_next/imagemap", ["proxy"]],
  ["/_next/image/x", ["proxy"]],
  // Asset-shaped URLs: covered twice since the matcher's extension exclusion was
  // dropped. The rewrite removes the document; the proxy attaches the policy and
  // the security headers, and brings these shapes inside the #2420 setup gate's
  // reach — which is why `isPublicWebsitePath()` must go on refusing them for a
  // reason of its own, asserted below.
  ["/foo.png", ["proxy", "asset-404"]],
  ["/foo.jpg", ["proxy", "asset-404"]],
  ["/foo.jpeg", ["proxy", "asset-404"]],
  ["/foo.gif", ["proxy", "asset-404"]],
  ["/foo.webp", ["proxy", "asset-404"]],
  ["/foo.svg", ["proxy", "asset-404"]],
  ["/foo.ico", ["proxy", "asset-404"]],
  // The two named carve-outs #2404 deleted. No such file exists in `public/` —
  // the root layout points at `/branding/favicon.ico` — so each was a dead
  // alternative that left one URL shape with no policy on it.
  ["/favicon.ico", ["proxy", "asset-404"]],
  ["/logo.png", ["proxy", "asset-404"]],
  ["/gallery.svg", ["proxy", "asset-404"]],
  ["/wp-content/uploads/x.jpg", ["proxy", "asset-404"]],
  ["/branding/favicon.ico", ["proxy", "asset-404"]],
  ["/branding/logo.example.png", ["proxy", "asset-404"]],
  // `_next/static` keeps its exclusion — it is the hot path, dozens of requests
  // per page load — so a deleted chunk is covered by the rewrite ALONE and the
  // terminal route's own `default-src 'none'` is what reaches the wire for it.
  ["/_next/static/chunks/nope.js", ["asset-404"]],
  ["/_next/static", ["proxy", "asset-404"]],
  // The uploaded-images route: a REAL route whose every URL ends in an image
  // extension. No rule may claim it, so routing reaches the real handler — the
  // rows that fail if the `/api` lookahead is dropped.
  ["/api/images/uploaded/photo.jpg", ["api-json"]],
  ["/api/images/uploaded/gallery/2026/hut.png", ["api-json"]],
  // Every other `/api` asset shape: claimed by no rule either, so it reaches
  // the catch-all's JSON exactly as `/api/does-not-exist` does.
  ["/api/does-not-exist.png", ["api-json"]],
  ["/api/chores/zzz.png", ["proxy", "api-json"]],
  // Case variants. The matcher and Next's route table are compiled
  // case-SENSITIVELY, rewrites (and therefore the `(?!api/)` lookahead)
  // case-INSENSITIVELY. So no rule claims these — the lookahead excludes them
  // symmetrically with their lowercase twins — and they then match no `/api`
  // route either: the CMS catch-all renders the club's 404 page. The proxy runs
  // on them, so that page is nonced — a wasted render, not a missing nonce, and
  // the same outcome `/foo.avif` gets.
  ["/API/x.png", ["proxy"]],
  ["/Api/does-not-exist.png", ["proxy"]],
  ["/API/images/uploaded/x.jpg", ["proxy"]],
  ["/FOO.PNG", ["proxy", "asset-404"]],
  // Plain `/api` URLs: src/app/api/[[...unmatched]]/route.ts answers JSON.
  ["/api", ["api-json"]],
  ["/api/does-not-exist", ["api-json"]],
  ["/api/health", ["api-json"]],
  // An extension nobody listed. It renders the club's 404 page rather than an
  // empty one, and the proxy DOES run on it, so it is nonced — a wasted render,
  // never a missing nonce. This row is why the extension list is allowed to go
  // stale without becoming a security problem.
  ["/foo.avif", ["proxy"]],
  // The image optimiser answers its own short plain-text 400, never a document.
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

/**
 * The rules as `next.config.ts` actually ships them, run through Next's own
 * config pipeline rather than through this file's compiled copy.
 *
 * `unstable_getResponseFromNextConfig()` calls the real `loadCustomRoutes()` —
 * which validates every source and destination and throws on a rule Next would
 * reject — and then the real rewrite matching and `prepareDestination()`. A
 * config that stopped exporting `rewrites()`, or exported rules that do not
 * compile, fails here and nowhere else in the suite.
 */
describe("the shipped next.config.ts, through Next's own pipeline", () => {
  async function rewriteOf(path: string) {
    const response = await unstable_getResponseFromNextConfig({
      url: `https://example.org${path}`,
      nextConfig,
    });

    return isRewrite(response) ? new URL(getRewrittenUrl(response)!).pathname : null;
  }

  it.each([
    ["/foo.png", ASSET_NOT_FOUND_PATH],
    ["/wp-content/uploads/x.jpg", ASSET_NOT_FOUND_PATH],
    ["/_next/static/chunks/nope.js", ASSET_NOT_FOUND_PATH],
  ])("rewrites %s to %s", async (path, expected) => {
    await expect(rewriteOf(path)).resolves.toBe(expected);
  });

  it("does NOT agree with the server on case, and that gap is the util's", async () => {
    // Read this as a note about the tool, not about the app. The two disagree on
    // `/API/x.png`, and the SERVER is the one to trust:
    //  • the util (`experimental/testing/server/config-testing-utils.js`,
    //    `matchRoute`) first tests `pathname.match(route.regex)` — a STRING
    //    operand, so `new RegExp()` rebuilds it with NO flags and the `i` that
    //    path-to-regexp set is lost — and only then extracts params through the
    //    case-INSENSITIVE compiled matcher. For `/API/x.png` the `(?!api/)`
    //    lookahead passes case-sensitively and fails case-insensitively, so the
    //    two disagree and the util throws its own E289 "extracting params from
    //    path failed but the regular expression matched";
    //  • `next/dist/server/lib/router-utils/filesystem.js` (what the router
    //    server uses) never consults `regex` at all — `resolve-routes.js` calls
    //    `route.match(pathname)`, the compiled case-INSENSITIVE function — so
    //    the server has no such disagreement to have, and no path to that error.
    // The compiled copy this file resolves through mirrors `filesystem.js`, so
    // the `/API/…` coverage rows above are the authoritative ones and
    // `e2e/asset-url-404.spec.ts` measures the same shapes on the wire. Pinned
    // rather than skipped so that a Next release fixing the util turns this red
    // and the divergence gets re-checked instead of silently drifting.
    await expect(rewriteOf("/API/x.png")).rejects.toThrow(
      /extracting params from path failed/,
    );
    expect(resolveRewrites("/API/x.png")).toBeNull();
  });

  it.each([
    "/",
    "/about",
    "/definitely-missing",
    "/api/health",
    "/foo.avif",
    "/api/does-not-exist.png",
    "/api/images/uploaded/photo.jpg",
  ])(
    "leaves %s alone",
    async (path) => {
      await expect(rewriteOf(path)).resolves.toBeNull();
    },
  );

  it("ships the rules in afterFiles, and only there", async () => {
    // The stage cannot be read back from `unstable_getResponseFromNextConfig` —
    // it flattens beforeFiles/afterFiles/fallback into one list — so it is
    // asserted against the config's own return value. This is the assertion that
    // fails if the rules are moved to `beforeFiles`, which would put them AHEAD
    // of the filesystem check and 404 every real image and chunk in the app.
    const rewrites = await nextConfig.rewrites!();

    expect(Array.isArray(rewrites), "must be the staged form, not a bare array")
      .toBe(false);
    expect(rewrites).toEqual({
      beforeFiles: [],
      afterFiles: [...ASSET_NOT_FOUND_REWRITES],
      fallback: [],
    });
  });

  it("does not turn on case-sensitive routing", () => {
    // `filesystem.js` passes this flag to path-to-regexp as `sensitive` when it
    // compiles a rewrite. The `/api` carve-out is a case-INSENSITIVE lookahead,
    // which is what makes it exclude `/API/…` symmetrically with `/api/…`;
    // turning this on would let `/API/x.png` fall past it into the empty 404
    // while its lowercase twin stayed out, reopening the case seam. The `/API/…`
    // rows above fail too; this states why.
    expect(CASE_SENSITIVE_ROUTES).toBeUndefined();
  });
});

/**
 * The half of the property that is about NOT breaking things: a rule written to
 * catch misses must never claim a URL a real route file exists to serve.
 *
 * This is not hypothetical. The first cut of #2404 sent every asset-shaped `/api`
 * URL to the frozen JSON, which swallowed `/api/images/uploaded/<file>` — the
 * production URL for every admin-uploaded image in the app (`imagePublicUrl()`,
 * and `Caddyfile`'s `/images/*` rewrite onto the same route). Every uploaded
 * `.jpg`, `.png`, `.gif` and `.webp` answered a JSON 404.
 */
describe("the rewrites cannot shadow a route that really serves the URL", () => {
  const APP_DIR = join(process.cwd(), "src/app");

  /** Every `route.ts` under `src/app`, as its URL pattern. */
  function routePatterns(dir: string, prefix = ""): string[] {
    const patterns: string[] = [];

    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        // Route GROUPS `(website)` and parallel slots `@modal` contribute no URL
        // segment; every other directory contributes its own name.
        const segment =
          entry.name.startsWith("(") || entry.name.startsWith("@")
            ? prefix
            : `${prefix}/${entry.name}`;
        patterns.push(...routePatterns(join(dir, entry.name), segment));
      } else if (entry.name === "route.ts" || entry.name === "route.tsx") {
        patterns.push(prefix || "/");
      }
    }

    return patterns;
  }

  /**
   * A concrete URL for a route pattern, with every dynamic segment filled in and
   * an asset extension on the tail — i.e. the shape these rules are hunting.
   * Returns null when the pattern's last segment is a literal, because such a
   * route can never be asked for an extension-suffixed URL.
   */
  function concreteAssetUrl(pattern: string): string | null {
    const segments = pattern.split("/").filter(Boolean);
    const last = segments.at(-1);

    if (!last?.startsWith("[")) return null;

    return `/${segments
      .map((segment, index) => {
        const isLast = index === segments.length - 1;
        const suffix = isLast ? ".png" : "";

        if (segment.startsWith("[[...") || segment.startsWith("[...")) {
          return `sample/nested${suffix}`;
        }
        if (segment.startsWith("[")) {
          return `sample${suffix}`;
        }
        return segment;
      })
      .join("/")}`;
  }

  const assetShapedRoutes = routePatterns(APP_DIR)
    .map((pattern) => [pattern, concreteAssetUrl(pattern)] as const)
    .filter((entry): entry is readonly [string, string] => entry[1] !== null);

  it("finds route files to check, so this suite cannot pass vacuously", () => {
    expect(assetShapedRoutes.length).toBeGreaterThan(20);
  });

  it.each(assetShapedRoutes)(
    "%s can be asked for %s without being diverted anywhere",
    (pattern, url) => {
      // Stated as "the rewrites must leave it where it was", not as "it must
      // not reach THIS terminal". Naming one destination is how this guard went
      // vacuous once before: every `/api` row was claimed by a rule with a
      // different destination, so all 55 rows passed unconditionally and
      // deleting the uploaded-images exemption changed nothing here.
      //
      // A real route handler's own URL may only be left alone (no rule claims
      // it) or handed back unchanged (a rule claims it and returns it to
      // resolution). Anything else means the handler has been made unreachable —
      // silently, and only for the extensions in the list.
      expect(
        [null, url],
        `${pattern} is a real route; ${url} must be left where routing would have taken it`,
      ).toContain(resolveRewrites(url));
    },
  );

  it("lets no route file outside /api match the general asset rule at all", () => {
    // Stated separately from the row above because it is a different claim: the
    // general rule's only carve-out is `/api`, so the only thing keeping it off
    // a non-`/api` route handler is that no such handler serves an
    // extension-suffixed URL. If one is ever added, this fails and the rule
    // needs an exemption of its own.
    const generalRule = compiledRewrites.find(
      (rule) => rule.source === ASSET_MISS_SOURCE,
    );
    expect(generalRule, "the general rule must still be shipped").toBeDefined();

    const shadowed = assetShapedRoutes
      .filter(([pattern]) => !pattern.startsWith("/api"))
      .map(([, url]) => url)
      .filter((url) => generalRule!.match(url) !== false);

    expect(shadowed).toEqual([]);
  });

  it("leaves the uploaded-images URL alone entirely, so the real route answers", () => {
    // Driven by the function that MINTS the URL rather than by a literal, so
    // renaming the storage prefix cannot silently un-exempt it. This is the
    // sharpest thing the `/api` lookahead protects: every admin-uploaded image
    // in the club ends in an image extension, and an earlier cut of #2404
    // terminated the lot of them at the empty 404.
    const url = imagePublicUrl(join(IMAGES_ROOT, "gallery", "hut.jpg"));

    expect(url).toBe(`${UPLOADED_IMAGE_URL_PREFIX}/gallery/hut.jpg`);
    expect(
      resolveRewrite(url),
      "no rule may claim an /api URL — the real route has to see it",
    ).toBeNull();
  });

  it("keeps a real route file at the uploaded-images path", () => {
    // If the route moves, the URL falls through to the CMS catch-all — a
    // document, which is the bug.
    expect(
      existsSync(
        join(process.cwd(), "src/app", UPLOADED_IMAGE_URL_PREFIX, "[...path]/route.ts"),
      ),
    ).toBe(true);
  });
});

describe("the /api namespace keeps #2405's module-state parity", () => {
  /**
   * A path under a module-gated prefix that no handler claims must answer the
   * same bytes and the same headers whether the module is on or off, or one
   * anonymous request reads off which optional modules a club runs. With the
   * module OFF `src/proxy.ts`'s gate answers `{"error":"Not found"}` as
   * `application/json` from middleware and routing stops there; with it ON the
   * request must still reach `src/app/api/[[...unmatched]]/route.ts`, which
   * answers the same thing.
   *
   * Sending an asset-shaped `/api` URL to the empty-bodied `/asset-not-found`
   * would reopen that oracle on the BODY. The HEADERS are subtler, and are why
   * no rule may match an `/api` URL AT ALL — an identity is not enough.
   * `resolve-routes.js` makes TWO independent comparisons on an RSC request:
   * `x-nextjs-rewritten-path` when the destination pathname differs, and
   * `x-nextjs-rewritten-query` when the destination SEARCH differs. A
   * destination cannot reproduce the request's own query string, so an identity
   * rule ships the query header for every probe carrying `?x=1` — present with
   * the module on, absent with it off. Both axes are asserted here.
   */
  it.each([
    "/api/chores/zzz.png",
    "/api/admin/lockers/1.svg",
    "/api/definitely-missing.jpg",
    "/api/images/uploaded/photo.jpg",
    "/api/address-autocomplete/x.png",
    "/api/group-bookings/x.png",
    "/API/chores/zzz.png",
    "/API/admin/lockers/1.png",
    "/API/images/uploaded/photo.jpg",
  ])("%s is claimed by no rule, with or without a query string", (pathname) => {
    for (const search of ["", "?x=1", "?utm=a&b=2"]) {
      expect(
        resolveRewrite(pathname, search),
        `${pathname}${search} must reach routing untouched — any rule that ` +
          `claims it stamps a rewrite header the module-off reply cannot have`,
      ).toBeNull();
    }
  });

  it("has no rule that can match any gated /api prefix, in either case", () => {
    // Driven from the gate's own route table rather than from a hand-written
    // list, so a module added later is covered the day its prefix lands. Every
    // gated `/api` prefix is probed at an asset-shaped child, in both spellings
    // the case-insensitive rewrite compiler admits.
    const gatedApiPrefixes = FEATURE_ROUTE_RULES.flatMap(
      (rule) => rule.prefixes ?? [],
    ).filter((prefix) => prefix.startsWith("/api"));

    expect(
      gatedApiPrefixes.length,
      "the gate must still list /api prefixes, or this passes vacuously",
    ).toBeGreaterThan(10);

    const claimed = gatedApiPrefixes.flatMap((prefix) =>
      [`${prefix}/zzz.png`, `/API${prefix.slice(4)}/zzz.png`]
        .filter((url) => resolveRewrite(url, "?x=1") !== null),
    );

    expect(claimed).toEqual([]);
  });

  it("keeps a route file at the /api catch-all that answers those URLs", () => {
    // Leaving an `/api` URL alone only works because something downstream
    // claims it: `api/[[...unmatched]]` is an optional catch-all, so every
    // unmatched `/api` address resolves onto it.
    expect(
      existsSync(join(process.cwd(), "src/app/api/[[...unmatched]]/route.ts")),
    ).toBe(true);
  });

  it("sets the query header for a NON-/api rewrite, so the guard above has teeth", () => {
    // The mechanism, demonstrated on a URL where it is harmless, so that the
    // assertions above are known to be measuring something real rather than a
    // comparison that is false everywhere. `/foo.png` IS claimed, and with a
    // query string it sets both headers.
    expect(resolveRewrite("/foo.png", "?x=1")).toEqual({
      destination: ASSET_NOT_FOUND_PATH,
      setsPathHeader: true,
      setsQueryHeader: true,
    });
    expect(resolveRewrite("/foo.png", "")?.setsQueryHeader).toBe(false);
  });

  it("never folds /API onto the gated handler, because no rule rewrites it", () => {
    // The trap the `(?!api/)` lookahead is written around. Rewrites compile
    // case-INSENSITIVELY — but the module gate's route table is case-SENSITIVE
    // (`matchesPrefix` in `src/config/feature-routes.ts` uses `startsWith`, and
    // its patterns carry no `i` flag), so `/API/admin/lockers/1.png` is gated by
    // nothing. A rule whose destination contained a literal `/api/` would
    // substitute that lowercase spelling and hand the request to the real, gated
    // handler with the gate never having run. Matching no `/api` URL in either
    // spelling is what stops it.
    expect(getRequiredFeaturesForPath("/api/admin/lockers/1.png")).toEqual([
      "lockers",
    ]);
    expect(getRequiredFeaturesForPath("/API/admin/lockers/1.png")).toEqual([]);
    for (const url of [
      "/api/admin/lockers/1.png",
      "/API/admin/lockers/1.png",
      "/API/images/uploaded/photo.jpg",
    ]) {
      expect(
        resolveRewrite(url),
        `${url} must not be rewritten at all, in any spelling`,
      ).toBeNull();
    }
    // Proved rather than argued: the ungated spelling must not resolve onto the
    // real handlers. Their route regexes are built without the `i` flag
    // (`next/dist/shared/lib/router/utils/route-regex.js`), so they do not.
    for (const [route, url] of [
      ["/api/images/uploaded/[...path]", "/API/images/uploaded/photo.jpg"],
      ["/api/[[...unmatched]]", "/API/admin/lockers/1.png"],
    ] as const) {
      expect(
        getRouteRegex(route).re.test(url),
        `${url} must not resolve onto ${route}`,
      ).toBe(false);
    }
    // And the proxy runs on both forms since #2404 widened the matcher, so the
    // response carries a policy either way. That is an improvement, not a
    // substitute: running is not gating.
    for (const url of [
      "/api/admin/lockers/1.png",
      "/API/admin/lockers/1.png",
    ]) {
      expect(
        unstable_doesProxyMatch({ config, nextConfig: {}, url }),
        `${url} must run the proxy`,
      ).toBe(true);
    }
  });

  it.each(["/apiary-photo.png", "/api.png", "/apis/logo.png"])(
    "does not treat %s as an /api path — it is not one",
    (pathname) => {
      // `/api.png` is the sharp one: a file called `api.png` at the root, not
      // anything under the `/api` namespace, and Next's router treats it so.
      expect(rewriteCoverage(pathname)).toBe("asset-404");
    },
  );

  it("ships exactly the two rules, both terminating", () => {
    // Pinned as a whole rather than by index. The property that matters is no
    // longer an ORDER (the two sources are disjoint) — it is that there are only
    // these two, that both end at the terminal, and that neither can claim an
    // `/api` URL. A third rule with an identity destination is precisely the
    // change that reopens the rewritten-query oracle, so it has to fail here.
    expect(ASSET_NOT_FOUND_REWRITES.map((rule) => rule.source)).toEqual([
      NEXT_STATIC_MISS_SOURCE,
      ASSET_MISS_SOURCE,
    ]);

    for (const rule of ASSET_NOT_FOUND_REWRITES) {
      expect(
        rule.destination,
        `${rule.source} must terminate — an identity destination cannot keep ` +
          `x-nextjs-rewritten-query off a query-carrying probe`,
      ).toBe(ASSET_NOT_FOUND_PATH);
    }

    expect(
      ASSET_MISS_SOURCE.startsWith("/:path((?!api/)"),
      "the general rule must exclude the whole /api namespace up front",
    ).toBe(true);
  });
});

/**
 * The other half of "the proxy now runs on asset shapes": a module-gated PAGE
 * prefix sees them too, and the two module states then answer from different
 * Next terminations. `docs/SECURITY-ATTACK-SURFACE.md` states this is no new
 * module-state oracle; the claim is asserted here rather than left to prose.
 *
 * What is pinned is the whole of what is true — status, empty body, no
 * `content-type`. The reason the remaining difference does not matter is a
 * reason rather than a measurement: with `kiosk` off, `/lodge` ITSELF answers an
 * empty 404 while with it on the same address answers a 200 page, so the flag is
 * already readable from the bare prefix and the asset-shaped sibling adds no
 * bit. The response FRAMING does differ (a middleware short-circuit is chunked,
 * a route handler sends `Content-Length: 0`); that is recorded in the doc rather
 * than asserted here, because it is decided by Next's transport layer and cannot
 * be read off either object.
 */
describe("a module-gated PAGE prefix's asset shape adds no module-state bit", () => {
  const allFeaturesOn = Object.fromEntries(
    MODULE_KEYS.map((key) => [key, true]),
  ) as FeatureFlags;

  it("answers the same empty 404 whichever layer replies", async () => {
    const gated = "/lodge/x.png";

    expect(getRequiredFeaturesForPath(gated)).toEqual(["kiosk"]);
    expect(
      unstable_doesProxyMatch({ config, nextConfig: {}, url: gated }),
      "the gate can only answer for a URL the proxy runs on",
    ).toBe(true);

    // Module OFF: the gate answers from middleware and routing stops there.
    const blocked = getFeatureFlagBlockResponse(gated, {
      ...allFeaturesOn,
      kiosk: false,
    });

    expect(blocked).not.toBeNull();
    expect(blocked!.status).toBe(404);
    expect(blocked!.headers.get("content-type")).toBeNull();
    await expect(blocked!.text()).resolves.toBe("");

    // Module ON: nothing is gated, and the rewrite terminates it instead.
    expect(
      getFeatureFlagBlockResponse(gated, { ...allFeaturesOn, kiosk: true }),
    ).toBeNull();
    expect(rewriteCoverage(gated)).toBe("asset-404");

    const terminal = assetNotFoundRoute.GET();

    expect(terminal.status).toBe(blocked!.status);
    expect(terminal.headers.get("content-type")).toBeNull();
    await expect(terminal.text()).resolves.toBe("");
  });
});

describe("the rewrite rules and the proxy matcher cannot drift", () => {
  /**
   * The matcher no longer carries an extension list at all — #2404 dropped it so
   * the proxy runs on asset shapes too — and this asserts that, because the
   * absence is what the coverage table above now depends on. If an extension
   * alternative ever comes back, every `["proxy", "asset-404"]` row silently
   * becomes a single-layer row again.
   */
  it("no longer excludes asset extensions from the proxy at all", () => {
    const source = config.matcher[0];

    expect(source).not.toMatch(/\\\.\(\?:[a-z|]+\)\$/);
    for (const extension of ASSET_URL_EXTENSIONS) {
      expect(source, `matcher must not carry a ${extension} carve-out`).not.toContain(
        extension,
      );
    }
  });

  /**
   * The coupling that REPLACED it, and it is the one that can still produce a
   * document. `isPublicWebsitePath()` keeps refusing asset-shaped paths so the
   * #2420 holding screen — a 503 HTML document — is never the answer to a request
   * for an image. An extension the rewrites terminate but that classifier does
   * NOT recognise would be gated pre-setup and answered with exactly the document
   * this issue exists to stop sending.
   *
   * Driven through the real function rather than through its private pattern, so
   * a rewrite of the classifier that keeps the behaviour keeps passing.
   *
   * Probed in UPPER CASE as well as lower, because the extension SET is not the
   * only thing that can drift: the classifier's only case handling is one `/i`
   * flag, and the obvious rewrite of it (take `path.extname()` and test set
   * membership) is case-SENSITIVE and passes every lowercase assertion. Dropping
   * the flag would make `/FOO.PNG` a public-website path, so a club mid-setup
   * would answer an image request with the 503 holding screen — the document on
   * an asset URL this whole issue is about. The matcher runs on `/FOO.PNG`
   * (it is compiled case-sensitively, and its `api`/`_next` alternatives are
   * lowercase), and the rewrites cannot help: `afterFiles` runs after
   * middleware, so the gate has already answered.
   */
  it("keeps every terminated extension out of the pre-setup gate, in either case", () => {
    for (const extension of ASSET_URL_EXTENSIONS) {
      const spellings = [extension, extension.toUpperCase()];

      for (const spelling of spellings) {
        for (const url of [
          `/foo.${spelling}`,
          `/a/b/foo.${spelling}`,
          `/branding/Logo.${spelling}`,
        ]) {
          expect(
            isPublicWebsitePath(url),
            `${url} is terminated as an asset miss, so the setup gate must not claim it`,
          ).toBe(false);
        }
      }
    }

    // Guards the loop: a classifier that refused everything would pass it.
    expect(isPublicWebsitePath("/foo.avif")).toBe(true);
    expect(isPublicWebsitePath("/FOO.AVIF")).toBe(true);
  });

  it("keeps the matcher exclusions to the set that has been paid for", () => {
    // Pinned deliberately. Every alternative in this lookahead is a path the
    // proxy does NOT run on, so each one needs its own answer to "what stops a
    // miss here rendering an unnonced document" — recorded in the JSDoc above
    // `config` in src/proxy.ts. Changing this string means re-deciding the
    // coverage table above, not just updating the expectation.
    //
    // Three alternatives, and only three: `/api` (its own JSON terminal and
    // #2405's parity, with the ordered `/api/…` entries re-admitting the gated
    // prefixes), `_next/static/` (the hot path; misses covered by the rewrite),
    // and `_next/image$` (a real handler that answers its own plain-text 400).
    expect(config.matcher[0]).toBe(
      "/((?!api(?:/|$)|_next/static/|_next/image$).*)",
    );
  });

  it("ships a route at the non-/api destination", () => {
    // A rewrite to a path with no route is a 404 rendered by the CMS catch-all —
    // i.e. silently the very bug this fixes, with an extra hop. (The /api
    // destination is the opposite case, asserted above: it must have no route.)
    expect(
      existsSync(
        join(process.cwd(), "src/app", ASSET_NOT_FOUND_PATH, "route.ts"),
      ),
    ).toBe(true);
  });

  it("cannot rewrite the terminal destination into itself", () => {
    expect(rewriteCoverage(ASSET_NOT_FOUND_PATH)).toBeNull();
  });

  it("is exempt from the pre-setup gate", () => {
    // `/asset-not-found` is a real, directly reachable URL with no extension, so
    // the proxy DOES run on a direct request for it — and #2420's gate would
    // otherwise classify it as a public-website path and answer the "Site setup
    // in progress" screen, a 503 HTML document, from the one route whose purpose
    // is to answer without a document.
    //
    // `setup-gate.test.ts` catches this too, by walking the app directory; it is
    // asserted here as well so the coupling fails in the suite that owns the
    // decision rather than only in someone else's.
    expect(isPublicWebsitePath(ASSET_NOT_FOUND_PATH)).toBe(false);
  });
});

/**
 * The terminal handler itself. The body being EMPTY is the whole security
 * property — with no document there is nothing a nonce-less policy has to permit
 * — so it is asserted rather than left implied, on every verb.
 *
 * These assertions are made against the handler in process. That the property
 * survives to the wire — an empty body with no `content-type` on a real HTTP
 * response — is measured by `e2e/asset-url-404.spec.ts` in CI's Playwright job,
 * not here.
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
    const handlers = autoImplementMethods(
      assetNotFoundRoute,
    ) as unknown as Record<string, () => Response>;
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
    // Set here rather than left to Caddyfile so the property holds in dev, in the
    // E2E stack, and in any deployment that does not front the app with our
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
