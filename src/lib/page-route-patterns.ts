/**
 * Route patterns for `revalidatePath(pattern, "page")` (#3635).
 *
 * A pattern names the page FILE, route groups included: Next matches it
 * against the page's own tag, which is built from the file's path under
 * `src/app` (`revalidatePath('/(main)/blog/[slug]', 'page')` in Next's
 * `revalidatePath` reference). `"/bookings/[id]"` and `"/admin/bookings/[id]"`
 * matched no page, so the writes that called them refreshed nothing.
 * `page-route-patterns.test.ts` checks each constant against the file on disk.
 */
export const BOOKING_DETAIL_ROUTE_PATTERN = "/(authenticated)/bookings/[id]";

// An ADMIN page is never named here: `revalidateAdminPage(id)`
// (`admin-page-revalidation.ts`, C3 #4800) builds its pattern from the hub
// registry, so the pattern follows the page when it moves under its hub.
