/**
 * THE ADMIN HUB REGISTRY (epic #4468, C1 #4798; `INV-SSOT`).
 *
 * Every admin page, the hub it belongs to, its old URL, its hub URL and how it
 * is admitted, defined once; and every page retired by a merge, with where its
 * old URL now goes (`retired.ts`, S1 #4796). C2 generates the page half of the
 * security map from it, C3 the redirects and rewrites, C13 the hub menu and S2
 * the command palette. The epic plan, in #4468's body, says what each of those does.
 *
 * Officers still open every page at its old URL while `ADMIN_HUBS_LIVE` is off.
 * C4 (#4801) has moved the Website pages: their files live under the hub, the
 * old URL is served from that file by a `beforeFiles` rewrite, and the hub URL
 * redirects back. Links go through `adminHref`, which keeps returning the old
 * URL until the switch is on. In production the registry is read by the
 * security map — C2 (#4799) generates the page half of the route map, the
 * admission paths and the admin page module gates from it (`security-map.ts`),
 * the same answer at the old path and the hub path — and, since C3 (#4800), by
 * `next.config.ts` (the redirects and rewrites), the sidebar's active link
 * (`activeAdminHref`) and `revalidateAdminPage`.
 * `src/lib/__tests__/admin-hubs-registry.test.ts` names every importer.
 * Relative imports only (see `release.ts`).
 */
import { ADMIN_HUBS_LIVE } from "./release";
import {
  normaliseHubPage,
  type AdminHubInput,
  type AdminHubPage,
  type AdminRetiredPage,
} from "./define";
import { ADMIN_RETIRED_PAGES } from "./retired";
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

export { ADMIN_RETIRED_PAGES };

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

type DeclaredList<Id extends AdminPageId, Field extends "tabs" | "anchors"> =
  Extract<AdminHubPageLiteral, { id: Id }> extends { readonly [K in Field]: readonly (infer Value)[] }
    ? Value & string
    : never;

/** A `?tab=` value page `Id` declares; `never` for a page without tabs. */
export type AdminPageTab<Id extends AdminPageId> = DeclaredList<Id, "tabs">;

/** A section id page `Id` declares; `never` for a page without anchors. */
export type AdminPageAnchor<Id extends AdminPageId> = DeclaredList<Id, "anchors">;

/** Every page that declares tabs. */
export type AdminTabbedPageId = {
  [Id in AdminPageId]: [AdminPageTab<Id>] extends [never] ? never : Id;
}[AdminPageId];

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
 * `href` with `tab` as its `?tab=` and `anchor` as its fragment; refuses a tab
 * or anchor the page does not declare. The first tab is the page's default, so
 * it is linked without a query.
 */
function withTabAndAnchor(
  page: AdminHubPage,
  href: string,
  tab: string | undefined,
  anchor: string | undefined,
): string {
  if (tab !== undefined && !page.tabs.includes(tab)) {
    throw new Error(`admin hub registry: ${page.id} has no "${tab}" tab`);
  }
  if (anchor !== undefined && !page.anchors.includes(anchor)) {
    throw new Error(`admin hub registry: ${page.id} has no "${anchor}" anchor`);
  }
  const query = tab !== undefined && tab !== page.tabs[0] ? `?tab=${encodeURIComponent(tab)}` : "";
  return `${href}${query}${anchor !== undefined ? `#${anchor}` : ""}`;
}

/** The URL to link one tab of a page at; the default tab has no query. */
export function adminTabHref<Id extends AdminTabbedPageId>(id: Id, tab: AdminPageTab<Id>): string {
  const page = getAdminPage(id);
  return withTabAndAnchor(page, resolveAdminHref(page, ADMIN_HUBS_LIVE), tab, undefined);
}

/** The URL to link one section of a page at. */
export function adminAnchorHref<Id extends AdminPageId>(
  id: Id,
  anchor: AdminPageAnchor<Id>,
): string {
  const page = getAdminPage(id);
  return withTabAndAnchor(page, resolveAdminHref(page, ADMIN_HUBS_LIVE), undefined, anchor);
}

/**
 * The tab a page is showing for its `?tab=` value: the value when the page
 * declares it, else the page's first (default) tab.
 */
