// Relative, not `@/`: not every loader that can reach a module beside the
// registry resolves the alias (see `src/lib/admin-hubs/release.ts`).
import { getAdminPage, type AdminPageId } from "./admin-hubs";

export const CSP_HEADER = "Content-Security-Policy";
// test seam
export const CSP_REPORT_ONLY_HEADER = "Content-Security-Policy-Report-Only";
export const CSP_NONCE_HEADER = "x-nonce";

// test seam
export const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Strict-Transport-Security": "max-age=31536000",
  "Cross-Origin-Opener-Policy": "same-origin",
} as const;

export function createCspNonce() {
  return Buffer.from(crypto.randomUUID()).toString("base64");
}

export interface CspOptions {
  /** The request pathname — a couple of routes carry a scoped relaxation. */
  pathname?: string;
  /**
   * The request's own origin (scheme://host[:port]). The sandboxed template
   * preview (LTV-036) frames /display with an OPAQUE origin, where `connect-src
   * 'self'` matches nothing; adding the concrete origin lets the framed document
   * still reach /api/display/state.
   */
  selfOrigin?: string;
  /**
   * Is this a public-website page — EITHER public route group, `(website)` or
   * `(website-dynamic)`? (#2352, D1.)
   *
   * Decided by the CALLER rather than re-derived here, because the authoritative
   * predicate is `isPublicWebsitePath()` in `src/lib/public-website-paths.ts` — the
   * same one the #2420 setup gate uses — and importing the gate here would drag
   * the database-backed setup state into a file every layout imports.
   * `src/proxy.ts` is the only caller that builds a page policy, and
   * `csp-proxy.test.ts` pins the mapping by driving the real proxy over a URL
   * matrix rather than trusting the flag.
   *
   * Its ONE consequence is that Stripe is dropped from `script-src` — the
   * tightening bundled with D1's trade. Stripe.js is loaded only from the member
   * payment surfaces, so allowing it on any public page was surplus reach.
   *
   * **This flag does NOT mean "the nonce handed in is the fixed per-release value",
   * and since the owner's 3 Aug 2026 narrowing that distinction is load-bearing.**
   * The fixed nonce covers only the five approved `(website)` routes
   * (`isFixedNonceWebsitePath()`); the eight `(website-dynamic)` routes —
   * `/hut-leader-instructions`, `/join/[code]`, `/join/verify/[token]`,
   * `/booking-requests`, `/school-bookings` and the three tokenised confirmation
   * pages under the last two — are public-website pages that carry a per-request
   * nonce. The tightening deliberately covers them anyway: following the nonce
   * here would have handed them a LOOSER policy as a side effect of tightening
   * their nonce.
   */
  publicWebsite?: boolean;
}

/**
 * Canonicalises a pathname before it is compared against the exact-match
 * allowlists below. It strips ONE trailing slash, and only from a path longer
 * than "/".
 *
 * Why: Next redirects `/admin/display/builder/` to the canonical no-slash form
 * with a 308, but this proxy runs BEFORE that redirect — so the redirect
 * response itself, and anything that ever reached the route without being
 * redirected, would be served the unrelaxed policy and the scoped relaxation
 * would be silently inert (issue #2246).
 *
 * This normalises the INPUT only; the comparison itself stays exact equality, so
 * nothing new is admitted. `/admin/display/builder/extra`,
 * `/admin/display/builder-foo`, `//admin/display/builder` and a double trailing
 * slash all still fail closed — see the path matrix in
 * `src/lib/__tests__/csp-proxy.test.ts`.
 */
function normalisePathname(pathname: string) {
  return pathname.length > 1 && pathname.endsWith("/")
    ? pathname.slice(0, -1)
    : pathname;
}

export function setSecurityHeaders(headers: Headers, pathname?: string) {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    headers.set(name, value);
  }
  // /display may be embedded in the same-origin sandboxed template preview
  // (LTV-036, ADR-003 §5). SAMEORIGIN keeps third-party clickjacking blocked
  // while letting our own admin preview host frame it; every other route keeps
  // the global DENY. The reverse proxy scopes its own X-Frame-Options to the
  // same single path so the edge cannot override this — see `Caddyfile`.
  if (pathname !== undefined && normalisePathname(pathname) === "/display") {
    headers.set("X-Frame-Options", "SAMEORIGIN");
  }
}

/**
 * An admin page's two addresses, old path then hub path, from the hub registry
 * (C11 #4808). Both are listed whatever `ADMIN_HUBS_LIVE` says: the page is
 * served at one and redirected from the other, and the redirect response is
 * itself on this pathname. Each stays a single exact path.
 */
function bothAdminPaths(id: AdminPageId): readonly string[] {
  const page = getAdminPage(id);
  return [page.oldPath, page.hubPath];
}

/**
 * Admin pages that EMBED the sandboxed /display iframe, and so need
 * `frame-src 'self'`: the Templates preview host (LTV-036, ADR-003 §5) and the
 * Visual builder's Live preview (ADR-004 §7, issue #2246). Each is listed at its
 * old path and its hub path under `/admin/lodge-ops`.
 *
 * Matched by EXACT equality against `normalisePathname(pathname)`, never by
 * prefix — a prefix match would silently hand `frame-src 'self'` to
 * `/admin/display/templates` (or `/admin/lodge-ops/display/templates`) and
 * every future display page, which is precisely the blanket relaxation the
 * scoped design avoids.
 *
 * Exported as a test seam: `display-builder-csp-static.test.ts` drives its
 * hard-navigation guard from these lists, so adding a path here automatically
 * requires that path's entry points to be hard navigations (issue #2279).
 */
