/**
 * Which URLs belong to the public website, and — since the D1 narrowing — which of
 * them carry the FIXED per-release CSP nonce.
 *
 * Extracted from `src/lib/setup-gate.ts` in the #2352 slice-1 review so several
 * callers can share one answer without dragging the gate's database reads with
 * them. It is deliberately DEPENDENCY-FREE (no `next/server`, no Prisma, no
 * `server-only`): the proxy, the CMS catch-all render and the admin slug validator
 * all import it.
 *
 * ## One predicate used to answer three questions. It now answers one each.
 *
 * Before the owner's 3 Aug 2026 narrowing there was a single `isPublicWebsitePath()`
 * and three callers asked it three DIFFERENT questions:
 *
 *  1. **The #2420 setup gate** — is this an address the "Site setup in progress"
 *     503 stands in for?
 *  2. **The #2352 D1 nonce split** — does this address carry the FIXED per-release
 *     script nonce, or a freshly minted per-request one?
 *  3. **The CMS catch-all's territory** — may `(website)/[...slug]` serve a page
 *     here at all?
 *
 * While the fixed nonce covered the whole `(website)` group those three had the
 * same answer, so one function could serve all three. The narrowing broke that: the
 * fixed nonce now covers exactly the five approved addresses, while the holding
 * screen must still stand in for the WHOLE public website — including every route
 * in `(website-dynamic)`. One predicate cannot say both things, and narrowing the
 * shared one would have quietly taken the pre-setup 503 off
 * `/hut-leader-instructions`, `/join/[code]`, `/join/verify/[token]` and — since
 * #2818 — `/booking-requests`, `/school-bookings` and their token flows.
 *
 * So the split is by QUESTION, not by convenience:
 *
 *  • {@link isPublicWebsitePath} answers (1). Unchanged behaviour: every public
 *    address, both groups. Only the setup gate calls it.
 *  • {@link isFixedNonceWebsitePath} answers (2). True for exactly the addresses
 *    the five approved routes can serve.
 *  • {@link isCmsServablePageSlug} answers (3), and is (2) restated as a slug
 *    question — because a page the catch-all STORES must be an address the fixed
 *    nonce covers, or its inline scripts are refused for every later visitor.
 *
 * ## The one-sentence invariant
 *
 * **An address carries the fixed per-release nonce if and only if it is a public
 * website address that one of the five approved `(website)` routes can serve — so no
 * PAGE is ever stored outside that set, and everything else on the site, public or
 * not, is rendered per request under a nonce minted for that request.**
 *
 * Held from both sides, which is why it is an invariant rather than an intention:
 * `src/proxy.ts` publishes the fixed nonce for exactly {@link isFixedNonceWebsitePath},
 * and {@link isCmsServablePageSlug} makes the catch-all's loader, the admin slug
 * validator and the Book Now target all refuse an address outside it. The public
 * site MENU used to be on that list and came off it in #2818: a menu entry is a
 * link, not a stored page, so the menu asks a slightly wider question — see
 * {@link BUILT_IN_DYNAMIC_PAGE_SLUGS}.
 *
 * **It is stated over PAGES because of one recorded exception, and the exception is
 * named here rather than left for a reader to trip over (#2570).** The `[...slug]`
 * catch-all claims every URL no other route claims, which includes addresses whose
 * first segment belongs to ANOTHER route group — `/dashboard/nope`, `/admin/typo`.
 * Those are deliberately NOT public-website addresses and so stay per-request, because
 * the proxy runs before routing and cannot tell `/dashboard/nope` from
 * `/dashboard/bookings`; widening would hand the fixed nonce to the real member and
 * admin areas, which decision D1 keeps per-request. The catch-all still renders its
 * 404 there, and that 404 DOCUMENT is stored carrying the generating request's nonce,
 * which no later response names. So the stored out-of-territory 404 documents are the
 * whole of the difference between "carries the fixed nonce" and "can be served by one
 * of the five", and an earlier wording of this paragraph asserted a plain "if and only
 * if" that they falsify. Tracked on #2570; not closed here.
 *
 * **What WAS closed for those documents is their HEADERS (#2578).** A stored
 * out-of-territory 404 shipped the framework's own `s-maxage` with no `Vary: Cookie`, because
 * `src/proxy.ts` keyed its private-only cache-control override on
 * {@link isPublicWebsitePath} and these addresses sit outside it. That override now
 * covers both territories, so a `false` from this predicate decides a NONCE and
 * nothing about caching. Do not reason from "not a public website path" to "the
 * framework's own cache header is the right one for it".
 *
 * ## Percent-encoded addresses: this file matches RAW, and that IS the mirror
 *
 * Every comparison below is against raw URL segments. That looks like a bypass —
 * percent-encode one character of a member address and it stops matching the deny
 * list — and the slice-1 review reported it as a high-severity one. It is not, because
 * Next resolves app ROUTES from the raw pathname as well, so the two agree. Measured
 * on a container build of THIS branch (`next start`, next 16.2.12) rather than
 * reasoned about, and identified by route rather than by status: the ISR catch-all is
 * the only route in either public group that answers with `x-nextjs-cache` /
 * `x-nextjs-prerender`, so those two headers say which route replied.
 *
 *     /hut-leader-instructions   200, no ISR headers -> the (website-dynamic) page
 *     /hut-leader-instruction%73 404, ISR headers    -> the CATCH-ALL, refusing the slug
 *     /hut%2Dleader%2Dinstructions  as above
 *     /dashboar%64               404, ISR headers    -> the catch-all, not /dashboard
 *     /logi%6E                   404, ISR headers    -> the catch-all, not /login
 *     /join/apply                200, no ISR headers -> the static route, one of the five
 *     /join/appl%79              404, no ISR headers -> /join/[code], same as /join/ANY
 *     /join/verif%79/tok         404, ISR headers    -> the catch-all, not the token page
 *
 * On an earlier container (16.2.11) with the group-bookings module enabled,
 * `/join/appl%79` answered 200 titled "Join a group booking" — the group-join page
 * outright, which is the same conclusion read off the body instead of the headers.
 *
 * The mechanism, in next@16.2.12's own source: a static route matches by exact string
 * equality against the raw pathname (`server/route-matchers/route-matcher.js` —
 * `pathname === this.definition.pathname`), and a dynamic route matches its regex
 * against the raw pathname with only the captured PARAMS decoded afterwards
 * (`shared/lib/router/utils/route-matcher.js`). The router server invokes the render
 * with the raw pathname (`invokePath`, `server/lib/router-server.js`) and base-server
 * routes on that. `fsChecker.getItem()` does try a decoded variant, but for an app
 * route all it produces is the `invokeOutput` hint, which filters DYNAMIC candidates
 * only (`base-server.js:1551`), so a decoded STATIC route never wins.
 *
 * So the answers here are the answers Next gives, in both directions:
 *  • an encoded form of a static route (`/hut-leader-instruction%73`, `/dashboar%64`)
 *    is claimed by nothing but the catch-all, so it is catch-all territory and takes
 *    the fixed nonce — which is the nonce the document stored there needs;
 *  • `/join/appl%79` really is the group-join page, so per-request is right.
 *    Decoding before matching would have handed a genuinely dynamic page the publicly
 *    readable fixed nonce — the security regression, not the fix.
 *
 * The one thing Next DOES resolve from a decoded path is a static FILE, which has an
 * `fsPath` and is served directly: `/robots%2Etxt` returns the real `robots.txt`
 * (measured). The consequence is confined to the pre-setup gate and is recorded rather
 * than fixed, because it is inert in both directions: while `ClubTheme.completedAt` is
 * NULL, `/robots%2Etxt` and `/branding/logo%2Epng` are claimed as website addresses and
 * answered with the 503 holding screen even though the file itself would have been
 * served — and no browser or crawler emits that form, they ask for `/robots.txt`. After
 * setup the classifier's answer for an asset URL only picks a nonce for a response that
 * carries no document at all.
 *
 * `public-website-path-predicates.test.ts` pins every shape above with the expected
 * answer written out literally, and `e2e/static-cms-pages.spec.ts` pins the route-table
 * half on a real server, because that is the half no unit test can see.
 */

