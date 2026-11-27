import { NextResponse } from "next/server";

import {
  canPlaceFoodOrder,
  ownOrdersOnlyFoodOrderViewer,
  resolveFoodOrderViewer,
  type FoodOrderViewer,
} from "@/lib/food-order-access";
import { arrivesAsMcpConnection } from "@/lib/mcp-connection-request";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";
import { getClientIp, type RateLimitConfig } from "@/lib/rate-limit";
import type { requireActiveSession } from "@/lib/session-guards";

/**
 * Placing an order: 10 an hour per member (and ten times that per IP, through
 * `applyMemberScopedRateLimit`), like `rateLimiters.maintenanceReportMember`.
 * Not `authSensitive`: there is no credential behind it. Kept here rather than
 * in `rateLimiters` because `rate-limit.ts` is at its file-size budget.
 */
export const FOOD_ORDER_MEMBER_RATE_LIMIT: RateLimitConfig = {
  id: "food-order-member",
  limit: 10,
  windowSeconds: 60 * 60,
};

/**
 * The guard every member food-order route opens with (fork triyder/AlpineClubBookingsNZ#121), so the four
 * handlers cannot apply it in different orders.
 *
 * 1. THE MODULE, FIRST. With `foodOrders` off the route answers the same 404 the
 *    proxy's feature-route rule gives, signed in or not — a module gate that
 *    lived only in middleware shipped bypassed once already (#2780).
 *    `loadEffectiveModuleFlags` fails closed on a read error.
 * 2. An active session (401/403 from `requireActiveSession`). The handler
 *    passes the session guard in as a callback, so each method body names
 *    `requireActiveSession()` itself (the per-method boundary census,
 *    `api-route-boundaries.test.ts`) while the module is still checked first.
 * 3. Not an organisation account (issue item 10): 403.
 * 4. An AI app connection (ALP-796) decides with the member's own orders only
 *    (`ownOrdersOnlyFoodOrderViewer`), whatever officer or hut-leader reach the
 *    person has on the website.
 */

export const FOOD_ORDER_NOT_FOUND = { error: "Not found" } as const;

export async function foodOrderModuleOff(): Promise<boolean> {
  const modules = await loadEffectiveModuleFlags();
  return !modules.foodOrders;
}

export type FoodOrderGuardResult =
  | { ok: true; viewer: FoodOrderViewer; memberId: string }
  | { ok: false; response: NextResponse };

export async function requireFoodOrderViewer(
  request: Request,
  requireSession: () => ReturnType<typeof requireActiveSession>,
): Promise<FoodOrderGuardResult> {
  if (await foodOrderModuleOff()) {
    return {
      ok: false,
      response: NextResponse.json(FOOD_ORDER_NOT_FOUND, { status: 404 }),
    };
  }

  const guard = await requireSession();
  if (!guard.ok) return { ok: false, response: guard.response as NextResponse };

  const viewer = await resolveFoodOrderViewer(guard.session.user);
  if (!canPlaceFoodOrder(viewer)) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          error:
            "Organisation accounts cannot order food. Please arrange catering through the booking officer.",
        },
        { status: 403 },
      ),
    };
  }

  return {
    ok: true,
    viewer: arrivesAsMcpConnection(request) ? ownOrdersOnlyFoodOrderViewer(viewer) : viewer,
    memberId: guard.session.user.id,
  };
}

/** The address the audit row records, as the rate limiter reads it. */
export function foodOrderAuditContext(request: Request): { ipAddress: string } {
  return { ipAddress: getClientIp(request) };
}
