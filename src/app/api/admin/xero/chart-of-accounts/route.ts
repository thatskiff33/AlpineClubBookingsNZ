import { NextResponse } from "next/server";
import { Account } from "xero-node";
import { auth } from "@/lib/auth";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { callXeroApi, getAuthenticatedXeroClient } from "@/lib/xero";
import {
  type XeroAccount,
  getCachedChartOfAccounts,
  setCachedChartOfAccounts,
} from "@/lib/xero-admin-cache";

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
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  // Return from cache if fresh
  const cachedAccounts = getCachedChartOfAccounts();
  if (cachedAccounts) {
    return NextResponse.json({ accounts: cachedAccounts });
  }

  try {
    const { xero, tenantId } = await getAuthenticatedXeroClient();
    const response = await callXeroApi(
      () => xero.accountingApi.getAccounts(tenantId),
      {
        operation: "getAccounts",
        resourceType: "ACCOUNT",
        workflow: "adminFetchChartOfAccounts",
        context: "admin/xero/chart-of-accounts",
      }
    );
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

    setCachedChartOfAccounts(accounts);

    return NextResponse.json({ accounts });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to fetch chart of accounts";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
