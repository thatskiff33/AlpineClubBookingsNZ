/**
 * The shape of one admin hub and its pages (epic #4468, C1 #4798).
 *
 * Relative, type-only imports: see `release.ts` for why nothing under
 * `src/lib/admin-hubs/` may use the `@/` alias.
 */
import type { AdminPermissionArea } from "../admin-permissions";
import type { FeatureFlagKey } from "../../config/schema";

/**
 * How a page is ADMITTED, as `canOpenAdminPath` decides it today.
 *
 * - `area`: the route map's area, at `view` (opening a page is a read).
 * - `any-admin`: `ANY_ADMIN_ADMISSION_PATHS` — any one admin area admits.
 * - `fees-or`: the consolidated fee console's bookings-OR-finance rule.
 * - `rooms-beds-or`: Rooms & Beds' lodge-OR-bookings rule.
 *
 * The three special rules still carry a route-map `area` on the entry, because
 * the route map resolves every path to one area and C2 generates that map.
 */
export type AdminPageAdmission =
  | "area"
  | "any-admin"
  | "fees-or"
  | "rooms-beds-or";

/**
 * What a page is FOR, which decides whether the hub menu (C13) and the command
 * palette (S2) may offer it. Only a `page` is a destination; the rest are
 * reached from one, or not at all.
 *
 * - `page`: a screen an officer opens on purpose.
 * - `detail`: one record's screen, reached from its list (any `[param]` path).
 * - `print`: a printable view of one record.
 * - `stub`: a `page.tsx` that only redirects, kept so old links still work.
 * - `test`: a test-only probe that 404s in production.
 */
export type AdminPageKind = "page" | "detail" | "print" | "stub" | "test";

/** One page as a hub fragment writes it. Omitted fields take the defaults below. */
export interface AdminHubPageInput {
  /** Stable key for `adminHref`; unique across every hub. */
  readonly id: string;
  readonly label: string;
  /** Today's URL, from the page directory on disk; `[name]` marks a dynamic segment. */
  readonly oldPath: `/admin/${string}`;
  /** The area `getAdminRouteRequirement(oldPath)` resolves today. */
  readonly area: AdminPermissionArea;
  /** Defaults to `"area"`. */
  readonly admission?: AdminPageAdmission;
  /** Every module flag `getRequiredFeaturesForPath(oldPath)` requires today. Defaults to none. */
  readonly flags?: readonly FeatureFlagKey[];
  /** Defaults to `"page"`. */
  readonly kind?: AdminPageKind;
  /** The menu hides the page from anyone but a Full Admin. Defaults to `false`. */
  readonly fullAdminOnly?: boolean;
  /**
   * The page IS its hub's root URL, instead of keeping its directory under the
   * hub prefix. Only Home's dashboard does this; every other hub root is left
   * for C13's hub landing page.
   */
  readonly landing?: true;
  /** Whether C4–C12 has moved the page's directory under its hub yet. */
  readonly moved: boolean;
}

export interface AdminHubInput {
  /** Stable hub key. */
  readonly key: string;
  readonly label: string;
  /** The hub's URL segment: every hub path sits under `/admin/<prefix>`. */
  readonly prefix: string;
  readonly pages: readonly AdminHubPageInput[];
}

/** One page, normalised: every field explicit, and its hub path derived. */
export interface AdminHubPage {
  readonly id: string;
  readonly label: string;
  readonly hub: string;
  readonly oldPath: string;
  readonly hubPath: string;
  readonly area: AdminPermissionArea;
  readonly admission: AdminPageAdmission;
  readonly flags: readonly FeatureFlagKey[];
  readonly kind: AdminPageKind;
  readonly fullAdminOnly: boolean;
  readonly moved: boolean;
}

/** Whether the hub menu and the command palette may offer this page. */
export function isAdminMenuDestination(page: AdminHubPage): boolean {
  return page.kind === "page";
}

/**
 * Identity at runtime; `const` keeps every id and path a literal type, which is
 * what lets `adminHref` refuse an unknown id at compile time.
 */
export function defineHub<const H extends AdminHubInput>(hub: H): H {
  return hub;
}

/** `/admin/<prefix>`, the root every one of the hub's paths sits under. */
export function hubRoot(prefix: string): string {
  return `/admin/${prefix}`;
}

/**
 * The hub path is DERIVED, never written: the page's directory keeps its whole
 * relative path under the hub prefix (`/admin/payments` ->
 * `/admin/finance/payments`, `/admin/members/[id]/merge` ->
 * `/admin/membership/members/[id]/merge`). A move is then one `git mv` of the
 * directory, and a page cannot be separated from the pages nested under it.
 */
export function normaliseHubPage(
  hub: AdminHubInput,
  page: AdminHubPageInput,
): AdminHubPage {
  const root = hubRoot(hub.prefix);
  return {
    id: page.id,
    label: page.label,
    hub: hub.key,
    oldPath: page.oldPath,
    hubPath: page.landing ? root : `${root}${page.oldPath.slice("/admin".length)}`,
    area: page.area,
    admission: page.admission ?? "area",
    flags: page.flags ?? [],
    kind: page.kind ?? "page",
    fullAdminOnly: page.fullAdminOnly ?? false,
    moved: page.moved,
  };
}
