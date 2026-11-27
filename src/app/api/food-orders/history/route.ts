import { NextRequest, NextResponse } from "next/server";

import {
  calendarDateParts,
  dateOnlyInstantOf,
  parseCalendarDate,
} from "@/lib/club-time";
import { clubTime } from "@/lib/club-time/server";
import { requireFoodOrderViewer } from "@/lib/food-order-route";
import {
  FOOD_ORDER_HISTORY_FILTER_ERRORS,
  foodOrderHistoryQuerySchema,
} from "@/lib/food-order-schema";
import { loadFoodOrderSettings } from "@/lib/food-order-settings";
import {
  findFoodOrderHistoryRow,
  listFoodOrderHistory,
  type FoodOrderHistoryFilters,
} from "@/lib/food-orders";
import { prisma } from "@/lib/prisma";
import { requireActiveSession } from "@/lib/session-guards";
import { FOOD_ORDER_HISTORY_CONNECTION_SHAPE } from "@/lib/connection-shapes-lodge-life";
import { connectionJson } from "@/lib/mcp-connection-request";

/**
 * The food-order history (fork triyder/AlpineClubBookingsNZ#121). A member gets their own orders; committee
 * and Lodge Operations view get every order, and a current hut leader the
 * orders at the lodges they lead (`foodOrderVisibility`). All can filter by lodge, status and a
 * needed-by date range, paged, with the order count and price total for the
 * whole filter. Each row carries `canManage` from `canManageFoodOrder`, which is
 * the only thing the page uses to show the Received and price controls.
 *
 * A malformed filter value is refused rather than ignored, so a typo never
 * silently widens the totals a club is forecasting from.
 *
 * `?order=<id>` (the link in the food officer's email) adds `linkedOrder`: that
 * one order, whichever page it falls on, when the viewer may see it, and null
 * otherwise. An order they may not see and one that does not exist answer the
 * same null, so the parameter cannot confirm another member's order exists.
 *
 * Also the AI app action `list_my_food_orders` (ALP-796): a connection sees
 * the member's own orders only (`requireFoodOrderViewer`), without the names
 * of who ticked or priced them or the management flags.
 */

function parseFilters(
  params: URLSearchParams,
): FoodOrderHistoryFilters | { error: string } {
  // The first value of each filter, as `URLSearchParams.get` reads it; an
  // empty value is no filter, as the history page sends it.
  const present: Record<string, string> = {};
  for (const key of Object.keys(foodOrderHistoryQuerySchema.shape)) {
    const value = params.get(key)?.trim();
    if (value) present[key] = value;
  }
  const parsed = foodOrderHistoryQuerySchema.safeParse(present);
  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path[0];
    return {
      error:
        typeof field === "string" && field in FOOD_ORDER_HISTORY_FILTER_ERRORS
          ? FOOD_ORDER_HISTORY_FILTER_ERRORS[field as keyof typeof FOOD_ORDER_HISTORY_FILTER_ERRORS]
          : "Unknown filter.",
    };
  }

  const { lodgeId, status, from, to, page } = parsed.data;
  const filters: FoodOrderHistoryFilters = { page: page ?? 1 };
  if (lodgeId) filters.lodgeId = lodgeId;
  if (status) filters.status = status;
  for (const [raw, field, key] of [
    [from, "neededFrom", "from"],
    [to, "neededTo", "to"],
  ] as const) {
    if (!raw) continue;
    const date = parseCalendarDate(raw);
    if (!date) return { error: FOOD_ORDER_HISTORY_FILTER_ERRORS[key] };
    filters[field] = dateOnlyInstantOf(date);
  }
  return filters;
}

export async function GET(request: NextRequest) {
  const guard = await requireFoodOrderViewer(request, () => requireActiveSession());
  if (!guard.ok) return guard.response;

  const filters = parseFilters(request.nextUrl.searchParams);
  if ("error" in filters) {
    return NextResponse.json({ error: filters.error }, { status: 400 });
  }

  const linkedId = request.nextUrl.searchParams.get("order")?.trim() ?? "";
  const [history, linkedOrder, settings, lodges, club] = await Promise.all([
    listFoodOrderHistory(guard.viewer, filters),
    linkedId && linkedId.length <= 64
      ? findFoodOrderHistoryRow(guard.viewer, linkedId)
      : Promise.resolve(null),
    loadFoodOrderSettings(),
    prisma.lodge.findMany({
      orderBy: [{ isDefault: "desc" }, { name: "asc" }],
      select: { id: true, name: true },
    }),
    clubTime(),
  ]);

  return connectionJson(request, {
    ...history,
    linkedOrder,
    // The club's own year today (club-time kernel): this year and later show
    // openly in the totals panel, earlier years inside "Previous years".
    currentYear: calendarDateParts(club.today()).year,
    officerLabel: settings.officerLabel,
    lodges,
  }, FOOD_ORDER_HISTORY_CONNECTION_SHAPE);
}