/**
 * Top-level path segments that belong to a route group OTHER than the two public
 * website groups, and so are never gated and never CMS territory.
 *
 * An ALLOW list would be wrong: `(website)/[...slug]` is a catch-all, so "is this
 * a public-website address?" really is "is it anything but one of these?".
 * Enumerated rather than inferred because the proxy sees only a URL — it has no
 * access to the route tree — and `setup-gate.test.ts` walks `src/app/**` and
 * fails if a new top-level route outside the public groups is added without being
 * listed here.
 *
 * Everything here is either an operator surface or an address the operator needs
 * in order to FINISH setup: the admin area and its site-style wizard, the login
 * and password flows that get them there, the lodge/finance/authenticated member
 * areas, and the lobby display. `/api/*` is excluded by the proxy matcher itself
 * as well as here, which is what keeps `api/[[...unmatched]]/route.ts` (#2405)
 * answering JSON 404 — and the module gate's verb-by-verb parity with it —
 * identical in both setup states.
 *
 * @see setup-gate.test.ts — the filesystem check that keeps this exhaustive.
 */
// test seam
export const NON_WEBSITE_ROOT_SEGMENTS: ReadonlySet<string> = new Set([
  // (admin) — includes /admin/site-style, the wizard that ends the gate.
  "admin",
  // (authenticated)
  "book",
  "bookings",
  "calendar",
  "dashboard",
  "induction",
  "lodge-instructions",
  // #2780: the signed-in maintenance-report form. An `(authenticated)` route
  // like dashboard/induction — no session exists pre-setup, so it redirects to
  // login rather than being a public website page.
  "maintenance-report",
  // #2994: the member message board. An `(authenticated)` route like
  // dashboard/notices -- no session exists pre-setup, so it redirects to login
  // rather than being a public website page.
  "message-board",
  "nominations",
  "notices",
  "profile",
  // (public) — login and the token flows an operator may need mid-setup.
  //
  // NOT every token flow in the product, and since #2818 that is worth saying
  // out loud. `booking-requests` and `school-bookings` used to be listed here as
  // `(public)` routes; they are now public WEBSITE addresses in
  // `(website-dynamic)`, so their emailed `verify`/`respond`/`confirm` links are
  // claimed by `isPublicWebsitePath()` and answer the pre-setup holding screen
  // like the rest of the site. That is decision 11 of #2818, accepted
  // deliberately: it matches how `/join/verify/[token]` has always behaved, and a
  // club that has not finished setup has not sent those emails.
  "change-password",
  "chores",
  "confirm-email-change",
  "family-invite",
  "forgot-password",
  "login",
  // #2780: the unauthenticated lodge-maintenance QR token flow, a `(public)`
  // token route like pay / membership-cancellation. It is module- and
  // setting-gated and no token can exist pre-setup, so it 404s rather than
  // answering the holding screen — never a public website page.
  "lodge-maintenance",
  "membership-cancellation",
  "pay",
  "register",
  "reset-password",
  "verify-email",
  // (finance)
  "finance",
  // (lodge)
  "lodge",
  // app root, outside every group
  "api",
  "display",
  // The terminal 404 asset-shaped misses are rewritten to (#2404). Not a
  // website page in any setup state: it exists to answer a machine that asked
  // for an image or a script with an empty 404 and no document.
  //
  // Two independent reasons it has to be listed, and NEITHER is "missing images
  // would get a 503" — they would not. The rewrites run in `afterFiles`, which
  // is AFTER middleware, so the gate only ever sees the ORIGINAL URL
  // (`/foo.png`), and the extension rule below refuses that shape. A rewritten
  // request never reaches this function at all. (Since #2404's Option A the
  // proxy DOES run on `/foo.png`, so the gate really is consulted for it now —
  // which is exactly why that extension rule has to stay.)
  //
  //  1. `/asset-not-found` is a REAL, directly reachable URL, and a direct
  //     request for it does run the proxy — it has no extension, so the matcher
  //     matches it. Unlisted, it would be classified as a public-website path
  //     and answered pre-setup with the "Site setup in progress" screen: a 503
  //     HTML document, from the one route whose entire purpose is to answer
  //     without a document.
  //  2. `setup-gate.test.ts` walks `src/app` and requires every top-level route
  //     segment to be classified one way or the other, so an unlisted new
  //     segment fails the suite by construction rather than by review.
  "asset-not-found",
]);

