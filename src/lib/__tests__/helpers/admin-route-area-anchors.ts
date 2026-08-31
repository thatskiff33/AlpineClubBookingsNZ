import type { AdminPermissionArea } from "@/lib/admin-permissions";

/**
 * THE REVIEWED ROUTE-TO-AREA ANCHORS: which area a handful of unmistakable admin
 * routes belong to, written down by a human on purpose (#2975).
 *
 * ## Why it is written down rather than derived
 *
 * `admin-route-authorization-proof.test.ts` computes what it expects from
 * `getAdminRouteRequirement` and from each route's own `permission` literal, so
 * every sweep in it would stay green if the MAP itself were wrong: the guard
 * would faithfully enforce the new, wrong answer. This table is the second
 * opinion. Each entry says which area a route unmistakably belongs to, in a
 * human's words, and the proof drives the REAL guards against it — the area's
 * single-area holder is admitted, every other area's is refused.
 *
 * Keep it small and keep it obvious. It is not a route inventory; an entry earns
 * its place only if a reviewer would recognise the pairing on sight.
 *
 * ## One home, two readers
 *
 * `admin-route-area-matrix.test.ts` pins the COMPLETE `/api/admin` route-to-area
 * assignment as a frozen snapshot, resolved through the map and never through a
 * guard. Its rows for these API routes and this table are the same reviewed fact
 * stated twice, and two statements of one fact can disagree — so the table lives
 * here, the proof imports it to drive the guards, and the matrix suite imports it
 * to assert its snapshot agrees. Neither can drift from the other in silence.
 *
 * The PAGE entries are genuinely new coverage: the frozen snapshot covers
 * `/api/admin` only, and nothing else states which area an admin SCREEN belongs
 * to.
 */
export const ADMIN_ROUTE_AREA_ANCHORS: Record<AdminPermissionArea, string[]> = {
  overview: ["/admin/dashboard", "/api/admin/pending-counts"],
  bookings: [
    "/admin/bookings",
    "/admin/waitlist",
    "/admin/booking-requests",
    "/api/admin/bookings",
    "/api/admin/waitlist",
  ],
  membership: [
    "/admin/members",
    "/admin/member-applications",
    "/admin/family-groups",
    "/api/admin/members",
    "/api/admin/family-groups",
  ],
  finance: [
    "/admin/payments",
    "/admin/reports",
    "/admin/subscriptions",
    "/api/admin/payments",
    "/api/admin/subscriptions",
  ],
  lodge: [
    "/admin/hut-leaders",
    "/admin/roster",
    "/admin/work-parties",
    "/api/admin/hut-leaders",
    "/api/admin/roster/status",
    "/api/admin/work-parties",
  ],
  content: [
    "/admin/page-content",
    "/admin/site-banners",
    "/admin/site-content",
    "/api/admin/page-content",
    "/api/admin/site-banners",
  ],
  support: [
    "/admin/access-roles",
    "/admin/modules",
    "/admin/health",
    "/api/admin/access-roles",
    "/api/admin/modules",
  ],
};

/** The anchors flattened to `{ area, pathname }` rows, in table order. */
export const ADMIN_ROUTE_AREA_ANCHOR_ENTRIES: ReadonlyArray<{
  area: AdminPermissionArea;
  pathname: string;
}> = (
  Object.entries(ADMIN_ROUTE_AREA_ANCHORS) as Array<
    [AdminPermissionArea, string[]]
  >
).flatMap(([area, paths]) => paths.map((pathname) => ({ area, pathname })));
