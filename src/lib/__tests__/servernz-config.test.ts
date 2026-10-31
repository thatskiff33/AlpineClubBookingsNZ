import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Every other credential provider in the repo carries a `*-config.test.ts` —
 * xero, stripe, google, ai-assistant, ai-diagnostics, backup. This is the
 * ServerNZ one, and it exists mainly to pin the EXPOSURE contract: the setup
 * surfaces must read metadata only, and `isServerNzConfigured` must fail closed.
 */

const mocks = vi.hoisted(() => ({
  credFindFirst: vi.fn(),
  resolveIntegrationCredential: vi.fn(),
  readIntegrationCredentialRow: vi.fn(),
  setIntegrationCredential: vi.fn(),
  deleteIntegrationCredential: vi.fn(),
  tx: { serverNzSettings: { createMany: vi.fn(), findUnique: vi.fn() } },
  lockServerNzSettings: vi.fn(),
  forgetServerConnectionAnswers: vi.fn(),
}));

vi.mock("@/lib/servernz-settings", async (importOriginal) => ({
  // The real normaliser: the address check must agree with what is stored.
  normalizeBaseUrl: ((await importOriginal()) as typeof import("@/lib/servernz-settings")).normalizeBaseUrl,
  forgetServerConnectionAnswers: mocks.forgetServerConnectionAnswers,
  lockServerNzSettings: mocks.lockServerNzSettings,
  SERVERNZ_SETTINGS_ID: "default",
  SERVERNZ_TRANSACTION_OPTIONS: { timeout: 150_000, maxWait: 10_000 },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: { integrationCredential: { findFirst: mocks.credFindFirst } },
}));

vi.mock("@/lib/integration-credentials", () => ({
  resolveIntegrationCredential: mocks.resolveIntegrationCredential,
  readIntegrationCredentialRow: mocks.readIntegrationCredentialRow,
  setIntegrationCredential: mocks.setIntegrationCredential,
  deleteIntegrationCredentialInTransaction: mocks.deleteIntegrationCredential,
  setIntegrationCredentialInTransaction: mocks.setIntegrationCredential,
  withCredentialTransaction: async (_providers: unknown, work: (tx: unknown) => Promise<unknown>) => work(mocks.tx),
}));

import {
  SERVERNZ_PROVIDER,
  SERVERNZ_CREDENTIAL_KEYS,
  SERVERNZ_WRITABLE_CREDENTIAL_KEYS,
  getOperationalServerNzCredential,
  readServerNzCredentialVersion,
  setServerNzApiKey,
  clearServerNzApiKey,
  clearServerNzPushSecret,
  ServerNzAddressChangedError,
  withServerNzConnectionTransaction,
  getServerNzSetupState,
  isServerNzConfigured,
} from "@/lib/servernz-config";

const STORED_URL = "https://central.example.invalid";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.tx.serverNzSettings.findUnique.mockResolvedValue({ baseUrl: STORED_URL });
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

  it("resolves the operational key with the version of the row it came from (#4366)", async () => {
    mocks.readIntegrationCredentialRow.mockResolvedValue({
      status: "configured",
      value: "acs_live_key",
      version: "row-version-1",
    });
    await expect(getOperationalServerNzCredential({ integrationCredential: {} } as never)).resolves.toEqual({
      apiKey: "acs_live_key",
      version: "row-version-1",
    });
    expect(mocks.readIntegrationCredentialRow).toHaveBeenCalledWith(
      { integrationCredential: {} },
      "servernz",
      "api_key",
    );
  });

  it.each([
    { status: "not_configured" },
    { status: "needs_reentry", reason: "secret changed", version: "row-version-1" },
  ])("reports no usable key ($status) as undefined", async (resolution) => {
    mocks.readIntegrationCredentialRow.mockResolvedValue(resolution);
    await expect(getOperationalServerNzCredential({ integrationCredential: {} } as never)).resolves.toBeUndefined();
  });

  it("bypasses the provider cache for a fenced request read", async () => {
    const tx = { integrationCredential: {} };
    mocks.readIntegrationCredentialRow.mockResolvedValue({ status: "configured", value: "new-key", version: "new" });
    await expect(getOperationalServerNzCredential(tx as never)).resolves.toEqual({ apiKey: "new-key", version: "new" });
    expect(mocks.readIntegrationCredentialRow).toHaveBeenCalledWith(tx, "servernz", "api_key");
    expect(mocks.resolveIntegrationCredential).not.toHaveBeenCalled();
  });

  it("re-reads the key's version through the caller's client, under the provider namespace (#4366)", async () => {
    const tx = { integrationCredential: {} };
    mocks.readIntegrationCredentialRow.mockResolvedValue({ status: "configured", version: "row-version-2" });
    await expect(readServerNzCredentialVersion(tx as never)).resolves.toBe("row-version-2");
    expect(mocks.readIntegrationCredentialRow).toHaveBeenCalledWith(tx, "servernz", "api_key");
  });

  it("keeps an unreadable row's version and returns null only for an absent row", async () => {
    const tx = { integrationCredential: {} };
    mocks.readIntegrationCredentialRow.mockResolvedValueOnce({ status: "needs_reentry", version: "row-version-2" });
    await expect(readServerNzCredentialVersion(tx as never)).resolves.toBe("row-version-2");
    mocks.readIntegrationCredentialRow.mockResolvedValueOnce({ status: "not_configured" });
    await expect(readServerNzCredentialVersion(tx as never)).resolves.toBeNull();
  });

  it("stores and clears the key through the encrypted-credential helpers", async () => {
    // The actor is REQUIRED (#2723): this helper used to take an optional
    // `updatedByUserId`, so an admin action could reach the store attributed
    // to nobody and store the same NULL a background writer stores.
    const actor = { kind: "admin", memberId: "member-1" } as const;
    const request = { id: "req-1", ipAddress: "1.2.3.4", userAgent: "test" };
    const saved = { provider: "servernz", key: "api_key", updatedAt: new Date() };
    mocks.setIntegrationCredential.mockResolvedValueOnce(saved);
    // The credentials route's result is the store's own (#4436).
    await expect(setServerNzApiKey("acs_new", STORED_URL, actor, request)).resolves.toBe(saved);
    expect(mocks.setIntegrationCredential).toHaveBeenCalledWith({
      tx: mocks.tx,
      provider: "servernz",
      key: "api_key",
      value: "acs_new",
      actor,
      expect: { expect: "any" },
      request,
    });
    expect(mocks.lockServerNzSettings).toHaveBeenCalledWith(mocks.tx);
    expect(mocks.lockServerNzSettings.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.setIntegrationCredential.mock.invocationCallOrder[0]);

    await withServerNzConnectionTransaction((tx) => clearServerNzApiKey(actor, tx));
    expect(mocks.deleteIntegrationCredential).toHaveBeenCalledWith({
      tx: mocks.tx,
      provider: "servernz",
      key: "api_key",
      actor,
      expect: { expect: "any" },
    });
  });

  it("forgets connection answers on both replacement and address move (#4436)", async () => {
    // The list was the server's answer for THAT key; the next key may own
    // different lodges. (The settings route's address move removes the key
    // through `clearServerNzApiKey`, so it is covered too.)
    const actor = { kind: "admin", memberId: "member-1" } as const;
    await setServerNzApiKey("acs_new", STORED_URL, actor);
    expect(mocks.forgetServerConnectionAnswers).toHaveBeenCalledWith(mocks.tx);
    expect(mocks.setIntegrationCredential.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.forgetServerConnectionAnswers.mock.invocationCallOrder[0]);
    await withServerNzConnectionTransaction((tx) => clearServerNzApiKey(actor, tx));
    // #49: the server's last reported version was that connection's answer
    // too, and both are forgotten in the one write.
    expect(mocks.forgetServerConnectionAnswers).toHaveBeenCalledTimes(2);
    expect(mocks.forgetServerConnectionAnswers).toHaveBeenLastCalledWith(mocks.tx);
  });
});

