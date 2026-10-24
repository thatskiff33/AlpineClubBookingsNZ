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

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  getIntegrationCredentialValue,
  setIntegrationCredentialInTransaction,
  deleteIntegrationCredentialInTransaction,
  withCredentialTransaction,
  type SetCredentialResult,
} from "@/lib/integration-credentials";
import type { CredentialActor, CredentialRequestContext } from "@/lib/integration-credential-actor";
import { forgetServerConnectionAnswers, lockServerNzSettings, loadServerNzSettings, updateServerNzSettings, normalizeBaseUrl, SERVERNZ_SETTINGS_ID } from "@/lib/servernz-settings";

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

/** Connection replacement and its forgotten answers share the download's row lock. */
async function withServerNzConnectionChange<T>(
  work: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return withCredentialTransaction([SERVERNZ_PROVIDER], async (tx) => {
    await lockServerNzSettings(tx);
    const result = await work(tx);
    await forgetServerConnectionAnswers(tx);
    return result;
  });
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
  request?: CredentialRequestContext,
): Promise<SetCredentialResult> {
  return withServerNzConnectionChange((tx) => setIntegrationCredentialInTransaction({
    tx, provider: SERVERNZ_PROVIDER, key: SERVERNZ_CREDENTIAL_KEYS.apiKey,
    value, actor, expect: { expect: "any" }, request,
  }));
}

/**
 * Remove the stored ServerNZ API key (disconnect). The owned-lodge list the
 * server issued for that key goes with it (#52): it was THAT connection's
 * answer, and a key issued later — or by a different server, which is the other
 * caller here — may own different lodges. The panel is read-only until the next
 * download records a fresh list. The server's last reported API version goes
 * for the same reason (#49): it was that server's answer. Both in ONE write.
 */
export async function clearServerNzApiKey(
  actor: CredentialActor,
): Promise<void> {
  await withServerNzConnectionChange((tx) => deleteIntegrationCredentialInTransaction({
    tx, provider: SERVERNZ_PROVIDER,
    key: SERVERNZ_CREDENTIAL_KEYS.apiKey,
    actor,
    expect: { expect: "any" },
  }));
}

/** Address change, credential deletion and answer reset are one fenced commit. */
export async function updateServerNzConnectionSettings(input: Parameters<typeof updateServerNzSettings>[0]) {
  return withCredentialTransaction([SERVERNZ_PROVIDER], async (tx) => {
    await lockServerNzSettings(tx);
    const before = await tx.serverNzSettings.findUnique({ where: { id: SERVERNZ_SETTINGS_ID }, select: { baseUrl: true } });
    const moved = input.baseUrl !== undefined && (before?.baseUrl ?? null) !== normalizeBaseUrl(input.baseUrl);
    await updateServerNzSettings(input, tx);
    if (moved) {
      await deleteIntegrationCredentialInTransaction({
        tx, provider: SERVERNZ_PROVIDER, key: SERVERNZ_CREDENTIAL_KEYS.apiKey,
        actor: { kind: "admin", memberId: input.updatedByMemberId }, expect: { expect: "any" },
      });
      await forgetServerConnectionAnswers(tx);
    }
    return { settings: await loadServerNzSettings(tx), apiKeyCleared: moved };
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
  const apiKeyUpdatedAt = await readServerNzApiKeyStamp();
  return { apiKeySet: apiKeyUpdatedAt !== null, apiKeyUpdatedAt };
}

/** Setup metadata only; sync fencing uses the durable credential version instead. */
export async function readServerNzApiKeyStamp(
  db: Pick<Prisma.TransactionClient, "integrationCredential"> = prisma,
): Promise<string | null> {
  const row = await db.integrationCredential.findFirst({
    where: {
      provider: SERVERNZ_PROVIDER,
      key: SERVERNZ_CREDENTIAL_KEYS.apiKey,
    },
    select: { updatedAt: true },
  });
  return row ? row.updatedAt.toISOString() : null;
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
