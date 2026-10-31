/**
 * THE ROUTE-GROUP ERROR BOUNDARIES, AS DATA (#4467 item 1).
 *
 * Every route group under `src/app` has its own `error.tsx`, and each one is a
 * one-line wrapper around the shared `RouteError` component
 * (`src/components/route-error.tsx`) naming its key below. Everything a group
 * answers differently — where "back" goes and what it is called — lives here,
 * once, so six boundaries cannot drift into six different screens.
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
};

export const ROUTE_GROUP_BOUNDARIES = {
  admin: {
    group: "(admin)",
    boundaryDir: "(admin)",
    homeHref: "/admin",
    homeLabel: "Back to the admin dashboard",
  },
  authenticated: {
    group: "(authenticated)",
    boundaryDir: "(authenticated)",
    homeHref: "/dashboard",
    homeLabel: "Back to your dashboard",
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
  },
  public: {
    group: "(public)",
    boundaryDir: "(public)",
    homeHref: "/",
    homeLabel: "Go to the home page",
  },
  website: {
    group: "(website)",
    boundaryDir: "(website)",
    homeHref: "/",
    homeLabel: "Go to the home page",
  },
  websiteDynamic: {
    group: "(website-dynamic)",
    boundaryDir: "(website-dynamic)",
    homeHref: "/",
    homeLabel: "Go to the home page",
  },
} as const satisfies Record<string, RouteGroupBoundary>;

export type RouteGroupKey = keyof typeof ROUTE_GROUP_BOUNDARIES;
