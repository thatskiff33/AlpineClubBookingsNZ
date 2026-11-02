/**
 * Integration credential cryptography (guided provider setup — #2079).
 *
 * Encrypts provider credentials at rest with AES-256-GCM under a key derived
 * via HKDF-SHA256 from the current data-encryption key (#4456): a ring key from
 * `DATA_ENCRYPTION_KEYS`, or the app auth secret while no ring is set. This is
 * the crypto spine cited by every guided-setup lane.
 *
 * PRIOR ART / DELIBERATE DIVERGENCE:
 *   `src/lib/two-factor.ts` derives its key with plain SHA256(secret + label)
 *   — NOT HKDF (verified 21 Jul 2026; credit @hoppers99). We intentionally use
 *   real `crypto.hkdfSync` here. We reuse two-factor's GCM *storage format*
 *   (version:iv:authTag:ciphertext hex tuple) and its per-write random IV, and
 *   nothing else. The HKDF info-label namespace here
 *   (`integration-credential:v1`; `xero-token-key:v1` until #3806 R2) is disjoint from
 *   two-factor's SHA256 concat labels (`:two-factor-secret:v1`,
 *   `:two-factor-code:v1`), so the two schemes coexist with fully independent
 *   derived keys.
 *
 * KEY DERIVATION (pinned spec). Which key wraps a row is named ON the row, in
 * `secretSource` (#4456), and a read uses that key alone — never the others in
 * turn (`data-encryption-keys.ts` says why):
 *   - `AUTH_SECRET` / `NEXTAUTH_SECRET` (legacy rows, and every write while no
 *     `DATA_ENCRYPTION_KEYS` ring is set):
 *       key = HKDF(SHA-256, ikm = the auth secret, salt = HKDF_SALT,
 *                  info = <the row's label>, length = 32 bytes)
 *   - `DATA_ENCRYPTION_KEY:<id>` (every write once a ring is set):
 *       key = deriveDataSubkey(<ring key id>, <the row's label>), the label
 *             being `integration-credential:v2`.
 *
 * SALT CHOICE (documented per RFC 5869): the salt is a FIXED, NON-SECRET,
 * application-specific domain-separation constant, not empty. RFC 5869 permits
 * an empty salt, but a fixed constant salt is equally sound (the salt is not
 * required to be secret) and gives explicit domain separation from any other
 * future HKDF use of the same auth secret. Security rests on (a) the secrecy of
 * the auth-secret IKM and (b) the versioned, per-purpose `info` labels — which
 * are what keep each derived key independent. Rotating HKDF_SALT would make all
 * existing ciphertexts undecryptable, so it is versioned in lockstep with the
 * label versions and must never change silently.
 *
 * AAD CONTEXT BINDING: every encrypt passes `${provider}:${key}:${labelVersion}`
 * as GCM additional authenticated data, so a ciphertext is bound to its row and
 * cannot be swapped between rows by an attacker with DB write access.
 *
 * Derivation is synchronous (no I/O). Only the ciphertext *fetch* is async and
 * lives in src/lib/integration-credentials.ts.
 */

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "crypto";

import {
  DataKeyRingError,
  LEGACY_AUTH_SECRET_KEY_ID,
  deriveDataSubkey,
  legacySecretOf,
  type DataKey,
} from "@/lib/data-encryption-key-material";
import {
  currentDataKey,
  dataKeyById,
} from "@/lib/data-encryption-keys";

const ENCRYPTION_ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;
const KEY_LENGTH = 32;

/**
 * Fixed, non-secret, application-specific HKDF salt. See the module header for
 * the rationale. Versioned so it can never change silently — a change here
 * would strand every existing ciphertext into the re-entry state.
 */
const HKDF_SALT = Buffer.from("acb:integration-credential:hkdf-salt:v1", "utf8");

