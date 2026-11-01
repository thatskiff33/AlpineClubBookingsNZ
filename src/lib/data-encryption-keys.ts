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
 * NOTHING HERE PRINTS KEY MATERIAL. Error messages name an entry's position or
 * its id, never its value, and `DataKey` keeps its material out of `toJSON` and
 * `util.inspect`, so a stray log line shows the id alone.
 */

import { hkdfSync } from "node:crypto";

import { getAuthSecret } from "@/lib/runtime-config";

/** The environment variable that holds the ring. */
export const DATA_ENCRYPTION_KEYS_ENV = "DATA_ENCRYPTION_KEYS";

/** The reserved id rows written under the auth secret are read with. */
export const LEGACY_AUTH_SECRET_KEY_ID = "legacy-auth-secret";

/** Every ring key is exactly this many bytes. */
export const DATA_KEY_BYTES = 32;

/** What a ring key id may look like: short, and never containing `:` or `,`. */
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;

/** Standard or URL-safe base64, padded or not. */
const BASE64_PATTERN = /^[A-Za-z0-9+/_-]+={0,2}$/;

/**
 * Fixed, non-secret HKDF salt for every sub-key derived from a RING key. The
 * legacy derivations keep their own frozen formulas in their own modules; this
 * one is new with the ring, and changing it would strand every ring-written row.
 */
const RING_HKDF_SALT = Buffer.from("acb:data-encryption-key:hkdf-salt:v1", "utf8");

const MATERIAL = Symbol("data-key-material");

/**
 * One key. `id` is safe to store and show; the material is reachable only
 * through `deriveDataSubkey` (ring keys) or `legacySecretOf` (the legacy key).
 */
export interface DataKey {
  readonly id: string;
  readonly legacy: boolean;
  readonly [MATERIAL]: Buffer | string;
}

function makeKey(id: string, legacy: boolean, material: Buffer | string): DataKey {
  const key = { id, legacy, [MATERIAL]: material };
  // A key that reaches a logger or JSON.stringify shows its id and nothing else.
  Object.defineProperty(key, "toJSON", { value: () => ({ id, legacy }), enumerable: false });
  Object.defineProperty(key, Symbol.for("nodejs.util.inspect.custom"), {
    value: () => `DataKey(${id})`,
    enumerable: false,
  });
  return Object.freeze(key);
}

export type DataKeyRingState =
  | { readonly status: "unset" }
  | { readonly status: "invalid"; readonly reason: string }
  | {
      readonly status: "configured";
      /** The key every new write uses: the first entry. */
      readonly current: DataKey;
      /** Every ring key, current first, in the order the variable lists them. */
      readonly keys: readonly DataKey[];
    };

/** The ring is set but cannot be used. Never names a key's value. */
export class DataKeyRingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DataKeyRingError";
  }
}

function decodeKey(encoded: string): Buffer | null {
  if (!BASE64_PATTERN.test(encoded)) return null;
  const normalised = encoded.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  const bytes = Buffer.from(normalised, "base64");
  // Round-trip, so stray characters Node would silently skip are refused.
  if (bytes.toString("base64").replace(/=+$/, "") !== normalised) return null;
  return bytes;
}

/**
 * Parse a `DATA_ENCRYPTION_KEYS` value. Pure. A blank value is `unset`; any
 * entry that is malformed, the wrong length, visibly not random (every byte the
 * same), a duplicate id, a duplicate key or the reserved legacy id makes the
 * whole ring `invalid` — never a partial ring, because a ring missing the key
 * an operator meant to be current would write under the wrong one.
 */
