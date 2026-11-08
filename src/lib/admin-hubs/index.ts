/**
 * THE ADMIN HUB REGISTRY (epic #4468, C1 #4798; `INV-SSOT`).
 *
 * Every admin page, the hub it belongs to, its old URL, its hub URL and how it
 * is admitted, defined once. C2 generates the page half of the security map
 * from it, C3 the redirects and rewrites, C13 the hub menu and S2 the command
 * palette. The epic plan, in #4468's body, says what each of those does.
 *
 * INERT: nothing outside this directory and its tests imports it until C2/C3,
 * and `src/lib/__tests__/admin-hubs-registry.test.ts` fails if anything does.
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
 * Next passes the request's query through both. Static paths sort before
 * dynamic ones, so `/notices/new` is never claimed by `/notices/:id`. A page
 * whose hub path is its old path (Home's dashboard) has nothing to redirect.
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
