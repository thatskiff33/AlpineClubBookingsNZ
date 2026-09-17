/**
 * Alpine Central Server (ServerNZ) connection configuration.
 *
 * The ServerNZ API key is a secret and lives ONLY in the encrypted
 * IntegrationCredential store (same mechanism as Stripe/Xero/Google, #2079).
 * The non-secret connection settings (base URL, per-shared-item enabled flags,
 * last-sync timestamps) live in the `ServerNzSettings` singleton — see
 * `servernz-settings.ts`.
 *
 * Exposure contract: THIS CODE never returns the API key to a client, logs it, or
 * writes it to an audit row. Status surfaces read metadata only
 * (`getServerNzSetupState`), and no `servernz-*` module is imported by any client
 * component, so the value cannot reach the browser.
 *
 * The one path that is not ours to guarantee, stated rather than implied: a
 * central server could echo the bearer token back inside its own error text, and
 * `servernz-sync-response.ts` writes that text into an audit row. Nothing here
 * can stop a remote saying it. What is bounded is the blast radius —
 * `readError()` caps that text at 200 characters and strips control characters
 * before it travels, and `sanitizeAuditDetails` runs over it afterwards. So the
 * claim above is about what this code does, not a promise about the remote.
 */

import { prisma } from "@/lib/prisma";
import {
  getIntegrationCredentialValue,
  setIntegrationCredential,
  deleteIntegrationCredential,
} from "@/lib/integration-credentials";
import type { CredentialActor } from "@/lib/integration-credential-actor";

export const SERVERNZ_PROVIDER = "servernz";

export const SERVERNZ_CREDENTIAL_KEYS = {
  apiKey: "api_key",
} as const;

/** The write-capturable ServerNZ credential keys (setup form + API allowlist). */
export const SERVERNZ_WRITABLE_CREDENTIAL_KEYS = [
  SERVERNZ_CREDENTIAL_KEYS.apiKey,
] as const;

/** The operational ServerNZ API key, or `undefined` when unconfigured. */
export async function getOperationalServerNzApiKey(): Promise<
  string | undefined
> {
  return (
    (await getIntegrationCredentialValue(
      SERVERNZ_PROVIDER,
      SERVERNZ_CREDENTIAL_KEYS.apiKey,
    )) ?? undefined
  );
}

/**
 * Store (or replace) the ServerNZ API key. Encrypted at rest.
 *
 * The actor is the caller's to supply and is REQUIRED (#2723) — this used to
 * take an optional `updatedByUserId`, which let an admin action reach the store
 * attributed to nobody.
 */
export async function setServerNzApiKey(
  value: string,
  actor: CredentialActor,
): Promise<void> {
  await setIntegrationCredential({
    provider: SERVERNZ_PROVIDER,
    key: SERVERNZ_CREDENTIAL_KEYS.apiKey,
    value,
    actor,
    // The admin form posts the key it wants stored outright; there is no
    // read-modify-write here to be stale against.
    expect: { expect: "any" },
  });
}

/** Remove the stored ServerNZ API key (disconnect). */
export async function clearServerNzApiKey(
  actor: CredentialActor,
): Promise<void> {
  await deleteIntegrationCredential({
    provider: SERVERNZ_PROVIDER,
    key: SERVERNZ_CREDENTIAL_KEYS.apiKey,
    actor,
    expect: { expect: "any" },
  });
}

export interface ServerNzSetupState {
  apiKeySet: boolean;
  apiKeyUpdatedAt: string | null;
}

/**
 * Metadata-only setup state for the setup page and module readiness. NEVER
 * returns the key value. A DB error propagates to the caller.
 */
export async function getServerNzSetupState(): Promise<ServerNzSetupState> {
  const row = await prisma.integrationCredential.findFirst({
    where: {
      provider: SERVERNZ_PROVIDER,
      key: SERVERNZ_CREDENTIAL_KEYS.apiKey,
    },
    select: { updatedAt: true },
  });
  return {
    apiKeySet: Boolean(row),
    apiKeyUpdatedAt: row ? row.updatedAt.toISOString() : null,
  };
}

/** True when a ServerNZ API key is configured (readiness helper, fail-closed). */
export async function isServerNzConfigured(): Promise<boolean> {
  try {
    const state = await getServerNzSetupState();
    return state.apiKeySet;
  } catch {
    return false;
  }
}
