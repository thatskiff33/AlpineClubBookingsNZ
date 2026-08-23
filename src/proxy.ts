import { NextResponse, type NextRequest } from "next/server";
import {
  getDisabledFeatureForPath,
  getRequiredFeaturesForPath,
} from "./config/feature-routes";
import type { FeatureFlags } from "./config/schema";
import { loadEffectiveModuleFlags } from "./lib/module-settings";
import {
  buildContentSecurityPolicy,
  createCspNonce,
  CSP_HEADER,
  CSP_NONCE_HEADER,
  setSecurityHeaders,
} from "./lib/csp";
import {
  REQUEST_METHOD_HEADER,
  REQUEST_PATH_HEADER,
} from "./lib/internal-return-path";
import { ASSET_URL_EXTENSIONS } from "./lib/asset-url-404";
import {
  planFamilyInviteReturnAddress,
  setFamilyInviteReturnNonceHeader,
} from "./lib/family-invite-return-address";
import {
  isFixedNonceWebsitePath,
  isPublicWebsitePath,
} from "./lib/public-website-paths";
import { getPublicWebsiteNonce } from "./lib/release-nonce";
import { getSetupInProgressResponse } from "./lib/setup-gate";
import {
  hasSignedInHint,
  serialiseSignedInHintCookie,
  SIGNED_IN_HINT_COOKIE,
  SIGNED_IN_HINT_MAX_AGE_SECONDS,
  SIGNED_IN_HINT_VALUE,
} from "./lib/signed-in-hint";

/**
 * Public pages a shared cache may store for anonymous visitors (#2322).
 *
 * Deliberately an ALLOW list, never a deny list: a route added later must opt
 * in on purpose rather than become cacheable the moment it lands. Excluded on
 * purpose:
 *  - every `(public)` route — all of them are token-, form-, or session-bearing
 *    (login, register, password reset, `pay/[token]`, `family-invite/[token]`…);
 *  - `/join/*` and `/contact` — public but form-bearing;
 *  - `/hut-leader-instructions` — reachable without a login, but per-assignment
 *    and PIN-gated (`?a=` from an assignment email), so it is not shared
 *    content;
 *  - the `(website)` `[...slug]` CMS catch-all — middleware cannot tell a CMS
 *    path from an application path without a database read, so it stays
 *    uncached even though it renders the same heavy layout.
 *
 * This list is about the BROWSER cache only, and #2352 did not change it. The
 * catch-all is now served from Next's own full-route ISR cache — a server-side
 * store the proxy neither reads nor advertises — so it is still not invited into
 * anybody's cache while no longer paying a full render per visit. Adding it here
 * would be a separate decision about the browser, not a consequence of that one.
 *
 * What DID have to change is the header a CMS page leaves with: the `revalidate`
 * export made the framework fill in an `s-maxage` of its own, so every page-shaped
 * path outside this list now gets {@link PRIVATE_ONLY_CACHE_CONTROL} explicitly —
 * including the addresses OUTSIDE the public website, which the catch-all also claims
 * and which #2578 found shipping that directive on stored 404s. See that constant and
 * {@link getPrivateOnlyCacheControl}.
 */
const CACHEABLE_ANONYMOUS_PATHS = new Set(["/"]);

/**
 * `private`, NOT `public`, and no `s-maxage` — a browser cache only (#2404
 * re-review).
 *
 * The directive used to be `public, max-age=60, s-maxage=60, …`, with a check
 * below meant to keep a flight (React Server Components) response out of it: a
 * flight body is different bytes under the SAME URL, so a shared cache that
 * ignores `Vary` could serve it to a browser asking for a page. **That check
 * cannot work in middleware, so the `public` half had nothing holding it.**
 * Next's middleware adapter DELETES every flight header before userland runs
 * (`next/dist/server/web/adapter.js`, `FLIGHT_HEADERS` from
 * `client/components/app-router-headers.js`: `rsc`, `next-router-state-tree`,
 * `next-router-prefetch`, `next-router-segment-prefetch`, `next-hmr-refresh`) —
 * measured through the real adapter, on both the node and edge middleware
 * runtimes, and `?_rsc=` is stripped off `nextUrl` as well. `Purpose` and
 * `Sec-Purpose` do survive, but they mark a PREFETCH, and a plain RSC
 * navigation carries neither, so no surviving signal identifies a flight
 * request. Middleware simply cannot tell the two apart.
 *
 * So the property is held by the directive itself instead: a shared cache is
 * never invited to store the response, whatever body Next goes on to produce
 * for it. `max-age` still earns the repeat-visit win from the browser, which is
 * the only benefit that was ever measured — no shared cache exists in the
 * deployment path today (Caddy runs without a cache module), so `s-maxage` was
 * storing nothing anywhere.
 *
 * **Do not restore `public`/`s-maxage` without a mechanism that can distinguish
 * a flight response, and middleware cannot be that mechanism.** #2352
 * (static/ISR public pages) is where such a mechanism would come from; the
 * pinning test is in `csp-proxy.test.ts`, which drives the real adapter.
 *
 * Survives the framework default: Next only writes its own `Cache-Control`
 * when the response does not already carry one
 * (`node_modules/next/dist/server/send-payload.js`,
 * `if (cacheControl && !res.getHeader('Cache-Control'))`). Note this holds in
 * production only — in dev, base-server overwrites it unconditionally.
 *
 * The `Vary: Cookie` set alongside it also survives: Next APPENDS its RSC vary
 * rather than replacing the header (`base-server.js:1169` and `:1174` in the
 * vendored next@16.2.11 both use `res.appendHeader('vary', ...)`), so the
 * middleware value reaches the wire next to the framework's. It still matters
 * with `private`: one browser profile can hold sessions in sequence, and the
 * anonymous render paints the header logged-out.
 *
 * The CSP nonce is no longer a reason to care either way, and the reason changed
 * with #2352. It used to be that `private` kept a per-request nonce from being
 * replayed to anyone else. On `/` — a `(website)` address — the nonce is now the
 * FIXED per-release value every visitor is served, so there is nothing left to
 * replay. `private` still earns its place for the other reason above: the
 * anonymous render paints the header signed-out.
 */
const ANONYMOUS_PAGE_CACHE_CONTROL =
  "private, max-age=60, stale-while-revalidate=300";