/**
 * The `(website)` route group's routes, as URL patterns — the FIXED-NONCE census.
 *
 * This is owner decision D1's five approved addresses (31 Jul 2026, narrowed back
 * to exactly these on 3 Aug), written down where the runtime can read it. Adding a
 * sixth is a decision about the CSP, not a routing detail, so it has to be made
 * here on purpose: `scripts/ci/check-website-render-modes.mjs` walks the route
 * group, compares it with this list, and fails until the two agree.
 *
 * `/[...slug]` is the CMS catch-all and is the only one of the five that is stored.
 * The other four are still `force-dynamic` pending #2352 slices 2 and 3 — they are
 * listed because the nonce split is about which POLICY an address is served under,
 * not about which addresses happen to be cached today, and a slice-2 change must not
 * have to touch this list to keep the policy right.
 */
export const FIXED_NONCE_WEBSITE_ROUTES = [
  "/",
  "/[...slug]",
  "/contact",
  "/join",
  "/join/apply",
] as const;

/**
 * The `(website-dynamic)` route group's routes, as URL patterns — the PER-REQUEST
 * census, and the input {@link isFixedNonceWebsitePath} subtracts.
 *
 * These eight are public website pages in every other respect (same chrome, same
 * pre-setup holding screen) and differ only in carrying a per-request nonce. Each
 * is `force-dynamic` for a permanent reason of its own — a PIN-gated
 * per-assignment page, a group code in the URL, a one-time token in the URL, or a
 * public form an anonymous visitor types personal details into — so none of them
 * is ever stored and none of them needs a nonce that outlives a request.
 *
 * `/booking-requests` and `/school-bookings` joined the group on 13 Aug 2026
 * (#2818 decision 2). They are database-backed built-in CMS pages, so the obvious
 * home for them was the fixed-nonce group alongside `/contact` and `/join/apply` —
 * but decision D1's census is a CSP decision the owner made deliberately at five,
 * and widening it is not a routing detail. Per-request costs these two nothing:
 * both are `force-dynamic` anyway, and keeping the unguessable nonce is worth more
 * on the two pages where an anonymous visitor enters the most personal
 * information. The nav coupling that would otherwise have forced the fixed-nonce
 * placement is broken by {@link BUILT_IN_DYNAMIC_PAGE_SLUGS} instead.
 *
 * **The predicate is DERIVED from this list rather than hand-written alongside it,
 * and that is what stops the classic decay.** A hand-maintained mirror of a route
 * tree rots in the dangerous direction: a route added to the group but forgotten in
 * the mirror would silently be handed the weaker fixed nonce, with nothing failing.
 * Here there is one list, `check-website-render-modes.mjs` fails if the group's
 * files and this list disagree, and the runtime answer follows the list — so the
 * only way to add a per-request public page is to add it here, and the only way to
 * add a fixed-nonce one is to amend {@link FIXED_NONCE_WEBSITE_ROUTES}.
 */
