/**
 * THE ADMIN HUB REGISTRY (epic #4468, C1 #4798; `INV-SSOT`).
 *
 * Every admin page, the hub it belongs to, its old URL, its hub URL and how it
 * is admitted, defined once. C2 generates the page half of the security map
 * from it, C3 the redirects and rewrites, C13 the hub menu and S2 the command
 * palette. The epic plan, in #4468's body, says what each of those does.
 *
 * Inert while no page has moved. In production it is read by the security map
 * — C2 (#4799) generates the page half of the route map, the admission paths and
 * the admin page module gates from it (`security-map.ts`), changing no answer —
 * and, since C3 (#4800), by `next.config.ts` (the redirects and rewrites), the
 * sidebar's active link (`activeAdminHref`) and `revalidateAdminPage`; each of
 * those answers exactly as before until a page's `moved` is set.
 * `src/lib/__tests__/admin-hubs-registry.test.ts` names every importer.
 * Relative imports only (see `release.ts`).
 */
import { ADMIN_HUBS_LIVE } from "./release";
import {
  normaliseHubPage,
  type AdminHubInput,
  type AdminHubPage,
} from "./define";
import { DASHBOARD_HUB } from "./hubs/dashboard";
import { BOOKINGS_HUB } from "./hubs/bookings";
import { RULES_HUB } from "./hubs/rules";
import { FINANCE_HUB } from "./hubs/finance";
import { MEMBERS_HUB } from "./hubs/members";
import { LODGE_OPS_HUB } from "./hubs/lodge-ops";
import { WEBSITE_HUB } from "./hubs/website";
import { MESSAGES_HUB } from "./hubs/messages";
import { SYSTEM_HUB } from "./hubs/system";
import { SETTINGS_HUB } from "./hubs/settings";

/** The hubs, in menu order: the order the owner approved on #4468. */
export const ADMIN_HUBS = [
  DASHBOARD_HUB,
  BOOKINGS_HUB,
  RULES_HUB,
  FINANCE_HUB,
  MEMBERS_HUB,
  LODGE_OPS_HUB,
  WEBSITE_HUB,
  MESSAGES_HUB,
  SYSTEM_HUB,
  SETTINGS_HUB,
] as const satisfies readonly AdminHubInput[];

type AdminHubPageLiteral = (typeof ADMIN_HUBS)[number]["pages"][number];

/** Every registered page id, as a literal union: an unknown id does not compile. */
export type AdminPageId = AdminHubPageLiteral["id"];

/** Every page, normalised, in hub order. */
export const ADMIN_PAGES: readonly AdminHubPage[] = ADMIN_HUBS.flatMap((hub) =>
  hub.pages.map((page) => normaliseHubPage(hub, page)),
);

const PAGES_BY_ID: ReadonlyMap<string, AdminHubPage> = new Map(
  ADMIN_PAGES.map((page) => [page.id, page]),
);

type ParamNames<Path extends string> =
  Path extends `${string}[${infer Name}]${infer Rest}`
    ? Name | ParamNames<Rest>
    : never;

type ParamsFor<Id extends AdminPageId> = ParamNames<
  Extract<AdminHubPageLiteral, { id: Id }>["oldPath"]
>;

/** No argument for a static page; `{ id: "…" }` (each segment) for a dynamic one. */
type AdminHrefArgs<Id extends AdminPageId> = [ParamsFor<Id>] extends [never]
  ? []
  : [params: Record<ParamsFor<Id>, string>];

const DYNAMIC_SEGMENT = /\[([^\]/]+)\]/g;

/**
 * The URL a page is linked at: its OLD path while the switch is off or the page
 * has not moved, its hub path once both are true. Dynamic segments are filled
 * from `params` and URI-encoded.
 */
export function resolveAdminHref(
  page: AdminHubPage,
  live: boolean,
  params: Readonly<Record<string, string>> = {},
): string {
  const path = live && page.moved ? page.hubPath : page.oldPath;
  return path.replace(DYNAMIC_SEGMENT, (_segment, name: string) => {
    const value = params[name];
    if (value === undefined) {
      throw new Error(`adminHref(${page.id}): missing the "${name}" parameter`);
    }
    return encodeURIComponent(value);
  });
}