/**
 * What every other page-shaped GET sends — in both territories since #2578 — and the
 * reason it has to be sent explicitly rather than left to the framework (#2352
 * slice-1 review). {@link getPrivateOnlyCacheControl} decides who gets it.
 *
 * Before slice 1 the CMS pages were dynamic, so Next filled in its own
 * `revalidate === 0` directive — `private, no-cache, no-store, max-age=0,
 * must-revalidate` (`next/dist/server/lib/cache-control.js`,
 * `getCacheControlHeader`). With `export const revalidate = 300` on the catch-all
 * the same function returns `s-maxage=<revalidate>, stale-while-revalidate=<expire
 * - revalidate>`, and `expire` defaults to `nextConfig.expireTime` = 31536000
 * (`config-shared.js`), so a CMS page was leaving with
 * `s-maxage=300, stale-while-revalidate=31535700` — the derivation FROM THE ROUTE'S
 * EXPORT, which is not what the wire shows. See the clamp below: the measured value
 * is `s-maxage=15`, and the 300 here is retained only because it is the figure the
 * `revalidate` export makes anyone reading that file expect.
 *
 * That is exactly the directive #2322 exists to keep off public pages, and it was
 * never decided: it arrived as a side effect of the `revalidate` export. A shared
 * cache in front of the app (a fork behind a CDN, an operator adding one, a
 * corporate proxy) could store a page for 300 seconds and then serve it stale for
 * up to 364 days, which `revalidatePublicSite()` cannot reach — so D3's "instant
 * on edit" would simply be false for those visitors. Worse, the response that
 * carries the D2 marker cookie carries no `Vary: Cookie` of ours, so a shared
 * cache could hand one visitor's `Set-Cookie` to a stranger.
 *
 * So the pre-slice-1 directive is restored verbatim for those paths. It changes
 * nothing about Next's own SERVER-side store — that is the `.next` cache, which
 * this header has no bearing on — and nothing about `/`, which keeps its
 * deliberate 60-second browser window above.
 *
 * **#2578 widened WHO gets it, not what it says.** The reasoning above was written as
 * if only a public-website path could pick up a framework `s-maxage`, and the
 * measurement said otherwise: the CMS catch-all claims out-of-territory addresses too
 * (`/pay`, `/dashboard/nope`, `/admin/typo`), so their stored 404 documents shipped
 * `s-maxage=15, stale-while-revalidate=31535985` — the same class of directive, on
 * addresses the proxy had classified as not-the-website and therefore skipped. The
 * byte string here is unchanged.
 *
 * **Why the measured figure is 15 and not the route's `revalidate = 300`, because
 * two numbers for one directive would otherwise rot into each other.** `s-maxage=15`
 * is the MEASURED wire value (container build of slice 1, 3 Aug 2026) and it is the
 * one to trust; 300 is the derivation from
 * `src/app/(website)/[...slug]/page.tsx`'s export alone. They differ because
 * `unstable_cache` shrinks the enclosing work unit's `revalidate` to the smallest
 * nested value — `if (workUnitStore.revalidate < options.revalidate) {} else {
 * workUnitStore.revalidate = options.revalidate }`
 * (`next/dist/server/web/spec-extension/unstable-cache.js`) — and the public layout
 * reads five tagged caches built at `SHORT_CONFIG_TTL_SECONDS = 15`
 * (`src/lib/public-layout-config.ts`). So the route's effective revalidate is 15,
 * the same `getCacheControlHeader()` yields `31536000 − 15 = 31535985` for the
 * stale-while-revalidate half, and the arithmetic checks out against the
 * measurement. THAT IS THE DEPENDENCY: raise `SHORT_CONFIG_TTL_SECONDS`, or drop the
 * last short-TTL cache out of the public layout, and the figures recorded here (and
 * in `docs/SECURITY-ATTACK-SURFACE.md`) move — the exposure window a reader sizes
 * off them is the layout's TTL, not the page's export. Nothing about this fix depends
 * on the number: the proxy refuses the whole class, whatever the figure.
 */
const PRIVATE_ONLY_CACHE_CONTROL =
  "private, no-cache, no-store, max-age=0, must-revalidate";

/**
 * next-auth v5 session cookie — plain, `__Secure-` prefixed, and the chunked
 * `.0`/`.1` variants. The authoritative pattern lives in
 * `src/lib/auth-diagnostics.ts` (`SESSION_COOKIE_NAME_PATTERN`).
 *
 * One deliberate divergence: that module excludes the legacy v4
 * `next-auth.session-token` so a years-stale cookie is not misread as an auth
 * anomaly. Here it must still suppress caching — misjudging a stale cookie as
 * "maybe authenticated" only costs a cache miss, whereas the opposite error
 * would let a shared cache store a page for someone who has a session.
 */
const SESSION_COOKIE_PATTERN =
  /^(?:__Secure-)?(?:authjs|next-auth)\.session-token(?:\.\d+)?$/;

function normalisePathname(pathname: string) {
  return pathname.length > 1 && pathname.endsWith("/")
    ? pathname.slice(0, -1)
    : pathname;
}

/**
 * The asset shapes the `afterFiles` rewrites terminate, DERIVED from the one list
 * that defines them (`src/lib/asset-url-404.ts`) rather than typed out again.
 *
 * Case-insensitive on purpose, and `asset-url-404.test.ts` records the lesson: the
 * obvious rewrite of an extension test (`path.extname()` plus set membership) is
 * case-SENSITIVE and passes every lowercase assertion, so `/FOO.PNG` would fall out
 * of the class while the rewrites still terminated it.
 */
const PROXY_ASSET_SHAPE_PATTERN = new RegExp(
  `\\.(?:${ASSET_URL_EXTENSIONS.join("|")})$`,
  "i",
);

/**
 * The `/api` namespace as Next's ROUTE TABLE sees it: case-sensitive, because
 * `next.config.ts` sets no `experimental.caseSensitiveRoutes` and app routes match
 * case-sensitively regardless. `/API/x` reaches no handler under
 * `src/app/api/[[...unmatched]]/route.ts`.
 */
function isApiHandlerPath(path: string): boolean {
  return path === "/api" || path.startsWith("/api/");
}

/**
 * The same namespace as the `afterFiles` REWRITES see it — case-insensitively,
 * because path-to-regexp's `sensitive` defaults to false, so
 * `ASSET_MISS_SOURCE`'s `(?!api/)` lookahead excludes `/API/`, `/Api/` and `/api/`
 * alike. See {@link isPageShapedPath} for why that seam matters here.
 */
const API_NAMESPACE_ANY_CASE_PATTERN = /^\/api(?:\/|$)/i;

/**
 * Could this request be answered with a page DOCUMENT — and therefore, is this a
 * response whose `Cache-Control` and `Set-Cookie` the proxy owns?
 *
 * Two classes are excluded, and each is excluded because ANOTHER layer decides the
 * answer deliberately rather than by omission:
 *
 *  1. **`/api/*`.** `api/[[...unmatched]]/route.ts` is an optional catch-all over the
 *     whole namespace, so no `/api` address ever falls through to the
 *     `(website)/[...slug]` page store — there is no framework `s-maxage` here to
 *     correct. The handlers on the other side DO choose their own directives on
 *     purpose (`/api/skifield-conditions` answers `public, max-age=600,
 *     stale-while-revalidate=1800`), and a middleware header WINS over a route
 *     handler's: `sendResponse()` appends the handler's value only when the name is
 *     not already set, and the router server writes the proxy's headers first
 *     (`next/dist/server/send-response.js`, `server/lib/router-server.js`). So a
 *     blanket override here would silently delete two deliberate public caches. The
 *     #2405 module-state parity also lives on these responses' headers.
 *  2. **Asset-shaped URLs.** Either a real file — served by the filesystem, whose
 *     `Cache-Control` is `send`'s set-if-absent `public, max-age=<maxAge>` — or a
 *     miss the `afterFiles` rewrites terminate at `/asset-not-found` with no
 *     document. Neither can come from the page store either, so again there is no
 *     shared-cache directive to strip; and overriding would replace the branding
 *     logo's and favicon's browser caching with `no-store` on every public page
 *     view, which is a measurable cost bought for nothing.
 *
 * **The asset class is exactly `ASSET_URL_EXTENSIONS` — seven image extensions —
 * which is narrower than "a file under `public/`", deliberately.** Both halves of the
 * premise above come from that list: the rewrites terminate those shapes and nothing
 * else. So a static file of any other type (`public/fonts/Inter.woff2`,
 * `public/handbook.pdf`) counts as page-shaped here and is sent the private-only
 * directive, which for a real file means it is refetched on every page view rather
 * than cached by the browser. That is the safe direction — an extension missing from
 * the list falls through to the CMS catch-all when the file is absent, so treating it
 * as an asset without a rewrite behind it would reopen #2578 for that shape — and it
 * costs nothing today, because `public/` holds only `branding/*` images plus
 * `robots.txt` (app JS and CSS live under `_next/static/`, which the matcher
 * excludes). ONE KNOB if that changes: add the extension to
 * `ASSET_URL_EXTENSIONS` (`src/lib/asset-url-404.ts`), which moves the rewrite, the
 * setup gate's classifier and this predicate together. Adding it here alone would
 * hand the framework's `s-maxage` back to every miss of that shape.
 *
 * **That two-case premise has a THIRD case, and it is the hole the first cut of
 * #2578 shipped (review finding, 4 Aug 2026).** An asset-shaped URL under an
 * ODD-CASED `/API/` prefix is claimed by neither: no rewrite claims it, because
 * `ASSET_MISS_SOURCE`'s `(?!api/)` lookahead compiles case-INSENSITIVELY, and no
 * handler claims it, because Next's route table is case-SENSITIVE — so
 * `(website)/[...slug]` renders the club's 404 page for it, out of the page store,
 * with the framework's `s-maxage` on it. That is not an inference: it is what
 * `src/lib/__tests__/asset-url-404.test.ts` already pins (`["/API/x.png",
 * ["proxy"]]`, `["/API/images/uploaded/x.jpg", ["proxy"]]`, and
 * `resolveRewrites("/API/x.png") === null` driven through Next's own
 * `getPathMatch()`), and what `src/lib/asset-url-404.ts`'s header states in words.
 * Measured on the first cut: `/API/x.png`, `/Api/does-not-exist.png` and
 * `/ApI/nested/deep/logo.ico` all left with no directive of ours, over an unbounded
 * URL space that ordinary scanners probe. So for ROUTING purposes such an address is
 * a page, whatever it ends in, and it is treated as one here — the real (lowercase)
 * namespace is taken by {@link isApiHandlerPath} first, so nothing an `/api` handler
 * can actually answer is affected.
 *
 * Both consequences follow from the same fact — no page document can be served here
 * — so ONE predicate answers both questions the proxy asks about such a response:
 * whether to write the private-only directive ({@link getPrivateOnlyCacheControl})
 * and whether to write a cookie at all. That is what holds the #2578 invariant
 * structurally rather than by coincidence: **the proxy never emits a `Set-Cookie` on
 * a response whose `Cache-Control` it has left to another layer.**
 *
 * One predicate was necessary and not sufficient — the review of the first cut found
 * the invariant false at `/`, where {@link getPrivateOnlyCacheControl} had a carve-out
 * this predicate knew nothing about — so the claim rests on two facts together: the
 * proxy's `Set-Cookie` writers are EXACTLY {@link syncSignedInHint} and
 * {@link syncFamilyInviteReturnAddress}, both gated here, and every path this
 * predicate admits gets a directive from `getPrivateOnlyCacheControl()` or
 * `getAnonymousPageCacheControl()`. BOTH are tested rather than merely documented
 * (review finding, 4 Aug 2026): the gating is mutation-proven, and the census is an
 * AST walk of this file asserted both ways round, so a writer added somewhere new and
 * one deleted or renamed away each redden `csp-proxy.test.ts`, whose docblock states
 * the argument in full. `docs/SECURITY-ATTACK-SURFACE.md` records the history.
 *
 * A further writer is not forbidden — it has to RE-ESTABLISH the pairing rather than
 * inherit it, as #2827's second writer did: same `GET` + page-shaped gate, and its one
 * address is out of the public-website territory, so it always takes
 * {@link PRIVATE_ONLY_CACHE_CONTROL}. The census fixes WHERE a `Set-Cookie` may be
 * emitted, never what reaches the writer — since #2974 the decision behind that one is
 * `planFamilyInviteReturnAddress()`, and only the append is here.
 *
 * Note this says nothing about which addresses are the public WEBSITE — that is
 * `isPublicWebsitePath()`. A member page, `/login`, `/robots.txt` and `/sitemap.xml`
 * are all page-shaped and all outside the website territory.
 */
