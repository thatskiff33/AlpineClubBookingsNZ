/**
 * Operational Google sign-in configuration — DB-only resolution (#2087, Lane E).
 *
 * The per-club Google OAuth client id + secret live ONLY in the encrypted
 * IntegrationCredential store (C1, #2079). The legacy `GOOGLE_CLIENT_ID` /
 * `GOOGLE_CLIENT_SECRET` env vars are no longer read for operation — they are
 * detected and flagged for removal (see `detectLegacyProviderEnv` in
 * xero-config.ts). Resolution is async (a DB fetch, cache-backed by
 * integration-credentials.ts).
 *
 * FAIL-OPEN (epic decision 7, binding): the request-scoped NextAuth config is
 * shared by EVERY sign-in method, so `getGoogleOAuthConfig()` must NEVER throw.
 * Any resolver error — DB outage, a GCM decrypt failure after an auth-secret
 * rotation — degrades to "unconfigured" (returns `null`, logged loudly). The
 * Google provider is then simply omitted; credentials/magic-link/2FA sign-in are
 * untouched.
 *
 * Exposure contract (#2079): the client secret is NEVER returned to a client,
 * logged, or put in an audit row. Setup surfaces read metadata-only state.
 */

import { prisma } from "@/lib/prisma";
import logger from "@/lib/logger";
import {
  deleteIntegrationCredential,
  getIntegrationCredentialValue,
  providerNeedsReentry,
  setIntegrationCredential,
} from "@/lib/integration-credentials";
import type {
  CredentialActor,
  CredentialRequestContext,
} from "@/lib/integration-credential-actor";

export const GOOGLE_PROVIDER = "google";

export const GOOGLE_CREDENTIAL_KEYS = {
  clientId: "client_id",
  clientSecret: "client_secret",
} as const;

/** The two write-capturable Google credential keys (wizard + API allowlist). */
export const GOOGLE_WRITABLE_CREDENTIAL_KEYS = [
  GOOGLE_CREDENTIAL_KEYS.clientId,
  GOOGLE_CREDENTIAL_KEYS.clientSecret,
] as const;

/**
 * Non-secret marker key recording that a real Google OAuth round-trip verified
 * the stored credentials (Google accepted the client id AND secret and redirected
 * back through the production callback). Stored in the same encrypted store (its
 * value is an ISO timestamp — not secret) so verify-reset and the needs-reentry
 * aggregate treat it uniformly. It is NEVER in the credential write allowlist —
 * only the verify callback writes it, and it is dropped by verify-reset whenever
 * either Google credential changes (epic decision 6 — the module re-locks).
 */
export const GOOGLE_VERIFIED_KEY = "verified_at";

export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
}

/**
 * Resolve the operational Google OAuth client id + secret, or `null` when Google
 * sign-in is unconfigured OR the resolver cannot complete. FAIL-OPEN: this
 * catches every error (a DB outage or a post-rotation decrypt failure) and
 * degrades to `null` so the shared request-scoped auth config never throws.
 * Both values must be present for a usable config.
 */
