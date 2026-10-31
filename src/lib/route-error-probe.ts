/**
 * THE ROUTE-ERROR PROBE: a test-only admin page that throws on demand (#4467).
 *
 * The acceptance test for the route-group error boundaries has to make an admin
 * page fail on purpose and then recover from it, and no real page can be made to
 * do that without putting test logic into it. So one page exists for the
 * purpose — `ROUTE_ERROR_PROBE_PATH` — and this module is the whole of its
 * behaviour, kept free of server imports so the Playwright spec reads the same
 * constants the page does.
 *
 * ## Why it cannot be reached in production
 *
 * The page asks the repo's existing test-harness gate, `isRealProductionRuntime()`
 * (`src/lib/xero-mock-endpoint.ts`, the backstop behind the `/api/testing/*`
 * routes), BEFORE it reads anything from the request. That gate answers "real
 * production" for any deployment that declares `APP_ENVIRONMENT_ROLE=production`
 * (the canonical answer, INV-CONFIG-003) and, as a backstop, for an undeclared
 * production build that is not the staging slot. There the page is a 404 and the
 * cookie is never read. The E2E stack declares `non-production` and runs as the
 * `staging` slot, so the probe exists there; `next dev` has it too. Everywhere it
 * exists it is still an admin page behind the admin layout's own guard, and all
 * it can do is fail with a fixed message and no data.
 *
 * ## Why a cookie, and why that makes "retry works" deterministic
 *
 * The page throws only while the browser sends `ROUTE_ERROR_PROBE_COOKIE` with
 * the value `ROUTE_ERROR_PROBE_THROW`. A cookie is per browser context, so it
 * holds no server state for a retried test to trip over, and the spec controls
 * both halves: set it, load the page (the boundary shows), clear it, press "Try
 * again" — whose `retry()` re-fetches the segment from the server — and the
 * same request now renders. A query flag could not do this: `retry()` refetches
 * the same URL, so the flag would throw again.
 */

/** Where the probe lives. Under `/admin` so it renders inside the admin layout. */
export const ROUTE_ERROR_PROBE_PATH = "/admin/testing/route-error";

/** The cookie that makes the probe throw, and the one value that does. */
export const ROUTE_ERROR_PROBE_COOKIE = "route-error-probe";
export const ROUTE_ERROR_PROBE_THROW = "throw";

/**
 * The message the probe throws. Fixed so the spec can assert it never reaches
 * the screen; in a production build Next replaces it with a digest anyway.
 */
export const ROUTE_ERROR_PROBE_MESSAGE =
  "Route error probe: deliberate failure for the error-boundary test";

/** The heading the probe renders once it stops throwing. */
export const ROUTE_ERROR_PROBE_HEADING = "Route error probe";

export type RouteErrorProbeOutcome = "absent" | "throw" | "render";

/**
 * What the probe does for one request. The cookie is read through a callback
 * so that, in a real production runtime, the request is never read at all.
 */
export async function routeErrorProbeOutcome({
  realProductionRuntime,
  readCookie,
}: {
  realProductionRuntime: boolean;
  readCookie: () => Promise<string | undefined>;
}): Promise<RouteErrorProbeOutcome> {
  if (realProductionRuntime) return "absent";
  return (await readCookie()) === ROUTE_ERROR_PROBE_THROW ? "throw" : "render";
}