function isPageShapedPath(path: string): boolean {
  // The real handler namespace, as the route table matches it.
  if (isApiHandlerPath(path)) {
    return false;
  }

  // An odd-cased `/API/…`: no rewrite claims it and no handler claims it, so the CMS
  // catch-all renders it out of the page store. Page-shaped whatever its extension.
  if (API_NAMESPACE_ANY_CASE_PATTERN.test(path)) {
    return true;
  }

  return !PROXY_ASSET_SHAPE_PATTERN.test(path);
}

/** Does this request carry a next-auth session cookie of any supported shape? */
function hasSessionCookie(request: NextRequest): boolean {
  return request.cookies
    .getAll()
    .some((cookie) => SESSION_COOKIE_PATTERN.test(cookie.name));
}

/**
 * Keeps the non-secret sign-in marker cookie (#2352 D2) in step with the observed
 * session cookie, and writes NOTHING when the two already agree.
 *
 * Scoped to GET on a PAGE-SHAPED path on purpose ({@link isPageShapedPath}). A JSON
 * client has no header to correct, and answering an API call with a `Set-Cookie` it
 * did not ask for is noise a caller might reasonably treat as a session change.
 * Restricting it also keeps the header off responses whose whole contract is
 * "indistinguishable from the module being switched on" (#2405).
 *
 * **Asset-shaped URLs were added to that exclusion by #2578, and the reason is the
 * cookie's company rather than the cookie itself.** An image response has no chrome
 * to correct either — the DOCUMENT that embeds the image gets its own hint sync on
 * the same page load — and an asset URL is the one class the proxy deliberately
 * leaves carrying another layer's directive, which for a real file is `send`'s
 * `public, max-age=…`. Writing a `Set-Cookie` next to a `public` directive is the
 * hazard #2578 exists to close, so the two rules are keyed off the same predicate —
 * including its odd-cased `/API/…` carve-in, where an asset-shaped URL DOES get both
 * the cookie and the private-only directive, because the CMS catch-all answers it
 * with a document and no other layer has a directive there to protect.
 *
 * **What #2578 did NOT do: suppress the hint on every out-of-territory path.** That
 * was considered and rejected, and the reason is that `/login`, `/logout` and the
 * member area are all outside the website territory — which is to say the session
 * state CHANGES on out-of-territory responses, so suppressing there would take the
 * correction off exactly the responses that need it and leave a signed-in visitor's
 * public chrome stale until their next public page view. The invariant is held from
 * the DIRECTIVE side instead, which is the same choice
 * {@link ANONYMOUS_PAGE_CACHE_CONTROL} makes: an out-of-territory response may carry
 * this cookie, and it never carries a shared-cache directive to carry it in.
 *
 * The hint is STRIPPED from the `Cookie` header passed through to the app
 * ({@link stripSignedInHintFromCookieHeader}), so no server render can come to
 * depend on it — the hint exists for the browser only, which is what keeps it a
 * display hint rather than a second, weaker session.
 */
function syncSignedInHint(
  request: NextRequest,
  response: NextResponse,
  signedIn: boolean,
): void {
  if (request.method !== "GET") return;
  if (!isPageShapedPath(normalisePathname(request.nextUrl.pathname))) return;

  const hintPresent = hasSignedInHint(request.headers.get("cookie"));

  if (hintPresent === signedIn) return;

  // Expiring rather than deleting on the way out: an explicit past-dated
  // overwrite carries the same attributes the value was written with, so a
  // browser that scoped the original to `/` cannot be left holding it.
  response.headers.append(
    "Set-Cookie",
    serialiseSignedInHintCookie(
      signedIn ? SIGNED_IN_HINT_VALUE : "",
      signedIn ? SIGNED_IN_HINT_MAX_AGE_SECONDS : 0,
    ),
  );
}

/**
 * Appends the family-invite return-address `Set-Cookie` (#2827, #2974) that
 * {@link planFamilyInviteReturnAddress} decided on. It stays in THIS file, and not
 * in the module holding everything else about the address, because the #2578 writer
 * census reads this file's AST — see {@link isPageShapedPath}. What gets written,
 * when, and why the proxy carries it at all: that module.
 */
function syncFamilyInviteReturnAddress(
  response: NextResponse,
  plan: ReturnType<typeof planFamilyInviteReturnAddress>,
): void {
  if (plan) response.headers.append("Set-Cookie", plan.setCookie);
}