export async function getGoogleOAuthConfig(): Promise<GoogleOAuthConfig | null> {
  try {
    const [clientId, clientSecret] = await Promise.all([
      getIntegrationCredentialValue(
        GOOGLE_PROVIDER,
        GOOGLE_CREDENTIAL_KEYS.clientId,
      ),
      getIntegrationCredentialValue(
        GOOGLE_PROVIDER,
        GOOGLE_CREDENTIAL_KEYS.clientSecret,
      ),
    ]);
    if (!clientId || !clientSecret) return null;
    return { clientId, clientSecret };
  } catch (err) {
    // Fail-open: a DB/decrypt failure degrades Google to "unconfigured" and is
    // logged loudly. It must never take down the shared sign-in config.
    logger.error(
      { err: err instanceof Error ? err.name : "unknown" },
      "Google OAuth credential resolution failed — treating Google as unconfigured (fail-open)",
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// Verified marker (records a real OAuth round-trip; verify-reset on write)
// ---------------------------------------------------------------------------

/**
 * Record that a real Google OAuth round-trip verified the stored credentials.
 * Best-effort: a weak auth secret (WeakAuthSecretError) or any store error must
 * NEVER break the verify redirect, so this swallows failures (the marker simply
 * stays unset and the operator retries). Freshness is guaranteed by the marker's
 * own `updatedAt` (compared against the credentials' `updatedAt` in
 * `getGoogleSetupState`) plus the verify-reset that drops the marker on any
 * credential write.
 */
export async function recordGoogleVerified(
  when: Date = new Date(),
): Promise<void> {
  try {
    await setIntegrationCredential({
      provider: GOOGLE_PROVIDER,
      key: GOOGLE_VERIFIED_KEY,
      value: when.toISOString(),
      actor: { kind: "system", actor: "google-verify-callback" },
      // The marker's whole purpose is to record the LATEST successful
      // round-trip, and this is its only writer, so there is nothing to be
      // stale against (#2723).
      expect: { expect: "any" },
    });
  } catch {
    // Never let marker persistence affect the verify round-trip response.
  }
}

/**
 * Drop the verified marker (verify-reset on any Google credential write).
 *
 * THE ACTOR IS THE CALLER'S, and required (#2723). This used to name a
 * `google-verify-reset` system actor, which was wrong about who did it: the one
 * caller is the admin credential-write route, which holds the acting member and
 * has already attributed the credential write itself to them. Hard-coding a
 * system actor here turned one administrator's action into two audit rows, one
 * naming the person and one naming a job with no member and no request context.
 */
export async function clearGoogleVerified(
  actor: CredentialActor,
  request?: CredentialRequestContext,
): Promise<void> {
  await deleteIntegrationCredential({
    provider: GOOGLE_PROVIDER,
    key: GOOGLE_VERIFIED_KEY,
    actor,
    // Verify-reset drops whatever marker is there; a concurrent re-verify that
    // re-stamped it should also be dropped, because the credential it attested
    // to has just changed.
    expect: { expect: "any" },
    request,
  });
}

export interface GoogleSetupState {
  /** Client id stored (metadata only — never the value). */
  clientIdSet: boolean;
  /** Client secret stored. */
  clientSecretSet: boolean;
  /** Any stored Google credential fails to decrypt (the auth secret changed). */
  needsReentry: boolean;
  /**
   * A real OAuth round-trip verified AND the marker is fresh — i.e. it was
   * recorded at or after both credentials were last written. Replacing a
   * credential makes it newer than the marker, so verified drops even before
   * verify-reset physically removes the marker (belt-and-suspenders).
   */
  verified: boolean;
}

/**
 * Metadata-only Google setup state for the wizard/status surfaces, the module
 * enable-gate, and readiness. NEVER returns any credential value. A DB error
 * propagates to the caller (which decides how to degrade). The verified-freshness
 * rule is applied here so every surface agrees.
 */
export async function getGoogleSetupState(): Promise<GoogleSetupState> {
  const rows = await prisma.integrationCredential.findMany({
    where: {
      provider: GOOGLE_PROVIDER,
      key: {
        in: [
          GOOGLE_CREDENTIAL_KEYS.clientId,
          GOOGLE_CREDENTIAL_KEYS.clientSecret,
          GOOGLE_VERIFIED_KEY,
        ],
      },
    },
    select: { key: true, updatedAt: true },
  });
  const byKey = new Map(rows.map((row) => [row.key, row.updatedAt]));

  const clientIdAt = byKey.get(GOOGLE_CREDENTIAL_KEYS.clientId);
  const clientSecretAt = byKey.get(GOOGLE_CREDENTIAL_KEYS.clientSecret);
  const verifiedAt = byKey.get(GOOGLE_VERIFIED_KEY);
  // Verified only counts when BOTH credentials are stored and the marker is at
  // least as new as the newer credential write.
  const newestCredentialAt =
    clientIdAt && clientSecretAt
      ? Math.max(clientIdAt.getTime(), clientSecretAt.getTime())
      : null;
  const verified = Boolean(
    verifiedAt &&
      newestCredentialAt !== null &&
      verifiedAt.getTime() >= newestCredentialAt,
  );

  return {
    clientIdSet: byKey.has(GOOGLE_CREDENTIAL_KEYS.clientId),
    clientSecretSet: byKey.has(GOOGLE_CREDENTIAL_KEYS.clientSecret),
    needsReentry: await providerNeedsReentry(GOOGLE_PROVIDER),
    verified,
  };
}