describe("a key is saved only for the address the setup page showed (#4470)", () => {
  const actor = { kind: "admin", memberId: "member-1" } as const;

  it.each([
    ["the stored address exactly", STORED_URL],
    ["the same address with a trailing slash", `${STORED_URL}/`],
  ])("saves when the page showed %s", async (_label, shown) => {
    await setServerNzApiKey("acs_new", shown, actor);
    expect(mocks.setIntegrationCredential).toHaveBeenCalledTimes(1);
  });

  it("compares the stored address only after taking the settings-row lock", async () => {
    await setServerNzApiKey("acs_new", STORED_URL, actor);
    expect(mocks.tx.serverNzSettings.findUnique).toHaveBeenCalledWith({
      where: { id: "default" },
      select: { baseUrl: true },
    });
    expect(mocks.lockServerNzSettings.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.tx.serverNzSettings.findUnique.mock.invocationCallOrder[0]);
  });

  it.each([
    ["another address", "https://old.example.invalid"],
    ["no address", null],
    ["a blank address", ""],
  ])("refuses, writing nothing, when the page showed %s", async (_label, shown) => {
    await expect(setServerNzApiKey("acs_old_server", shown, actor))
      .rejects.toBeInstanceOf(ServerNzAddressChangedError);
    expect(mocks.setIntegrationCredential).not.toHaveBeenCalled();
    expect(mocks.forgetServerConnectionAnswers).not.toHaveBeenCalled();
  });

  it("refuses a page that showed an address once the stored one is removed", async () => {
    mocks.tx.serverNzSettings.findUnique.mockResolvedValue({ baseUrl: null });
    await expect(setServerNzApiKey("acs_old_server", STORED_URL, actor))
      .rejects.toBeInstanceOf(ServerNzAddressChangedError);
    expect(mocks.setIntegrationCredential).not.toHaveBeenCalled();
  });

  it("saves a first key on a page that showed no address while none is stored", async () => {
    mocks.tx.serverNzSettings.findUnique.mockResolvedValue({ baseUrl: null });
    await setServerNzApiKey("acs_first", null, actor);
    expect(mocks.setIntegrationCredential).toHaveBeenCalledTimes(1);
  });

  it("says what happened and what to do, without the key", () => {
    const message = new ServerNzAddressChangedError().message;
    expect(message).toMatch(/address was changed/);
    expect(message).toMatch(/Reload the page/);
  });
});

describe("the old server's push secret (#4470)", () => {
  it("is removed under the provider namespace, by the forwarded admin actor", async () => {
    const actor = { kind: "admin", memberId: "member-1" } as const;
    await withServerNzConnectionTransaction((tx) => clearServerNzPushSecret(actor, tx));
    expect(mocks.deleteIntegrationCredential).toHaveBeenCalledWith({
      tx: mocks.tx,
      provider: "servernz",
      key: "push_secret",
      actor,
      expect: { expect: "any" },
    });
    expect(SERVERNZ_CREDENTIAL_KEYS.pushSecret).toBe("push_secret");
    // Never admin-writable: the server issues it.
    expect(SERVERNZ_WRITABLE_CREDENTIAL_KEYS).not.toContain("push_secret");
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
