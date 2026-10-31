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
import { normalizeBaseUrl } from "@/lib/servernz-base-url";
import {
  SERVERNZ_ADDRESS_CHANGED_CODE,
  SERVERNZ_ADDRESS_CHANGED_MESSAGE,
} from "@/lib/servernz-api-version";
import {
  readIntegrationCredentialRow,
  setIntegrationCredentialInTransaction,
  deleteIntegrationCredentialInTransaction,
  withCredentialTransaction,
  type SetCredentialResult,
} from "@/lib/integration-credentials";
import type {
  CredentialActor,
  CredentialRequestContext,
  CredentialVersion,
} from "@/lib/integration-credential-actor";
import {
  forgetServerConnectionAnswers,
  loadServerNzSettings,
  lockServerNzSettings,
  updateServerNzSettings,
  SERVERNZ_SETTINGS_ID,
  SERVERNZ_TRANSACTION_OPTIONS,
  type ServerNzConnectionTx,
  type ServerNzSettingsValues,
} from "@/lib/servernz-settings";

export const SERVERNZ_PROVIDER = "servernz";

export const SERVERNZ_CREDENTIAL_KEYS = {
  apiKey: "api_key",
  /**
   * The push-verification secret the server issued when this install
   * registered its push target (`ensurePushRegistration`,
   * `club-post-mirror.ts`). System-written, never admin-writable: it belongs to
   * the server it was registered with, so an address move removes it (#4470).
   */
  pushSecret: "push_secret",
} as const;

/**
 * The write-capturable ServerNZ credential keys (setup form + API allowlist).
 * Typed as exactly the API key (#4436): the credentials route saves that key
 * through `setServerNzApiKey`'s connection fence, so a second writable key
 * must first decide its own route there, and this type makes adding one a
 * deliberate edit rather than a one-line append.
 */
export const SERVERNZ_WRITABLE_CREDENTIAL_KEYS: readonly [
  typeof SERVERNZ_CREDENTIAL_KEYS.apiKey,
] = [SERVERNZ_CREDENTIAL_KEYS.apiKey];

/**
 * The operational ServerNZ API key together with the version token of the row
 * it was decrypted from (#4366), or `undefined` when unconfigured or unreadable.
 * The caller supplies its fenced transaction client; this read bypasses the
 * provider cache. Both come from ONE stored row, so the version names exactly the
 * key a request is sent with, even when this process's cached copy is behind a
 * write made elsewhere. The version is the connection's durable identity: every
 * write re-encrypts under a fresh IV, so it moves even when the same key value
 * is saved again (A -> B -> A), and the version recorder compares it under the
 * settings-row lock (`servernz-version-record.ts`).
 */
export async function getOperationalServerNzCredential(
  db: Pick<Prisma.TransactionClient, "integrationCredential">,
): Promise<
  { apiKey: string; version: CredentialVersion } | undefined
> {
  const resolution = await readIntegrationCredentialRow(
    db, SERVERNZ_PROVIDER, SERVERNZ_CREDENTIAL_KEYS.apiKey,
  );
  return resolution.status === "configured"
    ? { apiKey: resolution.value, version: resolution.version }
    : undefined;
}

/**
 * The stored API key's version token read through `db`, or `null` when no key
 * is stored. Uncached, so it can run under the caller's
 * lock as the re-read half of a compare-and-record (#4366).
 */
export async function readServerNzCredentialVersion(
  db: Pick<Prisma.TransactionClient, "integrationCredential">,
): Promise<CredentialVersion | null> {
  const resolution = await readIntegrationCredentialRow(
    db,
    SERVERNZ_PROVIDER,
    SERVERNZ_CREDENTIAL_KEYS.apiKey,
  );
  return resolution.status === "not_configured" ? null : resolution.version;
}

/**
 * A key save refused because the server address changed after the setup page
 * showed it (#4470): the key may have been issued by the old server, and saving
 * it against the new address would send it there on the next request. Nothing
 * was written. The message is safe to show an administrator.
 */
