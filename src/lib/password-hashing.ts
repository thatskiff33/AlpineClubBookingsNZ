// One work factor for every stored account password, including placeholders
// and seed accounts. Hut-leader PINs have their own policy.
export const PASSWORD_BCRYPT_COST = 13;

// Not a live credential: bcrypt of a random throwaway value. Precomputed so
// refused sign-ins spend one compare, without hashing again at startup.
// Regenerate at PASSWORD_BCRYPT_COST when changing it; password-hashing.test.ts
// checks the encoded work factor against real password hashes.
export const DUMMY_PASSWORD_HASH =
  "$2b$13$dcc0uu0pCIFM.e5XHAXIpO2Cj6ssbDXlOEH9D5JF/RHHpnKhmy1WO";
