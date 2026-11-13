import { NextRequest, NextResponse } from "next/server";

import {
  calendarDateParts,
  dateOnlyInstantOf,
  parseCalendarDate,
} from "@/lib/club-time";
import { clubTime } from "@/lib/club-time/server";
import { requireFoodOrderViewer } from "@/lib/food-order-route";
import { FOOD_ORDER_STATUSES } from "@/lib/food-order-rules";
import { loadFoodOrderSettings } from "@/lib/food-order-settings";
import {
  findFoodOrderHistoryRow,
  listFoodOrderHistory,
  type FoodOrderHistoryFilters,
} from "@/lib/food-orders";
import { prisma } from "@/lib/prisma";
import { requireActiveSession } from "@/lib/session-guards";

/**
 * The food-order history (fork #121). A member gets their own orders; a viewer
 * `canViewAllFoodOrders` admits (committee, a current hut leader, Lodge
 * Operations view) gets every order. Both can filter by lodge, status and a
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
 */

function parseFilters(
  params: URLSearchParams,
): FoodOrderHistoryFilters | { error: string } {
  const filters: FoodOrderHistoryFilters = { page: 1 };

  const lodgeId = params.get("lodgeId")?.trim();
  if (lodgeId) {
    if (lodgeId.length > 64) return { error: "Unknown lodge filter." };
    filters.lodgeId = lodgeId;
  }

  const status = params.get("status")?.trim();
  if (status) {
    const match = FOOD_ORDER_STATUSES.find((value) => value === status);
    if (!match) return { error: "Unknown status filter." };
    filters.status = match;
  }

  for (const [key, field] of [
    ["from", "neededFrom"],
    ["to", "neededTo"],
  ] as const) {
    const raw = params.get(key)?.trim();
    if (!raw) continue;
    const date = parseCalendarDate(raw);
    if (!date) return { error: "Dates must be in YYYY-MM-DD form." };
    filters[field] = dateOnlyInstantOf(date);
  }

  const page = params.get("page");
  if (page) {
    const value = Number(page);
    if (!Number.isInteger(value) || value < 1 || value > 100_000) {
      return { error: "Unknown page." };
    }
    filters.page = value;
  }
  return filters;
}

export async function GET(request: NextRequest) {
  const guard = await requireFoodOrderViewer(() => requireActiveSession());
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

  return NextResponse.json({
    ...history,
    linkedOrder,
    // The club's own year today (club-time kernel): this year and later show
    // openly in the totals panel, earlier years inside "Previous years".
    currentYear: calendarDateParts(club.today()).year,
    officerLabel: settings.officerLabel,
    lodges,
  });
}