/**
 * Enumerated, versioned HKDF info labels. Namespaces stay disjoint.
 *
 * RETIRED, never to be reused: `xero-token-key:v1`, the wrapped Xero token key's
 * label (#3806 R2 stopped writing the ciphertext it protected). A leftover row
 * still decrypts, because a decrypt derives from the label stored on the row.
 */
export const INTEGRATION_CREDENTIAL_LABEL = "integration-credential:v1";

/** The label of a row wrapped by a data-encryption ring key (#4456). */
export const INTEGRATION_CREDENTIAL_RING_LABEL = "integration-credential:v2";

export type AuthSecretSource = "AUTH_SECRET" | "NEXTAUTH_SECRET";

/** `secretSource` of a row wrapped by a ring key: this prefix, then the key id. */
export const DATA_KEY_SOURCE_PREFIX = "DATA_ENCRYPTION_KEY:";

/**
 * What wrapped a credential row, as stored in its `secretSource` column (no
 * CHECK constraint, so no migration): the auth secret's env var name for a
 * legacy row, or `DATA_ENCRYPTION_KEY:<id>` for a ring row. Never a secret.
 */
export type WrappingKeySource = AuthSecretSource | `${typeof DATA_KEY_SOURCE_PREFIX}${string}`;

/** Minimum acceptable auth-secret length at credential capture. */
export const AUTH_SECRET_MIN_LENGTH = 32;

/**
 * Literal placeholder values shipped in `.env.example` for BOTH AUTH_SECRET and
 * NEXTAUTH_SECRET. The current placeholder is 41 chars, so it PASSES a naive
 * length check — the blocklist is what actually catches it. Compared after a
 * trim, case-sensitively (these are exact literals).
 */
export const AUTH_SECRET_PLACEHOLDER_BLOCKLIST: readonly string[] = [
  "your-secret-key-here-change-in-production",
];

/**
 * Credential capture refused: the key it would encrypt under is unusable — a
 * weak auth secret while no ring is set, or an invalid `DATA_ENCRYPTION_KEYS`.
 * The message is plain English and never holds a secret, so routes surface it.
 */
export class WeakAuthSecretError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WeakAuthSecretError";
  }
}

/**
 * Thrown when GCM authentication fails on decrypt: the resolved auth-secret
 * value changed (rotation / restored clone / different environment), so the
 * credential must be re-entered. Never a raw crash — callers surface the clean
 * re-entry prompt (see the state model in integration-credentials.ts).
 */
export class CredentialDecryptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialDecryptError";
  }
}

/**
 * The auth secret and which env var it resolved from. Mirrors
 * getAuthSecret()'s AUTH_SECRET → NEXTAUTH_SECRET precedence so `secretSource`
 * records the actual source, making a silent fallback flip diagnosable.
 */
export function getAuthSecretWithSource():
  | { secret: string; source: AuthSecretSource }
  | undefined {
  const authSecret = process.env.AUTH_SECRET?.trim();
  if (authSecret) return { secret: authSecret, source: "AUTH_SECRET" };
  const nextAuthSecret = process.env.NEXTAUTH_SECRET?.trim();
  if (nextAuthSecret) return { secret: nextAuthSecret, source: "NEXTAUTH_SECRET" };
  return undefined;
}

/**
 * Is the given secret strong enough to encrypt credentials under? Pure,
 * side-effect free, so both the hard capture-time gate and the passive amber
 * readiness warning can share one predicate.
 */
export function isAuthSecretStrongEnough(secret: string | undefined): boolean {
  if (!secret) return false;
  const trimmed = secret.trim();
  if (trimmed.length < AUTH_SECRET_MIN_LENGTH) return false;
  if (AUTH_SECRET_PLACEHOLDER_BLOCKLIST.includes(trimmed)) return false;
  return true;
}

