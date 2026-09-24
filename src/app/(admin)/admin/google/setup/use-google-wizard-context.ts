"use client";

import { useCallback, useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import { isFullAdmin } from "@/lib/access-roles";

/**
 * Derives the Google sign-in setup wizard's server truth (#2087) — the `context`
 * the reusable shell verifies each step against. Everything here is LIVE server
 * state (credential metadata, verified freshness, re-entry), so step gating can
 * never be faked by a stale persisted cursor.
 */

export interface GoogleCredentialFieldMeta {
  set: boolean;
  setAt: string | null;
}

export type GoogleCredentialKey = "client_id" | "client_secret";

export interface GoogleWizardContext {
  /** Authorized redirect URI to paste into Google Cloud (server-derived). */
  redirectUri: string;
  /** Legacy GOOGLE_CLIENT_* env vars still present (server-detected); empty when clean. */
  legacyEnvVars: string[];
  /** Metadata-only credential status (never a value). */
  credentials: Record<GoogleCredentialKey, GoogleCredentialFieldMeta>;
  /**
   * Whether the viewer may write credentials (Full Admin only). Tri-state
   * (#2065 / #2324): `undefined` while the session resolves, so a step neither
   * flashes "Only a Full Admin can…" at a Full Admin nor flashes an enabled
   * control at anyone else. Treat only `true` as permission.
   */
  isFullAdmin: boolean | undefined;
  /** A stored Google credential no longer decrypts (auth secret changed). */
  needsReentry: boolean;
  /** A real OAuth round-trip verified the current credentials (D2 gate). */
  verified: boolean;
}

const CREDENTIALS_ENDPOINT =
  "/api/admin/integrations/credentials?provider=google";
const STATUS_ENDPOINT = "/api/admin/integrations/google/status";

const EMPTY_META: GoogleCredentialFieldMeta = { set: false, setAt: null };

interface CredentialsResponse {
  credentials?: Record<string, { set?: boolean; setAt?: string }>;
}
interface StatusResponse {
  clientIdSet?: boolean;
  clientSecretSet?: boolean;
  needsReentry?: boolean;
  verified?: boolean;
}

export interface GoogleWizardServerConfig {
  redirectUri: string;
  legacyEnvVars: string[];
}

function metaFor(
  rows: Record<string, { set?: boolean; setAt?: string }>,
  key: GoogleCredentialKey,
): GoogleCredentialFieldMeta {
  return { set: Boolean(rows[key]?.set), setAt: rows[key]?.setAt ?? null };
}

export function useGoogleWizardContext(
  serverConfig: GoogleWizardServerConfig,
): {
  context: GoogleWizardContext;
  loading: boolean;
  refresh: () => void;
} {
  const { data: session, status: sessionStatus } = useSession();
  // Tri-state: `undefined` until the session resolves (#2324). Reading an
  // unresolved session as `false` made every step's Full-Admin notice appear
  // and then vanish for an actual Full Admin.
  const isFull =
    sessionStatus === "loading"
      ? undefined
      : session
        ? isFullAdmin({ accessRoles: session.user?.accessRoles ?? [], canLogin: session.user?.canLogin ?? false })
        : false;

  const [loading, setLoading] = useState(true);
  const [credentials, setCredentials] = useState<
    Record<GoogleCredentialKey, GoogleCredentialFieldMeta>
  >({
    client_id: EMPTY_META,
    client_secret: EMPTY_META,
  });
  const [needsReentry, setNeedsReentry] = useState(false);
  const [verified, setVerified] = useState(false);

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
          client_id: metaFor(rows, "client_id"),
          client_secret: metaFor(rows, "client_secret"),
        });
      }

      if (statusRes.ok) {
        const data = (await statusRes.json()) as StatusResponse;
        setNeedsReentry(Boolean(data.needsReentry));
        setVerified(Boolean(data.verified));
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

  const context: GoogleWizardContext = {
    redirectUri: serverConfig.redirectUri,
    legacyEnvVars: serverConfig.legacyEnvVars,
    credentials,
    isFullAdmin: isFull,
    needsReentry,
    verified,
  };

  return { context, loading, refresh };
}
