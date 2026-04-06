import { NextResponse } from "next/server";
import { Account } from "xero-node";
import { auth } from "@/lib/auth";
import { getAuthenticatedXeroClient } from "@/lib/xero";

export interface XeroAccount {
  code: string;
  name: string;
  type: string;
  class: string;
}

// In-memory cache: 1-hour TTL
let cachedAccounts: XeroAccount[] | null = null;
let cacheExpiresAt: number = 0;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * GET /api/admin/xero/chart-of-accounts
 * Fetches accounts from the Xero chart of accounts, cached for 1 hour.
 * Returns { accounts: XeroAccount[] }
 */
export async function GET() {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  // Return from cache if fresh
  if (cachedAccounts && Date.now() < cacheExpiresAt) {
    return NextResponse.json({ accounts: cachedAccounts });
  }

  try {
    const { xero, tenantId } = await getAuthenticatedXeroClient();
    const response = await xero.accountingApi.getAccounts(tenantId);
    const raw = response.body.accounts ?? [];

    const accounts: XeroAccount[] = raw
      .filter((a) => a.code && a.name && a.type && a.status === Account.StatusEnum.ACTIVE)
      .map((a) => ({
        code: a.code!,
        name: a.name!,
        type: String(a.type),
        class: String(a._class ?? ""),
      }))
      .sort((a, b) => a.code.localeCompare(b.code));

    cachedAccounts = accounts;
    cacheExpiresAt = Date.now() + CACHE_TTL_MS;

    return NextResponse.json({ accounts });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to fetch chart of accounts";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/** Exported for testing — clears the in-memory cache */
export function _clearChartOfAccountsCache() {
  cachedAccounts = null;
  cacheExpiresAt = 0;
}