export class ServerNzAddressChangedError extends Error {
  /** The machine code the credentials route's 409 carries for the setup page. */
  readonly code = SERVERNZ_ADDRESS_CHANGED_CODE;
  constructor() {
    super(SERVERNZ_ADDRESS_CHANGED_MESSAGE);
    this.name = "ServerNzAddressChangedError";
  }
}

/**
 * Store (or replace) the ServerNZ API key. Encrypted at rest. The one
 * definition of key replacement (#4436): the credentials route calls it. The
 * new key and the reset of the previous connection's answers commit together
 * under the connection fence, so no request pairs the new key with the old
 * connection's owned-lodge list or API version, and the push secret registered
 * with the old key is removed with them (#4470).
 *
 * `expectedBaseUrl` is the server address the setup form showed beside the key
 * field (`null` when it showed none), and it is REQUIRED (#4470). A key is
 * issued by one server, so it is saved only while that address is still the
 * stored one, compared under the same settings-row lock an address move takes:
 * a move that committed first refuses the save with
 * `ServerNzAddressChangedError`, writing nothing, and a move that comes later
 * removes the key with the address it was saved for.
 *
 * The actor is the caller's to supply and is REQUIRED (#2723) — this used to
 * take an optional `updatedByUserId`, which let an admin action reach the store
 * attributed to nobody. `request` keeps the audit row's id, IP and user agent.
 */
export async function setServerNzApiKey(
  value: string,
  expectedBaseUrl: string | null,
  actor: CredentialActor,
  request?: CredentialRequestContext,
): Promise<SetCredentialResult> {
  return withServerNzConnectionTransaction(async (tx) => {
    const stored = await tx.serverNzSettings.findUnique({
      where: { id: SERVERNZ_SETTINGS_ID },
      select: { baseUrl: true },
    });
    // Both sides through the one normaliser: the stored value already went
    // through it on the way in, and a blank address the page showed is `null`.
    if ((stored?.baseUrl ?? null) !== normalizeBaseUrl(expectedBaseUrl)) {
      throw new ServerNzAddressChangedError();
    }
    const saved = await setIntegrationCredentialInTransaction({
      tx,
      provider: SERVERNZ_PROVIDER,
      key: SERVERNZ_CREDENTIAL_KEYS.apiKey,
      value,
      actor,
      // The admin form posts the key it wants stored outright; there is no
      // read-modify-write here to be stale against. The address check above is
      // what ties the key to the server it was issued for.
      expect: { expect: "any" },
      request,
    });
    // The push registration was made with the replaced key (#4470): a key
    // rotated because it may have leaked rotates its push secret too, and the
    // next sync registers again with the new key.
    await clearServerNzPushSecret(actor, tx, request);
    await forgetServerConnectionAnswers(tx);
    return saved;
  });
}

/**
 * Remove the stored ServerNZ API key. Its caller is the address move in
 * `saveServerNzConnectionSettings`. The owned-lodge list the server issued for
 * that key goes with it (#52): it was THAT connection's answer, and a key
 * issued later, or by a different server, may own different lodges. The panel
 * is read-only until the next download records a fresh list. The server's last
 * reported API version goes for the same reason (#49): it was that server's
 * answer. Both in ONE write.
 *
 * `tx` is a `withServerNzConnectionTransaction` client, by type (#4436): a
 * removal outside the fence could let a request pair a moved address with the
 * key being removed.
 */
export async function clearServerNzApiKey(
  actor: CredentialActor,
  tx: ServerNzConnectionTx,
): Promise<void> {
  await deleteIntegrationCredentialInTransaction({
    tx,
    provider: SERVERNZ_PROVIDER,
    key: SERVERNZ_CREDENTIAL_KEYS.apiKey,
    actor,
    expect: { expect: "any" },
  });
  await forgetServerConnectionAnswers(tx);
}

/**
 * Remove the push-verification secret the old connection registered (#4470).
 * Its callers are the address move (`saveServerNzConnectionSettings`) and the
 * key replacement (`setServerNzApiKey`), each in its own fenced transaction:
 * with the secret gone, pushes signed with it stop verifying (in another
 * process, once its credential cache, at most 45 seconds, expires), and the
 * next sync pass's `ensurePushRegistration` registers this install with the
 * connection now stored. A system-written row, so there is no version an
 * administrator saw to expect: the intended end state is "gone".
 */
