/**
 * THE PAGE HALF OF THE ADMIN SECURITY MAP, GENERATED FROM THE HUB REGISTRY
 * (epic #4468, C2 #4799; `INV-SSOT`).
 *
 * Until C2 the page half of three security tables was written by hand beside
 * the registry that now records the same facts: the route map's page prefixes
 * (`ROUTE_AREA_PREFIXES` in `admin-permissions.ts`), the paths admitted by a
 * special rule (any admin, the fee console's bookings-OR-finance, Rooms & Beds'
 * lodge-OR-bookings), and the admin page prefixes of `FEATURE_ROUTE_RULES`. They
 * are generated here instead, for every page's OLD path and its HUB path, so a
 * page answers the same at both before any page has moved, and a move (C4–C12)
 * changes no admission. The `/api/admin` half stays hand-written.
 *
 * HOW THE OLD HALF IS DERIVED. A rule can only name a static prefix, so each
 * page counts at its static head (`/admin/members/[id]` at `/admin/members`).
 * Walking the directories shortest first, a directory's answer is the answer of
 * the page AT it, else the one answer every page BENEATH it shares; a prefix is
 * emitted wherever that answer differs from its parent's. That reproduces the
 * hand-written map exactly: `/admin/setup` is a `support` directory, and the two
 * pages under it that are not (`setup/finance`, `setup/booking-rules`) get their
 * own, longer prefix; `/admin/stripe`, with no page of its own, takes the area
 * of the one page beneath it. Every top-level directory is emitted, `overview`
 * ones too, so no registered page relies on the `/admin` catch-all.
 *
 * HOW THE HUB HALF IS DERIVED. Every old-half rule is copied into each hub that
 * has a page beneath it, by the same relocation that gives the page its hub path
 * (`/admin/setup/finance` -> `/admin/settings/setup/finance`). Relocation maps
 * paths one to one, so the longest rule covering a hub path is the copy of the
 * longest rule covering its old path: a hub path, its children and the
 * directories above it answer exactly as their old counterparts.
 *
 * ORDER. The route map takes the FIRST matching prefix, not the longest, so the
 * generated entries are sorted deepest first: no prefix can precede a longer one
 * nested beneath it. `admin-hub-route-parity.test.ts` holds the ordering census.
 *
 * MODULE GATES FAIL CLOSED. A page that needs a module gates its whole
 * directory, as a hand-written prefix always did, so a page registered beneath
 * it without the flag is still gated (and the registry suite reports the
 * disagreement). The only way out from under a gate is an exact exemption that
 * `FEATURE_ROUTE_RULES` declares by hand; `withAdminHubTwins` adds its hub twin.
 *
 * A registry this cannot represent (two pages at one static head with different
 * areas, or a special admission on a dynamic path) throws when the module loads,
 * which every suite that reads the map turns into a red test.
 *
 * Relative imports only (see `release.ts`).
 */
import type { AdminPermissionArea } from "../admin-permissions";
import type { FeatureFlagKey } from "../../config/schema";
import { ADMIN_HUBS, ADMIN_PAGES } from "./index";
import { hubRoot, type AdminHubPage, type AdminPageAdmission } from "./define";

const ADMIN_ROOT = "/admin";

/** `candidate` is `root` or sits beneath it, `/`-anchored as every resolver matches. */
function nestsUnder(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}/`);
}

function depth(path: string): number {
  return path.split("/").length;
}

/** The page's path up to its first dynamic segment: the deepest prefix a rule can name. */
function staticHead(path: string): string {
  const segments = path.split("/");
  const firstDynamic = segments.findIndex((segment) => segment.startsWith("["));
  return firstDynamic === -1 ? path : segments.slice(0, firstDynamic).join("/");
}

/** Every directory from `/admin/<first segment>` down to `path`, shortest first. */
function directoriesOf(path: string): string[] {
  const segments = path.split("/").slice(2);
  return segments.map((_, index) => `${ADMIN_ROOT}/${segments.slice(0, index + 1).join("/")}`);
}

function parentOf(path: string): string {
  return path.slice(0, path.lastIndexOf("/"));
}

function headOf(page: AdminHubPage): string {
  const head = staticHead(page.oldPath);
  if (!nestsUnder(head, ADMIN_ROOT) || head === ADMIN_ROOT) {
    throw new Error(`admin security map: ${page.id}'s path ${page.oldPath} has no static directory under ${ADMIN_ROOT}`);
  }
  return head;
}

