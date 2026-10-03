/**
 * The encryption of the `XeroToken` row (#2079), lifted out of
 * `xero-token-store.ts` by #3454.
 *
 * Since #3454 the authoritative copy of the tokens is encrypted by the
 * integration-credential store. This module is what still writes and reads the
 * `XeroToken` MIRROR, in exactly the `iv:authTag:ciphertext` format a deployed
 * older release decrypts, under the DB-backed, auto-generated, HKDF-wrapped Xero
 * token key. It goes when the mirror does (the contract issue after #3454).
 *
 * It also holds the refresh's pre-flight (`assertXeroTokensCanBeStored`), which
 * proves BOTH encryptions a save needs will succeed before a refresh token is
 * spent.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "crypto";
import { requireStrongAuthSecretForCapture } from "@/lib/integration-crypto";
import { getOperationalXeroEncryptionKey } from "@/lib/xero-config";

const ENCRYPTION_ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;

/**
 * Thrown when a stored Xero OAuth token cannot be decrypted — the GCM tag fails
 * (the token was encrypted under a key the current auth secret no longer
 * derives) or the stored row is malformed. Both are unrecoverable and only an
 * admin RECONNECT fixes them, so this is a typed reconnect signal rather than an
 * opaque crypto error. It stays fail-closed (it still throws — never returns a
 * bogus token).
 *
 * `getXeroApiErrorInfo` and the connection probe's `classifyProbeError` map this
 * class (name-keyed, like XeroReconnectRequiredError) to the reconnect state, so
 * a token row left undecryptable by the env→DB upgrade (#2079) or an auth-secret
 * change surfaces the clean "reconnect Xero" prompt instead of an opaque 500.
 * Defined here (not extended from XeroReconnectRequiredError) to avoid a cycle
 * with xero-api-client, which imports this module.
 */
export class XeroTokenDecryptError extends Error {
  constructor(message = "Stored Xero token could not be decrypted") {
    super(message);
    this.name = "XeroTokenDecryptError";
  }
}

// The token-encryption key is the DB-backed, auto-generated, HKDF-wrapped Xero
// token key (#2079). `XERO_ENCRYPTION_KEY` no longer exists. Resolution is async
// (a cache-backed DB fetch); throws when the key cannot be resolved so callers
// surface a clean "reconnect Xero" rather than operate without encryption.
async function getEncryptionKey(): Promise<Buffer> {
  const key = await getOperationalXeroEncryptionKey();
  if (!key) {
    throw new Error(
      "Xero token encryption key is not available. Connect Xero from the admin panel (a strong AUTH_SECRET is required).",
    );
  }
  const buf = Buffer.from(key, "hex");
  if (buf.length !== 32) {
    throw new Error("Xero token encryption key must be a 64-character hex string (32 bytes)");
  }
  return buf;
}

// test seam
export async function encryptToken(plaintext: string): Promise<string> {
  const key = await getEncryptionKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ENCRYPTION_ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });
  let encrypted = cipher.update(plaintext, "utf8", "hex");
  encrypted += cipher.final("hex");
  const authTag = cipher.getAuthTag();
  // Format: iv:authTag:ciphertext
  return `${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted}`;
}

/**
 * Pure decrypt with an explicit key. Throws on a malformed row or a GCM tag
 * failure. Callers wrap this to attach the right typed error / policy.
 */
export function decryptWithKey(encrypted: string, key: Buffer): string {
  // `iv:authTag:ciphertext` and nothing else, said by the destructure rather
  // than by a length compared before three separate reads (#2800).
  const [ivHex, authTagHex, ciphertext, ...extraParts] = encrypted.split(":");
  if (
    ivHex === undefined ||
    authTagHex === undefined ||
    ciphertext === undefined ||
    extraParts.length > 0
  ) {
    throw new Error("Invalid encrypted token format");
  }
  const iv = Buffer.from(ivHex, "hex");
  const authTag = Buffer.from(authTagHex, "hex");
  if (authTag.length !== AUTH_TAG_LENGTH) {
    throw new Error("Invalid encrypted token authentication tag length");
  }
  const decipher = createDecipheriv(ENCRYPTION_ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });
  decipher.setAuthTag(authTag);
  let decrypted = decipher.update(ciphertext, "hex", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}

// test seam
export async function decryptToken(encrypted: string): Promise<string> {
  // Key resolution failures (key not yet available) keep their own error; only
  // an actual decrypt failure of an existing row is the reconnect signal.
  const key = await getEncryptionKey();
  try {
    return decryptWithKey(encrypted, key);
  } catch {
    // A GCM tag failure (key rotated) or a malformed row: unrecoverable, and
    // only a reconnect fixes it. Typed so the API/probe surfaces reconnect,
    // fail-closed (still throws — never returns a token).
    throw new XeroTokenDecryptError();
  }
}

/**
 * Thrown BEFORE a refresh token is spent, when the rotated pair could not then
 * be stored (#3454 review). Carries no value; the reason is a fixed sentence.
 */
export class XeroTokenSaveUnavailableError extends Error {
  constructor(reason: "auth-secret" | "token-key") {
    super(
      reason === "auth-secret"
        ? "The auth secret does not pass the strength check, so refreshed Xero tokens could not be stored; the refresh token was not spent."
        : "The Xero token encryption key is not available, so refreshed Xero tokens could not be stored; the refresh token was not spent.",
    );
    this.name = "XeroTokenSaveUnavailableError";
  }
}

/**
 * Prove the save of a refresh can succeed, BEFORE the refresh token is spent.
 *
 * Xero refresh tokens rotate: once spent, the old one is gone. The store copy
 * decrypts without the capture-time strength gate, but writing the rotated pair
 * needs both that gate (`encryptCredential`) and the wrapped token key (the
 * mirror). If either fails only AFTER Xero rotated the token, both copies keep a
 * spent token and the club must reconnect. A later release tightening the gate
 * would do exactly that to a grandfathered secret on its first refresh. So the
 * refresh path calls this first and refuses without spending anything. An audit
 * insert failing after the rotation remains possible; that is a stated limit.
 */
export async function assertXeroTokensCanBeStored(): Promise<void> {
  try {
    requireStrongAuthSecretForCapture();
  } catch {
    throw new XeroTokenSaveUnavailableError("auth-secret");
  }
  try {
    // Resolves the wrapped token key exactly as the save's mirror write will.
    await encryptToken("xero-token-save-preflight");
  } catch {
    throw new XeroTokenSaveUnavailableError("token-key");
  }
}
