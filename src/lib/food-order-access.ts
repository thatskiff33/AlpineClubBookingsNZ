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
 * Who may do what with food orders (fork triyder/AlpineClubBookingsNZ#121). The ONE access module every
 * food-order page, API route and UI control uses (INV-SSOT): a control is shown
 * from the flags the server computed here, never from a rule of its own.
 *
 * - **Order** (`canPlaceFoodOrder`): any signed-in account except an
 *   organisation, whose stays are arranged through the booking officer
 *   (issue item 10). Organisation accounts are kept out of every food-order
 *   surface, as they are from the events calendar (#2241).
 * - **Manage** an order — tick items received and set its price — is ONE rule
 *   (`canManageFoodOrder`), so the two cannot drift apart: a hut leader whose
 *   access window covers the club's today AT THAT ORDER'S LODGE (the
 *   `isHutLeader` window, `hutLeaderAccessWindowCoversDayWhere`, narrowed to the
 *   lodge), OR an admin with Lodge Operations edit. A committee role alone does
 *   not manage orders (owner decision on PR #5143, 15 Nov 2026).
 * - **See other members' orders** (`foodOrderVisibility`): committee and an
 *   admin with Lodge Operations view see every lodge's orders; a current hut
 *   leader sees only the orders at the lodges they lead today (owner decision on
 *   PR #5143, 15 Nov 2026, matching the lodge-scoping rule that a Lodge A hut
 *   leader does not read Lodge B's records). Everybody also sees their own.
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

/**
 * The viewer an AI app connection decides with (ALP-796, `INV-MCP-006`): the
 * member's own orders and nothing more. A connection never acts as an officer,
 * so the committee, hut-leader and Lodge Operations facts that widen what a
 * person sees or manages on the website are cleared; whether the account is an
 * organisation is kept, since that takes away rather than grants.
 */
export function ownOrdersOnlyFoodOrderViewer(viewer: FoodOrderViewer): FoodOrderViewer {
  return {
    memberId: viewer.memberId,
    isOrganisation: viewer.isOrganisation,
    isCommitteeMember: false,
    hutLeaderLodgeIds: new Set(),
    hasLodgeOperationsView: false,
    hasLodgeOperationsEdit: false,
  };
}

/** May this account place a food order at all? */
export function canPlaceFoodOrder(viewer: FoodOrderViewer): boolean {
  return !viewer.isOrganisation;
}

/**
 * May this member tick items received AND set the price? One rule for both:
 * a hut leader at this order's lodge today, or Lodge Operations edit.
 */
export function canManageFoodOrder(
  viewer: FoodOrderViewer,
  order: { lodgeId: string },
): boolean {
  if (viewer.isOrganisation) return false;
  if (viewer.hutLeaderLodgeIds.has(order.lodgeId)) return true;
  return viewer.hasLodgeOperationsEdit;
}

/**
 * Whose orders, beyond their own, this member sees: every lodge's (`all`), the
 * orders at some lodges (`lodges`, a current hut leader's), or none (`own`).
 * The history query and the one-order check both read this, so a list and a
 * link can never disagree.
 */
type FoodOrderVisibility =
  | { kind: "all" }
  | { kind: "lodges"; lodgeIds: ReadonlySet<string> }
  | { kind: "own" };

export function foodOrderVisibility(viewer: FoodOrderViewer): FoodOrderVisibility {
  if (viewer.isOrganisation) return { kind: "own" };
  if (viewer.isCommitteeMember || viewer.hasLodgeOperationsView) {
    return { kind: "all" };
  }
  if (viewer.hutLeaderLodgeIds.size > 0) {
    return { kind: "lodges", lodgeIds: viewer.hutLeaderLodgeIds };
  }
  return { kind: "own" };
}

/** May this member see this one order? Their own, or one their visibility covers. */
export function canViewFoodOrder(
  viewer: FoodOrderViewer,
  order: { memberId: string | null; lodgeId: string },
): boolean {
  if (viewer.isOrganisation) return false;
  if (order.memberId === viewer.memberId) return true;
  const visibility = foodOrderVisibility(viewer);
  if (visibility.kind === "all") return true;
  if (visibility.kind === "lodges") return visibility.lodgeIds.has(order.lodgeId);
  return false;
}