/** Directories, shortest first, so a parent is always decided before its child. */
function shortestFirst(paths: Iterable<string>): string[] {
  return [...paths].sort((a, b) => depth(a) - depth(b) || a.localeCompare(b));
}

const HUB_ROOTS: ReadonlyMap<string, string> = new Map(
  ADMIN_HUBS.map((hub) => [hub.key, hubRoot(hub.prefix)]),
);

/**
 * Where an old-path prefix lands in the page's hub: the page's hub path with
 * the part of its old path below the prefix removed. Throws when the hub path
 * does not end the same way, or the result would leave the hub's root.
 */
function relocate(page: AdminHubPage, oldPrefix: string): string {
  const tail = page.oldPath.slice(oldPrefix.length);
  const relocated = page.hubPath.slice(0, page.hubPath.length - tail.length);
  const root = HUB_ROOTS.get(page.hub);
  if (!page.hubPath.endsWith(tail) || !root || !nestsUnder(relocated, root)) {
    throw new Error(`admin security map: ${oldPrefix} has no place in ${page.id}'s hub path ${page.hubPath}`);
  }
  return relocated;
}

interface HubRule<T> {
  readonly hub: string;
  readonly prefix: string;
  readonly value: T;
}

/** Each old-half rule, copied into every hub that has a page beneath it. */
function relocateIntoHubs<T>(
  rules: ReadonlyArray<{ prefix: string; value: T }>,
  pages: readonly AdminHubPage[],
): HubRule<T>[] {
  return rules.flatMap(({ prefix, value }) => {
    const byHub = new Map<string, Set<string>>();
    for (const page of pages) {
      if (!nestsUnder(page.oldPath, prefix)) continue;
      const places = byHub.get(page.hub) ?? new Set<string>();
      places.add(relocate(page, prefix));
      byHub.set(page.hub, places);
    }
    return [...byHub].map(([hub, places]) => {
      const [place] = places;
      if (places.size !== 1 || place === undefined) {
        throw new Error(`admin security map: ${prefix} relocates to ${[...places].join(" and ")} in the ${hub} hub`);
      }
      return { hub, prefix: place, value };
    });
  });
}

// ---------------------------------------------------------------------------
// The route map's page prefixes.
// ---------------------------------------------------------------------------

export interface AdminPageRouteArea {
  readonly prefix: string;
  readonly area: AdminPermissionArea;
}

function deriveOldPathAreas(pages: readonly AdminHubPage[]): AdminPageRouteArea[] {
  const own = new Map<string, AdminPermissionArea>();
  const beneath = new Map<string, Set<AdminPermissionArea>>();
  for (const page of pages) {
    const head = headOf(page);
    const existing = own.get(head);
    if (existing !== undefined && existing !== page.area) {
      throw new Error(
        `admin security map: ${head} holds pages of the ${existing} and ${page.area} areas, which a prefix cannot tell apart`,
      );
    }
    own.set(head, page.area);
    for (const directory of directoriesOf(head)) {
      const areas = beneath.get(directory) ?? new Set<AdminPermissionArea>();
      areas.add(page.area);
      beneath.set(directory, areas);
    }
  }

  const answer = new Map<string, AdminPermissionArea | undefined>();
  const rules: AdminPageRouteArea[] = [];
  for (const directory of shortestFirst(beneath.keys())) {
    const areas = beneath.get(directory)!;
    const decided = own.get(directory) ?? (areas.size === 1 ? [...areas][0] : undefined);
    const inherited = answer.get(parentOf(directory));
    answer.set(directory, decided ?? inherited);
    if (decided !== undefined && decided !== inherited) {
      rules.push({ prefix: directory, area: decided });
    }
  }
  return rules;
}