export async function clearServerNzPushSecret(
  actor: CredentialActor,
  tx: ServerNzConnectionTx,
  request?: CredentialRequestContext,
): Promise<void> {
  await deleteIntegrationCredentialInTransaction({
    tx,
    provider: SERVERNZ_PROVIDER,
    key: SERVERNZ_CREDENTIAL_KEYS.pushSecret,
    actor,
    expect: { expect: "any" },
    request,
  });
}

/**
 * Save the non-secret connection settings, moving the server address and its
 * key as ONE unit (#4436). The address is where requests send the key, so a
 * changed address removes the stored key and forgets the old server's answers
 * (its owned list, version and every sync cursor) in the same fenced
 * transaction: no request can read the new address with the old key. The old
 * server's push secret goes in that transaction too (#4470), so the next sync
 * registers with the new server. An unchanged address (or a flag-only save)
 * keeps all of them. The caller
 * has already checked who may move the address and validated it; no HTTP and
 * no audit row here — the settings route audits after commit.
 *
 * The actor is the caller's to supply and is REQUIRED (#2723), like every
 * credential wrapper's: this helper forwards it to the key removal and records
 * its member as the settings row's editor. Only an administrator moves the
 * address, so the type admits the admin actor alone.
 */
export async function saveServerNzConnectionSettings(
  input: { baseUrl?: string | null; otherLodgesEnabled?: boolean },
  actor: Extract<CredentialActor, { kind: "admin" }>,
): Promise<{ settings: ServerNzSettingsValues; apiKeyCleared: boolean }> {
  return withServerNzConnectionTransaction(async (tx) => {
    const before = await loadServerNzSettings(tx);
    const settings = await updateServerNzSettings({
      baseUrl: input.baseUrl,
      otherLodgesEnabled: input.otherLodgesEnabled,
      updatedByMemberId: actor.memberId,
    }, tx);
    // A destination and its credential must never become visible separately.
    const apiKeyCleared = input.baseUrl !== undefined && before.baseUrl !== settings.baseUrl;
    if (apiKeyCleared) {
      await clearServerNzApiKey(actor, tx);
      await clearServerNzPushSecret(actor, tx);
    }
    return { settings, apiKeyCleared };
  });
}

/**
 * One fence for connection reads and replacements (#4436). Settings first,
 * credentials second; no HTTP in work. Materialise a fresh-install singleton
 * before locking it, so a missing row cannot leave concurrent setup unfenced.
 * Credential caches are invalidated after commit/rollback by the store.
 *
 * The ONE place a `ServerNzConnectionTx` is minted: the cast below follows the
 * lock, so the writers that require that type run only inside this fence.
 */
export async function withServerNzConnectionTransaction<T>(
  work: (tx: ServerNzConnectionTx) => Promise<T>,
): Promise<T> {
  return withCredentialTransaction([SERVERNZ_PROVIDER], async (tx) => {
    await tx.serverNzSettings.createMany({
      data: [{ id: SERVERNZ_SETTINGS_ID }],
      skipDuplicates: true,
    });
    await lockServerNzSettings(tx);
    return work(tx as ServerNzConnectionTx);
  }, SERVERNZ_TRANSACTION_OPTIONS);
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
  const apiKeyUpdatedAt = await readServerNzApiKeyUpdatedAt();
  return { apiKeySet: apiKeyUpdatedAt !== null, apiKeyUpdatedAt };
}

/**
 * When the stored API key was last written, or `null` when there is none:
 * setup-page metadata only, never the key, and never a connection's identity.
 * Whether an answer still belongs to the stored connection is decided by the
 * credential VERSION under the settings lock (`withCurrentServerNzConnection`
 * and `serverNzAnswerWriter` in `servernz-version-record.ts`, #4262 review).
 */
async function readServerNzApiKeyUpdatedAt(): Promise<string | null> {
  const row = await prisma.integrationCredential.findFirst({
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
