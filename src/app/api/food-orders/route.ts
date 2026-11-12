import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import {
  compareCalendarDates,
  dateOnlyInstantOf,
  parseCalendarDate,
} from "@/lib/club-time";
import { clubTime } from "@/lib/club-time/server";
import { notifyFoodOfficerOfOrder } from "@/lib/food-order-email";
import {
  foodOrderAuditContext,
  requireFoodOrderViewer,
} from "@/lib/food-order-route";
import {
  FOOD_ORDER_ITEM_DESCRIPTION_MAX_LENGTH,
  DEFAULT_FOOD_ORDER_UNIT,
  FOOD_ORDER_ITEM_QUANTITY_MAX,
  FOOD_ORDER_MAX_ITEMS,
  FOOD_ORDER_NOTES_MAX_LENGTH,
  foodOrderItemsProblem,
  isFoodOrderUnit,
  parseFoodOrderQuantity,
} from "@/lib/food-order-rules";
import { foodOfficerEmail, loadFoodOrderSettings } from "@/lib/food-order-settings";
import { createFoodOrder } from "@/lib/food-orders";
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { applyMemberScopedRateLimit, rateLimiters } from "@/lib/rate-limit";
import { requireActiveSession } from "@/lib/session-guards";

/**
 * The member's Order food door (fork #121): `GET` returns what the form needs,
 * `POST` places an order. Guarded by `requireFoodOrderViewer` (module, session,
 * not an organisation).
 *
 * THE ORDER IS SAVED BEFORE THE EMAIL IS QUEUED. `createFoodOrder` writes the
 * order, its item lines and its audit row in one transaction; only after that
 * commits is the food officer emailed, outside the transaction and not awaited
 * into the response.
 */

const NOT_SET_UP =
  "Food ordering is not set up yet: the club has not entered an email address to send orders to.";

// Bounded here so an oversized payload is refused before it is walked; the
// item rules themselves are `foodOrderItemsProblem`, shared with the form.
const postSchema = z
  .object({
    lodgeId: z.string().trim().min(1).max(64),
    neededBy: z.string().trim().max(10),
    notes: z.string().max(FOOD_ORDER_NOTES_MAX_LENGTH).optional().nullable(),
    items: z
      .array(
        z
          .object({
            description: z
              .string()
              .max(FOOD_ORDER_ITEM_DESCRIPTION_MAX_LENGTH * 2),
            // A decimal STRING ("0.5"), parsed strictly by
            // `parseFoodOrderQuantity` in `foodOrderItemsProblem`; a JSON
            // number is refused so no float ever carries a quantity.
            quantity: z.string().max(16),
            // Required: the form sends its default, Items.
            unit: z.string().max(20),
          })
          .strict(),
      )
      .max(FOOD_ORDER_MAX_ITEMS * 2),
  })
  .strict();

export async function GET() {
  const guard = await requireFoodOrderViewer(() => requireActiveSession());
  if (!guard.ok) return guard.response;

  const [settings, lodges, club] = await Promise.all([
    loadFoodOrderSettings(),
    prisma.lodge.findMany({
      where: { active: true },
      orderBy: [{ isDefault: "desc" }, { name: "asc" }],
      select: { id: true, name: true },
    }),
    clubTime(),
  ]);

  return NextResponse.json({
    // Whether there is anybody to send an order to. The address itself is not
    // returned to members.
    ready: settings.officerEmail !== null,
    officerLabel: settings.officerLabel,
    lodges,
    today: club.today(),
    limits: {
      maxItems: FOOD_ORDER_MAX_ITEMS,
      descriptionMaxLength: FOOD_ORDER_ITEM_DESCRIPTION_MAX_LENGTH,
      quantityMax: FOOD_ORDER_ITEM_QUANTITY_MAX,
      notesMaxLength: FOOD_ORDER_NOTES_MAX_LENGTH,
    },
  });
}

export async function POST(request: NextRequest) {
  const guard = await requireFoodOrderViewer(() => requireActiveSession());
  if (!guard.ok) return guard.response;
  const { memberId } = guard;

  const limited = await applyMemberScopedRateLimit(
    rateLimiters.foodOrderMember,
    request,
    memberId,
  );
  if (limited) return limited;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = postSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  }

  const itemsProblem = foodOrderItemsProblem(parsed.data.items);
  if (itemsProblem) {
    return NextResponse.json({ error: itemsProblem }, { status: 400 });
  }

  // A club calendar day on or after the club's today, compared as calendar
  // dates (INV-DATE), never by instant arithmetic.
  const club = await clubTime();
  const neededBy = parseCalendarDate(parsed.data.neededBy);
  if (!neededBy || compareCalendarDates(neededBy, club.today()) < 0) {
    return NextResponse.json(
      { error: "Choose the date the food is needed by: today or later." },
      { status: 400 },
    );
  }

  const [officerEmail, lodge] = await Promise.all([
    foodOfficerEmail(),
    prisma.lodge.findFirst({
      where: { id: parsed.data.lodgeId, active: true },
      select: { id: true },
    }),
  ]);
  // Refused, never stored: an order nobody would be told about is worse than
  // an error the member can see.
  if (!officerEmail) {
    return NextResponse.json({ error: NOT_SET_UP }, { status: 409 });
  }
  if (!lodge) {
    return NextResponse.json(
      { error: "Please choose the lodge the food is for." },
      { status: 400 },
    );
  }

  const notes = parsed.data.notes?.trim() || null;
  let created: { id: string };
  try {
    created = await createFoodOrder(
      {
        memberId,
        lodgeId: lodge.id,
        neededBy: dateOnlyInstantOf(neededBy),
        notes,
        // Validated above, so the parse and the unit check both hold here.
        items: parsed.data.items.map((item) => ({
          description: item.description,
          quantity: parseFoodOrderQuantity(item.quantity) ?? item.quantity,
          unit: isFoodOrderUnit(item.unit) ? item.unit : DEFAULT_FOOD_ORDER_UNIT,
        })),
      },
      foodOrderAuditContext(request),
    );
  } catch (err) {
    logger.error({ err }, "Failed to create food order");
    return NextResponse.json(
      { error: "Something went wrong placing that order. Please try again." },
      { status: 500 },
    );
  }

  // AFTER the commit, and never awaited into the response.
  void notifyFoodOfficerOfOrder(created.id, request).catch((err) =>
    logger.error(
      { err, foodOrderId: created.id },
      "Failed to send the food order email",
    ),
  );

  return NextResponse.json({ id: created.id }, { status: 201 });
}
