import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { getAuthenticatedXeroClient } from "@/lib/xero";

export interface XeroItem {
  itemID: string;
  code: string;
  name: string;
  description: string;
}

// In-memory cache: 1-hour TTL
let cachedItems: XeroItem[] | null = null;
let cacheExpiresAt: number = 0;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

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
  if (cachedItems && Date.now() < cacheExpiresAt) {
    return NextResponse.json({ items: cachedItems });
  }

  try {
    const { xero, tenantId } = await getAuthenticatedXeroClient();
    const response = await xero.accountingApi.getItems(tenantId);
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

    cachedItems = items;
    cacheExpiresAt = Date.now() + CACHE_TTL_MS;

    return NextResponse.json({ items });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to fetch Xero items";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/** Exported for testing — clears the in-memory cache */
export function _clearItemsCache() {
  cachedItems = null;
  cacheExpiresAt = 0;
}
