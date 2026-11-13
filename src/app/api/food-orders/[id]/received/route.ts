import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import {
  canManageFoodOrder,
  canViewFoodOrder,
} from "@/lib/food-order-access";
import {
  FOOD_ORDER_NOT_FOUND,
  foodOrderAuditContext,
  requireFoodOrderViewer,
} from "@/lib/food-order-route";
import { FOOD_ORDER_MAX_ITEMS } from "@/lib/food-order-rules";
import {
  findFoodOrderForAction,
  markFoodOrderItemsReceived,
} from "@/lib/food-orders";
import { requireActiveSession } from "@/lib/session-guards";

/**
 * Tick items of a food order received (fork #121; owner change, 13 Nov 2026:
 * food can arrive in parts). The order closes as Received when its last item
 * is (fork #121 owner decision 7).
 *
 * Who: `canManageFoodOrder` — committee, a hut leader at THIS order's lodge
 * today, or Lodge Operations edit. An order the caller may not even see answers
 * 404, so the route is not an oracle for other members' order ids; one they can
 * see but not manage answers 403.
 *
 * The body is `{ itemIds }`: 1-50 distinct ids, every one an item of THIS
 * order, or 400 with nothing written. `markFoodOrderItemsReceived` takes the
 * order row first with a status-guarded update, so concurrent ticks run one
 * after the other and the last item closes the order once. An order already
 * received, or a choice whose items were all already received, answers 409 and
 * changes nothing. Received is final: there is no unticking.
 */

const bodySchema = z
  .object({
    itemIds: z
      .array(z.string().trim().min(1).max(64))
      .min(1)
      .max(FOOD_ORDER_MAX_ITEMS)
      .refine((ids) => new Set(ids).size === ids.length, "duplicate item"),
  })
  .strict();

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await requireFoodOrderViewer(() => requireActiveSession());
  if (!guard.ok) return guard.response;

  const { id } = await params;
  const order = await findFoodOrderForAction(id);
  if (!order || !canViewFoodOrder(guard.viewer, order)) {
    return NextResponse.json(FOOD_ORDER_NOT_FOUND, { status: 404 });
  }
  if (!canManageFoodOrder(guard.viewer, order)) {
    return NextResponse.json(
      {
        error:
          "Only a committee member, a hut leader at this lodge, or a Lodge Operations admin can mark this order's items received.",
      },
      { status: 403 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(body);
  const ownItemIds = new Set(order.items.map((item) => item.id));
  if (!parsed.success || !parsed.data.itemIds.every((itemId) => ownItemIds.has(itemId))) {
    return NextResponse.json(
      { error: "Choose one or more items of this order." },
      { status: 400 },
    );
  }

  const result = await markFoodOrderItemsReceived(
    { orderId: order.id, actorId: guard.memberId, itemIds: parsed.data.itemIds },
    foodOrderAuditContext(request),
  );
  if (result.outcome === "already_received") {
    return NextResponse.json(
      { error: "This order has already been marked received." },
      { status: 409 },
    );
  }
  if (result.outcome === "items_already_received") {
    return NextResponse.json(
      { error: "Those items were already received. The order has been reloaded." },
      { status: 409 },
    );
  }
  return NextResponse.json({
    id: order.id,
    status: result.closed ? "RECEIVED" : "OPEN",
    markedCount: result.markedCount,
    remaining: result.remaining,
  });
}