/**
 * The `Cookie` header to forward to the render, with the #2352 D2 sign-in marker
 * removed. Returns null when the header would be empty afterwards.
 *
 * This exists because "not forwarded to the render" was ASSERTED before it was
 * true (slice-1 review, F2). `NextResponse.next({ request: { headers } })` makes
 * Next re-emit every header of that set as `x-middleware-request-<name>`
 * (`next/dist/server/web/spec-extension/response.js`, `handleMiddlewareField`),
 * and `Cookie` is one header — so copying `request.headers` verbatim carried the
 * hint straight through, and `(await cookies()).get("signed-in-hint")` worked in
 * any server component or route handler. The test that was meant to catch it
 * asserted on `x-middleware-request-signed-in-hint`, a header name that can never
 * exist for any input, so it passed unconditionally.
 *
 * Filtered at the STRING level, not by reserialising `request.cookies`: every
 * other pair keeps its exact original bytes, so nothing downstream can be changed
 * by a percent-encoded or unusually quoted value passing through this function.
 *
 * One residual, and it is why {@link syncSignedInHint} writes the `Set-Cookie`
 * header directly instead of through `response.cookies`: Next also seeds
 * `cookies()` from `x-middleware-set-cookie`
 * (`next/dist/server/async-storage/request-store.js`, `mergeMiddlewareCookies`),
 * which the `NextResponse.cookies` proxy sets. Writing the header ourselves means
 * that signal is never produced, so the request that first SETS the hint cannot
 * read it back either.
 */
// test seam
export function stripSignedInHintFromCookieHeader(
  cookieHeader: string | null,
): string | null {
  if (!cookieHeader) return null;

  const kept = cookieHeader
    .split(";")
    .filter((pair) => {
      const separator = pair.indexOf("=");
      const name = (separator === -1 ? pair : pair.slice(0, separator)).trim();
      return name !== SIGNED_IN_HINT_COOKIE;
    })
    .map((pair) => pair.trim())
    .filter((pair) => pair.length > 0);

  return kept.length > 0 ? kept.join("; ") : null;
}

/**
 * Cache-Control for an anonymous public page GET, or null when #2322's deliberate
 * browser window is not the directive being sent.
 *
 * **`null` no longer means "the framework's own header reaches the wire" (#2578).**
 * It used to, and the sentence saying so survived the first cut of that fix.
 * {@link getPrivateOnlyCacheControl} now CALLS this function for the one path in
 * {@link CACHEABLE_ANONYMOUS_PATHS} and writes {@link PRIVATE_ONLY_CACHE_CONTROL}
 * whenever it answers `null` — so `null` means "the private-only rule owns this
 * response", and the two functions between them cover every page-shaped GET.
 *
 * Worth stating because reasoning from the OLD premise is what produced #2578: the
 * pre-fix `getPrivateOnlyCacheControl()` docblock argued that only a public-website
 * path could pick up a framework `s-maxage`, and shipped the stored-404 hole on that
 * basis. #2352 slice 2 makes `/` static, and anyone adding a second entry to
 * `CACHEABLE_ANONYMOUS_PATHS` needs the current relationship rather than that one.
 */
// test seam
export function getAnonymousPageCacheControl(
  request: NextRequest,
): string | null {
  if (request.method !== "GET") {
    return null;
  }

  const pathname = normalisePathname(request.nextUrl.pathname);

  if (!CACHEABLE_ANONYMOUS_PATHS.has(pathname)) {
    return null;
  }

  // There is deliberately no flight-request check here: Next's adapter strips
  // every flight header before this function can see it, so any such check
  // would be dead code that reads like a guarantee. The `private` directive
  // above is what makes a flight body harmless — see its docblock.

  return hasSessionCookie(request) ? null : ANONYMOUS_PAGE_CACHE_CONTROL;
}

/**
 * Should this response carry {@link PRIVATE_ONLY_CACHE_CONTROL}?
 *
 * Every page-shaped GET, in EITHER territory, except the one address #2322 gave a
 * deliberate browser window. The two territories reach that answer for different
 * reasons, and both are stated here because the function used to answer only for the
 * first one — which is the whole of #2578.
 *
 * **In territory (`isPublicWebsitePath()` true).** `(website)/[...slug]` is the one
 * public route with a `revalidate` export, so it is the one place the framework fills
 * in an `s-maxage`; every other public route in either group is `force-dynamic` and
 * already gets `revalidate === 0`. Sending the directive to the whole public website
 * anyway keeps one rule instead of a path list, and for the `force-dynamic` routes
 * the value is byte-identical to what Next would have written — including the three
 * `(website-dynamic)` pages, which is why the D1 narrowing left this on
 * `isPublicWebsitePath()` rather than following the nonce. An in-territory GET is
 * therefore untouched by #2578; an in-territory HEAD is not, and the paragraph on
 * methods below owns that.
 *
 * **Out of territory — the #2578 fix, and it is keyed on the REQUEST rather than on
 * the route because the proxy has no other option.** The catch-all claims every URL
 * no other route claims, including addresses whose first segment belongs to another
 * route group, so a request the proxy classifies as "not the public website" can
 * still be answered out of the public page STORE: measured on a container build of
 * slice 1, `/pay`, `/dashboard/nope` and `/admin/typo` all returned stored 404
 * documents carrying `s-maxage=15, stale-while-revalidate=31535985` and no
 * `Vary: Cookie`, because this function had refused them and the framework's own
 * header reached the wire. `Vary: Cookie` rather than "no `Vary`", precisely: the
 * measurement shows `Vary: rsc, next-router-state-tree, next-router-prefetch,
 * next-router-segment-prefetch, Accept-Encoding` on every one of them — Next's own
 * flight-navigation vary, which says nothing about the session. `Cookie` is the
 * member that would have made the stored document safe to share, and it is the one
 * that was absent. The pre-slice-1 baseline answered `private, no-cache, no-store` on
 * the same four URLs, so the directive was introduced by slice 1 rather than
 * inherited.
 * Middleware runs before routing and cannot tell `/dashboard/nope` from
 * `/dashboard/bookings` (#2570), so the only sound rule is the one that does not need
 * to know: an address outside the public website is never invited into a shared
 * cache, whichever route ends up answering it. For the real member and admin pages
 * that share that classification the value is again byte-identical to Next's own
 * `revalidate === 0` default, so nothing but the stored-404 case changes on the wire.
 *
 * It also closes the second half of the same hazard rather than only the caching
 * half: this response can carry the D2 marker `Set-Cookie`
 * ({@link syncSignedInHint}), and a `Set-Cookie` next to an `s-maxage` with no `Vary: Cookie`
 * is a cookie a shared cache may hand to a stranger. After this it can never be next
 * to one — see {@link isPageShapedPath} for the two shapes that keep another layer's
 * directive, and why the cookie is withheld on exactly those.
 *
 * **GET and HEAD, not GET alone, and the reason is the same measurement.** The
 * previous wording justified "GET only" with "a cached response needs a cacheable
 * method, and Next's own default already refuses to store one" — and the second half
 * is the assumption #2578 falsified. A HEAD for a page is routed exactly as the GET
 * is, through the same store and the same `send-payload.js`, so it takes the same
 * framework directive; leaving it out would make the invariant above true of bodies
 * and false of headers, which is not an invariant. Everything else (POST and the rest)
 * genuinely is left alone: no cache stores those, and Next's own answer for them is
 * already `no-store`.
 *
 * Widening to HEAD is the one place #2578 changes IN-territory behaviour, and it is a
 * deliberate change rather than a side effect. Measured before the widening, this
 * function answered false for `HEAD /about` and the proxy wrote no header — so the
 * framework's own value reached the wire, which on that stored CMS page is the
 * `s-maxage=15` measured for the GET (derived for HEAD from the routing being the
 * same, not separately measured on the wire). Same route, same store, same fault.
 * `csp-proxy.test.ts` asserts the new answer in territory as well as out, so
 * "in-territory GET is byte-identical" cannot quietly be read as "nothing in
 * territory moved".
 *
 * {@link CACHEABLE_ANONYMOUS_PATHS} is excluded only while the anonymous directive is
 * ACTUALLY being sent, which is the second review finding #2578 collected against its
 * own first cut. The earlier rule excluded `/` outright and argued that `/` is
 * `force-dynamic`, so the framework writes `private, no-store` for it anyway and
 * #2322's decision about that one route stays wholly inside
 * `getAnonymousPageCacheControl()`. Both halves of that were true and the conclusion
 * still failed: for a SIGNED-IN GET of `/` (and for any HEAD of `/`, which the
 * GET-only anonymous function never answers) neither function wrote a directive while
 * {@link syncSignedInHint} still wrote the marker `Set-Cookie` — so the structural
 * invariant in {@link isPageShapedPath} was held on `/` only by that `force-dynamic`
 * export, which is
 * exactly the class of assumption #2578 exists to stop relying on, and which #2352
 * slice 2 intends to change. Asking `getAnonymousPageCacheControl()` costs nothing
 * observable today — for a `force-dynamic` `/` the value written is byte-identical to
 * Next's own — and it keeps the two functions in one relationship rather than two:
 * this one covers `/` exactly when that one does not.
 */
