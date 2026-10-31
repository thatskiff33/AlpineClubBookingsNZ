/**
 * THE ROUTE-GROUP ERROR BOUNDARIES, AS DATA (#4467 item 1).
 *
 * Every route group under `src/app` has its own `error.tsx`, and each one is a
 * one-line wrapper around the shared `RouteError` component
 * (`src/components/route-error.tsx`) naming its key below. Everything a group
 * answers differently — where "back" goes, what it is called, and whether the
 * group has a loading state of its own — lives here, once, so seven boundaries
 * cannot drift into seven different screens.
 *
 * ## Where each boundary sits, and why it is not always the group root
 *
 * Next renders an `error.tsx` INSIDE the `layout.tsx` of its own segment and
 * catches errors from everything below it, but never from that layout
 * (`node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/error.md`,
 * "does not wrap the layout.js ... above it in the same segment"). So a boundary
 * placed next to the group's OUTERMOST layout is the one that keeps the admin
 * sidebar, the member nav or the website header on screen while the page beneath
 * them failed. `boundaryDir` names that directory. For every group but one it
 * is the group root; `(finance)` has no group-level layout — its chrome lives in
 * `(finance)/finance/layout.tsx` — so its boundary lives there too. A boundary at
 * `(finance)/error.tsx` would sit ABOVE the finance layout and render without it.
 *
 * `route-group-boundaries.test.ts` walks `src/app` and holds this table to the
 * tree: an unlisted group, a missing `error.tsx`, or a boundary that is not the
 * shallowest layout in its group fails the build.
 *
 * ## The way back
 *
 * The second action on every boundary is a link to the group's own home rather
 * than `router.back()`. The layout above the boundary is still standing, so the
 * officer has not lost their place in the navigation; what failed is one page.
 * A fixed in-group target is deterministic — the previous history entry may be
 * the page that just failed, another site, or nothing at all on a kiosk or a
 * freshly opened link — and it is a plain `href`, so it still works when the
 * failure was in hydration itself.
 */

export type RouteGroupBoundary = {
  /** The route-group directory under `src/app`, parentheses included. */
  group: `(${string})`;
  /**
   * The directory, relative to `src/app`, holding the group's outermost
   * `layout.tsx` and therefore its `error.tsx` (and `loading.tsx`, where the
   * group has one).
   */
  boundaryDir: string;
  /** Where the "back" link goes: the group's own landing page. */
  homeHref: string;
  /** The link's visible text. */
  homeLabel: string;
  /**
   * Why this group has NO `loading.tsx` beside its error boundary, when it has
   * none. A group-level loading boundary is not free: it starts the response
   * stream before any page decides anything, so a page's own `notFound()` or
   * `redirect()` arrives as a 200 ("Streaming page responses begin with a 200
   * status code", `node_modules/next/dist/docs/01-app/03-api-reference/
   * 03-file-conventions/loading.md`, "Status codes"), and it makes every dynamic
   * page in the group prefetchable (`.../02-guides/prefetching.md`). The census
   * holds the tree to this answer both ways.
   */
  loadingExemptReason?: string;
  /**
   * The exemption covers only the group's own `loading.tsx`; pages further down
   * keep theirs. Without it, no folder in the group may have one.
   */
  loadingExemptAtRootOnly?: true;
};

export const ROUTE_GROUP_BOUNDARIES = {
  admin: {
    group: "(admin)",
    boundaryDir: "(admin)",
    homeHref: "/admin",
    homeLabel: "Back to the admin dashboard",
    loadingExemptReason:
      "Without Cache Components, Next prefetches a dynamic route only when it has a loading.js (node_modules/next/dist/docs/01-app/02-guides/prefetching.md, 'Prefetching static vs. dynamic routes'), so a group boundary would let every sidebar link prefetch its page, each one rendering the admin layout (guardAdminLayout plus five loads) on every admin page view. It would also turn the page-level notFound() and redirect() calls into streamed 200s, and expose every admin spec to the streaming double-render flake (docs/E2E_PLAYWRIGHT.md, flake invariant 2). The slow admin pages carry their own loading.tsx (bookings, dashboard, members), which is why this exemption is the group root only.",
    loadingExemptAtRootOnly: true,
  },
  authenticated: {
    group: "(authenticated)",
    boundaryDir: "(authenticated)",
    homeHref: "/dashboard",
    homeLabel: "Back to your dashboard",
    loadingExemptReason:
      "Member pages decide their own 404s after a database read: /notices/[id] answers an out-of-audience member with a hard 404 that e2e/member-notices.spec.ts asserts, and a group loading boundary would turn every one into a streamed 200. The member screens that are slow to load carry their own loading.tsx (dashboard, bookings, book, booking detail, consent), which is why this exemption is the group root only.",
    loadingExemptAtRootOnly: true,
  },
  finance: {
    group: "(finance)",
    boundaryDir: "(finance)/finance",
    homeHref: "/finance",
    homeLabel: "Back to the finance dashboard",
  },
  lodge: {
    group: "(lodge)",
    boundaryDir: "(lodge)",
    homeHref: "/lodge/kiosk",
    homeLabel: "Back to the lodge kiosk",
    loadingExemptReason:
      "The lodge kiosk and roster fetch their own data on the client, so a group loading boundary never shows on a fresh load, and it would turn the roster layout's server redirect to the kiosk into a client-side one. The July 2026 hardening review (docs/reviews/2026-07-15-production-hardening.md, F36) says of loading skeletons: 'Lodge routes are client-fetched — do not add there.'",
  },
  public: {
    group: "(public)",
    boundaryDir: "(public)",
    homeHref: "/",
    homeLabel: "Go to the home page",
    loadingExemptReason:
      "The sign-in, registration and recovery screens decide redirects in the page (/login, /login/verify, /login/enroll, /register, /membership-cancellation/[token]); behind a loading boundary each 307 becomes a 200 plus a client-side redirect on the most-travelled path in the app.",
  },
  website: {
    group: "(website)",
    boundaryDir: "(website)",
    homeHref: "/",
    homeLabel: "Go to the home page",
    loadingExemptReason:
      "Forbidden by scripts/ci/check-website-render-modes.mjs (#2352, #2434): a boundary above the CMS catch-all can commit a 200 before it decides a URL is a 404, making a missing page a soft 404 that ISR then stores.",
  },
  websiteDynamic: {
    group: "(website-dynamic)",
    boundaryDir: "(website-dynamic)",
    homeHref: "/",
    homeLabel: "Go to the home page",
    loadingExemptReason:
      "Forbidden by scripts/ci/check-website-render-modes.mjs (#2352, #2434), which bans render boundaries in both public-website groups; the token pages here decide their own 404s.",
  },
} as const satisfies Record<string, RouteGroupBoundary>;

export type RouteGroupKey = keyof typeof ROUTE_GROUP_BOUNDARIES;
