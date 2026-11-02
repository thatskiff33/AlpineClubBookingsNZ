/**
 * Integration credentials under the data-encryption key ring (#4456).
 *
 * The acceptance criterion this file carries: rotating `AUTH_SECRET` leaves
 * every credential written under a ring key readable. Beside it, the rules the
 * ring exists for — a write uses the CURRENT key, a read uses the key its row
 * NAMES and no other, a key the deployment no longer holds is the clean
 * re-entry error rather than a crash — and that no ring at all means exactly
 * the behaviour before #4456.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CredentialDecryptError,
  INTEGRATION_CREDENTIAL_LABEL,
  INTEGRATION_CREDENTIAL_RING_LABEL,
  WeakAuthSecretError,
  credentialCaptureAvailable,
  decryptCredential,
  encryptCredential,
  requireCredentialCaptureKey,
  wrappingKeyIdOf,
} from "@/lib/integration-crypto";

function testKey(seed: number): string {
  return Buffer.from(Array.from({ length: 32 }, (_, index) => (seed * 37 + index * 11) % 256)).toString("base64");
}
const K1 = testKey(1);
const K2 = testKey(2);
const AUTH = "a".repeat(48);
const ROTATED_AUTH = "b".repeat(48);
const ROW = { provider: "xero", key: "client_secret" } as const;

const savedEnv = { ...process.env };
beforeEach(() => {
  delete process.env.DATA_ENCRYPTION_KEYS;
  delete process.env.NEXTAUTH_SECRET;
  process.env.AUTH_SECRET = AUTH;
});
afterEach(() => {
  process.env = { ...savedEnv };
});

function write(plaintext = "value") {
  return { ...ROW, ...encryptCredential({ ...ROW, plaintext }) };
}

describe("no ring set: behaviour is exactly what it was before #4456", () => {
  it("writes under the auth secret with the v1 label, and reads it back", () => {
    const row = write("legacy");
    expect(row.secretSource).toBe("AUTH_SECRET");
    expect(row.labelVersion).toBe(INTEGRATION_CREDENTIAL_LABEL);
    expect(decryptCredential(row)).toBe("legacy");
  });

  it("still refuses capture under a weak auth secret", () => {
    process.env.AUTH_SECRET = "too-short";
    expect(() => requireCredentialCaptureKey()).toThrow(WeakAuthSecretError);
    expect(credentialCaptureAvailable()).toBe(false);
  });
});

describe("with a ring set", () => {
  it("writes under the CURRENT (first) key with the v2 label", () => {
    process.env.DATA_ENCRYPTION_KEYS = `k2:${K2},k1:${K1}`;
    const row = write();
    expect(row.secretSource).toBe("DATA_ENCRYPTION_KEY:k2");
    expect(row.labelVersion).toBe(INTEGRATION_CREDENTIAL_RING_LABEL);
    // Proven by reading it with ONLY k2 in the ring: a write under k1 would fail here.
    process.env.DATA_ENCRYPTION_KEYS = `k2:${K2}`;
    expect(decryptCredential(row)).toBe("value");
  });

  it("acceptance: rotating AUTH_SECRET, or removing it, leaves a ring-written credential readable", () => {
    process.env.DATA_ENCRYPTION_KEYS = `k1:${K1}`;
    const row = write("survives rotation");
    process.env.AUTH_SECRET = ROTATED_AUTH;
    expect(decryptCredential(row)).toBe("survives rotation");
    delete process.env.AUTH_SECRET;
    expect(decryptCredential(row)).toBe("survives rotation");
  });

  it("captures under the ring even while the auth secret is weak (the ring does not depend on it)", () => {
    process.env.DATA_ENCRYPTION_KEYS = `k1:${K1}`;
    process.env.AUTH_SECRET = "too-short";
    expect(credentialCaptureAvailable()).toBe(true);
    expect(write().secretSource).toBe("DATA_ENCRYPTION_KEY:k1");
  });

  it("still reads a legacy row under the auth secret, and an older ring row under its own key", () => {
    const legacy = write("old");
    process.env.DATA_ENCRYPTION_KEYS = `k1:${K1}`;
    const older = write("older ring");
    process.env.DATA_ENCRYPTION_KEYS = `k2:${K2},k1:${K1}`;
    expect(decryptCredential(legacy)).toBe("old");
    expect(decryptCredential(older)).toBe("older ring");
  });

  it("reads under the key the row NAMES and never tries the others in turn", () => {
    process.env.DATA_ENCRYPTION_KEYS = `k1:${K1}`;
    const underK1 = write("k1 value");
    process.env.DATA_ENCRYPTION_KEYS = `k2:${K2},k1:${K1}`;
    // The same ciphertext relabelled as k2's: k1 would open it, so a reader
    // that tried each ring key would answer "k1 value". The rule says no.
    expect(() => decryptCredential({ ...underK1, secretSource: "DATA_ENCRYPTION_KEY:k2" })).toThrow(
      CredentialDecryptError,
    );
    // And a ring row relabelled as an auth-secret row is not opened by the ring either.
    expect(() => decryptCredential({ ...underK1, secretSource: "AUTH_SECRET", labelVersion: INTEGRATION_CREDENTIAL_LABEL })).toThrow(
      CredentialDecryptError,
    );
    expect(decryptCredential(underK1)).toBe("k1 value");
  });

  it("a row naming a key no longer in the ring is the clean re-entry error naming that id", () => {
    process.env.DATA_ENCRYPTION_KEYS = `k1:${K1}`;
    const row = write();
    process.env.DATA_ENCRYPTION_KEYS = `k2:${K2}`;
    expect(() => decryptCredential(row)).toThrow(CredentialDecryptError);
    expect(() => decryptCredential(row)).toThrow(/"k1" it was written under is not in DATA_ENCRYPTION_KEYS/);
    delete process.env.DATA_ENCRYPTION_KEYS;
    expect(() => decryptCredential(row)).toThrow(CredentialDecryptError);
  });

  it("refuses a ring source spelling the legacy id, and an unknown source", () => {
    const legacy = write();
    expect(() => decryptCredential({ ...legacy, secretSource: "DATA_ENCRYPTION_KEY:legacy-auth-secret" })).toThrow(
      CredentialDecryptError,
    );
    expect(() => decryptCredential({ ...legacy, secretSource: "SOMETHING_ELSE" })).toThrow(CredentialDecryptError);
    expect(wrappingKeyIdOf("DATA_ENCRYPTION_KEY:legacy-auth-secret")).toBeNull();
    expect(wrappingKeyIdOf("NEXTAUTH_SECRET")).toBe("legacy-auth-secret");
    expect(wrappingKeyIdOf("DATA_ENCRYPTION_KEY:k7")).toBe("k7");
  });

  it("an invalid ring refuses capture and ring reads cleanly, and legacy rows stay readable", () => {
    const legacy = write("legacy");
    process.env.DATA_ENCRYPTION_KEYS = `k1:${K1}`;
    const ring = write("ring");
    process.env.DATA_ENCRYPTION_KEYS = `k1:${K1},k1:${K2}`;
    expect(() => write()).toThrow(WeakAuthSecretError);
    expect(() => write()).toThrow(/DATA_ENCRYPTION_KEYS: the id "k1" appears more than once/);
    expect(credentialCaptureAvailable()).toBe(false);
    expect(() => decryptCredential(ring)).toThrow(CredentialDecryptError);
    expect(decryptCredential(legacy)).toBe("legacy");
  });
});