// test seam
export function getPrivateOnlyCacheControl(
  request: NextRequest,
  publicWebsite: boolean,
): boolean {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return false;
  }

  const path = normalisePathname(request.nextUrl.pathname);

  // `/`, and only while the anonymous window is the directive actually being sent.
  if (CACHEABLE_ANONYMOUS_PATHS.has(path)) {
    return getAnonymousPageCacheControl(request) === null;
  }

  if (publicWebsite) {
    return true;
  }

  // #2578. `isPublicWebsitePath()` already refuses `/api` and every asset shape, so
  // this branch is the only one that has to ask — and an in-territory address can
  // never be either, which is why the check is not repeated above.
  return isPageShapedPath(path);
}

/**
 * Puts the private-only directive on a response the proxy itself is returning —
 * a #2420 holding screen or a module gate's 404 — unless it already decided its own.
 *
 * These two never come from the page store, so they cannot carry a framework
 * `s-maxage`; what they carried before #2578 was NOTHING, which leaves a 404 or a 503
 * heuristically cacheable by a shared cache under RFC 9111. That is a weaker version
 * of the same fault (a module-gated page's 404 held by a corporate proxy after the
 * module is switched back on), and it costs one line to close alongside.
 *
 * Set-if-absent, so the setup gate's own `no-store` + `Retry-After` discipline
 * (`src/lib/setup-gate.ts`) stays exactly as that issue decided it, and so a future
 * short-circuit that chooses a directive on purpose keeps it.
 *
 * **It asks a DIFFERENT question from {@link getPrivateOnlyCacheControl}, and the
 * first cut of #2578 wrongly reused that one (review finding, 4 Aug 2026).** That
 * predicate answers "will another layer write a directive here, and would overwriting
 * it cost something", which is why it excludes the asset shapes and `/`. A response
 * the proxy RETURNS never reaches `send` and never reaches a route handler, so on
 * these responses there is no other layer and nothing to protect: the exclusions
 * withhold the directive and buy nothing. Measured on the first cut through the real
 * proxy with the display module off, `GET /display/screen.png` came back `404` with no
 * `Cache-Control` at all (review measurement, 4 Aug 2026; reproduced at this seam) —
 * heuristically storable under RFC 9111, the same class the page-shaped case closes.
 * So the gate here is the method plus the `/api` carve-out and nothing else:
 *
 *  - **GET and HEAD only.** A cache may store those; for the other verbs RFC 9111
 *    requires explicit freshness before anything is stored, so a bare 404 is already
 *    unstorable.
 *  - **`/api` excluded**, which is what keeps the #2405 module-state parity — a gated
 *    verb's bare 400 and the JSON 404 must stay indistinguishable from what the
 *    enabled module answers, and those handlers set their own directives.
 *  - **No `/` carve-out.** #2322's browser window belongs to the home PAGE; a holding
 *    screen or a gate 404 served at `/` is not that page and must not be stored.
 */
// test seam
export function applyPrivateOnlyCacheControl(
  request: NextRequest,
  response: NextResponse,
): void {
  if (response.headers.has("Cache-Control")) return;
  if (request.method !== "GET" && request.method !== "HEAD") return;
  if (isApiHandlerPath(normalisePathname(request.nextUrl.pathname))) return;

  response.headers.set("Cache-Control", PRIVATE_ONLY_CACHE_CONTROL);
}

/**
 * The seven verbs Next's app-route module will resolve a handler for
 * (`next/dist/server/web/http.js`'s `HTTP_METHODS`). Anything else — `PROPFIND`
 * and the rest of the WebDAV/scanner vocabulary — is rejected by
 * `AppRouteRouteModule.resolve()` with a bare `400` and no body, before any
 * userland code runs. Kept in step with the vendored next@16.2.11.
 */
const STANDARD_HTTP_METHODS = new Set([
  "GET",
  "HEAD",
  "OPTIONS",
  "POST",
  "PUT",
  "DELETE",
  "PATCH",
]);

/**
 * The reply for a path a disabled module hides, or null when nothing is hidden.
 *
 * `method` matters because this response has to be INDISTINGUISHABLE from what
 * the same `/api` path answers when the module is switched ON (#2405 security
 * review). With the module on, the request reaches a real route handler — or
 * `src/app/api/[[...unmatched]]/route.ts` if no handler claims it — and Next
 * answers a non-standard verb with a bare `400` rather than running anything.
 * Answering those verbs with the JSON 404 here would have made the module state
 * readable from a single anonymous `PROPFIND /api/<gated-prefix>/zzz`: `400`
 * means on, `404` means off. Mirroring the bare 400 closes that.
 *
 * Scoped to `/api` paths on purpose. The 400 mirrors the ROUTE-HANDLER
 * contract; a page path is served by a different Next module with different
 * verb handling, so borrowing the same answer there would assert a parity that
 * has not been measured.
 *
 * Defaults to `GET` so a caller that only cares about the ordinary case (the
 * existing gate tests) reads plainly; `proxy()` always passes the real method.
 */
export function getFeatureFlagBlockResponse(
  pathname: string,
  flags: FeatureFlags,
  method: string = "GET",
): NextResponse | null {
  const disabledFeature = getDisabledFeatureForPath(pathname, flags);

  if (!disabledFeature) {
    return null;
  }

  if (!pathname.startsWith("/api/")) {
    return new NextResponse(null, { status: 404 });
  }

  return STANDARD_HTTP_METHODS.has(method)
    ? NextResponse.json({ error: "Not found" }, { status: 404 })
    : new NextResponse(null, { status: 400 });
}

async function getEffectiveModuleBlockResponse(
  pathname: string,
  method: string,
) {
  if (getRequiredFeaturesForPath(pathname).length === 0) {
    return null;
  }

  const effectiveFlags = await loadEffectiveModuleFlags();
  return getFeatureFlagBlockResponse(pathname, effectiveFlags, method);
}

/**
 * The pre-#2733 audit-log member-filter query keys, which carried a member's
 * name and email address in the page's own address.
 *
 * The audit-log page rewrites them out of the address bar, but that runs in the
 * BROWSER and therefore only after the server has already been handed the legacy
 * address — so it cannot keep them out of anything the server does with that
 * request. One of those things is durable: `${pathname}${search}` is published to
 * server components as `REQUEST_PATH_HEADER`, and `app/(admin)/layout.tsx` turns
 * it into the 2FA gate's `callbackUrl` (a redirect URL, and so a `Location`
 * header and a further history entry) and into `recordAuthBounce`'s
 * `requestedPath`, which is written to an `AuthBounceRecord` row that outlives
 * the request.
 */
const LEGACY_MEMBER_LABEL_PARAMS = ["memberName", "memberEmail"] as const;

/**
 * Deletes exactly `memberName` and `memberEmail` from a request's query string
 * for the purpose of composing `REQUEST_PATH_HEADER` (#2733).
 *
 * Deliberately narrow, and deliberately not a redirect:
 *  - **Key-exact, not a general sanitizer.** Two known legacy keys, named. It
 *    makes no attempt to guess which other parameter might hold person text, and
 *    it is not a substitute for not putting person text in a URL in the first
 *    place.
 *  - **The request still serves normally.** Bouncing or rewriting the visitor
 *    would change what a bookmark does; the page's own rewrite already handles
 *    the address bar.
 *  - **The search string is returned UNCHANGED, byte for byte, unless one of the
 *    two keys is actually present.** Re-serialising every query string through
 *    `URLSearchParams` would silently re-encode values (`%20` becomes `+`, and
 *    so on) for every request on the site, and this header feeds path matching
 *    and return paths.
 *
 * No routing decision reads either key: every `REQUEST_PATH_HEADER` consumer
 * either splits the pathname off first (`isModuleGatedRequestPath`,
 * `getAdminRouteRequirement`, `isOnboardingGateExemptPath`) or passes the value
 * to `getSafeInternalReturnPath`, which cares only about its shape.
 */