export function parseAdminPageTab<Id extends AdminTabbedPageId>(
  id: Id,
  value: string | null | undefined,
): AdminPageTab<Id> {
  const { tabs } = getAdminPage(id);
  return (value != null && tabs.includes(value) ? value : tabs[0]) as AdminPageTab<Id>;
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

type RelocatedPath = "oldPath" | "hubPath";

/**
 * `pathname` relocated from one of a MOVED page's two paths to the other: the
 * longest moved page whose `from` path is at or above it decides, its dynamic
 * segments carried across by name, whatever lies beneath kept. Anything no
 * moved page covers comes back unchanged. Only moved pages are read: an unmoved
 * page's hub path is served by nothing, so no browser can be at it.
 */
function relocateAdminPathname(
  pathname: string,
  pages: readonly AdminHubPage[],
  from: RelocatedPath,
  to: RelocatedPath,
): string {
  const segments = pathname.split("/");
  let best: { page: AdminHubPage; params: Map<string, string>; length: number } | null =
    null;
  for (const page of pages) {
    if (!page.moved || page.hubPath === page.oldPath) continue;
    const pattern = page[from].split("/");
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
  const head = page[to].split("/").map((segment) => {
    const dynamic = DYNAMIC_PATH_SEGMENT.exec(segment);
    return dynamic ? params.get(dynamic[1]!)! : segment;
  });
  return [...head, ...segments.slice(length)].join("/");
}

/**
 * An admin pathname in its OLD-path form: a moved page's hub path, or a path
 * beneath one, becomes the old path it relocates; anything else is unchanged.
 * It is the registry's `samePage()` key (C3 #4800).
 *
 * Use it wherever a `usePathname()` value is used as a KEY (help content, the
 * sidebar's highlight). While the switch is off a moved page is served at its
 * old URL by a rewrite, and the two renders disagree about the path: on the
 * server `usePathname()` reads the request Next rendered, the rewrite's
 * destination (Next's `usePathname` reference, "Avoid hydration mismatch with
 * rewrites"), while in the browser the router starts from `location`, the old
 * URL (`create-initial-router-state.js`). Both map to one answer here. Once the
 * switch is on the browser is at the hub path, and old-path keys still match.
 */
export function canonicalAdminPathname(
  pathname: string,
  pages: readonly AdminHubPage[] = ADMIN_PAGES,
): string {
  return relocateAdminPathname(pathname, pages, "hubPath", "oldPath");
}

/**
 * An admin pathname in the form the browser is served it at under the switch:
 * the old-path form while off, a moved page's hub path once on, as `adminHref`
 * links it. Use it wherever a `usePathname()` value becomes a URL (a return-to
 * link, a `router.replace` target): it is the same on the server and in the
 * browser, and it never sends the officer through a redirect.
 */
export function servedAdminPathname(
  pathname: string,
  live: boolean = ADMIN_HUBS_LIVE,
  pages: readonly AdminHubPage[] = ADMIN_PAGES,
): string {
  const canonical = canonicalAdminPathname(pathname, pages);
  return live ? relocateAdminPathname(canonical, pages, "oldPath", "hubPath") : canonical;
}

/** `href` as the path the sidebar compares, its query or fragment kept on the end. */
function toOldAdminHref(href: string, pages: readonly AdminHubPage[]): string {
  const cut = href.search(/[?#]/);
  return cut === -1
    ? canonicalAdminPathname(href, pages)
    : canonicalAdminPathname(href.slice(0, cut), pages) + href.slice(cut);
}

/**
 * The sidebar's active link (C3 #4800): of `hrefs`, the deepest one the current
 * `pathname` is at or beneath, or `""` for none. Both sides are compared in
 * `canonicalAdminPathname` form, so a moved page's old path and hub path are the
 * SAME page here, whichever either side is written in, and the server and
 * browser renders cannot split.
 *
 * An href with a query (the sidebar's dated queue links) is never active, as
 * before: a pathname carries no query to match it.
 */
export function activeAdminHref(
  pathname: string,
  hrefs: readonly string[],
  pages: readonly AdminHubPage[] = ADMIN_PAGES,
): string {
  const current = canonicalAdminPathname(pathname, pages);
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

/**
 * A redirect in the shape `next.config.ts` hands to Next. A 307 for now, a
 * retired page's included: a 308 is cached by the browser with no expiry, so
 * a rollback would leave old links bouncing to tabs the old code lacks. The
 * retired redirects become 308s one release after S1 (#4796) ships.
 */
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
 * Refuses a registry in which a dynamic page's rule would capture a static
 * sibling that is not moving with it (#4800 review). Rules match whole paths,
 * so `/admin/notices/:id` matches `/admin/notices/new`: if only `notice-detail`
 * had moved, its rules would send `/admin/notices/new` to
 * `/admin/<hub>/notices/new`, where no file is, in both switch states. A
 * dynamic page and every static page its pattern matches must share `moved`.
 */
function assertNoCapturedSibling(pages: readonly AdminHubPage[]): void {
  for (const dynamicPage of pages) {
    const pattern = dynamicPage.oldPath.split("/");
    if (!pattern.some((segment) => DYNAMIC_PATH_SEGMENT.test(segment))) continue;
    for (const sibling of pages) {
      if (sibling === dynamicPage || sibling.moved === dynamicPage.moved) continue;
      const segments = sibling.oldPath.split("/");
      if (segments.length !== pattern.length) continue;
      const captured = pattern.every((segment, index) =>
        DYNAMIC_PATH_SEGMENT.test(segment)
          ? !DYNAMIC_PATH_SEGMENT.test(segments[index]!)
          : segment === segments[index],
      );
      if (captured) {
        throw new Error(
          `admin hub rules: ${dynamicPage.id} (${dynamicPage.oldPath}) would capture ` +
            `${sibling.id} (${sibling.oldPath}); move them together`,
        );
      }
    }
  }
}

/**
 * A retired page's redirect (a 307 for its first release, then permanent;
 * see `AdminUrlRedirect`) to the URL its content is served at
 * under the switch: the page it was merged into, at its tab and section. Next
 * merges the request's query into the destination's, the destination's `tab`
 * winning. Refuses a retired path that is dynamic or that any registered page
 * uses or sits beneath, and a destination the registry does not have.
 */
function retiredRedirect(
  retired: AdminRetiredPage,
  live: boolean,
  pages: readonly AdminHubPage[],
): AdminUrlRedirect {
  if (retired.oldPath.includes("[")) {
    throw new Error(`admin hub rules: retired ${retired.oldPath} is dynamic`);
  }
  const clash = pages.find((page) =>
    [page.oldPath, page.hubPath].some(
      (path) => path === retired.oldPath || path.startsWith(`${retired.oldPath}/`),
    ),
  );
  if (clash) {
    throw new Error(`admin hub rules: retired ${retired.oldPath} is still ${clash.id}'s path`);
  }
  const target = pages.find((page) => page.id === retired.mergedInto);
  if (!target) {
    throw new Error(`admin hub rules: retired ${retired.oldPath} was merged into unknown ${retired.mergedInto}`);
  }
  return {
    source: retired.oldPath,
    destination: withTabAndAnchor(target, resolveAdminHref(target, live), retired.tab, retired.anchor),
    permanent: false,
  };
}

/**
 * The redirects and rewrites for the MOVED pages, after the redirects of the
 * RETIRED ones (S1 #4796). An unmoved page has none. A
 * registry in which a moved dynamic page would capture an unmoved static
 * sibling, or the reverse, is refused.
 *
 * The retired redirects come first, in both states, so no moved page's
 * pattern can claim a retired URL; each goes straight to where its
 * destination is served, so it is never a chain.
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
  retiredPages: readonly AdminRetiredPage[] = ADMIN_RETIRED_PAGES,
): AdminUrlRules {
  assertNoCapturedSibling(pages);
  const retired = retiredPages.map((page) => retiredRedirect(page, live, pages));
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
      redirects: [
        ...retired,
        ...pairs.map(({ oldUrl, hubUrl }) => ({
          source: oldUrl,
          destination: hubUrl,
          permanent: false as const,
        })),
      ],
      rewrites: { beforeFiles: [] },
    };
  }
  return {
    redirects: [
      ...retired,
      ...pairs.map(({ oldUrl, hubUrl }) => ({
        source: hubUrl,
        destination: oldUrl,
        permanent: false as const,
      })),
    ],
    rewrites: {
      beforeFiles: pairs.map(({ oldUrl, hubUrl }) => ({
        source: oldUrl,
        destination: hubUrl,
      })),
    },
  };
}
