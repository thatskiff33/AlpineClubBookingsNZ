import { Account } from "xero-node";
import { callXeroApi, getAuthenticatedXeroClient } from "@/lib/xero-api-client";
import { type XeroAccount, type XeroAdminCacheMetadata, setCachedChartOfAccounts } from "@/lib/xero-admin-cache";
import { fetchMockChartOfAccounts, getXeroMockApiOrigin, isXeroMockActive } from "@/lib/xero-mock-endpoint";

/**
 * The connected organisation's ACTIVE accounts, asked of Xero now and stored as
 * the chart every reader shares (`setCachedChartOfAccounts`). The chart route's
 * refresh and the account mapping save (#5235 review, owner decision of 28 Nov
 * 2026: a save with no fresh chart asks Xero first) both read through here, so
 * an archived account is absent from the chart in both. Throws when Xero cannot
 * be asked. Never call it inside a transaction (`INV-LOCK-004`).
 *
 * The E2E mock harness (#2081) answers from the gated mock chart instead, and
 * stores nothing, as the route always did there.
 */
export async function fetchChartOfAccountsFromXero(): Promise<{
  accounts: XeroAccount[];
  cache: XeroAdminCacheMetadata | null;
}> {
  if (isXeroMockActive()) {
    const origin = getXeroMockApiOrigin();
    return { accounts: origin ? await fetchMockChartOfAccounts(origin) : [], cache: null };
  }
  const { xero, tenantId } = await getAuthenticatedXeroClient();
  const response = await callXeroApi(() => xero.accountingApi.getAccounts(tenantId), {
    operation: "getAccounts",
    resourceType: "ACCOUNT",
    workflow: "adminFetchChartOfAccounts",
    context: "admin/xero/chart-of-accounts",
  });
  const accounts: XeroAccount[] = (response.body.accounts ?? [])
    .filter((a) => a.code && a.name && a.type && a.status === Account.StatusEnum.ACTIVE)
    .map((a) => ({
      code: a.code!,
      name: a.name!,
      type: String(a.type),
      class: String(a._class ?? ""),
    }))
    .sort((a, b) => a.code.localeCompare(b.code));
  const cache = await setCachedChartOfAccounts(tenantId, accounts);
  return { accounts, cache };
}
