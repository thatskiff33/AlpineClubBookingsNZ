/**
 * The data-encryption key ring's MATERIAL and its parser (#4456): pure, with no
 * application imports, so the runtime readiness check (`runtime-config.ts`) can
 * refuse an invalid ring without an import cycle. Which key the environment
 * names for a write, a read or a lookup is `data-encryption-keys.ts`; the
 * reasons for each rule are in that module's header.
 *
 * NOTHING HERE PRINTS KEY MATERIAL. Error messages name an entry's position or
 * its id, never its value, and `DataKey` keeps its material out of `toJSON` and
 * `util.inspect`, so a stray log line shows the id alone.
 */

import { hkdfSync } from "node:crypto";

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
export function parseDataEncryptionKeys(
  raw: string | undefined,
  authSecret?: string,
): DataKeyRingState {
  const authForms = authSecretForms(authSecret);
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
    if (authForms.text.has(encoded) || authForms.bytes.has(material.toString("hex"))) {
      return invalid(
        `the key for "${id}" is weak: it is the auth secret, so it would not separate stored data from sessions. Generate a new one with openssl rand -base64 32.`,
      );
    }
    if (material.every((byte) => byte >= 0x20 && byte <= 0x7e)) {
      return invalid(
        `the key for "${id}" is weak: every byte is printable text, so it is a password rather than 32 random bytes. Generate it with openssl rand -base64 32.`,
      );
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

/**
 * The spellings of the auth secret a ring key must not be: its text, and the
 * bytes it decodes to as base64, as hex, or as UTF-8 text. A ring key equal to
 * the auth secret would undo the separation the ring exists for.
 */
function authSecretForms(authSecret: string | undefined): { text: Set<string>; bytes: Set<string> } {
  const secret = authSecret?.trim() ?? "";
  if (secret === "") return { text: new Set(), bytes: new Set() };
  const bytes = new Set<string>([Buffer.from(secret, "utf8").toString("hex")]);
  const asBase64 = decodeKey(secret);
  if (asBase64) bytes.add(asBase64.toString("hex"));
  if (/^(?:[0-9a-fA-F]{2})+$/.test(secret)) bytes.add(secret.toLowerCase());
  return { text: new Set([secret]), bytes };
}

function invalid(reason: string): DataKeyRingState {
  return { status: "invalid", reason: `${DATA_ENCRYPTION_KEYS_ENV}: ${reason}` };
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

/** The legacy key for an auth secret: read-only material for the legacy formulas. */
export function legacyDataKey(authSecret: string): DataKey {
  return makeKey(LEGACY_AUTH_SECRET_KEY_ID, true, authSecret);
}
