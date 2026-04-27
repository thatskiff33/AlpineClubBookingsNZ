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

const FINANCE_TOKEN_REFRESH_BUFFER_MS = 10 * 60 * 1000;

let financeTokenRefreshPromise: Promise<{
  xero: XeroClient;
  tenantId: string;
  tokenExpiresAt: Date;
}> | null = null;

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
  if (!tenantId) {
    throw new Error(
      "Finance Xero did not return an organisation to connect. Please reconnect and choose the finance organisation in Xero."
    );
  }

  await saveFinanceXeroTokens({
    accessToken: tokenSet.access_token!,
    refreshToken: tokenSet.refresh_token!,
    expiresAt: new Date(Date.now() + (tokenSet.expires_in ?? 1800) * 1000),
    tenantId,
  });
}

export async function getFinanceXeroRouteStatus(): Promise<{
  connected: boolean;
  hasStoredTokens: boolean;
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

async function resolveFinanceTenantId(
  xero: XeroClient,
  fallbackTenantId?: string | null
): Promise<string> {
  await xero.updateTenants();

  const tenantId = fallbackTenantId ?? xero.tenants[0]?.tenantId ?? null;
  if (!tenantId) {
    throw new Error(
      "Finance Xero is connected, but no finance organisation is available. Reconnect finance Xero."
    );
  }

  return tenantId;
}

export async function getAuthenticatedFinanceXeroClient(): Promise<{
  xero: XeroClient;
  tenantId: string;
  tokenExpiresAt: Date;
}> {
  const tokens = await loadFinanceXeroTokens();
  if (!tokens) {
    throw new Error("Finance Xero is not connected");
  }

  if (!tokens.tenantId) {
    throw new Error("Finance Xero tenant is not available. Reconnect finance Xero.");
  }

  const xero = createFinanceXeroClient();
  await xero.initialize();

  const now = Date.now();
  const expiresAtMs = tokens.expiresAt.getTime();

  if (now >= expiresAtMs - FINANCE_TOKEN_REFRESH_BUFFER_MS) {
    if (financeTokenRefreshPromise) {
      return financeTokenRefreshPromise;
    }

    const refreshWork = (async () => {
      xero.setTokenSet({
        access_token: tokens.accessToken,
        refresh_token: tokens.refreshToken,
        token_type: "Bearer",
      });

      const config = getFinanceXeroConfig();
      try {
        const refreshedTokenSet = await xero.refreshWithRefreshToken(
          config.clientId,
          config.clientSecret,
          tokens.refreshToken
        );
        xero.setTokenSet({
          access_token: refreshedTokenSet.access_token!,
          refresh_token: refreshedTokenSet.refresh_token!,
          token_type: refreshedTokenSet.token_type ?? "Bearer",
        });
        const refreshedExpiresAt = new Date(
          Date.now() + (refreshedTokenSet.expires_in ?? 1800) * 1000
        );
        const tenantId = await resolveFinanceTenantId(xero, tokens.tenantId);

        await saveFinanceXeroTokens({
          accessToken: refreshedTokenSet.access_token!,
          refreshToken: refreshedTokenSet.refresh_token!,
          expiresAt: refreshedExpiresAt,
          tenantId,
        });

        return {
          xero,
          tenantId,
          tokenExpiresAt: refreshedExpiresAt,
        };
      } catch {
        throw new Error(
          "Finance Xero token refresh failed. Reconnect finance Xero from the finance page."
        );
      } finally {
        financeTokenRefreshPromise = null;
      }
    })();

    financeTokenRefreshPromise = refreshWork;
    return refreshWork;
  }

  xero.setTokenSet({
    access_token: tokens.accessToken,
    refresh_token: tokens.refreshToken,
    token_type: "Bearer",
  });

  const tenantId = await resolveFinanceTenantId(xero, tokens.tenantId);
  return {
    xero,
    tenantId,
    tokenExpiresAt: tokens.expiresAt,
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
