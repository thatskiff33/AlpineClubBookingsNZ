/**
 * Which hub menu the sidebar shows (epic #4468, C14 #4811).
 *
 * A menu preference only. It decides which hubs the sidebar lists, and nothing
 * about who may open a page. Permission guards must not import this module:
 * the census in `admin-menu-role-guard-census.test.ts` walks their import
 * graphs and fails if one reaches here.
 *
 * The choice lives in the `admin-menu-role` cookie. No Max-Age: the browser
 * keeps it until the officer clears it or the save route deletes it. Sign-out
 * does not clear it, because the next session's menu is still only a menu.
 */
import {
  ACCESS_ROLE_LABELS,
  isAccessRole,
  isFullAdmin,
  resolveAccessRoleTokens,
  type AccessRoleAssignmentInput,
  type PrivilegeCheckInput,
} from "@/lib/access-roles";
import { ADMIN_HUBS, ADMIN_PAGES } from "@/lib/admin-hubs";
import {
  isAdminMenuDestination,
  type AdminHubPage,
} from "@/lib/admin-hubs/define";
import {
  ADMIN_PERMISSION_AREAS,
  canAccessConsolidatedFeesPage,
  canAccessRoomsBedsPage,
  getAdminPermissionMatrix,
  hasAnyAdminAreaFromMatrix,
  type AdminPermissionMatrix,
} from "@/lib/admin-permissions";

/** Cookie name. HttpOnly, SameSite=Lax, Path=/admin, Secure in production. */
export const ADMIN_MENU_ROLE_COOKIE = "admin-menu-role";

/** Attributes for setting or clearing the cookie. No Max-Age. */
export function adminMenuRoleCookieOptions(secure: boolean) {
  return {
    httpOnly: true as const,
    sameSite: "lax" as const,
    path: "/admin",
    secure,
  };
}

/** One role the switcher can offer. */
export type AdminMenuRoleChoice = {
  readonly token: string;
  readonly label: string;
};

/** What the sidebar is asked to show. `selected` is null for "All my roles". */
export type ResolvedAdminMenu = {
  readonly hubKeys: readonly string[];
  readonly roles: readonly AdminMenuRoleChoice[];
  readonly selected: string | null;
};

/**
 * A held token, or null. Anything else — absent, stale, another member's
 * role, forged, malformed — is no choice, and the menu falls back to the union.
 */
export function parseMenuRoleCookie(
  value: string | null | undefined,
  heldTokens: readonly string[],
): string | null {
  if (!value) return null;
  return heldTokens.includes(value) ? value : null;
}

function hubKeysInOrder(keys: ReadonlySet<string>): readonly string[] {
  return ADMIN_HUBS.map((hub) => hub.key).filter((key) => keys.has(key));
}

function everyHub(): readonly string[] {
  return ADMIN_HUBS.map((hub) => hub.key);
}

/** Editable menu destination: the edit half of the admission rule. */
function destinationEditable(
  page: AdminHubPage,
  matrix: AdminPermissionMatrix,
): boolean {
  if (page.fullAdminOnly || page.admission === "any-admin") return false;
  if (page.admission === "fees-or") {
    return matrix.bookings === "edit" || matrix.finance === "edit";
  }
  if (page.admission === "rooms-beds-or") return matrix.bookings === "edit";
  return page.admission === "area" && matrix[page.area] === "edit";
}

/** Viewable menu destination: the view fallback, including edit. */
function destinationViewable(
  page: AdminHubPage,
  matrix: AdminPermissionMatrix,
): boolean {
  if (page.fullAdminOnly || page.admission === "any-admin") return false;
  if (page.admission === "fees-or") return canAccessConsolidatedFeesPage(matrix);
  if (page.admission === "rooms-beds-or") return canAccessRoomsBedsPage(matrix);
  return (
    page.admission === "area" &&
    (matrix[page.area] === "view" || matrix[page.area] === "edit")
  );
}