export const PER_REQUEST_WEBSITE_ROUTES = [
  "/booking-requests",
  "/booking-requests/respond/[token]",
  "/booking-requests/verify/[token]",
  "/hut-leader-instructions",
  "/join/[code]",
  "/join/verify/[token]",
  "/school-bookings",
  "/school-bookings/confirm/[token]",
] as const;

/**
 * The built-in `(website-dynamic)` pages that own a `PageContent` row, and so may
 * carry a public menu entry even though the CMS catch-all will never serve them.
 *
 * ## The coupling this breaks
 *
 * {@link isCmsServablePageSlug} answers "may the catch-all STORE a page here?",
 * and until #2818 the public menu filter
 * (`listWebsiteMenuPages`, `src/lib/page-content-html.ts`) used that same answer
 * as its own. For an admin-created page the two questions really are the same
 * one: a slug the catch-all refuses is a slug nothing serves, so linking to it
 * promises a 404. These two pages are the case that breaks the equivalence —
 * a REAL code-backed route serves each of them, so the address works perfectly,
 * while the catch-all must still refuse the slug because the page is rendered
 * per request and is never stored.
 *
 * Without this list the only way to give either page a menu entry would be to
 * move it into the fixed-nonce group, which is what #2813 originally did and what
 * decision 2 of #2818 reversed. The list is the seam that lets the CSP decision
 * and the navigation decision be made independently.
 *
 * ## Why an allowlist rather than "any per-request route"
 *
 * Membership here is code-owned and deliberately tiny. `/hut-leader-instructions`
 * is per-request too and must NOT be listable: it is PIN-gated and
 * per-assignment, has no `PageContent` row, and would be a nav link to a screen
 * that refuses everyone who follows it. Deriving the set from
 * {@link PER_REQUEST_WEBSITE_ROUTES} would sweep it in, so the set is written
 * down — and `public-website-path-predicates.test.ts` pins that every entry is a
 * real single-segment route in that census, so an entry cannot rot into a nav
 * link pointing at nothing.
 *
 * Being on this list is PERMISSION, never advertisement. Both pages seed an EMPTY
 * `menuTitle`, so every deployment stays unlisted until a club sets one under
 * Site Appearance & Content → Page Content (#2818 decision 1) — and the same
 * signal decides search-engine indexability, so the nav and the robots tag can
 * never disagree.
 */