/** The registered page for an id; an id the registry does not know throws. */
export function getAdminPage(id: AdminPageId): AdminHubPage {
  const page = PAGES_BY_ID.get(id);
  if (!page) throw new Error(`admin hub registry: unknown admin page "${id}"`);
  return page;
}

/** The URL to link an admin page at, under today's `ADMIN_HUBS_LIVE`. */
export function adminHref<Id extends AdminPageId>(
  id: Id,
  ...args: AdminHrefArgs<Id>
): string {
  return resolveAdminHref(getAdminPage(id), ADMIN_HUBS_LIVE, args[0]);
}

/**
 * The path of the page's FILE under `src/app/(admin)`: its hub path once its
 * directory has moved, its old path until then. The switch does not enter into
 * it. While off, a moved page's old URL is served from this file through a
 * `beforeFiles` rewrite; while on, its hub URL is served from it directly.
 *
 * It is what `revalidatePath` must be given (C3 #4800). Next tags a rendered
 * page with the path of the route that rendered it, never the URL the browser
 * asked for: `getImplicitTags(page, resolvedPathname)` in
 * `next/dist/server/app-render/app-render.js`, where `resolvedPathname` is the
 * matched route's own page path (`route-module.js`), and Next's `revalidatePath`
 * reference: "When using rewrites, you must pass the destination path".
 */
export function adminPageRoutePath(page: AdminHubPage): string {
  return page.moved ? page.hubPath : page.oldPath;
}

/** One whole `[name]` path segment. */
const DYNAMIC_PATH_SEGMENT = /^\[([^\]/]+)\]$/;

/**
 * A moved page's hub path, or a path beneath one, written back as the old path
 * it relocates; anything else unchanged. Only MOVED pages are read: an unmoved
 * page's hub path is served by nothing, so no browser can be at it.
 */
function toOldAdminPathname(
  pathname: string,
  pages: readonly AdminHubPage[],
): string {
  const segments = pathname.split("/");
  let best: { page: AdminHubPage; params: Map<string, string>; length: number } | null =
    null;
  for (const page of pages) {
    if (!page.moved || page.hubPath === page.oldPath) continue;
    const pattern = page.hubPath.split("/");
    if (pattern.length > segments.length) continue;
    if (best && pattern.length <= best.length) continue;
    const params = new Map<string, string>();
    const matches = pattern.every((segment, index) => {
      const value = segments[index]!;
      const dynamic = DYNAMIC_PATH_SEGMENT.exec(segment);
      if (!dynamic) return segment === value;
      params.set(dynamic[1]!, value);
      return value !== "";
    });
    if (matches) best = { page, params, length: pattern.length };
  }
  if (!best) return pathname;
  const { page, params, length } = best;
  const oldHead = page.oldPath.split("/").map((segment) => {
    const dynamic = DYNAMIC_PATH_SEGMENT.exec(segment);
    return dynamic ? params.get(dynamic[1]!)! : segment;
  });
  return [...oldHead, ...segments.slice(length)].join("/");
}