function stripLegacyMemberLabelParams(search: string): string {
  if (!search) return search;
  if (!LEGACY_MEMBER_LABEL_PARAMS.some((key) => search.includes(key))) {
    return search;
  }

  const params = new URLSearchParams(search);
  let removed = false;
  for (const key of LEGACY_MEMBER_LABEL_PARAMS) {
    if (params.has(key)) {
      params.delete(key);
      removed = true;
    }
  }
  // A bare substring hit that was not a real key (a VALUE spelling
  // "memberName", say) changes nothing.
  if (!removed) return search;

  const remaining = params.toString();
  return remaining ? `?${remaining}` : "";
}

export async function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  // #2352 D1, as the owner narrowed it on 3 Aug 2026. The invariant, in one
  // sentence:
  //
  //   **An address carries the fixed per-release nonce if and only if it is a
  //   public website address one of the five approved `(website)` routes can serve
  //   — so no PAGE is ever stored outside that set, and every other address on the
  //   site is rendered per request under a nonce minted for that request.**
  //
  // It says PAGE deliberately. The one exception is the stored out-of-territory 404
  // DOCUMENT described further down (#2570): `/dashboard/nope` IS served by one of
  // the five, because the catch-all claims every URL no other route claims, and it
  // still keeps a per-request nonce. Stating this as a plain "if and only if" would
  // contradict the residual recorded in this very docblock.
  //
  // Percent-encoded addresses need no special handling and get none:
  // `isFixedNonceWebsitePath()` compares raw segments because Next matches routes
  // raw too, so the two agree in both directions. Measured, with the framework
  // source that explains it, in `src/lib/public-website-paths.ts`.
  //
  // The five are `/`, the `[...slug]` CMS catch-all, `/join`, `/contact` and
  // `/join/apply`. `isFixedNonceWebsitePath()` is the whole answer, and it is a
  // different question from the one the #2420 setup gate asks two lines below —
  // which is why there are now two predicates instead of one shared by three
  // callers (`src/lib/public-website-paths.ts` sets out all three questions).
  //
  // **Why the fixed nonce is confined this tightly.** Its cost is real: the value
  // is readable in the page source, so on those pages it no longer stops a fully
  // injected `<script>` tag. The owner accepted that only where it buys something
  // — a STORED page can carry just one nonce, and these five hold nothing but
  // twice-sanitised admin HTML. The eight `(website-dynamic)` routes are never
  // stored, so the fixed nonce would cost them that defence and return nothing;
  // they live in `(website-dynamic)` and read the per-request nonce out of
  // `CSP_NONCE_HEADER` exactly as the member and admin pages do. Since #2818 that
  // group also holds `/booking-requests` and `/school-bookings` — two CMS-backed
  // built-in pages that would have fitted the fixed-nonce group perfectly well,
  // kept per-request because the census is an owner decision at five and because
  // these are the two pages where an anonymous visitor types the most personal
  // information.
  //
  // **Why two route groups rather than one layout with a condition.** A route
  // takes its nonce from the layout above it, and `(website)/layout.tsx` may not
  // read the request at all — that read is precisely what forced a full render on
  // every public page view. So two nonce sources means two layouts. The markup is
  // NOT duplicated to get them: both layouts are three lines around one shared
  // `WebsiteChrome` component, and
  // `scripts/ci/check-website-render-modes.mjs` fails the build if either grows
  // chrome of its own or if either group's route census changes.
  //
  // **The cache's territory is inside the fixed-nonce set, and that is a security
  // property rather than tidiness** (slice-1 review, F1). The catch-all claims
  // every URL no other route claims, which is wider than the five — so a page
  // served in the difference would be stored carrying a per-request nonce that no
  // later response names, and every inline script on it would be refused,
  // permanently, for everyone. It is closed from the CMS side rather than by
  // widening this predicate: `isCmsServablePageSlug()` makes the catch-all's
  // loader, the admin slug validator and the Book Now target all refuse an address
  // outside the set. `/pay` was the live shape. (The public site MENU asks a
  // slightly wider question since #2818, because a menu entry is a link rather
  // than a stored page — see `BUILT_IN_DYNAMIC_PAGE_SLUGS`.)
  //
  // One residual, tracked as #2570 rather than hidden, and NOT changed by the
  // narrowing: a 404 the catch-all raises for a path outside the set
  // (`/dashboard/nope`) is still stored as a 404 entry with that request's nonce,
  // so the not-found DOCUMENT served from the store afterwards carries a nonce the
  // policy no longer names — its inline scripts do not run and the page renders
  // without hydrating. MEASURED on a container build of this branch rather than
  // reasoned about: two requests for `/admin/typo` both answered 404, the first with
  // policy nonce == HTML nonce, the second with a fresh policy nonce while the HTML
  // still carried the first one. An in-territory miss (`/definitely-missing`) is
  // consistent on both, because it carries the fixed nonce — the fault is confined to
  // addresses belonging to another route group. Nothing on that document is personal,
  // the status is a correct 404 every time, and an admin write or a deploy clears it.
  //
  // The visible symptom is a BLANK page rather than the readable-but-inert page the
  // #2570 briefing described, and that correction is measured too: a `notFound()`
  // response from this route has zero server-rendered visible markup — `<body>` is an
  // empty placeholder and the whole 404 screen arrives in the RSC flight payload,
  // carried by nonce'd inline scripts. When those are refused, nothing paints.
  //
  // **What those same stored documents did to the HEADERS was a separate fault, and
  // it is CLOSED (#2578) rather than accepted.** Because the response was answered
  // out of the page store, the framework's own `s-maxage=15,
  // stale-while-revalidate=31535985` reached the wire with no `Vary: Cookie` — and could do so
  // alongside the D2 marker `Set-Cookie` — on addresses this proxy had classified as
  // not-the-public-website. `getPrivateOnlyCacheControl()` now answers for BOTH
  // territories, so an out-of-territory address is never invited into a shared cache
  // whichever route answers it. The nonce residual above is untouched: same store,
  // same blank document, same accepted trade — only its headers changed.
  //
  // **Both mechanisms for closing it are dead, and the second one for a reason of
  // principle rather than of framework version.** The owner chose option 2 on 3 Aug
  // (stop storing those documents). Next's per-render cache opt-out cannot deliver it
  // on next@16.2.12 — an on-demand ISR generation renders under the prerender-legacy
  // work-unit store, where `connection()` and `unstable_noStore()` both throw
  // `DynamicServerError` and base-server turns that into a 500, the worse outcome
  // that option's own terms said to drop the change for. The replacement considered
  // was rewriting such an address HERE to a dedicated per-request not-found route,
  // and this is the wrong place for it to be possible: **the proxy runs before
  // routing, so it cannot tell `/dashboard/nope` from `/dashboard/bookings`.**
  // `isPublicWebsitePath()` refuses both — one is a typo and the other is a real
  // member page — so a rewrite driven from here would 404 the member and admin areas
  // outright. Detecting a genuine MISS needs the route table, which only Next has at
  // that point. Do not add a hand-maintained route census here to fix that: the owner
  // rejected exactly that (option 4, #2570) because a forgotten entry hands a real
  // member page the weak fixed nonce silently. So this goes back to the owner rather
  // than being downgraded quietly.
  const fixedNonceAddress = isFixedNonceWebsitePath(pathname);
  const nonce = fixedNonceAddress
    ? await getPublicWebsiteNonce()
    : createCspNonce();
  // The POLICY's public-website flag is the WIDE predicate, not the nonce's, and
  // the difference is deliberate. Its only effect is dropping `https://js.stripe.com`
  // from `script-src` — the tightening bundled with D1 — and that is right for the
  // whole public website: Stripe.js is loaded only from the member payment
  // surfaces, so allowing it on a PIN-gated lodge-instructions page, a group-join
  // screen or a public booking-request form is reach for an attacker and nothing
  // for the club. Narrowing this flag alongside the nonce would have handed the
  // `(website-dynamic)` pages a LOOSER policy as a side effect of tightening their
  // nonce.
  const publicWebsite = isPublicWebsitePath(pathname);
  const csp = buildContentSecurityPolicy(nonce, {
    pathname,
    selfOrigin: request.nextUrl.origin,
    publicWebsite,
  });
  // NOTE: no `x-page-slug` request header any more (#2352). It existed so the two
  // public layouts could stamp `data-page-slug` on the footer, and reading it
  // meant a `headers()` call in the layout — the second of the two lines that
  // forced a full render on every public page view. The footer derives the slug
  // from `usePathname()` instead, which needs no request. Do not reintroduce a
  // request header for a value the URL already carries.

  // Ahead of the module gate on purpose (#2420). Until site setup is complete
  // the whole public website answers "not ready yet", and that outranks "this
  // module is switched off" — a 404 for a module-gated website path would
  // otherwise tell an anonymous prober which modules an unconfigured install has
  // on. For a gated PUBLIC-WEBSITE path it also means the module read never
  // happens; every other path (the admin area, the member areas, the `/api`
  // matcher entries) falls straight through to the module gate below exactly as
  // before, in both setup states. `/api/*` is never gated here — the matcher
  // drops it and `isPublicWebsitePath()` refuses it again — so
  // `api/[[...unmatched]]` keeps answering JSON 404, and the bare 400 for a
  // non-standard verb keeps matching it, whether or not setup is complete
  // (#2405).
  const setupInProgressResponse = await getSetupInProgressResponse(request);

  if (setupInProgressResponse) {
    setupInProgressResponse.headers.set(CSP_HEADER, csp);
    setSecurityHeaders(setupInProgressResponse.headers, pathname);
    applyPrivateOnlyCacheControl(request, setupInProgressResponse);
    return setupInProgressResponse;
  }

  const featureFlagBlockResponse = await getEffectiveModuleBlockResponse(
    request.nextUrl.pathname,
    request.method,
  );

  if (featureFlagBlockResponse) {
    featureFlagBlockResponse.headers.set(CSP_HEADER, csp);
    setSecurityHeaders(featureFlagBlockResponse.headers, pathname);
    applyPrivateOnlyCacheControl(request, featureFlagBlockResponse);
    return featureFlagBlockResponse;
  }

  const requestHeaders = new Headers(request.headers);

  // #2974: decided before the render's headers are assembled, because a WRITE has
  // to hand the invite page the same nonce it is about to put in the cookie.
  const normalisedPath = normalisePathname(pathname);
  const familyInviteReturnPlan = planFamilyInviteReturnAddress({
    method: request.method,
    pageShapedPath: isPageShapedPath(normalisedPath) ? normalisedPath : null,
    signedIn: hasSessionCookie(request),
    secFetchDest: request.headers.get("sec-fetch-dest"),
  });

  // The D2 marker cookie is for the BROWSER only. See
  // `stripSignedInHintFromCookieHeader` for why this line is what makes that
  // true rather than a comment claiming it.
  const forwardedCookies = stripSignedInHintFromCookieHeader(
    request.headers.get("cookie"),
  );

  if (forwardedCookies === null) {
    requestHeaders.delete("cookie");
  } else {
    requestHeaders.set("cookie", forwardedCookies);
  }

  requestHeaders.set(CSP_NONCE_HEADER, nonce);
  requestHeaders.set(CSP_HEADER, csp);
  requestHeaders.set(
    REQUEST_PATH_HEADER,
    `${request.nextUrl.pathname}${stripLegacyMemberLabelParams(
      request.nextUrl.search
    )}`
  );
  requestHeaders.set(REQUEST_METHOD_HEADER, request.method);

  // #2974: a message FROM the proxy, so an inbound copy is deleted either way.
  setFamilyInviteReturnNonceHeader(requestHeaders, familyInviteReturnPlan);

  const response = NextResponse.next({
    request: {
      headers: requestHeaders,
    },
  });

  response.headers.set(CSP_HEADER, csp);
  setSecurityHeaders(response.headers, pathname);
  syncSignedInHint(request, response, hasSessionCookie(request));
  syncFamilyInviteReturnAddress(response, familyInviteReturnPlan);

  const anonymousCacheControl = getAnonymousPageCacheControl(request);

  if (anonymousCacheControl) {
    response.headers.set("Cache-Control", anonymousCacheControl);
    // Appended, not set: a shared cache must key on the cookie so a member with
    // a session is never served the stored anonymous render (which paints the
    // header logged-out). Appending leaves any Vary the framework adds for RSC
    // navigation intact.
    response.headers.append("Vary", "Cookie");
  } else if (getPrivateOnlyCacheControl(request, publicWebsite)) {
    response.headers.set("Cache-Control", PRIVATE_ONLY_CACHE_CONTROL);
  }

  return response;
}

