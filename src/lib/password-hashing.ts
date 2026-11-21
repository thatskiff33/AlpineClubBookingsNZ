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

// The work factor a bcrypt hash was stored at, or null when it is not a
// standard bcrypt encoding.
export function passwordHashCost(encodedHash: string): number | null {
  const match = /^\$2[aby]\$(\d\d)\$/.exec(encodedHash);
  return match ? Number(match[1]) : null;
}

// True only for a readable hash stored below the target cost (#5261).
export function passwordHashNeedsUpgrade(
  encodedHash: string,
  target: number = PASSWORD_BCRYPT_COST,
): boolean {
  const cost = passwordHashCost(encodedHash);
  return cost !== null && cost < target;
}

// Costs to hash at so a compare at `storedCost` plus these hashes spends the
// work of one compare at `target`: 2^c + (2^c + … + 2^(target-1)) = 2^target.
export function passwordCostTopUpLadder(
  storedCost: number,
  target: number = PASSWORD_BCRYPT_COST,
): number[] {
  const ladder: number[] = [];
  for (let cost = storedCost; cost < target; cost += 1) ladder.push(cost);
  return ladder;
}

// After a refused compare against `encodedHash`, spend the work it fell short
// of a current-cost compare, so a wrong password for an older account answers
// as slowly as an unknown email (#5261). Results are discarded.
export async function burnPasswordCostShortfall(plain: string, encodedHash: string): Promise<void> {
  const cost = passwordHashCost(encodedHash);
  if (cost === null) {
    await burnDummyPasswordCompare(plain);
    return;
  }
  for (const step of passwordCostTopUpLadder(cost)) {
    await hash(plain, { cost: step });
  }
}
