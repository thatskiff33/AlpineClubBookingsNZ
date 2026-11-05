/**
 * The Xero token store's typed failures and the refresh pre-flight (#3454, #3806).
 *
 * Until #3806 R2 this lived in `xero-token-crypto.ts` beside the encryption of
 * the `XeroToken` row. R2 stopped writing and reading that ciphertext, so the
 * encryption and the wrapped token key it needed are gone; what is left is the
 * part every caller still relies on.
 */

import { readDataKeyRing } from "@/lib/data-encryption-keys";
import {
  DataKeyRingMissingError,
  assertLegacyWriteAllowed,
} from "@/lib/data-encryption-legacy-write-guard";
import { WeakAuthSecretError, requireCredentialCaptureKey } from "@/lib/integration-crypto";
import { prisma } from "@/lib/prisma";

/**
 * Thrown when the stored Xero tokens cannot be used: the credential-store copy
 * fails to decrypt (the auth secret it was written under changed), is malformed,
 * or is missing while a connection row exists. Every one of those is
 * unrecoverable and only an admin RECONNECT fixes it, so this is a typed
 * reconnect signal rather than an opaque crypto error. It stays fail-closed (it
 * throws — it never returns a bogus token).
 *
 * `getXeroApiErrorInfo` and the connection probe's `classifyProbeError` map this
 * class (name-keyed, like XeroReconnectRequiredError) to the reconnect state.
 * Defined here (not extended from XeroReconnectRequiredError) to avoid a cycle
 * with xero-api-client, which imports the token store.
 */
export class XeroTokenDecryptError extends Error {
  constructor(message = "Stored Xero token could not be decrypted") {
    super(message);
    this.name = "XeroTokenDecryptError";
  }
}

/**
 * Why a refreshed token pair could not be stored right now (#4456 review):
 *   - `auth-secret-weak`: no ring is set and the auth secret fails the strength
 *     check, so capture refuses it;
 *   - `data-key-ring-invalid`: `DATA_ENCRYPTION_KEYS` is set but cannot be used;
 *   - `data-key-ring-missing`: no ring is set, but stored data names a ring key
 *     (`data-encryption-legacy-write-guard.ts`).
 * None is fixed by a Xero reconnect: each needs the server's configuration.
 */
export type XeroTokenSaveRefusal =
  | "auth-secret-weak"
  | "data-key-ring-invalid"
  | "data-key-ring-missing";

/**
 * Thrown BEFORE a refresh token is spent, when the rotated pair could not then
 * be stored (#3454 review). Carries the refusal's reason and its plain-English
 * message, which never holds a secret.
 */
export class XeroTokenSaveUnavailableError extends Error {
  readonly reason: XeroTokenSaveRefusal;
  constructor(refusal: { reason: XeroTokenSaveRefusal; message: string }) {
    super(
      `${refusal.message} Refreshed Xero tokens could not be stored, so the refresh token was not spent.`,
    );
    this.name = "XeroTokenSaveUnavailableError";
    this.reason = refusal.reason;
  }
}

/**
 * Could a refreshed token pair be stored right now? Null when it could, else
 * why not. The ONE predicate behind both the refresh pre-flight below and the
 * admin connection status (`getXeroConnectionStatus`), so "Connected" never sits
 * over tokens no refresh could store (#4456 review). Asks exactly what the
 * credential store's write asks: the capture key, then, for a write that would
 * fall back to the auth secret, whether stored data already names a ring key.
 * A database error propagates as itself: it is not a verdict on any key.
 */
export async function xeroTokenSaveRefusal(): Promise<{
  reason: XeroTokenSaveRefusal;
  message: string;
} | null> {
  let legacy: boolean;
  try {
    legacy = requireCredentialCaptureKey().key.legacy;
  } catch (error) {
    if (!(error instanceof WeakAuthSecretError)) throw error;
    return {
      reason: readDataKeyRing().status === "invalid" ? "data-key-ring-invalid" : "auth-secret-weak",
      message: error.message,
    };
  }
  if (!legacy) return null;
  try {
    await assertLegacyWriteAllowed(prisma);
  } catch (error) {
    if (error instanceof DataKeyRingMissingError) {
      return { reason: "data-key-ring-missing", message: error.message };
    }
    throw error;
  }
  return null;
}

/**
 * Prove the save of a refresh can succeed, BEFORE the refresh token is spent.
 *
 * Xero refresh tokens rotate: once spent, the old one is gone. The store copy
 * decrypts without the capture-time strength gate, but writing the rotated pair
 * needs it (`encryptCredential`). If the gate failed only AFTER Xero rotated the
 * token, the store would keep a spent token and the club must reconnect. A later
 * release tightening the gate would do exactly that to a grandfathered secret on
 * its first refresh. So the refresh path calls this first and refuses without
 * spending anything. An audit insert failing after the rotation remains
 * possible; that is a stated limit.
 */
export async function assertXeroTokensCanBeStored(): Promise<void> {
  const refusal = await xeroTokenSaveRefusal();
  if (refusal) throw new XeroTokenSaveUnavailableError(refusal);
}