/** `href` as the path the sidebar compares, its query or fragment kept on the end. */
function toOldAdminHref(href: string, pages: readonly AdminHubPage[]): string {
  const cut = href.search(/[?#]/);
  return cut === -1
    ? toOldAdminPathname(href, pages)
    : toOldAdminPathname(href.slice(0, cut), pages) + href.slice(cut);
}

/**
 * The sidebar's active link (C3 #4800): of `hrefs`, the deepest one the current
 * `pathname` is at or beneath, or `""` for none. It is the registry's
 * `samePage()`: a moved page's old path and hub path are the SAME page here, so
 * the answer does not depend on which of the two either side is written in.
 *
 * That matters because, while the switch is off, a moved page is served at its
 * old URL by a rewrite, and the two renders disagree about the path:
 * `usePathname()` on the server reads the request Next rendered, the rewrite's
 * destination (Next's `usePathname` reference, "Avoid hydration mismatch with
 * rewrites"), while in the browser the router starts from `location`, the old
 * URL (`create-initial-router-state.js`). Comparing both in old-path form gives
 * one answer, so neither the highlight nor hydration can split.
 *
 * An href with a query (the sidebar's dated queue links) is never active, as
 * before: a pathname carries no query to match it.
 */
export function activeAdminHref(
  pathname: string,
  hrefs: readonly string[],
  pages: readonly AdminHubPage[] = ADMIN_PAGES,
): string {
  const current = toOldAdminPathname(pathname, pages);
  let active = "";
  let activeLength = -1;
  for (const href of hrefs) {
    const target = toOldAdminHref(href, pages);
    const within = current === target || current.startsWith(`${target}/`);
    if (within && target.length > activeLength) {
      active = href;
      activeLength = target.length;
    }
  }
  return active;
}

/** A redirect in the shape `next.config.ts` hands to Next. Always a 307. */
export interface AdminUrlRedirect {
  readonly source: string;
  readonly destination: string;
  readonly permanent: false;
}

export interface AdminUrlRewrite {
  readonly source: string;
  readonly destination: string;
}

export interface AdminUrlRules {
  readonly redirects: AdminUrlRedirect[];
  /** `beforeFiles` only: the old URL must be served before the filesystem is tried. */
  readonly rewrites: { readonly beforeFiles: AdminUrlRewrite[] };
}

/**
 * `[name]` -> `:name`, Next's path-to-regexp spelling. Catch-all segments are
 * refused rather than guessed at: no admin page has one today.
 */
function toNextPattern(path: string): string {
  return path
    .split("/")
    .map((segment) => {
      if (!segment.startsWith("[")) return segment;
      const simple = /^\[([A-Za-z][A-Za-z0-9]*)\]$/.exec(segment);
      if (!simple) {
        throw new Error(`admin hub rules: unsupported dynamic segment "${segment}" in ${path}`);
      }
      return `:${simple[1]}`;
    })
    .join("/");
}

function dynamicSegmentCount(path: string): number {
  return path.split("/").filter((segment) => segment.startsWith("[")).length;
}

/**
 * The redirects and rewrites for the MOVED pages; nothing for the rest, so
 * today's registry yields none.
 *
 * - Off: the hub URL redirects (307) to the old URL, and a `beforeFiles`
 *   rewrite serves the old URL from the moved file, so the proxy, the module
 *   gate and the layout guard all see the old path.
 * - On: the old URL redirects (307) to the hub URL; no rewrites.
 *
 * Next passes the request's query through both. A page whose hub path is its
 * old path (Home's dashboard) has nothing to redirect.
 *
 * The order is fixed, static paths before dynamic ones, as defence in depth
 * only: a hub path keeps its page's relative path, so even if `/notices/:id`
 * claimed `/notices/new` it would send it to the same file. A mutation probe
 * that removed the sort left the suite green, which is why this says so.
 */
export function buildAdminUrlRules(
  live: boolean,
  pages: readonly AdminHubPage[] = ADMIN_PAGES,
): AdminUrlRules {
  const moved = pages
    .filter((page) => page.moved && page.hubPath !== page.oldPath)
    .sort(
      (a, b) =>
        dynamicSegmentCount(a.oldPath) - dynamicSegmentCount(b.oldPath) ||
        a.oldPath.localeCompare(b.oldPath),
    );
  const pairs = moved.map((page) => ({
    oldUrl: toNextPattern(page.oldPath),
    hubUrl: toNextPattern(page.hubPath),
  }));

  if (live) {
    return {
      redirects: pairs.map(({ oldUrl, hubUrl }) => ({
        source: oldUrl,
        destination: hubUrl,
        permanent: false,
      })),
      rewrites: { beforeFiles: [] },
    };
  }
  return {
    redirects: pairs.map(({ oldUrl, hubUrl }) => ({
      source: hubUrl,
      destination: oldUrl,
      permanent: false,
    })),
    rewrites: {
      beforeFiles: pairs.map(({ oldUrl, hubUrl }) => ({
        source: oldUrl,
        destination: hubUrl,
      })),
    },
  };
}
