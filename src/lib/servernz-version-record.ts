import "server-only";
import type { CredentialVersion } from "@/lib/integration-credential-actor";
import { invalidateProviderCredentialCache } from "@/lib/integration-credentials";
import { prisma } from "@/lib/prisma";
import {
  SERVERNZ_PROVIDER,
  readServerNzCredentialVersion,
} from "@/lib/servernz-config";
import {
  SERVERNZ_SETTINGS_ID,
  SERVERNZ_TRANSACTION_OPTIONS,
  lockServerNzSettings,
  recordServerVersionCheck,
  type ServerNzAnswerTx,
} from "@/lib/servernz-settings";

/**
 * Which connection a central-server request was sent on (#4366): the stored
 * base URL and the version token of the stored API key, both captured BEFORE
 * the request. Never the plaintext key. A key saved again with the same value
 * (A -> B -> A) still gets a new version, because every credential write
 * re-encrypts under a fresh IV.
 */
export interface ServerNzConnectionIdentity {
  /** `ServerNzSettings.baseUrl` exactly as stored when the request was built. */
  baseUrl: string;
  /** `credentialVersionOf` the API-key row the request's bearer token came from. */
  credentialVersion: CredentialVersion;
}

/**
 * THE CONNECTION FENCE for writing a central-server ANSWER (#4366, #4436;
 * the Other lodges download since the #4262 review): run `work` in one short
 * transaction that first takes the settings row lock (`lockServerNzSettings`)
 * and re-reads the stored address and API-key credential version under it,
 * and runs `work` only while both are still the ones `identity` captured
 * before the request. Otherwise nothing is written and `{ current: false }`
 * comes back.
 *
 * Connection replacements (#4436) take the same lock before reading or
 * writing the address/key and reset the old answers in that transaction. A
 * fenced write therefore either commits before the replacement takes the
 * lock, or waits for the replacement and refuses the old identity: an answer
 * from a connection replaced while its request was in flight never lands.
 * Order: settings row, then the credential read, then whatever `work` writes.
 *
 * A refused write also drops this process's cached ServerNZ credential: the
 * key the request was sent with may be a cached copy a write elsewhere has
 * replaced, and the next request should resolve - and check - the stored one
 * rather than repeat the stale key for the rest of the cache window.
 *
 * No HTTP happens here: the caller has already received the answer, and the
 * transaction holds no provider call (`INV-INT-027`). A database failure
 * propagates, so a RECEIVED answer is never mistaken for a refused one.
 */
async function withCurrentServerNzConnection<T>(
  identity: ServerNzConnectionIdentity,
  work: (tx: ServerNzAnswerTx) => Promise<T>,
): Promise<{ current: true; value: T } | { current: false }> {
  const outcome = await prisma.$transaction(
    async (tx): Promise<{ current: true; value: T } | { current: false }> => {
      await lockServerNzSettings(tx);
      const settings = await tx.serverNzSettings.findUnique({
        where: { id: SERVERNZ_SETTINGS_ID },
        select: { baseUrl: true },
      });
      const credentialVersion = await readServerNzCredentialVersion(tx);
      if (
        settings?.baseUrl !== identity.baseUrl ||
        credentialVersion !== identity.credentialVersion
      ) {
        return { current: false };
      }
      // THE ONE place a `ServerNzAnswerTx` is minted (#4470): the cast follows
      // the lock and the identity check, so the answer recorders that require
      // the type run only for a connection that is still the stored one.
      return { current: true, value: await work(tx as ServerNzAnswerTx) };
    },
    // Allow a bounded wait behind another fenced write holding the settings row.
    SERVERNZ_TRANSACTION_OPTIONS,
  );
  if (!outcome.current) invalidateProviderCredentialCache(SERVERNZ_PROVIDER);
  return outcome;
}

/** A fenced write was refused: the connection its answer came from was replaced. */
export class ServerNzConnectionChangedError extends Error {
  constructor() {
    super("The Alpine Central Server connection changed while its answer was being written; nothing more from it was written.");
    this.name = "ServerNzConnectionChangedError";
  }
}

/**
 * Run one transaction of writes for an answer from `identity`. The same fence
 * as `withCurrentServerNzConnection`, for a caller that writes many times: a
 * refusal THROWS `ServerNzConnectionChangedError`, having written nothing, so
 * the caller stops at its first stale write.
 */
export type ServerNzAnswerWrite = <T>(
  work: (tx: ServerNzAnswerTx) => Promise<T>,
) => Promise<T>;

export function serverNzAnswerWriter(identity: ServerNzConnectionIdentity): ServerNzAnswerWrite {
  return async (work) => {
    const outcome = await withCurrentServerNzConnection(identity, work);
    if (!outcome.current) throw new ServerNzConnectionChangedError();
    return outcome.value;
  };
}

/**
 * THE ONE WRITE OF THE VERSION COLUMN (#49, #4366): record `version` only if
 * the connection that produced it is STILL the stored one, and say whether it
 * did, through the connection fence above.
 */
export async function recordServerVersionIfCurrent(
  identity: ServerNzConnectionIdentity,
  version: string,
): Promise<boolean> {
  const outcome = await withCurrentServerNzConnection(identity, (tx) =>
    recordServerVersionCheck(version, new Date(), tx),
  );
  return outcome.current;
}