export default proxy;

/**
 * The root matcher entry's negative lookahead decides which requests the proxy
 * runs on at all — and therefore which requests the #2420 setup gate can answer.
 * A URL excluded here is a URL the gate never sees.
 *
 * Three of the alternatives were bare PREFIXES, and that was a bug rather than a
 * choice (#2420 review finding F3). Measured on the pre-fix matcher: `/apiary`
 * and `/api-docs` were excluded by `api`, `/logo.pngs` by `logo.png`, and
 * `/favicon.icons` by `favicon.ico` — whose unescaped dot also excluded
 * `/faviconXico`. All are ordinary website addresses. They skipped the proxy
 * entirely, so pre-setup they answered 200 instead of 503, and at all times they
 * were served with no CSP header. `api` was anchored then — it must be followed
 * by `/` or end the path — and #2404 finished the other two by deleting them
 * outright (see below): a carve-out for a file that does not exist can only cost.
 *
 * The two REMAINING bare prefixes were anchored in #2404 for the same reason F3
 * gives, one namespace over: `_next/static` also excluded `/_next/staticfoo` and
 * `_next/image` also excluded `/_next/imagemap` and `/_next/image/x`. No
 * framework handler claims any of those, so they were ordinary website addresses
 * being served with no CSP header — measured answering 404 with unnonced inline
 * `<script>` tags.
 *
 * The two anchors differ in shape, and that is the point rather than an
 * inconsistency: `_next/static` is a DIRECTORY, so only `/_next/static/…` is ever
 * served and a trailing slash is the whole exclusion; `_next/image` is a single
 * ENDPOINT taking a `?url=` query, so only the exact path is served and `$` is.
 * Each now excludes precisely what the framework serves and nothing else, and
 * `csp-proxy.test.ts` still asserts `/_next/static/chunks/main.js` stays outside.
 *
 * **The image-extension alternative was REMOVED in #2404 (owner decision,
 * 1 Aug 2026), and the two named filenames with it.** It used to read
 * `favicon\.ico$|logo\.png$|.*\.(?:png|jpg|…)$`, on the reasoning that a real
 * asset must not pay a nonce mint. Three measured facts overturned that:
 *
 *  1. **It was the reason the class existed at all.** A URL the proxy skips is a
 *     URL nothing of ours can attach a header to, and a URL the #2420 setup gate
 *     never sees. The `afterFiles` rewrites in `next.config.ts` (rules in
 *     `src/lib/asset-url-404.ts`) remove the DOCUMENT from an asset-shaped miss,
 *     which is what makes the missing nonce harmless — but
 *     only the proxy can put a `Content-Security-Policy` on the response, and
 *     only the proxy can answer 503 pre-setup. Layer, not replacement.
 *  2. **The exclusion was not buying anything.** Benchmarked on the compiled
 *     matcher, the shorter lookahead is marginally CHEAPER per request (~1.4ns),
 *     and the genuinely hot shape — the dozens of `/_next/static/…` chunk
 *     requests one page load issues — is still excluded by its own alternative.
 *     `public/` holds `branding/*` and `robots.txt` and nothing else, so the real
 *     asset requests newly running the proxy are few, and they gain `nosniff`,
 *     `X-Frame-Options` and the rest of `SECURITY_HEADERS` they did not have.
 *  3. **`favicon.ico` and `logo.png` excluded nothing whatsoever.** Neither file
 *     exists — `src/app/layout.tsx` points at `/branding/favicon.ico` — so both
 *     were dead alternatives leaving two exposed URL shapes. If either file is
 *     ever added, the filesystem serves it ahead of any rewrite and the whole
 *     cost of the proxy running on it is one nonce mint.
 *
 * So an asset-shaped miss now meets BOTH layers, and they compose rather than
 * fight: the proxy attaches the policy and the security headers, and the rewrite
 * still terminates the request at `src/app/asset-not-found/route.ts` so no
 * document is rendered. Which layer's `Content-Security-Policy` reaches the wire
 * is decided by Next and is worth knowing: `sendResponse()`
 * (`next/dist/server/send-response.js`) appends a route handler's header only
 * when the name is not already set on the outgoing response, and the router
 * server writes the middleware's headers first
 * (`server/lib/router-server.js`, "apply any response headers from routing"). The
 * proxy's per-request page policy therefore wins wherever the proxy runs, and the
 * route's tighter `default-src 'none'` remains in force for the shapes it still
 * skips — `/_next/static/chunks/deleted.js` — and as the floor if the matcher
 * ever stops covering a shape. Either way a policy ships, which is the property.
 *
 * `isPublicWebsitePath()` in `src/lib/setup-gate.ts` still refuses asset-shaped
 * paths, and no longer because it mirrors this string — it is now an independent
 * rule with its own reason, recorded there. Keep the extension list there in step
 * with `ASSET_URL_EXTENSIONS`; `src/lib/__tests__/asset-url-404.test.ts` fails if
 * they diverge.
 *
 * **There is NO prefetch exemption, and its absence is load-bearing (#2404,
 * owner decision 1 Aug 2026).** The entry used to carry a `missing:` clause that
 * skipped any request bearing `Next-Router-Prefetch` or `Purpose: prefetch`,
 * because Next's router prefetches whole route trees on hover and minting a
 * nonce for a response the user may never see is waste. Those are ordinary
 * request headers, so a bare `GET /anything` carrying `Purpose: prefetch`
 * skipped the proxy on EVERY URL and was served with no nonce, no
 * `Content-Security-Policy` and no #2420 setup gate — the same end state as the
 * asset-URL class, on any address rather than only the asset-shaped ones.
 *
 * Narrowing the exemption to a REAL flight prefetch — the pair of entries that
 * skipped only when a prefetch header and `RSC` arrived together — was tried and
 * rejected, because the matcher cannot express Next's own definition of a flight
 * request. Next flags one on `RSC: 1` EXACTLY
 * (`next/dist/server/lib/is-rsc-request.js`), while a `missing:` item with no
 * `value` treats any non-empty header as present
 * (`prepare-destination.js`'s `matchHas`). So `RSC: 2`, `RSC: 0`, or two `RSC`
 * headers that Node joins into `1, 1`, all skipped the proxy while Next went on
 * to render the full HTML document — strictly more useful to a prober than the
 * exemption itself. Pinning `value: "1"` would close that instance; deleting the
 * clause closes the class.
 *
 * The exemption also has no measured cost to defend: benchmarked on the compiled
 * matcher it was worth ~1.4ns per request, the same measurement that removed the
 * extension alternative above. And #2352 (static/ISR public pages) needs it gone
 * outright — a prefetch that skipped the proxy would put a nonce-less copy of a
 * page into the page cache, which every later visitor would then be served.
 *
 * So the proxy now runs on every request the lookahead admits, prefetch or not,
 * and no combination of request headers takes a URL outside it.
 * `csp-proxy.test.ts` pins that across the whole prefetch/`RSC` matrix.
 *
 * Because that lookahead drops the whole of `/api`, the explicit entries below
 * are the ONLY way an API path reaches the proxy — so every `/api` prefix and
 * every `/api` regex in `FEATURE_ROUTE_RULES` must be covered by an entry here,
 * or its module gate is dead code (#2435: the member-guest consent pattern had
 * none, so the `memberGuests` gate never ran in front of that endpoint). A
 * PREFIX rule gates a whole subtree, so its entry has to end in `:path*` — a
 * bare literal leaves every child gated-but-unmatched. Entries must be static
 * literals; Next parses this list at build time. `csp-proxy.test.ts` asserts
 * the two lists cannot drift apart again, probing each prefix at its bare path
 * and at a child, and each pattern once per alternation branch.
 */