export const BUILT_IN_DYNAMIC_PAGE_SLUGS: ReadonlySet<string> = new Set([
  "booking-requests",
  "school-bookings",
]);

/**
 * Is this slug one of the built-in per-request pages that may appear in the
 * public navigation when its club has set a menu title?
 *
 * A `true` here says only that a real route serves the address. The menu filter
 * still requires the row to be published and to carry a non-empty `menuTitle`;
 * see {@link BUILT_IN_DYNAMIC_PAGE_SLUGS}.
 */
export function isBuiltInDynamicPageSlug(slug: string): boolean {
  return BUILT_IN_DYNAMIC_PAGE_SLUGS.has(slug);
}

/**
 * Machine-readable addresses served from the app root or `public/` that are not
 * the visitor-facing website. `robots.txt` in particular has to keep answering:
 * a crawler that cannot read it falls back to crawling everything, which is the
 * opposite of what the holding screen is for.
 */
const NON_WEBSITE_EXACT_PATHS: ReadonlySet<string> = new Set([
  "/robots.txt",
  "/sitemap.xml",
  "/favicon.ico",
]);

/**
 * Static-asset shapes that are never public-website pages, whatever the setup
 * state.
 *
 * **This is an INDEPENDENT rule with its own reason, and it stopped mirroring
 * `config.matcher` in #2404.** It was introduced in #2420 (review finding F3) as
 * the classifier's half of a reconciliation: the matcher skipped every
 * image-extension path so a real asset never paid a nonce mint, and the gate had
 * to agree, because claiming a path the proxy never runs on asserts a 503 that
 * can never be served. #2404's Option A then removed that exclusion from the
 * matcher, so the mirror is gone — the proxy now runs on `/gallery.svg`, the gate
 * really is consulted for it, and this rule is the only thing deciding the answer.
 *
 * The reason it must stay is simpler than the one it replaced, and stronger: **the
 * holding screen is an HTML DOCUMENT.** A request for an image or a deleted
 * script chunk must never be answered with one — that is the whole of #2404 — and
 * a club mid-setup would otherwise answer every such request with the 503 "Site
 * setup in progress" page.
 *
 * Not for the holding screen's own sake: it loads no image at all
 * (`src/lib/setup-in-progress-screen.ts` inlines its theme CSS and ships no
 * `<img>`, no `<link>` and no external anything, precisely so this constraint is
 * satisfied by needing nothing). The surface that does need `public/branding/*`
 * mid-setup is the ADMIN's site-style wizard, which an operator uses in exactly
 * the state this rule covers — `branding` is not in
 * {@link NON_WEBSITE_ROOT_SEGMENTS}, so without this rule
 * `/branding/favicon.ico` would be gated 503 underneath them.
 *
 * The list is kept in step with `ASSET_URL_EXTENSIONS` in
 * `src/lib/asset-url-404.ts` — the shapes the `afterFiles` rewrites terminate —
 * because an extension terminated there but unrecognised here is exactly the
 * gap that puts a document back on an asset URL.
 * `src/lib/__tests__/asset-url-404.test.ts` fails if the two drift apart.
 *
 * Consequence, recorded rather than hidden: pre-setup, a request for an
 * asset-shaped URL that no file backs (`/gallery.svg`) is answered by the app
 * rather than the gate — since #2404, with an empty 404 rather than a 200.
 */
