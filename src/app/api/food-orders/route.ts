import { NextRequest, NextResponse } from "next/server";
import {
  compareCalendarDates,
  dateOnlyInstantOf,
  parseCalendarDate,
} from "@/lib/club-time";
import { clubTime } from "@/lib/club-time/server";
import { notifyFoodOfficerOfOrder } from "@/lib/food-order-email";
import {
  FOOD_ORDER_MEMBER_RATE_LIMIT,
  foodOrderAuditContext,
  requireFoodOrderViewer,
} from "@/lib/food-order-route";
import {
  FOOD_ORDER_ITEM_DESCRIPTION_MAX_LENGTH,
  DEFAULT_FOOD_ORDER_UNIT,
  FOOD_ORDER_ITEM_QUANTITY_MAX,
  FOOD_ORDER_MAX_ITEMS,
  FOOD_ORDER_NOTES_MAX_LENGTH,
  FOOD_ORDER_UNITS,
  foodOrderItemsProblem,
  isFoodOrderUnit,
  parseFoodOrderQuantity,
} from "@/lib/food-order-rules";
import { foodOfficerEmail, loadFoodOrderSettings } from "@/lib/food-order-settings";
import { createFoodOrder } from "@/lib/food-orders";
import logger from "@/lib/logger";
import {
  filterLodgesByEligibility,
  getEligibleLodgeIdsForMember,
  isMemberEligibleToBookLodge,
} from "@/lib/lodge-access";
import { prisma } from "@/lib/prisma";
import { applyMemberScopedRateLimit } from "@/lib/rate-limit";
import { requireActiveSession } from "@/lib/session-guards";
import { parseJsonRequestBody } from "@/lib/api-json";
import {
  FOOD_ORDER_CREATED_CONNECTION_SHAPE,
  FOOD_ORDER_OPTIONS_CONNECTION_SHAPE,
} from "@/lib/connection-shapes-lodge-life";
import { foodOrderPlaceSchema } from "@/lib/food-order-schema";
import { connectionJson } from "@/lib/mcp-connection-request";

/**
 * The member's Order food door (fork triyder/AlpineClubBookingsNZ#121): `GET` returns what the form needs,
 * `POST` places an order. Guarded by `requireFoodOrderViewer` (module, session,
 * not an organisation).
 *
 * THE ORDER IS SAVED BEFORE THE EMAIL IS QUEUED. `createFoodOrder` writes the
 * order, its item lines and its audit row in one transaction; only after that
 * commits is the food officer emailed, outside the transaction and not awaited
 * into the response.
 *
 * Also the AI app actions `get_food_order_options` and `place_food_order`
 * (ALP-796): the same form facts and the same order, from a connection.
 */

const NOT_SET_UP =
  "Food ordering is not set up yet: the club has not entered an email address to send orders to.";


export async function GET(request: NextRequest) {
  const guard = await requireFoodOrderViewer(request, () => requireActiveSession());
  if (!guard.ok) return guard.response;

  const [settings, activeLodges, access, club] = await Promise.all([
    loadFoodOrderSettings(),
    prisma.lodge.findMany({
      where: { active: true },
      orderBy: [{ isDefault: "desc" }, { name: "asc" }],
      select: { id: true, name: true },
    }),
    getEligibleLodgeIdsForMember(prisma, guard.memberId),
    clubTime(),
  ]);
  // A member restricted to some lodges for booking orders food only for those
  // (owner answer on PR #5143, question 6): the same rule, and the same
  // helper, as every other lodge-scoped member surface.
  const lodges = filterLodgesByEligibility(access, activeLodges);

  return connectionJson(request, {
    // Whether there is anybody to send an order to. The address itself is not
    // returned to members.
    ready: settings.officerEmail !== null,
    officerLabel: settings.officerLabel,
    lodges,
    today: club.today(),
    // The item unit codes an order takes: fixed product values, not club data.
    units: FOOD_ORDER_UNITS,
    limits: {
      maxItems: FOOD_ORDER_MAX_ITEMS,
      descriptionMaxLength: FOOD_ORDER_ITEM_DESCRIPTION_MAX_LENGTH,
      quantityMax: FOOD_ORDER_ITEM_QUANTITY_MAX,
      notesMaxLength: FOOD_ORDER_NOTES_MAX_LENGTH,
    },
  }, FOOD_ORDER_OPTIONS_CONNECTION_SHAPE);
}

export async function POST(request: NextRequest) {
  const guard = await requireFoodOrderViewer(request, () => requireActiveSession());
  if (!guard.ok) return guard.response;
  const { memberId } = guard;

  const limited = await applyMemberScopedRateLimit(
    FOOD_ORDER_MEMBER_RATE_LIMIT,
    request,
    memberId,
  );
  if (limited) return limited;

  const jsonBody = await parseJsonRequestBody(request, {
    error: "Invalid JSON",
  });
  if (!jsonBody.ok) return jsonBody.response;
  const body = jsonBody.body;
  const parsed = foodOrderPlaceSchema.safeParse(body);
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

  const [officerEmail, lodge, eligible] = await Promise.all([
    foodOfficerEmail(),
    prisma.lodge.findFirst({
      where: { id: parsed.data.lodgeId, active: true },
      select: { id: true },
    }),
    isMemberEligibleToBookLodge(prisma, memberId, parsed.data.lodgeId),
  ]);
  // Refused, never stored: an order nobody would be told about is worse than
  // an error the member can see.
  if (!officerEmail) {
    return NextResponse.json({ error: NOT_SET_UP }, { status: 409 });
  }
  // A lodge the member may not book answers exactly as one that does not
  // exist: the list they were offered never contained it.
  if (!lodge || !eligible) {
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

  return connectionJson(request, { id: created.id }, FOOD_ORDER_CREATED_CONNECTION_SHAPE, {
    status: 201,
  });
}
