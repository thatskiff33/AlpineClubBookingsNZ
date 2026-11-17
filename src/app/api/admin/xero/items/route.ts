import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/session-guards";
import logger from "@/lib/logger";
import { callXeroApi, getAuthenticatedXeroClient } from "@/lib/xero-api-client";
import {
  type XeroItem,
  getCachedItems,
  setCachedItems,
} from "@/lib/xero-admin-cache";
import {
  fetchMockXeroItems,
  getXeroMockApiOrigin,
  isXeroMockActive,
} from "@/lib/xero-mock-endpoint";

/**
 * GET /api/admin/xero/items
 * Fetches items (products/services) from the Xero API, cached for 1 hour.
 * Returns { items: XeroItem[] }
 */
export async function GET(request?: NextRequest) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const forceRefresh = request?.nextUrl.searchParams.get("refresh") === "1";

  // E2E mock harness (#2081): route to the gated mock items instead of live
  // Xero. Production-inert (see chart-of-accounts route).
  if (isXeroMockActive()) {
    const origin = getXeroMockApiOrigin();
    const items = origin ? await fetchMockXeroItems(origin) : [];
    return NextResponse.json({ items, cache: null });
  }

  if (!forceRefresh) {
    const cachedItems = await getCachedItems();
    if (cachedItems) {
      return NextResponse.json({
        items: cachedItems.values,
        cache: cachedItems.metadata,
      });
    }
  }

  try {
    const { xero, tenantId } = await getAuthenticatedXeroClient();
    const response = await callXeroApi(
      () => xero.accountingApi.getItems(tenantId),
      {
        operation: "getItems",
        resourceType: "ITEM",
        workflow: "adminFetchXeroItems",
        context: "admin/xero/items",
      }
    );
    const raw = response.body.items ?? [];

    const items: XeroItem[] = raw
      .filter((item) => item.code && item.name && item.isSold !== false)
      .map((item) => ({
        itemID: item.itemID ?? "",
        code: item.code!,
        name: item.name!,
        description: item.description ?? "",
      }))
      .sort((a, b) => a.code.localeCompare(b.code));

    const cache = await setCachedItems(tenantId, items);

    return NextResponse.json({ items, cache });
  } catch (error) {
    logger.error({ err: error }, "Failed to fetch Xero items");
    return NextResponse.json({ error: "Failed to fetch Xero items" }, { status: 500 });
  }
}
