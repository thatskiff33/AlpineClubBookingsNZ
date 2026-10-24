import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  settings: { baseUrl: "https://central.test", serverVersion: null as string | null, otherLodgesCursor: null as string | null, otherLodgesKeyedAt: null as string | null },
  key: { status: "configured", value: "key-A", version: "version-A" },
  depth: 0,
  record: vi.fn(),
  fetch: vi.fn(),
}));
vi.mock("@/lib/prisma", () => {
  const tx = { serverNzSettings: { findUnique: async () => ({ ...m.settings, otherLodgesSyncStartedAt: null }) } };
  return { prisma: { $transaction: async (work: (client: typeof tx) => Promise<unknown>) => {
    m.depth++;
    try { return await work(tx); } finally { m.depth--; }
  } } };
});
vi.mock("@/lib/servernz-settings", () => ({
  SERVERNZ_SETTINGS_ID: "default",
  lockServerNzSettings: vi.fn(),
  loadServerNzSettings: async () => ({ ...m.settings }),
  recordServerVersionCheck: m.record,
  validateCentralServerBaseUrl: (value: string) => ({ ok: true, value }),
}));
vi.mock("@/lib/integration-credentials", () => ({ readIntegrationCredentialRow: async () => ({ ...m.key }) }));
vi.mock("@/lib/servernz-config", () => ({
  SERVERNZ_PROVIDER: "servernz", SERVERNZ_CREDENTIAL_KEYS: { apiKey: "api_key" },
  getOperationalServerNzApiKey: async () => m.key.value,
}));
vi.mock("@/lib/logger", () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { captureServerNzSyncConnection, recordServerNzSyncVersion } from "@/lib/servernz-sync-connection";
import { pullOtherLodges } from "@/lib/servernz-api";

beforeEach(() => {
  vi.clearAllMocks();
  m.settings = { baseUrl: "https://central.test", serverVersion: null, otherLodgesCursor: null, otherLodgesKeyedAt: null };
  m.key = { status: "configured", value: "key-A", version: "version-A" };
  vi.stubGlobal("fetch", m.fetch);
});
afterEach(() => vi.unstubAllGlobals());

const response = (status: number) => new Response(JSON.stringify(status === 200
  ? { version: "2.6", match: true }
  : { code: "API_VERSION_MISMATCH", serverVersion: "2.5" }), { status });

describe("captured download version metadata", () => {
  it("discovers outside the transaction and persists under the snapshot fence", async () => {
    m.fetch.mockImplementation(async () => {
      expect(m.depth).toBe(0);
      return response(200);
    });
    await captureServerNzSyncConnection();
    expect(m.record).toHaveBeenCalledWith("2.6", expect.any(Date), expect.anything());
  });

  it("refuses a stored mismatch before fetching a transfer", async () => {
    m.settings.serverVersion = "2.5";
    await expect(captureServerNzSyncConnection()).rejects.toThrow(/version/i);
    expect(m.fetch).not.toHaveBeenCalled();
  });

  it.each([200, 409])("rejects late version answer HTTP %s after same-key ABA or address replacement", async (status) => {
    for (const replacement of ["same-key ABA", "address"] as const) {
      m.record.mockClear();
      m.settings.baseUrl = "https://central.test";
      m.key.version = "version-A";
      m.fetch.mockImplementation(async () => {
        expect(m.depth).toBe(0);
        if (replacement === "same-key ABA") m.key.version = "version-C";
        else m.settings.baseUrl = "https://new.test";
        return response(status);
      });
      await expect(captureServerNzSyncConnection()).rejects.toThrow(/superseded/);
      expect(m.record).not.toHaveBeenCalled();
    }
  });

  it("fences a download's own 409 metadata after its key was replaced", async () => {
    m.settings.serverVersion = "2.6";
    const snapshot = await captureServerNzSyncConnection();
    m.fetch.mockImplementation(async () => {
      expect(m.depth).toBe(0);
      m.key.version = "version-C";
      return response(409);
    });
    await expect(pullOtherLodges(null, snapshot.api, (answer) => recordServerNzSyncVersion(snapshot, answer)))
      .rejects.toThrow(/superseded/);
    expect(m.record).not.toHaveBeenCalled();
  });
});
