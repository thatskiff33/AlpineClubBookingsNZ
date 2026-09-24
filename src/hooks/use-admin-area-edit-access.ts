"use client";

import { useSession } from "next-auth/react";
import { isFullAdmin } from "@/lib/access-roles";
import {
  hasAdminAreaAccess,
  type AdminPermissionArea,
} from "@/lib/admin-permissions";

export const ADMIN_VIEW_ONLY_ACTION_REASON =
  "Your admin role can view this area but cannot make changes.";

/**
 * Reason for a control gated on FULL ADMIN rather than on an area's edit access
 * (#2324).
 *
 * The integration setup wizards need this because their banner and their
 * controls do not always describe the same permission. The shell's view-only
 * banner states the wizard's own area (finance, support, lodge) and appears only
 * when THAT area is view-only — but writing a provider credential additionally
 * requires Full Admin. An admin with finance edit and no Full Admin therefore
 * sees no banner and a dead Save button, so those controls keep their own
 * reason and say which permission it is.
 */
export const ADMIN_FULL_ADMIN_ONLY_ACTION_REASON =
  "This change needs Full Admin access, which your admin role does not have.";

/**
 * Tri-state admin edit-access gate (#2065).
 *
 * Returns:
 * - `undefined` while the client session is still resolving (the
 *   post-hydration `/api/auth/session` fetch has not settled). Consumers must
 *   render a NEUTRAL state for this value: controls stay disabled/skeleton and
 *   NO "view only" banner is shown. This prevents a privileged admin from
 *   briefly seeing the view-only banner + disabled controls (which then pop to
 *   enabled), and — just as importantly — prevents a view-only admin from ever
 *   briefly seeing ENABLED controls during resolution.
 * - `true`  once resolved and the admin can edit the area.
 * - `false` once resolved and the admin can only view the area.
 *
 * `undefined` is falsy, so the common `disabled={!canEdit}` / `readOnly={!canEdit}`
 * idioms already treat the resolving window as disabled (the correct neutral).
 * The view-only banner/notice, however, must gate on `canEdit === false` (see
 * `AdminViewOnlyNotice`, `ViewOnlyActionButton`, and `WysiwygEditor`), never on
 * `!canEdit`, so it does not flash during resolution.
 */
export function useAdminAreaEditAccess(
  area: AdminPermissionArea,
): boolean | undefined {
  const { data: session, status } = useSession();

  // Session still resolving on the client: neutral, undecided state.
  if (status === "loading") return undefined;

  if (!session?.user) return false;

  return hasAdminAreaAccess(session.user, {
    area,
    level: "edit",
  });
}

/**
 * Tri-state FULL ADMIN gate, for a section every admin may VIEW whose write
 * route is `requireAdmin({ permission: false })` rather than an area level
 * (#3596, `/admin/club-format`).
 *
 * The same contract as {@link useAdminAreaEditAccess} — `undefined` while the
 * session resolves, so `ViewOnlyActionButton` and `AdminViewOnlySectionBanner`
 * stay neutral; `true` for a Full Admin; `false` for every other admin — because
 * an area-edit check here would describe the wrong permission: an admin holding
 * every area at `edit` is still not a Full Admin, and the route still refuses
 * them. Client-side it only decides what the screen OFFERS; the route decides
 * what is allowed.
 */
export function useFullAdminEditAccess(): boolean | undefined {
  const { data: session, status } = useSession();

  if (status === "loading") return undefined;

  if (!session?.user) return false;

  return isFullAdmin({ accessRoles: session.user.accessRoles ?? [] });
}

/**
 * View-level variant for read-only actions (e.g. the Xero member-grouping
 * dry-run, E8 #1934) that are allowed to every admin who can see the area,
 * matching a route guard of requireAdmin({ permission: { area, level:
 * "view" } }).
 *
 * Tri-state like {@link useAdminAreaEditAccess}: `undefined` while the session
 * is resolving, so consumers render a neutral state instead of flashing a
 * no-access affordance (#2065).
 */
export function useAdminAreaViewAccess(
  area: AdminPermissionArea,
): boolean | undefined {
  const { data: session, status } = useSession();

  if (status === "loading") return undefined;

  if (!session?.user) return false;

  return hasAdminAreaAccess(session.user, {
    area,
    level: "view",
  });
}
