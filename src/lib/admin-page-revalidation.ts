import { revalidatePath } from "next/cache";
import {
  adminPageRoutePath,
  getAdminPage,
  type AdminPageId,
} from "@/lib/admin-hubs";
import type { AdminHubPage } from "@/lib/admin-hubs/define";

/**
 * REVALIDATING AN ADMIN PAGE (epic #4468, C3 #4800; `INV-SSOT`).
 *
 * The one way production code refreshes an admin page after a write: by its
 * registry id, never by a literal `/admin…` path, so a page that moves under its
 * hub (C4–C12) is refreshed at its new place with no call site edited.
 * `admin-page-revalidation.test.ts` holds the census.
 *
 * WHICH PATH, AND WHY ONLY ONE. Next tags a rendered page with the path of the
 * ROUTE FILE that rendered it, not with the URL the browser asked for. Its
 * `revalidatePath` reference says so for rewrites ("you must pass the
 * destination path … the source path won't match the cache entry"), and the
 * source agrees: `getImplicitTags(workStore.page, routeMatch.resolvedPathname)`
 * in `next/dist/server/app-render/app-render.js` tags the page's file path and
 * `resolvedPathname`, which `route-module.js` builds from the matched route's
 * own page (`normalizedSrcPage`), with the params filled in. While the switch is
 * off, a moved page's old URL is served from its hub-path file by a
 * `beforeFiles` rewrite, so the tag is the HUB path; once on, the hub URL is
 * served directly, so it is still the hub path. Before the move it is the old
 * path in both states. So the right target is always the file's path,
 * `adminPageRoutePath`, whatever `ADMIN_HUBS_LIVE` says; the other path names no
 * cache entry, and revalidating it too would only hide which one does the work.
 */

/** Every admin page file sits under this route group (`src/app/(admin)/admin/…`). */
const ADMIN_ROUTE_GROUP = "/(admin)";

/**
 * The `revalidatePath` arguments for a page.
 *
 * - A static page: its literal path, which matches the pathname tag.
 * - A dynamic page: its file pattern, route group included, with `"page"`, which
 *   refreshes every record's page; Next refuses a dynamic path without a type,
 *   and matches a pattern against the file's own tag, so the group must be in it
 *   (#3635, `page-route-patterns.ts`).
 */
export function adminPageRevalidationTarget(
  page: AdminHubPage,
): readonly [path: string, type?: "page"] {
  const path = adminPageRoutePath(page);
  return path.includes("[") ? [`${ADMIN_ROUTE_GROUP}${path}`, "page"] : [path];
}

/** Refreshes one admin page's cached render, wherever its file lives today. */
export function revalidateAdminPage(id: AdminPageId): void {
  const [path, type] = adminPageRevalidationTarget(getAdminPage(id));
  if (type) {
    revalidatePath(path, type);
  } else {
    revalidatePath(path);
  }
}
