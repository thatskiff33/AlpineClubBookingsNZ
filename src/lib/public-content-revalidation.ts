import "server-only";

import { revalidatePath } from "next/cache";
import {
  invalidatePublicLayoutConfig,
  PUBLIC_LAYOUT_CACHE_TAGS,
} from "@/lib/public-layout-cache";

/**
 * Clears BOTH public-site caches after an authority write (#2352 F3).
 *
 * There are two of them and they are not interchangeable, which is what made the
 * old split a bug waiting for slice 1:
 *
 *  • `revalidatePath("/", "layout")` clears Next's FULL-ROUTE cache for every route
 *    under the root layout — the stored HTML of the admin-authored CMS pages. Since
 *    #2352 that store is what a public page view is served from, so a write that
 *    skips this call is a write nobody sees until the 300-second backstop lapses.
 *  • `invalidatePublicLayoutConfig(...)` clears the 15-second TAGGED data caches
 *    the layout and header read (theme, banners, modules, identity, capacity).
 *    Before slice 1 that was enough on its own, because the page itself was
 *    re-rendered on every visit. It no longer is: clearing the data cache under a
 *    stored page changes nothing the visitor sees.
 *
 * So every entry point now calls THIS function rather than one half of it. The two
 * calls are cheap and idempotent, and pairing them removes the class of bug where
 * a new admin write picks whichever one the file it was copied from happened to
 * use. The slice-1 review extended "every entry point" to the writers that change
 * data the CMS page BODY renders — lodge capacity and the images tree — which the
 * original F3 audit missed because it looked only at layout config.
 *
 * The route-group form (`revalidatePath("/(website)", "layout")`) was deliberately
 * NOT kept: `"/"` with `"layout"` covers the same routes from the root down, it is
 * the form already proven against the full-route store, and one form means one
 * thing to verify.
 *
 * **What proves it clears a STORED entry rather than only a data cache**, stated
 * precisely because an earlier version of this comment named a test that does not
 * exist: the unpublish case in `e2e/static-cms-pages.spec.ts`. It warms the store
 * with a 200, hides the page through the admin PATCH, and asserts a 404 within
 * seconds (a short poll, #5205) — which can only pass if `revalidatePath("/", "layout")` cleared
 * the stored copy, since a data-cache clear would leave the 200 answering for up to
 * the 300-second backstop.
 *
 * That case needs a real server and a real database, and for a while it was the ONLY
 * thing holding the line below. Measured, not supposed: deleting
 * `revalidatePath("/", "layout")` from this function left the entire Vitest tier
 * green — the 39-call-site contract test next door pins who reaches this helper, not
 * what it then does. `src/lib/__tests__/public-content-revalidation.test.ts` now
 * pins the body, so the refactor that drops the line fails in seconds instead of
 * waiting for Playwright.
 *
 * The COMPLETE-SETUP transition that F3 also asked for is covered at the unit level
 * only (`site-style-api.test.ts` asserts the PUT issues the call). There is no
 * end-to-end case for it: `e2e/pre-setup/setup-gate.spec.ts` flips the state by
 * writing `ClubTheme` directly — it has to, because `saveClubTheme()` never clears
 * `completedAt` — so the admin PUT, and therefore this function, is never invoked in
 * that flow. Recorded rather than implied.
 */
export function revalidatePublicSite(
  ...extraTags: Array<
    (typeof PUBLIC_LAYOUT_CACHE_TAGS)[keyof typeof PUBLIC_LAYOUT_CACHE_TAGS]
  >
): void {
  revalidatePath("/", "layout");
  invalidatePublicLayoutConfig(
    PUBLIC_LAYOUT_CACHE_TAGS.capacity,
    ...extraTags,
  );
}

/**
 * Invalidates every PageContent-backed public route after an authority write.
 *
 * Kept as the name the page-content, policy, lodge and season writes already use;
 * it is now one line over {@link revalidatePublicSite} so the two can never drift.
 */
export function revalidatePublicPageContent(): void {
  revalidatePublicSite();
}
