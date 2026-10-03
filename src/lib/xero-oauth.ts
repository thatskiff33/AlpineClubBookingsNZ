/**
 * Xero OAuth lifecycle
 *
 * Builds the consent URL, handles the OAuth callback, exposes client construction
 * for higher-level Xero infrastructure, and disconnects (revoke + clear tokens).
 */

import { XeroClient } from "xero-node";
import { getOperationalXeroConfig } from "@/lib/xero-config";
import {
  buildMockXeroConsentUrl,
  getXeroMockApiOrigin,
  getXeroMockInternalOrigin,
  handleMockXeroCallback,
} from "@/lib/xero-mock-endpoint";
import { XERO_OAUTH_CALLBACK_NO_TENANT_MESSAGE } from "@/lib/xero-oauth-callback-messages";
import {
  deleteXeroTokens,
  loadXeroTokens,
  saveXeroTokens,
  type XeroTokenWriteContext,
} from "./xero-token-store";

export async function createXeroClient(state?: string): Promise<XeroClient> {
  return new XeroClient({
    ...(await getOperationalXeroConfig()),
    ...(state ? { state } : {}),
  });
}

/**
 * Build the Xero OAuth2 consent URL for admin to connect.
 */
export async function getXeroConsentUrl(state?: string): Promise<string> {
  // Test-only mock-Xero harness (#2080). Inert in production (env unset).
  const mockOrigin = getXeroMockApiOrigin();
  if (mockOrigin) return buildMockXeroConsentUrl(mockOrigin, state);

  const xero = await createXeroClient(state);
  await xero.initialize();
  return xero.buildConsentUrl();
}

/**
 * Handle the OAuth2 callback from Xero.
 * Exchanges the authorization code for tokens and stores them encrypted.
 */
export async function handleXeroCallback(
  url: string,
  state: string | undefined,
  context: XeroTokenWriteContext,
): Promise<void> {
  // Test-only mock-Xero harness (#2080). Inert in production (env unset).
  // Token exchange is a SERVER-side fetch, so it uses the in-container origin
  // (the browser-facing origin may be a host-mapped port the container can't dial).
  const mockInternalOrigin = getXeroMockInternalOrigin();
  if (mockInternalOrigin) {
    await handleMockXeroCallback(mockInternalOrigin, url, context);
    return;
  }

  const xero = await createXeroClient(state);
  await xero.initialize();
  const tokenSet = await xero.apiCallback(url);
  await xero.updateTenants();

  const tenants = xero.tenants;
  const tenantId = tenants.length > 0 ? tenants[0].tenantId : null;
  if (!tenantId) {
    throw new Error(XERO_OAUTH_CALLBACK_NO_TENANT_MESSAGE);
  }

  await saveXeroTokens({
    accessToken: tokenSet.access_token!,
    refreshToken: tokenSet.refresh_token!,
    expiresAt: new Date(Date.now() + (tokenSet.expires_in ?? 1800) * 1000),
    tenantId,
  }, context);
}

/**
 * Disconnect Xero by revoking stored tokens (best-effort) and removing them locally.
 */
export async function disconnectXero(context: XeroTokenWriteContext): Promise<void> {
  const tokens = await loadXeroTokens();
  if (tokens) {
    try {
      const xero = await createXeroClient();
      await xero.initialize();
      xero.setTokenSet({
        access_token: tokens.accessToken,
        refresh_token: tokens.refreshToken,
        token_type: "Bearer",
      });
      await xero.revokeToken();
    } catch {
      // Best-effort revocation; continue with local cleanup
    }
  }
  await deleteXeroTokens({ ...context, cause: { kind: "oauth-disconnect" } });
}