/** Human-readable reason a secret fails the gate, or null when it passes. */
export function authSecretWeaknessReason(
  secret: string | undefined,
): string | null {
  if (!secret || !secret.trim()) {
    return "No AUTH_SECRET or NEXTAUTH_SECRET is set. Sign-in, 2FA and credential encryption all depend on this secret.";
  }
  const trimmed = secret.trim();
  if (trimmed.length < AUTH_SECRET_MIN_LENGTH) {
    return `The auth secret is too short (needs at least ${AUTH_SECRET_MIN_LENGTH} characters). Sign-in, 2FA and credential encryption all depend on this secret.`;
  }
  if (AUTH_SECRET_PLACEHOLDER_BLOCKLIST.includes(trimmed)) {
    return "The auth secret is still the .env.example placeholder. Generate a real one — sign-in, 2FA and credential encryption all depend on this secret.";
  }
  return null;
}

/** The key a credential write wraps under, with the row metadata naming it. */
export interface CredentialCaptureKey {
  key: DataKey;
  source: WrappingKeySource;
  label: string;
}

/**
 * Hard gate at credential CAPTURE (any encrypt). Returns the CURRENT data key —
 * the ring's first key, or, with no ring set, the auth secret after its strength
 * gate — or throws WeakAuthSecretError. NEVER called at boot, only when writing.
 * Once a ring is set no write can land under the legacy key (#4456).
 */
export function requireCredentialCaptureKey(): CredentialCaptureKey {
  let key: DataKey | null;
  try {
    key = currentDataKey();
  } catch (error) {
    if (error instanceof DataKeyRingError) throw new WeakAuthSecretError(error.message);
    throw error;
  }
  if (key && !key.legacy) {
    return { key, source: `${DATA_KEY_SOURCE_PREFIX}${key.id}`, label: INTEGRATION_CREDENTIAL_RING_LABEL };
  }
  const resolved = getAuthSecretWithSource();
  const reason = authSecretWeaknessReason(resolved?.secret);
  if (!key || !resolved || reason) {
    throw new WeakAuthSecretError(
      reason ??
        "The auth secret is not strong enough to encrypt provider credentials.",
    );
  }
  return { key, source: resolved.source, label: INTEGRATION_CREDENTIAL_LABEL };
}

/** Could a credential be captured right now? The gate above, as a boolean. */
export function credentialCaptureAvailable(): boolean {
  try {
    requireCredentialCaptureKey();
    return true;
  } catch (error) {
    if (error instanceof WeakAuthSecretError) return false;
    throw error;
  }
}

/**
 * Derive a 32-byte AES key from an explicit secret and a versioned info label.
 * Synchronous; no I/O. `hkdfSync` returns an ArrayBuffer — wrap it in a Buffer.
 */
function deriveKeyFromSecret(secret: string, label: string): Buffer {
  return Buffer.from(
    hkdfSync("sha256", Buffer.from(secret, "utf8"), HKDF_SALT, Buffer.from(label, "utf8"), KEY_LENGTH),
  );
}

/** The AES key for one row: the legacy formula or the ring sub-key, by key kind. */
function wrappingKeyFor(key: DataKey, label: string): Buffer {
  return key.legacy
    ? deriveKeyFromSecret(legacySecretOf(key), label)
    : deriveDataSubkey(key, label);
}

/**
 * The key id a row's `secretSource` names: `legacy-auth-secret` for an
 * auth-secret row, the ring id for a ring row, or null for anything else —
 * including a ring source spelling the legacy id, which no write produces.
 */
export function wrappingKeyIdOf(secretSource: string): string | null {
  if (secretSource === "AUTH_SECRET" || secretSource === "NEXTAUTH_SECRET") {
    return LEGACY_AUTH_SECRET_KEY_ID;
  }
  if (!secretSource.startsWith(DATA_KEY_SOURCE_PREFIX)) return null;
  const id = secretSource.slice(DATA_KEY_SOURCE_PREFIX.length);
  return id === LEGACY_AUTH_SECRET_KEY_ID || id === "" ? null : id;
}

/**
 * The key a stored row names, or null when this deployment does not hold it.
 * A legacy source reads under the auth secret as it is now (the source NAME may
 * have flipped, as before #4456); a ring source reads under that ring id only.
 */