export function parseDataEncryptionKeys(raw: string | undefined): DataKeyRingState {
  const trimmed = raw?.trim() ?? "";
  if (trimmed === "") return { status: "unset" };

  const entries = trimmed.split(",").map((entry) => entry.trim());
  const keys: DataKey[] = [];
  const seenIds = new Set<string>();
  const seenMaterial = new Set<string>();
  for (const [index, entry] of entries.entries()) {
    const position = `entry ${index + 1}`;
    const separator = entry.indexOf(":");
    if (separator <= 0) {
      return invalid(`${position} is not in the form <id>:<base64 key>.`);
    }
    const id = entry.slice(0, separator).trim();
    const encoded = entry.slice(separator + 1).trim();
    if (!KEY_ID_PATTERN.test(id)) {
      return invalid(
        `${position} has an id that is not 1-32 letters, digits, "-" or "_" starting with a letter or digit.`,
      );
    }
    if (id === LEGACY_AUTH_SECRET_KEY_ID) {
      return invalid(`${position} uses the reserved id "${LEGACY_AUTH_SECRET_KEY_ID}".`);
    }
    if (seenIds.has(id)) return invalid(`the id "${id}" appears more than once.`);
    const material = decodeKey(encoded);
    if (material === null) return invalid(`the key for "${id}" is not valid base64.`);
    if (material.length !== DATA_KEY_BYTES) {
      return invalid(
        `the key for "${id}" is ${material.length} bytes; every key must be exactly ${DATA_KEY_BYTES} random bytes.`,
      );
    }
    if (material.every((byte) => byte === material[0])) {
      return invalid(`the key for "${id}" repeats one byte; generate it with openssl rand -base64 32.`);
    }
    const fingerprint = material.toString("hex");
    if (seenMaterial.has(fingerprint)) {
      return invalid(`the key for "${id}" repeats an earlier entry's key.`);
    }
    seenIds.add(id);
    seenMaterial.add(fingerprint);
    keys.push(makeKey(id, false, material));
  }
  return { status: "configured", current: keys[0]!, keys };
}

function invalid(reason: string): DataKeyRingState {
  return { status: "invalid", reason: `${DATA_ENCRYPTION_KEYS_ENV}: ${reason}` };
}

let memo: { raw: string | undefined; state: DataKeyRingState } | null = null;

/** The ring as the environment states it now (memoised on the raw value). */
export function readDataKeyRing(): DataKeyRingState {
  const raw = process.env[DATA_ENCRYPTION_KEYS_ENV];
  if (memo === null || memo.raw !== raw) {
    memo = { raw, state: parseDataEncryptionKeys(raw) };
  }
  return memo.state;
}

/** Is a usable ring set? */
export function isDataKeyRingConfigured(): boolean {
  return readDataKeyRing().status === "configured";
}

function configuredRing(): Extract<DataKeyRingState, { status: "configured" }> | null {
  const state = readDataKeyRing();
  if (state.status === "invalid") throw new DataKeyRingError(state.reason);
  return state.status === "configured" ? state : null;
}

/** The legacy key, or null when no auth secret is set. */
function legacyKey(): DataKey | null {
  const secret = getAuthSecret();
  return secret ? makeKey(LEGACY_AUTH_SECRET_KEY_ID, true, secret) : null;
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

/**
 * A 32-byte sub-key of a RING key for one purpose, by HKDF-SHA256 with the
 * purpose as `info`, so each use (credentials, authenticator secrets, code
 * hashes) gets an independent key. The legacy key has no sub-key here: its
 * consumers keep the derivation they always used (`legacySecretOf`).
 */
export function deriveDataSubkey(key: DataKey, purpose: string): Buffer {
  const material = key[MATERIAL];
  if (key.legacy || typeof material === "string") {
    throw new DataKeyRingError("The legacy key has no ring sub-key; use its legacy derivation.");
  }
  return Buffer.from(
    hkdfSync("sha256", material, RING_HKDF_SALT, Buffer.from(purpose, "utf8"), DATA_KEY_BYTES),
  );
}

/** The auth secret behind the legacy key, for the legacy derivations only. */
export function legacySecretOf(key: DataKey): string {
  const material = key[MATERIAL];
  if (!key.legacy || typeof material !== "string") {
    throw new DataKeyRingError("Only the legacy key carries the auth secret.");
  }
  return material;
}
