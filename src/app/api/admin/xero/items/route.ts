import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { callXeroApi, getAuthenticatedXeroClient } from "@/lib/xero";
import {
  type XeroItem,
  getCachedItems,
  setCachedItems,
} from "@/lib/xero-admin-cache";

/**
 * GET /api/admin/xero/items
 * Fetches items (products/services) from the Xero API, cached for 1 hour.
 * Returns { items: XeroItem[] }
 */
export async function GET() {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  // Return from cache if fresh
  const cachedItems = getCachedItems();
  if (cachedItems) {
    return NextResponse.json({ items: cachedItems });
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

    setCachedItems(items);

    return NextResponse.json({ items });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to fetch Xero items";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
