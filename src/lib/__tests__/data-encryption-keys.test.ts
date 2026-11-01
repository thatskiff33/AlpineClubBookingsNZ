import { inspect } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn(), trace: vi.fn() },
}));
vi.mock("@/lib/logger", () => ({ default: mocks.logger, logger: mocks.logger }));

import {
  DATA_KEY_BYTES,
  DataKeyRingError,
  LEGACY_AUTH_SECRET_KEY_ID,
  codeHashKeys,
  currentDataKey,
  dataKeyById,
  deriveDataSubkey,
  legacySecretOf,
  parseDataEncryptionKeys,
  readDataKeyRing,
} from "@/lib/data-encryption-keys";
import { decryptCredential, encryptCredential, WeakAuthSecretError } from "@/lib/integration-crypto";
import { buildDataEncryptionKeyCheck } from "@/lib/setup-readiness-data-keys";

/** Deterministic, non-repeating 32-byte keys for tests (never real keys). */
function testKey(seed: number, bytes = DATA_KEY_BYTES): string {
  return Buffer.from(Array.from({ length: bytes }, (_, index) => (seed * 31 + index * 7) % 256)).toString("base64");
}
const K1 = testKey(1);
const K2 = testKey(2);
const AUTH = "auth-secret-for-key-ring-tests-0123456789abcdef";

const savedEnv = { ...process.env };
beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.DATA_ENCRYPTION_KEYS;
  delete process.env.NEXTAUTH_SECRET;
  process.env.AUTH_SECRET = AUTH;
});
afterEach(() => {
  process.env = { ...savedEnv };
});

