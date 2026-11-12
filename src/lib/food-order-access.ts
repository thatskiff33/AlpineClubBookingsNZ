import {
  hasAdminAreaAccess,
  type AdminPermissionInput,
} from "@/lib/admin-permissions";
import { isActiveCommitteeMember } from "@/lib/calendar-access";
import { clubTodayDateOnlyInstant } from "@/lib/club-time/server";
import { hutLeaderAccessWindowCoversDayWhere } from "@/lib/hut-leader-access-window";
import { isOrganisationAccount } from "@/lib/organisation-account";
import { prisma } from "@/lib/prisma";

/**
 * Who may do what with food orders (fork #121). The ONE access module every
 * food-order page, API route and UI control uses (INV-SSOT): a control is shown
 * from the flags the server computed here, never from a rule of its own.
 *
 * - **Order** (`canPlaceFoodOrder`): any signed-in account except an
 *   organisation, whose stays are arranged through the booking officer
 *   (issue item 10). Organisation accounts are kept out of every food-order
 *   surface, as they are from the events calendar (#2241).
 * - **Manage** an order — mark it Received and set its price — is ONE rule
 *   (`canManageFoodOrder`, fork #121 owner decisions 7 and 12), so the two cannot drift
 *   apart: an active committee assignment under an active committee role, OR a
 *   hut leader whose access window covers the club's today AT THAT ORDER'S LODGE
 *   (the `isHutLeader` window, `hutLeaderAccessWindowCoversDayWhere`, narrowed
 *   to the lodge), OR an admin with Lodge Operations edit.
 * - **See every order** (`canViewAllFoodOrders`): committee, a current hut
 *   leader at any lodge, or an admin with Lodge Operations view. Everybody else
 *   sees only their own orders.
 *
 * The facts are resolved once per request (`resolveFoodOrderViewer`) and the
 * decisions are pure over them, so the history page can decide every row with
 * the same function the action routes use, without a query per row.
 */

export type FoodOrderActor = AdminPermissionInput & { id: string };

/** What the rules need to know about the signed-in member, resolved once. */
export type FoodOrderViewer = {
  memberId: string;
  isOrganisation: boolean;
  isCommitteeMember: boolean;
  /** Lodges where a hut-leader access window covers the club's today. */
  hutLeaderLodgeIds: ReadonlySet<string>;
  hasLodgeOperationsView: boolean;
  hasLodgeOperationsEdit: boolean;
};

/**
 * Whether this account may use food orders at all — the synchronous half of
 * the rules, for a surface that only needs to know whether to offer the
 * feature (the dashboard card). Organisation accounts may not.
 */
export function canActorUseFoodOrders(actor: AdminPermissionInput): boolean {
  return !isOrganisationAccount(actor);
}

/**
 * Resolve the facts for `actor`. An organisation account short-circuits before
 * any committee or hut-leader read, because no rule admits it.
 */
export async function resolveFoodOrderViewer(
  actor: FoodOrderActor,
): Promise<FoodOrderViewer> {
  if (!canActorUseFoodOrders(actor)) {
    return {
      memberId: actor.id,
      isOrganisation: true,
      isCommitteeMember: false,
      hutLeaderLodgeIds: new Set(),
      hasLodgeOperationsView: false,
      hasLodgeOperationsEdit: false,
    };
  }

  const today = await clubTodayDateOnlyInstant();
  const [isCommitteeMember, hutLeaderRows] = await Promise.all([
    isActiveCommitteeMember(actor.id),
    prisma.hutLeaderAssignment.findMany({
      where: { memberId: actor.id, ...hutLeaderAccessWindowCoversDayWhere(today) },
      select: { lodgeId: true },
    }),
  ]);

  return {
    memberId: actor.id,
    isOrganisation: false,
    isCommitteeMember,
    hutLeaderLodgeIds: new Set(hutLeaderRows.map((row) => row.lodgeId)),
    hasLodgeOperationsView: hasAdminAreaAccess(actor, {
      area: "lodge",
      level: "view",
    }),
    hasLodgeOperationsEdit: hasAdminAreaAccess(actor, {
      area: "lodge",
      level: "edit",
    }),
  };
}

/** May this account place a food order at all? */
export function canPlaceFoodOrder(viewer: FoodOrderViewer): boolean {
  return !viewer.isOrganisation;
}

/**
 * May this member confirm the order Received AND set its price? One rule for
 * both (fork #121 owner decisions 7 and 12).
 */
export function canManageFoodOrder(
  viewer: FoodOrderViewer,
  order: { lodgeId: string },
): boolean {
  if (viewer.isOrganisation) return false;
  if (viewer.isCommitteeMember) return true;
  if (viewer.hutLeaderLodgeIds.has(order.lodgeId)) return true;
  return viewer.hasLodgeOperationsEdit;
}

/** May this member see every member's orders, rather than only their own? */
export function canViewAllFoodOrders(viewer: FoodOrderViewer): boolean {
  if (viewer.isOrganisation) return false;
  return (
    viewer.isCommitteeMember ||
    viewer.hutLeaderLodgeIds.size > 0 ||
    viewer.hasLodgeOperationsView
  );
}

/** May this member see this one order? Their own, or any when they see all. */
export function canViewFoodOrder(
  viewer: FoodOrderViewer,
  order: { memberId: string | null },
): boolean {
  if (viewer.isOrganisation) return false;
  return order.memberId === viewer.memberId || canViewAllFoodOrders(viewer);
}