const STATIC_ASSET_EXTENSION_PATTERN = /\.(?:png|jpg|jpeg|gif|webp|svg|ico)$/i;

/**
 * One trailing slash off, and nothing else — in particular NO percent-decoding.
 *
 * Next strips the trailing slash the same way before matching
 * (`removeTrailingSlash` in `handleCatchallRenderRequest`), and it matches routes
 * against the raw pathname. Decoding here would make this file disagree with the
 * route table in both directions; the module header sets out the measurement.
 */
function normalisePathname(pathname: string) {
  return pathname.length > 1 && pathname.endsWith("/")
    ? pathname.slice(0, -1)
    : pathname;
}

/**
 * A route pattern compiled to a per-segment matcher: a string matches that segment
 * literally, `null` matches any one non-empty segment.
 *
 * Only literal segments and single dynamic segments (`[code]`) are understood, and
 * an unsupported shape THROWS at module load rather than being skipped. That is
 * deliberate: a catch-all or optional catch-all in the per-request group would
 * claim more addresses than a per-segment match can express, and silently matching
 * fewer would hand the fixed nonce to a per-request page. A module-load throw fails
 * the dev server, every test and the build at once; a quiet miss would fail nothing.
 */
function compileRoutePattern(pattern: string): (string | null)[] {
  return pattern
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => {
      if (!segment.startsWith("[")) {
        return segment;
      }
      if (/^\[[^.[\]]+\]$/.test(segment)) {
        return null;
      }
      throw new Error(
        `Unsupported route segment "${segment}" in "${pattern}": ` +
          "src/lib/public-website-paths.ts understands literal and single dynamic " +
          "segments only. A catch-all here would claim addresses this matcher " +
          "cannot express, which would hand the fixed CSP nonce to a per-request page.",
      );
    });
}

const PER_REQUEST_ROUTE_MATCHERS = PER_REQUEST_WEBSITE_ROUTES.map(
  compileRoutePattern,
);