export const config = {
  matcher: [
    "/((?!api(?:/|$)|_next/static/|_next/image$).*)",
    "/api/admin/:path*",
    "/api/admin/bed-allocation/:path*",
    "/api/admin/chores/:path*",
    "/api/admin/communications/:path*",
    "/api/admin/hut-leaders/:path*",
    "/api/admin/induction-templates/:path*",
    "/api/admin/inductions/:path*",
    "/api/admin/internet-banking-settings",
    "/api/admin/lockers/:path*",
    "/api/admin/lodge/:path*",
    "/api/admin/lodges/:path*",
    "/api/admin/members/:id/xero-link",
    "/api/admin/members/:id/xero-push",
    "/api/admin/members/:id/xero-unlink",
    "/api/admin/mountain-conditions/:path*",
    "/api/admin/promo-codes/:path*",
    "/api/admin/roster/:path*",
    "/api/admin/setup/finance-report-mappings/:path*",
    "/api/admin/waitlist/:path*",
    "/api/admin/work-parties/:path*",
    "/api/admin/xero/:path*",
    "/api/address-autocomplete/:path*",
    "/api/bookings/:id/guests/:guestId/consent",
    "/api/bookings/:id/waitlist-confirm",
    "/api/admin/bookings/:id/force-confirm",
    "/api/admin/bookings/:id/return-to-waitlist",
    // Events calendar (#2241): the eventsCalendar rule in
    // src/config/feature-routes.ts gates "/api/calendar", and the first matcher
    // entry above excludes every "/api/..." path, so without this entry the
    // proxy would never run on the calendar API and that half of the rule would
    // be dead.
    "/api/calendar/:path*",
    // Club message board (#2994): the commsPortal rule in
    // src/config/feature-routes.ts gates "/api/club-posts", and the first
    // matcher entry above excludes every "/api/..." path -- so without this
    // entry the proxy never runs on it and that half of the rule is dead. The
    // route handler checks the module itself as well, so the door is not left
    // live either way; this restores the edge gate and the CSP header.
    "/api/club-posts/:path*",
    "/api/chores/:path*",
    "/api/cron/xero/:path*",
    "/api/display/:path*",
    "/api/finance/:path*",
    "/api/group-bookings/:path*",
    "/api/inductions/:path*",
    "/api/lodge/:path*",
    // Maintenance reports (#2780): the maintenanceReports rule in
    // src/config/feature-routes.ts gates "/api/lodge-maintenance" (the
    // unauthenticated QR submit door) and "/api/maintenance-reports" (the member
    // submit door), and the first matcher entry above excludes every "/api/..."
    // path — so without these two entries the proxy never runs on them and
    // turning the module OFF would leave both API doors LIVE while only the
    // pages 404. Same failure the calendar entry above was added to prevent.
    "/api/lodge-maintenance/:path*",
    "/api/maintenance-reports/:path*",
    "/api/notices/:path*",
    "/api/promo-codes/:path*",
    "/api/skifield-conditions/:path*",
    "/api/skifield-whakapapa/:path*",
    "/api/webhooks/xero/:path*",
    "/api/work-parties/:path*",
  ],
};
