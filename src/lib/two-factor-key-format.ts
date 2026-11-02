/**
 * The stored formats of two-factor secrets and code hashes, as far as which
 * key they name (#4456). Kept apart from `two-factor.ts`, which reads the
 * database and club identity, so the setup snapshot can count rows per key
 * without importing either. `two-factor.ts` writes and reads these formats.
 */

import { LEGACY_AUTH_SECRET_KEY_ID } from "@/lib/data-encryption-key-material";

/** Authenticator secrets under the auth secret: read-only once a ring is set. */
export const LEGACY_ENCRYPTION_VERSION = "v1";
/** Authenticator secrets under a ring key: `v2:<key id>:iv:tag:ct`. */
export const RING_ENCRYPTION_VERSION = "v2";

/** The key id a stored code hash was made under: its prefix, or legacy if bare. */
export function codeHashKeyId(codeHash: string): string {
  const separator = codeHash.indexOf(":");
  return separator === -1 ? LEGACY_AUTH_SECRET_KEY_ID : codeHash.slice(0, separator);
}

/**
 * The key id a stored authenticator secret names — legacy for `v1`, the id for
 * `v2:<id>:…` — or null for a format no write produces. Counting only; a read
 * goes through `decryptTwoFactorSecret`, which refuses the same formats.
 */
export function twoFactorSecretKeyId(stored: string): string | null {
  const parts = stored.split(":");
  if (parts[0] === LEGACY_ENCRYPTION_VERSION && parts.length === 4) return LEGACY_AUTH_SECRET_KEY_ID;
  if (parts[0] === RING_ENCRYPTION_VERSION && parts.length === 5 && parts[1] && parts[1] !== LEGACY_AUTH_SECRET_KEY_ID) {
    return parts[1];
  }
  return null;
}
