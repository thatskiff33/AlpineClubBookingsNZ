import fs from "node:fs";
import path from "node:path";

/**
 * THE ADMIN ROUTE TREE, DISCOVERED FROM DISK, IN ONE PLACE (#2975).
 *
 * Three suites need "every admin page and every `/api/admin` route" and each of
 * them had written its own walk: `admin-route-map-drift.test.ts`,
 * `admin-route-area-matrix.test.ts` and `admin-route-authorization-proof.test.ts`.
 * The walks were identical; the pathname builders were NOT — two substituted
 * `x123` for a dynamic segment and the third substituted `sample`. Nothing was
 * broken by that, but it is a latent hazard rather than a harmless difference:
 * `getAdminRouteRequirement` matches by literal prefix as well as by pattern, so
 * the moment a prefix matches one placeholder and not the other, two suites
 * enumerating "the same" tree resolve different areas and only one of them goes
 * red.
 *
 * SHARING THE ENUMERATION COSTS NO INDEPENDENCE, which is the reason it is safe
 * to share when the reviewed area assignments are deliberately NOT. The
 * enumeration is not the assertion in any of the three suites — the route-to-area
 * map is, and each suite states its own expectation about it. What is shared here
 * is only the list of paths those expectations are made about, and a list every
 * suite derives differently is a list they can silently disagree about.
 *
 * ## The placeholder
 *
 * `x123` rather than `sample`, on purpose: a dynamic segment must be substituted
 * with something that cannot collide with a real, literal path segment somewhere
 * in the tree, and `sample` is an ordinary English word that a future route could
 * plausibly use. Both satisfy the `[^/]+` patterns in
 * `SPECIAL_ROUTE_AREA_PATTERNS` identically.
 *
 * ## Pages come from EVERY route group, not just `(admin)`
 *
 * A route group is a rendering concern and this is a permissions concern; tying
 * the second to the first is how the drift guard briefly went silent for a page
 * that moved into a group of its own (a withdrawn revision of AID-7, #2378). The
 * walk therefore covers every `(group)/admin/**` page.
 */

const APP_DIR = path.join(process.cwd(), "src/app");
const API_ADMIN_DIR = path.join(APP_DIR, "api/admin");

/** Every file named `leaf` under `dir`, recursively. */
export function walkFiles(dir: string, leaf: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return walkFiles(entryPath, leaf);
    return entry.name === leaf ? [entryPath] : [];
  });
}

/** App-router directory segments for a `page.tsx` / `route.ts`, groups stripped. */
function segmentsFor(absFile: string): string[] {
  const parts = path.relative(APP_DIR, absFile).split(path.sep);
  parts.pop(); // drop the page.tsx / route.ts leaf
  return parts.filter((seg) => !(seg.startsWith("(") && seg.endsWith(")")));
}

/**
 * The pathname the route maps resolve: route groups stripped, dynamic segments
 * substituted with a concrete literal so prefix and `[^/]+` pattern matching
 * behaves exactly as it does for a real request.
 */
export function toResolverPathname(absFile: string): string {
  const segments = segmentsFor(absFile).map((seg) =>
    /^\[.*\]$/.test(seg) ? "x123" : seg,
  );
  return `/${segments.join("/")}`;
}

/**
 * The human-auditable pathname, dynamic segments left as `[id]`. Used as the key
 * of the frozen route-to-area snapshot, where a reviewer has to recognise the
 * route on sight.
 */
export function toRawPathname(absFile: string): string {
  return `/${segmentsFor(absFile).join("/")}`;
}

/** Repo-relative, forward-slashed, for failure messages. */
export function toRepoRelative(absFile: string): string {
  return path.relative(process.cwd(), absFile).split(path.sep).join("/");
}

/** Every admin `page.tsx` on disk, from whichever route group it lives in. */
export const adminPageFiles: string[] = fs
  .readdirSync(APP_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && entry.name.startsWith("("))
  .flatMap((group) => walkFiles(path.join(APP_DIR, group.name, "admin"), "page.tsx"))
  .sort();

/** Every `/api/admin/**\/route.ts` on disk. */
export const adminApiRouteFiles: string[] = walkFiles(
  API_ADMIN_DIR,
  "route.ts",
).sort();

/** Resolver pathnames for the admin pages, de-duplicated and sorted. */
export const adminPagePaths: string[] = Array.from(
  new Set(adminPageFiles.map(toResolverPathname)),
).sort();

/** Resolver pathnames for the `/api/admin` routes, de-duplicated and sorted. */
export const adminApiPaths: string[] = Array.from(
  new Set(adminApiRouteFiles.map(toResolverPathname)),
).sort();

/** Every admin path, page and API alike. */
export const allAdminPaths: ReadonlySet<string> = new Set([
  ...adminPagePaths,
  ...adminApiPaths,
]);
