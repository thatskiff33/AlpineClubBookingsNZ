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
import { FOOD_ORDER_PRICE_CENTS_MAX } from "@/lib/food-order-rules";
import { findFoodOrderForAction, setFoodOrderPrice } from "@/lib/food-orders";
import { requireActiveSession } from "@/lib/session-guards";

/**
 * Record or change a food order's price (fork #121, owner decisions 8, 11, 12).
 *
 * The SAME rule as confirming receipt (`canManageFoodOrder`), and allowed on a
 * closed order too. The amount is integer cents, at least 0
 * (INV-MONEY, the `cents` schema below). It is a record only: nothing is
 * charged, invoiced, posted to the ledger or sent to Xero.
 *
 * Every change writes an audit row with who changed it and the old and new
 * amounts, in the same transaction as the change.
 *
 * STALE SCREENS ARE REFUSED. The client sends `expectedCents`, the price it was
 * showing (null for none). If the stored price is no longer that, the request
 * answers 409 and changes nothing, so a person never overwrites a price they
 * have not seen. The update itself is guarded on the same amount
 * (`setFoodOrderPrice`), which closes the gap between this read and the write.
 */

// Integer cents, 0 to the integer-cents ceiling (INV-MONEY-001), the same
// bounds the form checks with `isValidFoodOrderPriceCents`. `expectedCents` is required: null
// means the screen showed no price.
const cents = z.number().int().min(0).max(FOOD_ORDER_PRICE_CENTS_MAX);
const patchSchema = z
  .object({ priceCents: cents, expectedCents: cents.nullable() })
  .strict();

const STALE_PRICE =
  "Somebody else changed this price just now. Reload to see it before changing it again.";

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await requireFoodOrderViewer(() => requireActiveSession());
  if (!guard.ok) return guard.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Enter the price as an amount of zero or more." },
      { status: 400 },
    );
  }
  const { priceCents, expectedCents } = parsed.data;

  const { id } = await params;
  const order = await findFoodOrderForAction(id);
  if (!order || !canViewFoodOrder(guard.viewer, order)) {
    return NextResponse.json(FOOD_ORDER_NOT_FOUND, { status: 404 });
  }
  if (!canManageFoodOrder(guard.viewer, order)) {
    return NextResponse.json(
      {
        error:
          "Only a committee member, a hut leader at this lodge, or a Lodge Operations admin can record this order's price.",
      },
      { status: 403 },
    );
  }

  if (order.priceCents !== expectedCents) {
    return NextResponse.json({ error: STALE_PRICE }, { status: 409 });
  }

  const result = await setFoodOrderPrice(
    { orderId: order.id, actorId: guard.memberId, expectedCents, priceCents },
    foodOrderAuditContext(request),
  );
  if (result.outcome === "conflict") {
    return NextResponse.json({ error: STALE_PRICE }, { status: 409 });
  }
  return NextResponse.json({ id: order.id, priceCents });
}
