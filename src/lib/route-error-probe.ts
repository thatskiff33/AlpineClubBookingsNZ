/**
 * THE ROUTE-ERROR PROBE: a test-only admin page that throws on demand (#4467).
 *
 * The acceptance test for the route-group error boundaries has to make an admin
 * page fail on purpose and then recover from it, and no real page can be made to
 * do that without putting test logic into it. So one page exists for the
 * purpose — `ROUTE_ERROR_PROBE_PATH`. This module holds its constants, kept free
 * of server imports so the Playwright spec reads the same values the page does.
 *
 * ## Why it cannot be reached in production, or by anyone but an admin
 *
 * The page does three things in a fixed order, and the order is the guarantee:
 *
 *   1. It asks the repo's existing test-harness gate, `isRealProductionRuntime()`
 *      (`src/lib/xero-mock-endpoint.ts`, the backstop behind the `/api/testing/*`
 *      routes). That answers "real production" for any deployment declaring
 *      `APP_ENVIRONMENT_ROLE=production` (the canonical answer, INV-CONFIG-003)
 *      and, as a backstop, for an undeclared production build that is not the
 *      staging slot. There the page calls `notFound()` before any `await`, and
 *      with no `loading.tsx` or Suspense between the root layout and this page
 *      that happens before the response starts streaming, so it is a real 404
 *      status (the admin group's not-found screen) — not a streamed 200.
 *   2. It runs the admin guard itself, `guardAdminLayout()`, and redirects if
 *      refused. The admin layout runs the same guard, but "a layout also does not
 *      control whether the rest of the route renders. Route segments ... are
 *      rendered by the router, so a layout that hides or swaps them does not stop
 *      them from running" (`node_modules/next/dist/docs/01-app/02-guides/
 *      authentication.md`, "Layouts and auth checks"). A page that relied on the
 *      layout would still reach step 3 for a signed-out request. The
 *      ai-diagnostics page carries the same call for the same reason.
 *   3. Only then does it read the cookie.
 *
 * The E2E stack declares `non-production` and runs as the `staging` slot, so the
 * probe exists there; `next dev` has it too. All it can do there is fail with a
 * fixed message and no data, for an admitted administrator.
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