/**
 * The four STATIC addresses among the approved five, which win over any dynamic
 * pattern exactly as they do in Next's own route table.
 *
 * `/join/apply` is why this set has to exist: it matches the `/join/[code]` pattern
 * segment-for-segment, but Next serves the static route, so the address belongs to
 * the fixed-nonce group. Derived from {@link FIXED_NONCE_WEBSITE_ROUTES} rather than
 * typed out again, so amending the census cannot leave this behind.
 */
const FIXED_NONCE_STATIC_PATHS: ReadonlySet<string> = new Set(
  FIXED_NONCE_WEBSITE_ROUTES.filter((route) => !route.includes("[")),
);

/**
 * Does a `(website-dynamic)` route claim this address?
 *
 * Segments are compared RAW, which mirrors Next: a dynamic route's regex is matched
 * against the undecoded pathname and only the captured params are decoded, so
 * `/join/appl%79` is the `/join/[code]` page (measured) while `/join/verif%79/tok` is
 * not the token page and falls to the catch-all. See the module header.
 */
function matchesPerRequestRoute(path: string): boolean {
  const segments = path.split("/").filter((segment) => segment.length > 0);

  return PER_REQUEST_ROUTE_MATCHERS.some(
    (matcher) =>
      matcher.length === segments.length &&
      matcher.every(
        (expected, index) => expected === null || expected === segments[index],
      ),
  );
}

/**
 * Does this URL resolve into one of the two public website route groups — i.e. is
 * it part of the public website the holding screen stands in for?
 *
 * **This is the #2420 SETUP GATE's question and nothing else now.** It deliberately
 * claims both public groups, so every `(website-dynamic)` route — including
 * `/hut-leader-instructions`, `/join/[code]`, `/join/verify/[token]` and the
 * booking-request and school-booking pages and their token flows — is answered
 * with the 503 holding screen before setup is complete, exactly as the five
 * approved routes are. Narrowing it to the fixed-nonce set would have taken the
 * holding screen off them, which is a change to what an unlaunched club exposes
 * and was never asked for — the D1 narrowing is about which NONCE an address
 * carries, not about which addresses are public.
 *
 * The recorded consequence for the token flows (#2818 decision 11): pre-setup, an
 * emailed `verify`/`respond`/`confirm` link answers the holding screen rather than
 * the confirmation screen, exactly as `/join/verify/[token]` already did. Accepted
 * rather than carved out — a club that has not finished setup has not sent those
 * emails, and a carve-out would put a real, tokenised page in front of the world
 * on a site the operator has not yet launched.
 *
 * For the nonce decision use {@link isFixedNonceWebsitePath}; for the CMS
 * catch-all's territory use {@link isCmsServablePageSlug}.
 *
 * Case-sensitive, like Next's own routing: `/Admin/nope` is not the admin area,
 * it is an unmatched website address, and it should be gated exactly as
 * `/definitely-missing` is.
 *
 * MUST stay a subset of what `config.matcher` matches: the gate runs inside
 * `proxy()`, so claiming a path the proxy never runs on would assert a 503 that
 * can never be served. That invariant is asserted, not assumed.
 */
// test seam
export function isPublicWebsitePath(pathname: string): boolean {
  const path = normalisePathname(pathname);

  if (!path.startsWith("/")) {
    return false;
  }

  if (path === "/") {
    return true;
  }

  if (NON_WEBSITE_EXACT_PATHS.has(path)) {
    return false;
  }

  if (STATIC_ASSET_EXTENSION_PATTERN.test(path)) {
    return false;
  }

  const rootSegment = path.split("/")[1] ?? "";

  // `/_next/*` and any other framework-internal prefix. The proxy matcher
  // already drops `_next/static` and `_next/image`; this covers the rest.
  if (rootSegment.startsWith("_")) {
    return false;
  }

  return !NON_WEBSITE_ROOT_SEGMENTS.has(rootSegment);
}