/**
 * The hubs one role's own matrix shows.
 *
 * One editable menu destination: Home when overview is view or edit, plus
 * every hub that has an editable destination. None editable: the hubs that
 * have a viewable destination. A matrix that edits every area (Full Admin's
 * hardcoded bundle, or a custom role edited to the same) shows every hub.
 * `any-admin` and `fullAdminOnly` pages never count.
 */
export function hubsForRoleMatrix(
  matrix: AdminPermissionMatrix,
): readonly string[] {
  const editsEverything = ADMIN_PERMISSION_AREAS.every(
    (area) => matrix[area.key] === "edit",
  );
  if (editsEverything) return everyHub();

  const destinations = ADMIN_PAGES.filter(isAdminMenuDestination);
  const editable = new Set<string>();
  for (const page of destinations) {
    if (destinationEditable(page, matrix)) editable.add(page.hub);
  }
  if (editable.size > 0) {
    if (matrix.overview === "view" || matrix.overview === "edit") {
      editable.add("dashboard");
    }
    return hubKeysInOrder(editable);
  }

  const viewable = new Set<string>();
  for (const page of destinations) {
    if (destinationViewable(page, matrix)) viewable.add(page.hub);
  }
  return hubKeysInOrder(viewable);
}

function definitionLabel(item: string | AccessRoleAssignmentInput): string | null {
  if (typeof item === "string" || !item.roleDefinition) return null;
  const label = (item.roleDefinition as { label?: unknown }).label;
  return typeof label === "string" && label.length > 0 ? label : null;
}

function roleLabel(
  item: string | AccessRoleAssignmentInput,
  token: string,
): string {
  return (
    definitionLabel(item) ??
    (isAccessRole(token) ? ACCESS_ROLE_LABELS[token] : token)
  );
}

type HeldMenuRole = AdminMenuRoleChoice & { readonly matrix: AdminPermissionMatrix };

/**
 * Menu roles are the member's resolved tokens whose own matrix is not all
 * `none` (User, Organisation and Lodge drop out). Each matrix is that
 * assignment alone, so a club-edited or custom role uses its definition and
 * Full Admin stays the hardcoded bundle.
 */
function heldMenuRoles(member: PrivilegeCheckInput): HeldMenuRole[] {
  const roles: HeldMenuRole[] = [];
  const seen = new Set<string>();
  for (const item of member.accessRoles ?? []) {
    const [token] = resolveAccessRoleTokens({
      canLogin: member.canLogin,
      accessRoles: [item],
    });
    if (!token || seen.has(token)) continue;
    const matrix = getAdminPermissionMatrix({
      canLogin: member.canLogin,
      accessRoles: [item],
    });
    if (!hasAnyAdminAreaFromMatrix(matrix)) continue;
    seen.add(token);
    roles.push({ token, label: roleLabel(item, token), matrix });
  }
  return roles;
}

function unionHubs(roles: readonly HeldMenuRole[]): readonly string[] {
  const keys = new Set<string>();
  for (const role of roles) {
    for (const key of hubsForRoleMatrix(role.matrix)) keys.add(key);
  }
  return hubKeysInOrder(keys);
}

/**
 * The menu for this member and cookie.
 *
 * No cookie, or a token they do not hold: the union of each menu role's hubs.
 * A Full Admin always gets every hub, and the cookie is ignored — the switcher
 * is not offered to them. The palette and every guard keep the merged matrix;
 * this return value is for the sidebar only.
 */
export function resolveAdminMenu(
  member: PrivilegeCheckInput,
  cookie: string | null | undefined,
): ResolvedAdminMenu {
  const roles = heldMenuRoles(member);
  const choices = roles.map(({ token, label }) => ({ token, label }));
  if (isFullAdmin(member)) {
    return { hubKeys: everyHub(), roles: choices, selected: null };
  }
  const selected = parseMenuRoleCookie(
    cookie,
    choices.map((role) => role.token),
  );
  if (!selected) {
    return { hubKeys: unionHubs(roles), roles: choices, selected: null };
  }
  const chosen = roles.find((role) => role.token === selected);
  return {
    hubKeys: chosen ? hubsForRoleMatrix(chosen.matrix) : unionHubs(roles),
    roles: choices,
    selected: chosen ? selected : null,
  };
}