/** Deepest first, then alphabetical: the resolver takes the first match. */
function deepestFirst<T extends { prefix: string }>(rules: T[]): T[] {
  return rules.sort((a, b) => depth(b.prefix) - depth(a.prefix) || a.prefix.localeCompare(b.prefix));
}

function buildRouteAreas(pages: readonly AdminHubPage[]) {
  const oldHalf = deriveOldPathAreas(pages);
  const hubHalf = relocateIntoHubs(
    oldHalf.map(({ prefix, area }) => ({ prefix, value: area })),
    pages,
  );
  const byPrefix = new Map<string, AdminPermissionArea>();
  for (const { prefix, area } of [
    ...oldHalf,
    ...hubHalf.map(({ prefix, value }) => ({ prefix, area: value })),
  ]) {
    const existing = byPrefix.get(prefix);
    if (existing !== undefined && existing !== area) {
      throw new Error(`admin security map: ${prefix} is generated as both ${existing} and ${area}`);
    }
    byPrefix.set(prefix, area);
  }
  return {
    entries: deepestFirst([...byPrefix].map(([prefix, area]) => ({ prefix, area }))),
    hubHalf,
  };
}

const ROUTE_AREAS = buildRouteAreas(ADMIN_PAGES);

/**
 * The route map's page half, old and hub paths alike, deepest first.
 * `admin-permissions.ts` puts it ahead of its hand-written `/api/admin` half.
 * Frozen, entries included: the resolver reads it on every request.
 */
export const ADMIN_PAGE_ROUTE_AREAS: readonly AdminPageRouteArea[] = Object.freeze(
  ROUTE_AREAS.entries.map((entry) => Object.freeze(entry)),
);

// ---------------------------------------------------------------------------
// The paths admitted by a special rule rather than by their area.
// ---------------------------------------------------------------------------

type SpecialAdmission = Exclude<AdminPageAdmission, "area">;

/**
 * Old and hub paths of every page admitted by a special rule, by rule, frozen.
 *
 * A special rule matches by PREFIX, so it reaches everything beneath the path
 * it names. Two shapes would therefore hand it to pages that never asked for
 * it, and both are refused rather than widened:
 * - a dynamic page, whose rule would sit on its static head and so cover every
 *   sibling beneath that head;
 * - a page with another registered page beneath its old or hub path — a hub
 *   landing page at the hub's root, say, whose `any-admin` would admit any
 *   administrator to every page of the hub (#4799 security review, H1).
 */
// test seam
export function buildAdmissionPaths(
  pages: readonly AdminHubPage[],
): Readonly<Record<SpecialAdmission, readonly string[]>> {
  const paths: Record<SpecialAdmission, string[]> = {
    "any-admin": [],
    "fees-or": [],
    "rooms-beds-or": [],
  };
  for (const page of pages) {
    if (page.admission === "area") continue;
    if (staticHead(page.oldPath) !== page.oldPath) {
      throw new Error(`admin security map: ${page.id} has a ${page.admission} admission on a dynamic path`);
    }
    const own = [page.oldPath, page.hubPath];
    const beneath = pages.find(
      (other) =>
        other !== page &&
        [other.oldPath, other.hubPath].some((path) => own.some((root) => nestsUnder(path, root))),
    );
    if (beneath) {
      throw new Error(
        `admin security map: ${page.id} has a ${page.admission} admission over ${beneath.id}, which sits beneath it`,
      );
    }
    for (const path of own) {
      if (!paths[page.admission].includes(path)) paths[page.admission].push(path);
    }
  }
  return Object.freeze({
    "any-admin": Object.freeze(paths["any-admin"]),
    "fees-or": Object.freeze(paths["fees-or"]),
    "rooms-beds-or": Object.freeze(paths["rooms-beds-or"]),
  });
}

/**
 * Old and hub paths of every page admitted by a special rule, by rule. Each is
 * matched as a prefix, exactly as the hand-written paths were.
 */
export const ADMIN_PAGE_ADMISSION_PATHS: Readonly<Record<SpecialAdmission, readonly string[]>> =
  buildAdmissionPaths(ADMIN_PAGES);