function keyNamedByRow(secretSource: string): DataKey | null {
  const id = wrappingKeyIdOf(secretSource);
  return id === null ? null : dataKeyById(id);
}

export interface EncryptedCredential {
  ciphertext: string;
  iv: string;
  authTag: string;
  secretSource: WrappingKeySource;
  labelVersion: string;
}

/**
 * Encrypt a credential value under the CURRENT data key (the capture gate
 * above chooses it, and the label goes with the key). Uses a FRESH random IV
 * per call (never derived, never reused), and binds the ciphertext to its row
 * via GCM AAD.
 */
export function encryptCredential(params: {
  provider: string;
  key: string;
  plaintext: string;
}): EncryptedCredential {
  const { key, source, label } = requireCredentialCaptureKey();
  const derivedKey = wrappingKeyFor(key, label);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ENCRYPTION_ALGORITHM, derivedKey, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });
  cipher.setAAD(buildAad(params.provider, params.key, label));
  let encrypted = cipher.update(params.plaintext, "utf8", "hex");
  encrypted += cipher.final("hex");
  const authTag = cipher.getAuthTag();
  return {
    ciphertext: encrypted,
    iv: iv.toString("hex"),
    authTag: authTag.toString("hex"),
    secretSource: source,
    labelVersion: label,
  };
}

/**
 * Decrypt a stored credential under the key its row names (`secretSource`) and
 * that key alone. On a missing key or any GCM failure throws
 * CredentialDecryptError so the caller can enter the clean re-entry state
 * rather than crash.
 *
 * Decrypt does NOT run the capture-time strength gate: a deployment whose secret
 * was strong at write time must always be able to READ its own credentials even
 * if the gate rules later tighten.
 */
export function decryptCredential(params: {
  provider: string;
  key: string;
  ciphertext: string;
  iv: string;
  authTag: string;
  labelVersion: string;
  secretSource: string;
}): string {
  let key: DataKey | null;
  try {
    key = keyNamedByRow(params.secretSource);
  } catch (error) {
    if (!(error instanceof DataKeyRingError)) throw error;
    throw new CredentialDecryptError(
      `Stored integration credential could not be decrypted: ${error.message}`,
    );
  }
  if (!key) {
    throw new CredentialDecryptError(
      params.secretSource.startsWith(DATA_KEY_SOURCE_PREFIX)
        ? `Stored integration credential could not be decrypted: the data-encryption key "${params.secretSource.slice(DATA_KEY_SOURCE_PREFIX.length)}" it was written under is not in DATA_ENCRYPTION_KEYS. Restore that key, or re-enter the credential.`
        : "No auth secret is available to decrypt integration credentials.",
    );
  }
  try {
    const derivedKey = wrappingKeyFor(key, params.labelVersion);
    const iv = Buffer.from(params.iv, "hex");
    const authTag = Buffer.from(params.authTag, "hex");
    if (authTag.length !== AUTH_TAG_LENGTH) {
      throw new Error("bad auth tag length");
    }
    const decipher = createDecipheriv(ENCRYPTION_ALGORITHM, derivedKey, iv, {
      authTagLength: AUTH_TAG_LENGTH,
    });
    decipher.setAAD(buildAad(params.provider, params.key, params.labelVersion));
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(params.ciphertext, "hex", "utf8");
    decrypted += decipher.final("utf8");
    return decrypted;
  } catch {
    // Deliberately opaque: never leak crypto internals or any value fragment.
    throw new CredentialDecryptError(
      key.legacy
        ? "Stored integration credential could not be decrypted (the app auth secret has changed). Re-enter the credential."
        : `Stored integration credential could not be decrypted under the data-encryption key "${key.id}". Re-enter the credential.`,
    );
  }
}

function buildAad(provider: string, key: string, labelVersion: string): Buffer {
  return Buffer.from(`${provider}:${key}:${labelVersion}`, "utf8");
}
