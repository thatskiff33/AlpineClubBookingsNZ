import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Every other credential provider in the repo carries a `*-config.test.ts` —
 * xero, stripe, google, ai-assistant, ai-diagnostics, backup. This is the
 * ServerNZ one, and it exists mainly to pin the EXPOSURE contract: the setup
 * surfaces must read metadata only, and `isServerNzConfigured` must fail closed.
 */

const mocks = vi.hoisted(() => ({
  credFindFirst: vi.fn(),
  getIntegrationCredentialValue: vi.fn(),
  setIntegrationCredential: vi.fn(),
  deleteIntegrationCredential: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: { integrationCredential: { findFirst: mocks.credFindFirst } },
}));

vi.mock("@/lib/integration-credentials", () => ({
  getIntegrationCredentialValue: mocks.getIntegrationCredentialValue,
  setIntegrationCredential: mocks.setIntegrationCredential,
  deleteIntegrationCredential: mocks.deleteIntegrationCredential,
}));

import {
  SERVERNZ_PROVIDER,
  SERVERNZ_CREDENTIAL_KEYS,
  SERVERNZ_WRITABLE_CREDENTIAL_KEYS,
  getOperationalServerNzApiKey,
  setServerNzApiKey,
  clearServerNzApiKey,
  getServerNzSetupState,
  isServerNzConfigured,
} from "@/lib/servernz-config";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ServerNZ credential wiring", () => {
  it("reads and writes under the provider namespace the write allowlist knows", () => {
    // The credential route's WRITABLE_CREDENTIALS allowlist is keyed on these,
    // and that allowlist is what inherits the Full-Admin POST gate. A drift here
    // would silently move the key outside that gate.
    expect(SERVERNZ_PROVIDER).toBe("servernz");
    expect(SERVERNZ_WRITABLE_CREDENTIAL_KEYS).toEqual([
      SERVERNZ_CREDENTIAL_KEYS.apiKey,
    ]);
  });

  it("resolves the operational key from the encrypted store", async () => {
    mocks.getIntegrationCredentialValue.mockResolvedValue("acs_live_key");
    await expect(getOperationalServerNzApiKey()).resolves.toBe("acs_live_key");
    expect(mocks.getIntegrationCredentialValue).toHaveBeenCalledWith(
      "servernz",
      "api_key",
    );
  });

  it("reports an absent key as undefined rather than null", async () => {
    mocks.getIntegrationCredentialValue.mockResolvedValue(null);
    await expect(getOperationalServerNzApiKey()).resolves.toBeUndefined();
  });

  it("stores and clears the key through the encrypted-credential helpers", async () => {
    // The actor is REQUIRED (#2723): this helper used to take an optional
    // `updatedByUserId`, so an admin action could reach the store attributed
    // to nobody and store the same NULL a background writer stores.
    const actor = { kind: "admin", memberId: "member-1" } as const;
    await setServerNzApiKey("acs_new", actor);
    expect(mocks.setIntegrationCredential).toHaveBeenCalledWith({
      provider: "servernz",
      key: "api_key",
      value: "acs_new",
      actor,
      expect: { expect: "any" },
    });

    await clearServerNzApiKey(actor);
    expect(mocks.deleteIntegrationCredential).toHaveBeenCalledWith({
      provider: "servernz",
      key: "api_key",
      actor,
      expect: { expect: "any" },
    });
  });
});

describe("setup state exposure", () => {
  it("selects METADATA ONLY — never the value, ciphertext, iv or authTag", async () => {
    mocks.credFindFirst.mockResolvedValue({ updatedAt: new Date("2026-08-14T00:00:00Z") });

    const state = await getServerNzSetupState();

    // This is the exposure contract, asserted on the QUERY rather than on the
    // return value: a future edit that widened the select would still produce a
    // correct-looking result object while putting the ciphertext one property
    // access away from a server component.
    expect(mocks.credFindFirst).toHaveBeenCalledWith({
      where: { provider: "servernz", key: "api_key" },
      select: { updatedAt: true },
    });
    expect(state).toEqual({
      apiKeySet: true,
      apiKeyUpdatedAt: "2026-08-14T00:00:00.000Z",
    });
    expect(JSON.stringify(state)).not.toContain("acs_");
  });

  it("reports not-set when no row exists", async () => {
    mocks.credFindFirst.mockResolvedValue(null);
    await expect(getServerNzSetupState()).resolves.toEqual({
      apiKeySet: false,
      apiKeyUpdatedAt: null,
    });
  });

  it("fails CLOSED when the database read throws", async () => {
    // Readiness must never report "configured" on the strength of an error —
    // that would show a connected-looking integration with no key behind it.
    mocks.credFindFirst.mockRejectedValue(new Error("database unavailable"));
    await expect(isServerNzConfigured()).resolves.toBe(false);
  });

  it("propagates the database error to a caller that asked for detail", async () => {
    // `getServerNzSetupState` deliberately does NOT swallow: only the readiness
    // helper above is fail-closed, so a setup page can still surface a real fault.
    mocks.credFindFirst.mockRejectedValue(new Error("database unavailable"));
    await expect(getServerNzSetupState()).rejects.toThrow("database unavailable");
  });
});