// ---------------------------------------------------------------------------
// The admin page module gates.
// ---------------------------------------------------------------------------

/**
 * The old-path gate prefixes for one module: a directory is gated when a page
 * AT it needs the module (its whole subtree, fail closed), or when it has no
 * page of its own and every page beneath it does.
 */
function deriveOldPathGates(pages: readonly AdminHubPage[], flag: FeatureFlagKey): string[] {
  const ownGated = new Set<string>();
  const gatedBeneath = new Set<string>();
  const freeBeneath = new Set<string>();
  const hasOwnPage = new Set<string>();
  for (const page of pages) {
    const head = headOf(page);
    const gated = page.flags.includes(flag);
    hasOwnPage.add(head);
    if (gated) ownGated.add(head);
    for (const directory of directoriesOf(head)) {
      (gated ? gatedBeneath : freeBeneath).add(directory);
    }
  }

  const gates: string[] = [];
  for (const directory of shortestFirst(gatedBeneath)) {
    if (gates.some((gate) => nestsUnder(directory, gate))) continue;
    const uniform = !hasOwnPage.has(directory) && !freeBeneath.has(directory);
    if (ownGated.has(directory) || uniform) gates.push(directory);
  }
  return gates;
}

function buildModuleGates(pages: readonly AdminHubPage[]) {
  const flags = [...new Set(pages.flatMap((page) => page.flags))];
  const byFlag = new Map<FeatureFlagKey, readonly string[]>();
  const hubHalf: Array<HubRule<FeatureFlagKey>> = [];
  for (const flag of flags) {
    const oldHalf = deriveOldPathGates(pages, flag);
    const relocated = relocateIntoHubs(
      oldHalf.map((prefix) => ({ prefix, value: flag })),
      pages,
    );
    hubHalf.push(...relocated);
    byFlag.set(
      flag,
      Object.freeze([...new Set([...oldHalf, ...relocated.map(({ prefix }) => prefix)])]),
    );
  }
  return { byFlag, hubHalf };
}

const MODULE_GATES = buildModuleGates(ADMIN_PAGES);

/**
 * The admin page prefixes each module gates, old and hub paths alike, each list
 * frozen. `FEATURE_ROUTE_RULES` copies them into the rule for that module once,
 * when it loads; the map is read nowhere else at runtime.
 */
export const ADMIN_PAGE_MODULE_GATES: ReadonlyMap<FeatureFlagKey, readonly string[]> =
  MODULE_GATES.byFlag;

const PAGES_BY_OLD_PATH: ReadonlyMap<string, AdminHubPage> = new Map(
  ADMIN_PAGES.map((page) => [page.oldPath, page]),
);

/**
 * `paths`, each registered page's old path followed by its hub path. Anything
 * else (an API path, an unregistered path) passes through unchanged. For a
 * hand-written exact exemption, whose hub twin must be exempt too.
 */
export function withAdminHubTwins(paths: readonly string[]): string[] {
  return paths.flatMap((path) => {
    const page = PAGES_BY_OLD_PATH.get(path);
    return page && page.hubPath !== path ? [path, page.hubPath] : [path];
  });
}

// ---------------------------------------------------------------------------
// What each hub owns.
// ---------------------------------------------------------------------------

/**
 * Every path this module generates beneath one hub's root: its relocated route
 * prefixes and module gates, its pages' hub paths (admission paths and exemption
 * twins are among them). The registry's prefix census treats these as the
 * hub's own rather than as collisions; anything else beneath the root is one.
 */
export function adminHubOwnedPaths(hubKey: string): string[] {
  return [
    ...new Set([
      ...ROUTE_AREAS.hubHalf.filter((rule) => rule.hub === hubKey).map((rule) => rule.prefix),
      ...MODULE_GATES.hubHalf.filter((rule) => rule.hub === hubKey).map((rule) => rule.prefix),
      ...ADMIN_PAGES.filter((page) => page.hub === hubKey).map((page) => page.hubPath),
    ]),
  ].sort();
}
