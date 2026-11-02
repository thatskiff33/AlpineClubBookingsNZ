import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AUTH_SECRET_PLACEHOLDER_BLOCKLIST,
  CredentialDecryptError,
  WeakAuthSecretError,
  authSecretWeaknessReason,
  decryptCredential,
  encryptCredential,
  getAuthSecretWithSource,
  isAuthSecretStrongEnough,
} from "@/lib/integration-crypto";

const STRONG_SECRET = "a".repeat(48); // >= 32, not a placeholder
const OTHER_STRONG_SECRET = "b".repeat(48);
const originalEnv = { ...process.env };

function setAuthSecret(name: "AUTH_SECRET" | "NEXTAUTH_SECRET", value: string) {
  delete process.env.AUTH_SECRET;
  delete process.env.NEXTAUTH_SECRET;
  process.env[name] = value;
}

beforeEach(() => {
  delete process.env.AUTH_SECRET;
  delete process.env.NEXTAUTH_SECRET;
});
afterEach(() => {
  process.env = { ...originalEnv };
});

describe("integration-crypto: strength gate", () => {
  it("rejects short and placeholder secrets, accepts a strong one", () => {
    expect(isAuthSecretStrongEnough(undefined)).toBe(false);
    expect(isAuthSecretStrongEnough("short")).toBe(false);
    // The .env.example placeholder is 41 chars — it PASSES a naive length check
    // but the blocklist must catch it.
    for (const placeholder of AUTH_SECRET_PLACEHOLDER_BLOCKLIST) {
      expect(placeholder.length).toBeGreaterThanOrEqual(32);
      expect(isAuthSecretStrongEnough(placeholder)).toBe(false);
      expect(authSecretWeaknessReason(placeholder)).toMatch(/placeholder/i);
    }
    expect(isAuthSecretStrongEnough(STRONG_SECRET)).toBe(true);
    expect(authSecretWeaknessReason(STRONG_SECRET)).toBeNull();
  });

  it("encryptCredential throws WeakAuthSecretError on a weak secret (capture-time gate)", () => {
    setAuthSecret("AUTH_SECRET", "too-short");
    expect(() =>
      encryptCredential({
        provider: "xero",
        key: "client_id",
        plaintext: "secret-value",
      }),
    ).toThrow(WeakAuthSecretError);
  });
});

describe("integration-crypto: encrypt/decrypt", () => {
  beforeEach(() => setAuthSecret("AUTH_SECRET", STRONG_SECRET));

  it("uses a fresh random IV per encrypt (no reuse)", () => {
    const ivs = new Set<string>();
    for (let i = 0; i < 25; i += 1) {
      const enc = encryptCredential({
        provider: "xero",
        key: "client_secret",
        plaintext: "same-plaintext",
      });
      ivs.add(enc.iv);
    }
    expect(ivs.size).toBe(25);
  });

  it("round-trips and never leaks the plaintext into the ciphertext material", () => {
    const plaintext = "super-secret-client-secret";
    const enc = encryptCredential({
      provider: "xero",
      key: "client_secret",
      plaintext,
    });
    expect(enc.ciphertext).not.toContain(plaintext);
    expect(enc.secretSource).toBe("AUTH_SECRET");
    const dec = decryptCredential({
      provider: "xero",
      key: "client_secret",
      ciphertext: enc.ciphertext,
      iv: enc.iv,
      authTag: enc.authTag,
      labelVersion: enc.labelVersion,
      secretSource: enc.secretSource,
    });
    expect(dec).toBe(plaintext);
  });

  it("AAD binds a ciphertext to its (provider,key,label) row — a swap fails", () => {
    const enc = encryptCredential({
      provider: "xero",
      key: "client_id",
      plaintext: "value-A",
    });
    // Same ciphertext bytes, but decrypt under a different key slot → AAD
    // mismatch → GCM auth failure.
    expect(() =>
      decryptCredential({
        provider: "xero",
        key: "client_secret",
        ciphertext: enc.ciphertext,
        iv: enc.iv,
        authTag: enc.authTag,
        labelVersion: enc.labelVersion,
        secretSource: enc.secretSource,
      }),
    ).toThrow(CredentialDecryptError);
  });

  it("still decrypts when the value is unchanged but the secret SOURCE flips", () => {
    const enc = encryptCredential({
      provider: "xero",
      key: "webhook_key",
      plaintext: "hook",
    });
    expect(enc.secretSource).toBe("AUTH_SECRET");
    // Same value, now under NEXTAUTH_SECRET (AUTH_SECRET removed).
    setAuthSecret("NEXTAUTH_SECRET", STRONG_SECRET);
    expect(getAuthSecretWithSource()?.source).toBe("NEXTAUTH_SECRET");
    expect(
      decryptCredential({
        provider: "xero",
        key: "webhook_key",
        ciphertext: enc.ciphertext,
        iv: enc.iv,
        authTag: enc.authTag,
        labelVersion: enc.labelVersion,
        secretSource: enc.secretSource,
      }),
    ).toBe("hook");
  });

  it("fails cleanly into re-entry (CredentialDecryptError) when the secret VALUE changes", () => {
    const enc = encryptCredential({
      provider: "xero",
      key: "client_id",
      plaintext: "value",
    });
    setAuthSecret("AUTH_SECRET", OTHER_STRONG_SECRET);
    expect(() =>
      decryptCredential({
        provider: "xero",
        key: "client_id",
        ciphertext: enc.ciphertext,
        iv: enc.iv,
        authTag: enc.authTag,
        labelVersion: enc.labelVersion,
        secretSource: enc.secretSource,
      }),
    ).toThrow(CredentialDecryptError);
  });
});
