import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/session-guards";
import logger from "@/lib/logger";
import { getCachedChartOfAccounts } from "@/lib/xero-admin-cache";
import { fetchChartOfAccountsFromXero } from "@/lib/xero-chart-of-accounts-fetch";
import { isXeroMockActive } from "@/lib/xero-mock-endpoint";

/**
 * GET /api/admin/xero/chart-of-accounts
 * Fetches accounts from the Xero chart of accounts, cached for 1 hour.
 * Returns { accounts: XeroAccount[] }
 */
export async function GET(request?: NextRequest) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const forceRefresh = request?.nextUrl.searchParams.get("refresh") === "1";

  // E2E mock harness (#2081): the gated mock chart of accounts instead of live
  // Xero, never cached (`fetchChartOfAccountsFromXero`). Production-inert —
  // isXeroMockActive() is false everywhere the XERO_MOCK_API_ORIGIN staging var
  // is unset.
  if (!forceRefresh && !isXeroMockActive()) {
    const cachedAccounts = await getCachedChartOfAccounts();
    if (cachedAccounts) {
      return NextResponse.json({
        accounts: cachedAccounts.values,
        cache: cachedAccounts.metadata,
      });
    }
  }

  try {
    return NextResponse.json(await fetchChartOfAccountsFromXero());
  } catch (error) {
    logger.error({ err: error }, "Failed to fetch chart of accounts");
    return NextResponse.json({ error: "Failed to fetch chart of accounts" }, { status: 500 });
  }
}
