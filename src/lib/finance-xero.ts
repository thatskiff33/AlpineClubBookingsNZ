import { XeroClient } from "xero-node";
import {
  clearFinanceXeroTokens,
  getFinanceXeroConnectionStatus,
  loadFinanceXeroTokens,
  saveFinanceXeroTokens,
} from "@/lib/finance-xero-token-store";
import {
  getFinanceXeroConfig,
  getFinanceXeroConfigIssues,
  getFinanceXeroTokenStorageIssues,
} from "@/lib/xero-config";

export function createFinanceXeroClient(state?: string): XeroClient {
  return new XeroClient({
    ...getFinanceXeroConfig(),
    ...(state ? { state } : {}),
  });
}

export async function getFinanceXeroConsentUrl(state?: string): Promise<string> {
  const xero = createFinanceXeroClient(state);
  await xero.initialize();
  return xero.buildConsentUrl();
}

export async function handleFinanceXeroCallback(
  url: string,
  state?: string
): Promise<void> {
  const xero = createFinanceXeroClient(state);
  await xero.initialize();
  const tokenSet = await xero.apiCallback(url);
  await xero.updateTenants();

  const tenantId = xero.tenants[0]?.tenantId;

  await saveFinanceXeroTokens({
    accessToken: tokenSet.access_token!,
    refreshToken: tokenSet.refresh_token!,
    expiresAt: new Date(Date.now() + (tokenSet.expires_in ?? 1800) * 1000),
    tenantId,
  });
}

export async function getFinanceXeroRouteStatus(): Promise<{
  connected: boolean;
  tenantId: string | null;
  tokenExpiresAt: Date | null;
  oauthConfigured: boolean;
  tokenStorageConfigured: boolean;
  canConnect: boolean;
  configIssues: string[];
  tokenStorageIssues: string[];
}> {
  const [connectionStatus, configIssues, tokenStorageIssues] = await Promise.all(
    [
      getFinanceXeroConnectionStatus(),
      Promise.resolve(getFinanceXeroConfigIssues()),
      Promise.resolve(getFinanceXeroTokenStorageIssues()),
    ]
  );

  return {
    ...connectionStatus,
    oauthConfigured: configIssues.length === 0,
    tokenStorageConfigured: tokenStorageIssues.length === 0,
    canConnect:
      configIssues.length === 0 && tokenStorageIssues.length === 0,
    configIssues,
    tokenStorageIssues,
  };
}

export async function disconnectFinanceXero(): Promise<void> {
  const tokens = await loadFinanceXeroTokens();

  if (tokens) {
    try {
      const xero = createFinanceXeroClient();
      await xero.initialize();
      xero.setTokenSet({
        access_token: tokens.accessToken,
        refresh_token: tokens.refreshToken,
        token_type: "Bearer",
      });
      await xero.revokeToken();
    } catch {
      // Best-effort revocation; always clear the finance token store locally.
    }
  }

  await clearFinanceXeroTokens();
}
