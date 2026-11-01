/**
 * The Xero token store's typed failures and the refresh pre-flight (#3454, #3806).
 *
 * Until #3806 R2 this lived in `xero-token-crypto.ts` beside the encryption of
 * the `XeroToken` row. R2 stopped writing and reading that ciphertext, so the
 * encryption and the wrapped token key it needed are gone; what is left is the
 * part every caller still relies on.
 */

import { requireCredentialCaptureKey } from "@/lib/integration-crypto";

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
 * Thrown BEFORE a refresh token is spent, when the rotated pair could not then
 * be stored (#3454 review). Carries no value; the reason is a fixed sentence.
 */
export class XeroTokenSaveUnavailableError extends Error {
  constructor() {
    super(
      "The auth secret does not pass the strength check, so refreshed Xero tokens could not be stored; the refresh token was not spent.",
    );
    this.name = "XeroTokenSaveUnavailableError";
  }
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
  try {
    requireCredentialCaptureKey();
  } catch {
    throw new XeroTokenSaveUnavailableError();
  }
}