describe("parseDataEncryptionKeys (#4456)", () => {
  it("treats a blank value as unset", () => {
    expect(parseDataEncryptionKeys(undefined)).toEqual({ status: "unset" });
    expect(parseDataEncryptionKeys("   ")).toEqual({ status: "unset" });
  });

  it("parses a ring in order, the first entry current, tolerating spaces and url-safe base64", () => {
    const urlSafe = K2.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const state = parseDataEncryptionKeys(` k2026:${K1} , k2025 : ${urlSafe} `);
    expect(state.status).toBe("configured");
    if (state.status !== "configured") return;
    expect(state.current.id).toBe("k2026");
    expect(state.keys.map((key) => key.id)).toEqual(["k2026", "k2025"]);
  });

  it.each([
    ["an entry with no id", `${K1}`, /entry 1 is not in the form/],
    ["an empty id", `:${K1}`, /entry 1 is not in the form/],
    ["an id with a space", `bad id:${K1}`, /entry 1 has an id/],
    ["the reserved legacy id", `${LEGACY_AUTH_SECRET_KEY_ID}:${K1}`, /reserved id/],
    ["a duplicate id", `k1:${K1},k1:${K2}`, /"k1" appears more than once/],
    ["a key that is not base64", "k1:not base64!!", /not valid base64/],
    ["a short key", `k1:${testKey(3, 16)}`, /16 bytes; every key must be exactly 32/],
    ["a long key", `k1:${testKey(3, 48)}`, /48 bytes/],
    ["a key repeating one byte", `k1:${Buffer.alloc(32).toString("base64")}`, /repeats one byte/],
    ["the same key under two ids", `k1:${K1},k2:${K1}`, /repeats an earlier entry's key/],
    ["a trailing empty entry", `k1:${K1},`, /entry 2 is not in the form/],
  ])("refuses %s as a whole ring", (_label, raw, reason) => {
    const state = parseDataEncryptionKeys(raw);
    expect(state.status).toBe("invalid");
    if (state.status !== "invalid") return;
    expect(state.reason).toMatch(reason);
    expect(state.reason).toMatch(/^DATA_ENCRYPTION_KEYS: /);
    // A refusal names a position or an id, never the value it refused.
    expect(state.reason).not.toContain(K1);
    expect(state.reason).not.toContain(K2);
    expect(state.reason).not.toContain("not base64!!");
  });
});

describe("which key a write, a read and a lookup use (#4456)", () => {
  it("with no ring, the current key is the legacy key and it is the only lookup key", () => {
    expect(readDataKeyRing()).toEqual({ status: "unset" });
    expect(currentDataKey()?.id).toBe(LEGACY_AUTH_SECRET_KEY_ID);
    expect(codeHashKeys().map((key) => key.id)).toEqual([LEGACY_AUTH_SECRET_KEY_ID]);
    expect(legacySecretOf(currentDataKey()!)).toBe(AUTH);
  });

  it("with no ring and no auth secret there is no key at all", () => {
    delete process.env.AUTH_SECRET;
    expect(currentDataKey()).toBeNull();
    expect(codeHashKeys()).toEqual([]);
    expect(dataKeyById(LEGACY_AUTH_SECRET_KEY_ID)).toBeNull();
  });

  it("with a ring, writes use its first key and lookups use every ring key but never the legacy key", () => {
    process.env.DATA_ENCRYPTION_KEYS = `k2:${K2},k1:${K1}`;
    expect(currentDataKey()?.id).toBe("k2");
    expect(codeHashKeys().map((key) => key.id)).toEqual(["k2", "k1"]);
  });

  it("a read gets exactly the key a row names, the legacy key included, and null for one not held", () => {
    process.env.DATA_ENCRYPTION_KEYS = `k2:${K2},k1:${K1}`;
    expect(dataKeyById("k1")?.id).toBe("k1");
    expect(dataKeyById(LEGACY_AUTH_SECRET_KEY_ID)?.legacy).toBe(true);
    expect(dataKeyById("k0")).toBeNull();
  });

  it("an invalid ring fails closed for writes and ring reads, but leaves legacy reads alone", () => {
    process.env.DATA_ENCRYPTION_KEYS = `k1:${testKey(4, 8)}`;
    expect(() => currentDataKey()).toThrow(DataKeyRingError);
    expect(() => dataKeyById("k1")).toThrow(DataKeyRingError);
    expect(() => codeHashKeys()).toThrow(DataKeyRingError);
    expect(dataKeyById(LEGACY_AUTH_SECRET_KEY_ID)?.legacy).toBe(true);
  });

  it("re-reads the variable when it changes", () => {
    process.env.DATA_ENCRYPTION_KEYS = `k1:${K1}`;
    expect(currentDataKey()?.id).toBe("k1");
    process.env.DATA_ENCRYPTION_KEYS = `k2:${K2},k1:${K1}`;
    expect(currentDataKey()?.id).toBe("k2");
  });

  it("derives an independent sub-key per purpose and per key, and none from the legacy key", () => {
    process.env.DATA_ENCRYPTION_KEYS = `k2:${K2},k1:${K1}`;
    const [k2, k1] = codeHashKeys();
    expect(deriveDataSubkey(k2!, "a")).toHaveLength(32);
    expect(deriveDataSubkey(k2!, "a").equals(deriveDataSubkey(k2!, "b"))).toBe(false);
    expect(deriveDataSubkey(k2!, "a").equals(deriveDataSubkey(k1!, "a"))).toBe(false);
    expect(() => deriveDataSubkey(dataKeyById(LEGACY_AUTH_SECRET_KEY_ID)!, "a")).toThrow(DataKeyRingError);
    expect(() => legacySecretOf(k1!)).toThrow(DataKeyRingError);
  });
});

describe("no key material reaches a log, an error or a report (#4456)", () => {
  it("a key shows its id alone when stringified, inspected or spread", () => {
    process.env.DATA_ENCRYPTION_KEYS = `k1:${K1}`;
    const key = currentDataKey()!;
    const legacy = dataKeyById(LEGACY_AUTH_SECRET_KEY_ID)!;
    const views = [JSON.stringify({ key, legacy }), inspect(key), inspect(legacy), JSON.stringify({ ...key }), String(key)];
    for (const view of views) {
      expect(view).not.toContain(K1);
      expect(view).not.toContain(Buffer.from(K1, "base64").toString("hex"));
      expect(view).not.toContain(AUTH);
    }
    expect(inspect(key)).toBe("DataKey(k1)");
  });

  it("every path a ring or a credential takes emits nothing holding a key or the auth secret", () => {
    const thrown: unknown[] = [];
    const capture = (work: () => unknown) => {
      try {
        work();
      } catch (error) {
        thrown.push(error instanceof Error ? { ...error, name: error.name, message: error.message } : error);
      }
    };
    const consoleSpies = (["log", "info", "warn", "error", "debug"] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => {}),
    );
    try {
      process.env.DATA_ENCRYPTION_KEYS = `k2:${K2},k1:${K1}`;
      const ring = encryptCredential({ provider: "xero", key: "client_secret", plaintext: "v" });
      capture(() => decryptCredential({ ...ring, provider: "xero", key: "client_secret" }));
      capture(() => decryptCredential({ ...ring, provider: "xero", key: "client_secret", secretSource: "DATA_ENCRYPTION_KEY:k9" }));
      capture(() => decryptCredential({ ...ring, provider: "xero", key: "client_secret", secretSource: "DATA_ENCRYPTION_KEY:k1" }));
      process.env.DATA_ENCRYPTION_KEYS = `k2:${K2},k1:${testKey(5, 12)}`;
      capture(() => encryptCredential({ provider: "xero", key: "client_secret", plaintext: "v" }));
      capture(() => decryptCredential({ ...ring, provider: "xero", key: "client_secret" }));
      const report = buildDataEncryptionKeyCheck(process.env.DATA_ENCRYPTION_KEYS, undefined);
      const emitted = JSON.stringify([
        thrown,
        report,
        Object.values(mocks.logger).map((fn) => fn.mock.calls),
        consoleSpies.map((spy) => spy.mock.calls),
      ]);
      expect(thrown.length).toBeGreaterThanOrEqual(4);
      expect(thrown.some((error) => (error as Error).name === WeakAuthSecretError.name)).toBe(true);
      for (const secret of [K1, K2, testKey(5, 12), AUTH]) {
        expect(emitted).not.toContain(secret);
      }
      for (const material of [K1, K2]) {
        expect(emitted).not.toContain(Buffer.from(material, "base64").toString("hex"));
      }
    } finally {
      for (const spy of consoleSpies) spy.mockRestore();
    }
  });
});