// test seam
export const FRAME_SRC_SELF_PATHS: readonly string[] = [
  ...bothAdminPaths("display-preview"),
  ...bothAdminPaths("display-builder"),
];

/**
 * Routes whose img-src drops the `https:` wildcard (issue #161, ADR-003
 * residual): admin-authored display HTML/CSS can embed an <img>, and the global
 * img-src otherwise allows any https host — an authoring admin could exfiltrate
 * the display's own token values (config, occupancy, …) via an image-beacon
 * `src`. These are the routes that RENDER authored display markup: /display
 * itself, and the minimal preview host whose whole body is that iframe, at its
 * old path and its hub path.
 *
 * Deliberately NOT the Visual builder: it is a full admin page inside the admin
 * chrome (avatars, uploaded images, the rest of the admin UI), not a sandboxed
 * display document, so dropping `blob:`/`https:` there would break unrelated
 * admin imagery for no gain — the authored markup it previews runs in the
 * opaque-origin /display frame, which carries the tightened policy itself.
 * Exact equality against the normalised pathname only, for the same reason as
 * above. Exported as the same test seam.
 */
// test seam
export const TIGHT_IMG_SRC_PATHS: readonly string[] = [
  "/display",
  ...bothAdminPaths("display-preview"),
];

export function buildContentSecurityPolicy(nonce: string, options: CspOptions = {}) {
  const isDev = process.env.NODE_ENV === "development";
  const { pathname, selfOrigin, publicWebsite = false } = options;

  // Scoped relaxations for the sandboxed display preview (LTV-036, ADR-004 §7):
  //  • /display: frame-ancestors 'self' so our own admin preview surfaces can
  //    frame it (every other route stays 'none'), and connect-src gains this
  //    site's explicit origin so the opaque-origin framed document can still
  //    fetch the state API.
  //  • the FRAME_SRC_SELF_PATHS hosts: frame-src 'self' so they may embed the
  //    /display iframe.
  //  • the TIGHT_IMG_SRC_PATHS routes: a tighter img-src (see above).
  // The frame-src and img-src sets are deliberately SEPARATE lists: framing
  // /display and rendering authored display markup are unrelated needs, and one
  // shared boolean would force every new preview host to accept the tightened
  // img-src as the price of an iframe.
  // One normalisation, applied to every allowlist below, so they cannot diverge
  // on a trailing slash (a route that gained `frame-src 'self'` on `/…/builder/`
  // but not the matching tightened `img-src` would be a policy nobody designed).
  const canonicalPath = pathname === undefined ? undefined : normalisePathname(pathname);
  const isDisplay = canonicalPath === "/display";
  const framesDisplay =
    canonicalPath !== undefined && FRAME_SRC_SELF_PATHS.includes(canonicalPath);
  const tightensImgSrc =
    canonicalPath !== undefined && TIGHT_IMG_SRC_PATHS.includes(canonicalPath);
  // `blob:` is required for the member-photo crop UI (epic #171): it previews the
  // locally-selected file by loading its `URL.createObjectURL(...)` blob into an
  // <img>. blob: URLs are same-origin and page-created — no exfiltration vector,
  // unlike the `https:` wildcard the display route deliberately drops.
  const imgSrc = tightensImgSrc
    ? "img-src 'self' data:"
    : "img-src 'self' data: blob: https: https://www.google-analytics.com https://*.google-analytics.com";

  const directives = [
    "default-src 'self'",
    [
      "script-src",
      "'self'",
      `'nonce-${nonce}'`,
      ...(isDev ? ["'unsafe-eval'"] : []),
      // Dropped on the public website (#2352 D1): Stripe.js is loaded from the
      // member payment surfaces only, never from a public information page, so
      // this entry bought an attacker reach and the club nothing. Google Tag
      // Manager stays — the analytics module loads gtag from it on exactly these
      // pages when an admin has switched analytics on.
      ...(publicWebsite ? [] : ["https://js.stripe.com"]),
      "https://www.googletagmanager.com",
    ].join(" "),
    // Keep inline styles during the script nonce rollout; Tailwind/Radix and
    // selected editor-rendered content can still emit runtime style attributes.
    "style-src 'self' 'unsafe-inline'",
    imgSrc,
    "font-src 'self' data:",
    [
      "connect-src",
      "'self'",
      ...(isDisplay && selfOrigin ? [selfOrigin] : []),
      "https://api.stripe.com",
      "https://js.stripe.com",
      "https://*.ingest.sentry.io",
      "https://www.google-analytics.com",
      "https://*.google-analytics.com",
    ].join(" "),
    [
      "frame-src",
      ...(framesDisplay ? ["'self'"] : []),
      "https://js.stripe.com",
      "https://hooks.stripe.com",
    ].join(" "),
    "worker-src 'self' blob:",
    "object-src 'none'",
    isDisplay ? "frame-ancestors 'self'" : "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ];

  return directives.join("; ");
}
