/**
 * The data-encryption key ring (#4456): the ONE source of the keys that wrap
 * data at rest, so the session secret no longer has to be one of them.
 *
 * WHY. `AUTH_SECRET` signs every session. Until this module it was also the
 * root every stored-data key was derived from — the integration credentials
 * (`integration-crypto.ts`), the authenticator-app secrets and the two-factor
 * code hashes (`two-factor.ts`). Rotating it after a leak therefore destroyed
 * every stored credential and every member's authenticator. The ring separates
 * the two: sessions keep `AUTH_SECRET`; data uses these keys, which can be
 * rotated by adding a new one and re-encrypting.
 *
 * THE VARIABLE. `DATA_ENCRYPTION_KEYS` is a comma-separated list of
 * `<id>:<base64 key>` entries. The FIRST entry is the current key: every new
 * write uses it. The others stay readable until no row names them. Each key is
 * exactly 32 random bytes (`openssl rand -base64 32`). One variable rather than
 * one per key, so adding a key is one edit and which key is current is never in
 * doubt.
 *
 * THE LEGACY KEY. Rows written before a ring existed name no ring key; they are
 * read under the reserved id `legacy-auth-secret`, whose material is the auth
 * secret as it is now. With no ring set, `currentDataKey()` IS that legacy key,
 * so every consumer behaves exactly as it did before this module existed (a
 * deploy that sets nothing changes nothing — `BLUE_GREEN_MIGRATION_POLICY.md`).
 * The reserved id may not appear in the variable.
 *
 * THE RULES every consumer follows, and why:
 *   - a WRITE uses `currentDataKey()`, never another ring key;
 *   - a READ uses `dataKeyById(<the id stored on the row>)` and never tries the
 *     keys one after another, so there is one deterministic answer and a
 *     missing key is a clean "re-enter" rather than a guess;
 *   - a keyed-hash LOOKUP (a code compared by its hash) computes the hash under
 *     each key `codeHashKeys()` returns and asks the database for any of them;
 *     the legacy key is not among them once a ring is set (owner decision on
 *     #4456, 1 Nov 2026: recovery codes hashed under the auth secret are retired
 *     at cut-over).
 *
 * The key material, the parser and the sub-key derivation are pure and live in
 * `data-encryption-key-material.ts`; this module only reads the environment.
 */

import {
  DATA_ENCRYPTION_KEYS_ENV,
  DataKeyRingError,
  LEGACY_AUTH_SECRET_KEY_ID,
  legacyDataKey,
  parseDataEncryptionKeys,
  type DataKey,
  type DataKeyRingState,
} from "@/lib/data-encryption-key-material";
import { getAuthSecret } from "@/lib/runtime-config";

let memo: { raw: string | undefined; authSecret: string | undefined; state: DataKeyRingState } | null =
  null;

/** The ring as the environment states it now (memoised on the raw values). */
export function readDataKeyRing(): DataKeyRingState {
  const raw = process.env[DATA_ENCRYPTION_KEYS_ENV];
  const authSecret = getAuthSecret();
  if (memo === null || memo.raw !== raw || memo.authSecret !== authSecret) {
    memo = { raw, authSecret, state: parseDataEncryptionKeys(raw, authSecret) };
  }
  return memo.state;
}

function configuredRing(): Extract<DataKeyRingState, { status: "configured" }> | null {
  const state = readDataKeyRing();
  if (state.status === "invalid") throw new DataKeyRingError(state.reason);
  return state.status === "configured" ? state : null;
}

/** The legacy key, or null when no auth secret is set. */
function legacyKey(): DataKey | null {
  const secret = getAuthSecret();
  return secret ? legacyDataKey(secret) : null;
}

/**
 * The key a new write uses: the ring's first key, or the legacy key when no
 * ring is set. Throws `DataKeyRingError` for an invalid ring, and returns null
 * only when there is no ring and no auth secret.
 */
export function currentDataKey(): DataKey | null {
  const ring = configuredRing();
  return ring ? ring.current : legacyKey();
}

/**
 * The key a row names, for a READ: the legacy key for `legacy-auth-secret`,
 * otherwise that ring entry. Null when the row names a key this deployment does
 * not hold — a removed ring key, an unset ring, or no auth secret — so the
 * caller reports a clean "cannot be read" instead of trying the other keys.
 * An invalid ring throws `DataKeyRingError` for a ring id (the legacy key does
 * not depend on the ring, so legacy rows stay readable).
 */
export function dataKeyById(id: string): DataKey | null {
  if (id === LEGACY_AUTH_SECRET_KEY_ID) return legacyKey();
  const ring = configuredRing();
  return ring?.keys.find((key) => key.id === id) ?? null;
}

/**
 * The keys a keyed-hash lookup computes a candidate under: every ring key when
 * a ring is set (the legacy key deliberately excluded, see the module header),
 * otherwise the legacy key alone. Empty only with no ring and no auth secret.
 */
export function codeHashKeys(): readonly DataKey[] {
  const ring = configuredRing();
  if (ring) return ring.keys;
  const legacy = legacyKey();
  return legacy ? [legacy] : [];
}

