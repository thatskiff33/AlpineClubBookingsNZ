/**
 * THE ADMIN HUB REGISTRY (epic #4468, C1 #4798; `INV-SSOT`).
 *
 * Every admin page, the hub it belongs to, its old URL, its hub URL and how it
 * is admitted, defined once. C2 generates the page half of the security map
 * from it, C3 the redirects and rewrites, C13 the hub menu and S2 the command
 * palette. The epic plan, in #4468's body, says what each of those does.
 *
 * C3 (#4800) reads it for three things, all still inert while `ADMIN_HUBS_LIVE`
 * is off and no page has `moved`: `next.config.ts` takes its redirects and
 * `beforeFiles` rewrites from `buildAdminUrlRules`, the sidebar highlights a
 * link with `samePage`, and `revalidateAdminPage` (`revalidate.ts`) refreshes
 * a page by the URL of its file. C2 (#4799) already generates the page half of
 * the route map from `security-map.ts`. Relative imports only (see `release.ts`).
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

/** The URL to link an admin page at, under today's `ADMIN_HUBS_LIVE`. */
export function adminHref<Id extends AdminPageId>(
  id: Id,
  ...args: AdminHrefArgs<Id>
): string {
  const page = PAGES_BY_ID.get(id);
  if (!page) throw new Error(`adminHref: unknown admin page "${id}"`);
  return resolveAdminHref(page, ADMIN_HUBS_LIVE, args[0]);
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

/** One `[name]` segment. A catch-all is refused, as in `toNextPattern`. */
function segmentPattern(segment: string): { source: string; dynamic: boolean } {
  if (!segment.startsWith("[")) {
    return { source: segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), dynamic: false };
  }
  const simple = /^\[([A-Za-z][A-Za-z0-9]*)\]$/.exec(segment);
  if (!simple) {
    throw new Error(`admin hub rules: unsupported dynamic segment "${segment}"`);
  }
  return { source: "[^/]+", dynamic: true };
}

function compileAdminPath(path: string, nested: boolean): { regex: RegExp; dynamic: number } {
  let dynamic = 0;
  const body = path
    .split("/")
    .map((segment) => {
      if (!segment) return "";
      const part = segmentPattern(segment);
      if (part.dynamic) dynamic += 1;
      return part.source;
    })
    .join("/");
  return { regex: new RegExp(`^${body}${nested ? "(?:/.*)?$" : "$"}`), dynamic };
}

interface CompiledAdminPage {
  page: AdminHubPage;
  oldExact: RegExp;
  hubExact: RegExp;
  oldTree: RegExp;
  hubTree: RegExp;
  oldDynamic: number;
  hubDynamic: number;
}

const COMPILED_PAGES: readonly CompiledAdminPage[] = ADMIN_PAGES.map((page) => {
  const oldExact = compileAdminPath(page.oldPath, false);
  const hubExact = compileAdminPath(page.hubPath, false);
  const oldTree = compileAdminPath(page.oldPath, true);
  const hubTree = compileAdminPath(page.hubPath, true);
  return {
    page,
    oldExact: oldExact.regex,
    hubExact: hubExact.regex,
    oldTree: oldTree.regex,
    hubTree: hubTree.regex,
    oldDynamic: oldExact.dynamic,
    hubDynamic: hubExact.dynamic,
  };
});

function withoutDecorations(value: string): string {
  const path = value.split("?")[0]?.split("#")[0] ?? value;
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

/**
 * Whether `pathname` is the admin page `href` points at, or a route nested
 * under it, at either the old URL or the hub URL.
 *
 * The sidebar still lists today's addresses. Once a page has moved, the
 * browser can be on the hub URL (the switch on) or the old URL (the switch
 * off, served through the rewrite), and either spelling has to light the same
 * link. A filtered link such as `/admin/bookings?unpaid=finished` is not the
 * page itself: `usePathname()` carries no query, and treating the query as
 * part of the path would let that longer href steal the highlight from
 * Bookings.
 *
 * An href the registry does not know falls back to a plain prefix match, which
 * is how the sidebar decided this before.
 */
export function samePage(pathname: string, href: string): boolean {
  if (href.includes("?") || href.includes("#")) return false;
  const path = withoutDecorations(pathname);
  const link = withoutDecorations(href);
  let best: CompiledAdminPage | undefined;
  let bestDynamic = Number.POSITIVE_INFINITY;
  let bestViaOld = false;
  let bestLength = -1;
  for (const compiled of COMPILED_PAGES) {
    const viaOld = compiled.oldExact.test(link);
    const viaHub = !viaOld && compiled.hubExact.test(link);
    if (!viaOld && !viaHub) continue;
    const dynamic = viaOld ? compiled.oldDynamic : compiled.hubDynamic;
    const length = viaOld ? compiled.page.oldPath.length : compiled.page.hubPath.length;
    const better =
      dynamic < bestDynamic ||
      (dynamic === bestDynamic && viaOld && !bestViaOld) ||
      (dynamic === bestDynamic && viaOld === bestViaOld && length > bestLength);
    if (!better) continue;
    best = compiled;
    bestDynamic = dynamic;
    bestViaOld = viaOld;
    bestLength = length;
  }
  if (!best) return path === link || path.startsWith(`${link}/`);
  return best.oldTree.test(path) || best.hubTree.test(path);
}

/**
 * The URL Next caches this page under: the path of its file.
 *
 * A `beforeFiles` rewrite serves a moved page at its old URL from the file at
 * its hub URL, and Next tags that render with the file's path
 * (`resolvedPathname` in the route module), not the address the browser shows.
 * Refreshing the old URL then leaves the page stale. Until the page is moved
 * the file is still at the old URL, so this is that URL.
 */
export function adminPageCachePathFor(page: AdminHubPage): string {
  const path = page.moved ? page.hubPath : page.oldPath;
  if (path.includes("[")) {
    throw new Error(
      `revalidateAdminPage(${page.id}) refreshes one concrete URL. ${path} has a dynamic segment, so it needs revalidatePath(pattern, "page") instead.`,
    );
  }
  return path;
}

/** {@link adminPageCachePathFor} for a registered page id. */
export function adminPageCachePath(id: AdminPageId): string {
  const page = PAGES_BY_ID.get(id);
  if (!page) throw new Error(`revalidateAdminPage: unknown admin page "${id}"`);
  return adminPageCachePathFor(page);
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
