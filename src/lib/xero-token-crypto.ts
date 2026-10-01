/**
 * The encryption of the `XeroToken` row (#2079), lifted out of
 * `xero-token-store.ts` by #3454.
 *
 * Since #3454 the authoritative copy of the tokens is encrypted by the
 * integration-credential store. This module is what still writes and reads the
 * `XeroToken` MIRROR, in exactly the `iv:authTag:ciphertext` format a deployed
 * older release decrypts, under the DB-backed, auto-generated, HKDF-wrapped Xero
 * token key. It goes when the mirror does (the contract issue after #3454).
 */

import { createCipheriv, createDecipheriv, randomBytes } from "crypto";
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
