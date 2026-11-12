import "server-only";

import { hash, verify } from "@node-rs/bcrypt";

// One work factor for every stored account password, including placeholders
// and seed accounts. Hut-leader PINs have their own policy.
export const PASSWORD_BCRYPT_COST = 13;

// Not a live credential: bcrypt of a random throwaway value. Precomputed so
// refused sign-ins spend one compare, without hashing again at startup.
// Regenerate at PASSWORD_BCRYPT_COST when changing it; password-hashing.test.ts
// checks the encoded work factor against real password hashes.
export const DUMMY_PASSWORD_HASH =
  "$2b$13$dcc0uu0pCIFM.e5XHAXIpO2Cj6ssbDXlOEH9D5JF/RHHpnKhmy1WO";

// Valid bcrypt of a discarded random value, distinct from the dummy hash.
// Regenerate at PASSWORD_BCRYPT_COST when changing it; the parity test checks it.
// A valid hash keeps full-cost comparison if a placeholder later gains login.
export const UNUSABLE_PLACEHOLDER_PASSWORD_HASH =
  "$2b$13$jsnZm8TGm1HcXz48Mjb2Aua5S68WRABVmYUGd45wTcyYdOHGNW.AC";

// Native async tasks run on libuv's pool, never on the request event loop.
export function hashPassword(plain: string): Promise<string> {
  return hash(plain, { cost: PASSWORD_BCRYPT_COST });
}

export function hashPin(plain: string, cost: number): Promise<string> {
  return hash(plain, { cost });
}

export function verifyPassword(plain: string, encodedHash: string): Promise<boolean> {
  return verify(plain, encodedHash);
}

export function burnDummyPasswordCompare(plain: string): Promise<boolean> {
  return verifyPassword(plain, DUMMY_PASSWORD_HASH);
}
