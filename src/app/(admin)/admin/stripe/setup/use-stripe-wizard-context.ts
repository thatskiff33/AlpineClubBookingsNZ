"use client";

import { useCallback, useEffect, useState } from "react";
import { useFullAdminEditAccess } from "@/hooks/use-admin-area-edit-access";

/**
 * Derives the Stripe setup wizard's server truth (#2082) — the `context` the
 * reusable shell verifies each step against. Everything here is LIVE server
 * state (credential metadata, connection status + account name, webhook-verified
 * freshness), so step gating can never be faked by a stale persisted cursor.
 */

export interface StripeCredentialFieldMeta {
  set: boolean;
  setAt: string | null;
}

export type StripeCredentialKey =
  | "secret_key"
  | "publishable_key"
  | "webhook_secret";

export interface StripeWizardContext {
  /** Webhook endpoint URL to paste into Stripe (from NEXTAUTH_URL, server-provided). */
  webhookEndpointUrl: string;
  /** Legacy STRIPE_* env vars still present (server-detected); empty when clean. */
  legacyEnvVars: string[];
  /** Metadata-only credential status (never a value). */
  credentials: Record<StripeCredentialKey, StripeCredentialFieldMeta>;
  /**
   * Whether the viewer may write credentials (Full Admin only). Tri-state
   * (#2065 / #2324): `undefined` while the session resolves, so a step neither
   * flashes "Only a Full Admin can…" at a Full Admin nor flashes an enabled
   * control at anyone else. Treat only `true` as permission.
   */
  isFullAdmin: boolean | undefined;
  /** Live "right account" confirmation — the secret key retrieved an account. */
  connected: boolean;
  /** Connected Stripe account display name, when known. */
  accountName: string | null;
  /** A stored Stripe credential no longer decrypts (auth secret changed). */
  needsReentry: boolean;
  /** A fresh TEST-MODE webhook event verified under the current signing secret. */
  webhookVerified: boolean;
}

const CREDENTIALS_ENDPOINT =
  "/api/admin/integrations/credentials?provider=stripe";
const STATUS_ENDPOINT = "/api/admin/integrations/stripe/status";

const EMPTY_META: StripeCredentialFieldMeta = { set: false, setAt: null };

interface CredentialsResponse {
  credentials?: Record<string, { set?: boolean; setAt?: string }>;
}
interface StatusResponse {
  connected?: boolean;
  accountName?: string | null;
  needsReentry?: boolean;
  webhookVerified?: boolean;
}

export interface StripeWizardServerConfig {
  webhookEndpointUrl: string;
  legacyEnvVars: string[];
}

function metaFor(
  rows: Record<string, { set?: boolean; setAt?: string }>,
  key: StripeCredentialKey,
): StripeCredentialFieldMeta {
  return { set: Boolean(rows[key]?.set), setAt: rows[key]?.setAt ?? null };
}

export function useStripeWizardContext(serverConfig: StripeWizardServerConfig): {
  context: StripeWizardContext;
  loading: boolean;
  refresh: () => void;
} {
  // Tri-state: `undefined` until the session resolves (#2324). Reading an
  // unresolved session as `false` made every step's Full-Admin notice appear
  // and then vanish for an actual Full Admin. The shared hook is the one home
  // for that reading (#3596); it answers `false` for a signed-out session too.
  const isFull = useFullAdminEditAccess();

  const [loading, setLoading] = useState(true);
  const [credentials, setCredentials] = useState<
    Record<StripeCredentialKey, StripeCredentialFieldMeta>
  >({
    secret_key: EMPTY_META,
    publishable_key: EMPTY_META,
    webhook_secret: EMPTY_META,
  });
  const [connected, setConnected] = useState(false);
  const [accountName, setAccountName] = useState<string | null>(null);
  const [needsReentry, setNeedsReentry] = useState(false);
  const [webhookVerified, setWebhookVerified] = useState(false);

  const load = useCallback(async () => {
    try {
      const [credRes, statusRes] = await Promise.all([
        fetch(CREDENTIALS_ENDPOINT, { credentials: "same-origin" }),
        fetch(STATUS_ENDPOINT, { credentials: "same-origin" }),
      ]);

      if (credRes.ok) {
        const data = (await credRes.json()) as CredentialsResponse;
        const rows = data.credentials ?? {};
        setCredentials({
          secret_key: metaFor(rows, "secret_key"),
          publishable_key: metaFor(rows, "publishable_key"),
          webhook_secret: metaFor(rows, "webhook_secret"),
        });
      }

      if (statusRes.ok) {
        const data = (await statusRes.json()) as StatusResponse;
        setConnected(Boolean(data.connected));
        setAccountName(data.accountName ?? null);
        setNeedsReentry(Boolean(data.needsReentry));
        setWebhookVerified(Boolean(data.webhookVerified));
      }
    } catch {
      // Leave the last-known state; the wizard degrades to "not verified".
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const refresh = useCallback(() => {
    void load();
  }, [load]);

  const context: StripeWizardContext = {
    webhookEndpointUrl: serverConfig.webhookEndpointUrl,
    legacyEnvVars: serverConfig.legacyEnvVars,
    credentials,
    isFullAdmin: isFull,
    connected,
    accountName,
    needsReentry,
    webhookVerified,
  };

  return { context, loading, refresh };
}
