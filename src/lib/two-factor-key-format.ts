/**
 * The stored formats of two-factor secrets and code hashes, as far as which
 * key they name (#4456): the ONE parser of an authenticator secret's envelope
 * and the ONE writer and reader of a code hash's key prefix. Kept apart from
 * `two-factor.ts`, which reads the database and club identity, so the setup
 * snapshot can count rows per key without importing either.
 */

import { createHash, createHmac } from "node:crypto";

import {
  LEGACY_AUTH_SECRET_KEY_ID,
  deriveDataSubkey,
  legacySecretOf,
  type DataKey,
} from "@/lib/data-encryption-key-material";

/** Authenticator secrets under the auth secret: read-only once a ring is set. */
export const LEGACY_ENCRYPTION_VERSION = "v1";
/** Authenticator secrets under a ring key: `v2:<key id>:iv:tag:ct`. */
export const RING_ENCRYPTION_VERSION = "v2";
/** HKDF purpose of the ring sub-key code hashes use; the legacy label stays frozen. */
const CODE_HASH_RING_PURPOSE = "two-factor-code:v2";

/** A stored authenticator secret's envelope: the key it names and its parts. */
export interface TwoFactorSecretEnvelope {
  readonly keyId: string;
  readonly ivHex: string;
  readonly authTagHex: string;
  readonly ciphertextHex: string;
}

/**
 * Parse a stored authenticator secret — `v1:iv:tag:ct` (the legacy key) or
 * `v2:<id>:iv:tag:ct` (that ring key) — or null for any other shape, an empty
 * part, or a `v2` row naming the reserved legacy id. The decrypt and the setup
 * count both read through this, so they never disagree on a row.
 */
export function parseTwoFactorSecret(stored: string): TwoFactorSecretEnvelope | null {
  const parts = stored.split(":");
  if (parts.some((part) => part === "")) return null;
  let keyId: string;
  let rest: string[];
  if (parts[0] === LEGACY_ENCRYPTION_VERSION && parts.length === 4) {
    keyId = LEGACY_AUTH_SECRET_KEY_ID;
    rest = parts.slice(1);
  } else if (parts[0] === RING_ENCRYPTION_VERSION && parts.length === 5 && parts[1] !== LEGACY_AUTH_SECRET_KEY_ID) {
    keyId = parts[1]!;
    rest = parts.slice(2);
  } else {
    return null;
  }
  const [ivHex, authTagHex, ciphertextHex] = rest as [string, string, string];
  return { keyId, ivHex, authTagHex, ciphertextHex };
}

/** The key id a stored authenticator secret names, or null if unrecognised. */
export function twoFactorSecretKeyId(stored: string): string | null {
  return parseTwoFactorSecret(stored)?.keyId ?? null;
}

/**
 * A code's keyed hash under one key. A ring hash is `<id>:<hex>`; a legacy hash
 * is bare hex under the frozen formula `HMAC(SHA-256(secret + ':two-factor-code:v1'), code)`.
 */
export function keyedCodeHash(key: DataKey, value: string): string {
  if (!key.legacy) {
    const digest = createHmac("sha256", deriveDataSubkey(key, CODE_HASH_RING_PURPOSE))
      .update(value)
      .digest("hex");
    return `${key.id}:${digest}`;
  }
  const legacyHashKey = createHash("sha256")
    .update(legacySecretOf(key))
    .update(":two-factor-code:v1")
    .digest();
  return createHmac("sha256", legacyHashKey).update(value).digest("hex");
}

/**
 * The key id of a recovery code RETIRED in the database (#4456, owner decision
 * of 1 Nov 2026: codes hashed under the auth secret are invalidated at
 * cut-over). `pnpm run data-keys:reencrypt --retire-legacy-recovery-codes`
 * prefixes each unused legacy hash with this id and a `:`. The `.` is outside
 * every ring id's alphabet (`KEY_ID_PATTERN`), so no key can ever claim it, and
 * no lookup computes a hash under it — on any release, ring or not — so the
 * code never signs anyone in again. The row stays unused, which is what keeps
 * telling its member to generate a new set (`isRetiredRecoveryCodeHash`).
 */
export const RETIRED_RECOVERY_CODE_KEY_ID = `retired.${LEGACY_AUTH_SECRET_KEY_ID}`;

/** The stored form of a retired legacy recovery-code hash. */
export function retiredRecoveryCodeHash(legacyCodeHash: string): string {
  return `${RETIRED_RECOVERY_CODE_KEY_ID}:${legacyCodeHash}`;
}

/** The key id a stored code hash was made under: its prefix, or legacy if bare. */
export function codeHashKeyId(codeHash: string): string {
  const separator = codeHash.indexOf(":");
  return separator === -1 ? LEGACY_AUTH_SECRET_KEY_ID : codeHash.slice(0, separator);
}
