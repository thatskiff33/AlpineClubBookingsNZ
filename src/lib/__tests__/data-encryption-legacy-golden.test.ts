/**
 * Golden vectors for the three LEGACY formulas (#4456 review): with no
 * `DATA_ENCRYPTION_KEYS` set, rows written by the release before the key ring
 * must still read, byte for byte. The fixed ciphertexts below were made outside
 * the application with Node's crypto from the formulas as they stood before
 * #4456, and the hash is recomputed here from first principles, so a change to
 * a legacy label, salt or derivation fails this file even though every
 * round-trip test (which encrypts and decrypts with the same new code) passes.
 *
 *   TOTP v1      key  = SHA-256(secret + ":two-factor-secret:v1")
 *   code hash    HMAC-SHA256(SHA-256(secret + ":two-factor-code:v1"), code)
 *   credential   key  = HKDF-SHA256(secret, "acb:integration-credential:hkdf-salt:v1",
 *                                    "integration-credential:v1", 32),
 *                AAD  = "<provider>:<key>:integration-credential:v1"
 */
import { createHash, createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/club-identity-settings", () => ({
  getClubIdentitySync: () => ({ name: "Test Club", bookingsName: "Test Club - Bookings" }),
}));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));

import { decryptCredential } from "@/lib/integration-crypto";
import { decryptTwoFactorSecret, hashTwoFactorCode } from "@/lib/two-factor";

const SECRET = "golden-vector-auth-secret-0123456789abcdefghij";
const TOTP_V1 =
  "v1:00112233445566778899aabbccddeeff:e53f5cc65776b27e0bd5bb94fe55ad1b:69b2f5808843ee7ae523c0bdbaa54867";
const CREDENTIAL_ROW = {
  provider: "xero",
  key: "client_secret",
  ciphertext: "a3f3f8ec46847d685b9e63770680a8d49b5b4edb",
  iv: "00112233445566778899aabbccddeeff",
  authTag: "c9d614901e6bb357d95bdef8c2b3bd0a",
  labelVersion: "integration-credential:v1",
  secretSource: "AUTH_SECRET",
};

const savedEnv = { ...process.env };
beforeEach(() => {
  delete process.env.DATA_ENCRYPTION_KEYS;
  delete process.env.NEXTAUTH_SECRET;
  process.env.AUTH_SECRET = SECRET;
});
afterEach(() => {
  process.env = { ...savedEnv };
});

describe("legacy formulas are unchanged with no ring set (#4456)", () => {
  it("decrypts a fixed v1 authenticator secret made under SHA-256(secret + ':two-factor-secret:v1')", () => {
    expect(decryptTwoFactorSecret(TOTP_V1)).toBe("JBSWY3DPEHPK3PXP");
  });

  it("hashes a code as HMAC(SHA-256(secret + ':two-factor-code:v1'), code), unprefixed", () => {
    const key = createHash("sha256").update(SECRET).update(":two-factor-code:v1").digest();
    for (const code of ["123456", "ABCDEFGHIJKL"]) {
      expect(hashTwoFactorCode(code)).toBe(createHmac("sha256", key).update(code).digest("hex"));
    }
  });

  it("decrypts a fixed credential row made under HKDF(secret, the v1 salt, 'integration-credential:v1')", () => {
    expect(decryptCredential(CREDENTIAL_ROW)).toBe("golden-client-secret");
    // The NEXTAUTH_SECRET spelling of the same secret reads it too, as before.
    expect(decryptCredential({ ...CREDENTIAL_ROW, secretSource: "NEXTAUTH_SECRET" })).toBe("golden-client-secret");
  });
});