/**
 * Does this address carry the FIXED per-release CSP nonce (#2352 D1, narrowed by
 * the owner on 3 Aug 2026)?
 *
 * True for exactly the addresses one of the five approved `(website)` routes can
 * serve: the four fixed paths, plus everything the `[...slug]` CMS catch-all
 * claims. False for the eight `(website-dynamic)` routes and for every non-website
 * address, both of which mint a nonce per request.
 *
 * The subtraction is the whole of it, and it is exact rather than approximate:
 * a public-website address is in the fixed-nonce set unless a `(website-dynamic)`
 * route claims it, and Next's static-beats-dynamic precedence is mirrored by
 * checking {@link FIXED_NONCE_STATIC_PATHS} first so `/join/apply` stays with the
 * five instead of being swallowed by the `/join/[code]` pattern.
 *
 * Two consequences worth stating, because both are correct and neither is obvious:
 *  • `/join/deeper/still` and `/hut-leader-instructions/extra` are in the set. No
 *    `(website-dynamic)` route claims them (its patterns are fixed-length), so the
 *    catch-all serves them, so they must carry the nonce a stored page would be
 *    stored with.
 *  • `/dashboard/nope` is NOT in the set, and the catch-all still renders its 404.
 *    That is the #2570 residual — a stored 404 document whose nonce a later
 *    response no longer names — and it is unchanged by the narrowing. See
 *    `src/proxy.ts`.
 *
 * A percent-encoded address is answered exactly as Next answers it, and the module
 * header carries the measurement: an encoded static route is catch-all territory
 * (`/hut-leader-instruction%73` is in the set), and `/join/appl%79` is the
 * `/join/[code]` page, so it is not.
 */
export function isFixedNonceWebsitePath(pathname: string): boolean {
  const path = normalisePathname(pathname);

  if (!isPublicWebsitePath(path)) {
    return false;
  }

  if (FIXED_NONCE_STATIC_PATHS.has(path)) {
    return true;
  }

  return !matchesPerRequestRoute(path);
}

/**
 * May the `(website)/[...slug]` CMS catch-all serve a page for this slug?
 *
 * Takes a SLUG (`about`, `trips/2026`), not a path, because that is what its
 * callers hold: the admin write validator, the catch-all's own loader and the
 * Book Now target. The answer is {@link isFixedNonceWebsitePath} of the
 * corresponding path, and the point of the wrapper is the name — a reader at any
 * of those call sites should see the reason rather than a nonce predicate used
 * for something that is not a nonce decision.
 *
 * A `false` here is not a preference. Under full-route ISR a page served outside
 * the fixed-nonce set is a page stored with a per-request nonce, which every
 * later response then fails to name — see this module's header.
 *
 * It tightened with the D1 narrowing, and the three addresses it gained were
 * already unreachable rather than newly refused: `hut-leader-instructions`,
 * `join/<code>` and `join/verify/<token>` are claimed by real routes, so a CMS
 * page at one of those slugs could never be served in any release. Refusing them
 * here is what stops the admin creating one, and what drops any existing row out
 * of the public menu — the same treatment `/lodge/history` got in the slice-1
 * security re-review, for the same reason: an address the site will not serve is
 * an address the site must not offer.
 *
 * **The public site MENU no longer asks this question alone (#2818).** It gained
 * `/booking-requests` and `/school-bookings`, which real code-backed routes serve
 * perfectly while the catch-all must still refuse the slug — so the menu filter
 * accepts this predicate OR {@link isBuiltInDynamicPageSlug}. That is the only
 * caller with the widened test; the admin write validator, the catch-all loader
 * and the Book Now target all still refuse these two, because for each of them
 * "the catch-all will serve it" really is the question being asked.
 */
export function isCmsServablePageSlug(slug: string): boolean {
  return isFixedNonceWebsitePath(`/${slug}`);
}
