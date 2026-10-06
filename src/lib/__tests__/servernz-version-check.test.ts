import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #49: the version check as a service. The fetch-and-record path is pinned in
 * servernz-api-version-gate.test.ts; here it is a seam, so these tests are
 * about what the service reports and when it makes no call at all.
 */

const mocks = vi.hoisted(() => ({
  refreshStoredServerVersion: vi.fn(),
  getServerNzSetupState: vi.fn(),
  loadServerNzSettings: vi.fn(),
}));

vi.mock("@/lib/servernz-api", () => ({
  refreshStoredServerVersion: mocks.refreshStoredServerVersion,
}));
vi.mock("@/lib/servernz-config", () => ({
  getServerNzSetupState: mocks.getServerNzSetupState,
}));
vi.mock("@/lib/servernz-settings", () => ({
  loadServerNzSettings: mocks.loadServerNzSettings,
}));

import {
  checkServerVersion,
  isServerSyncPaused,
  readStoredServerVersion,
} from "@/lib/servernz-version-check";

const CHECKED_AT = "2026-07-01T00:00:00.000Z";

function stored(serverVersion: string | null, checkedAt: string | null = CHECKED_AT) {
  mocks.loadServerNzSettings.mockResolvedValue({
    serverVersion,
    serverVersionCheckedAt: checkedAt,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getServerNzSetupState.mockResolvedValue({ apiKeySet: true, apiKeyUpdatedAt: null });
});

describe("checkServerVersion", () => {
  it("makes NO request and reports the server as 0 while no API key is stored", async () => {
    mocks.getServerNzSetupState.mockResolvedValue({ apiKeySet: false, apiKeyUpdatedAt: null });
    stored("9.9"); // a stale answer must not show through either

    const result = await checkServerVersion();

    expect(mocks.refreshStoredServerVersion).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: "no-key", serverVersion: "0", expected: "2.0", couldNotCheck: false });
  });

  it("asks, then reports the freshly stored answer as match or mismatch", async () => {
    mocks.refreshStoredServerVersion.mockResolvedValue("2.0");
    stored("2.0");
    expect(await checkServerVersion()).toMatchObject({ status: "match", serverVersion: "2.0", checkedAt: CHECKED_AT });

    mocks.refreshStoredServerVersion.mockResolvedValue("unknown");
    stored("unknown");
    expect(await checkServerVersion()).toMatchObject({ status: "mismatch", serverVersion: "unknown", couldNotCheck: false });
  });

  it("keeps the last known answer and says couldNotCheck when the call fails", async () => {
    mocks.refreshStoredServerVersion.mockResolvedValue(null);
    stored("2.0");
    const result = await checkServerVersion();
    // Still a match on the stored answer: a failed check is not a mismatch.
    expect(result).toMatchObject({ status: "match", serverVersion: "2.0", couldNotCheck: true });
  });

  it("reports unchecked, and allows, when a failed first check leaves the row NULL", async () => {
    mocks.refreshStoredServerVersion.mockResolvedValue(null);
    stored(null, null);
    const result = await checkServerVersion();
    expect(result).toMatchObject({ status: "unchecked", serverVersion: "0", couldNotCheck: true, checkedAt: null });
  });
});

describe("readStoredServerVersion (no network)", () => {
  it("never refreshes, and reads the stored answer against the key state", async () => {
    stored("2.1");
    expect(await readStoredServerVersion()).toMatchObject({ status: "mismatch", serverVersion: "2.1" });
    mocks.getServerNzSetupState.mockResolvedValue({ apiKeySet: false, apiKeyUpdatedAt: null });
    expect(await readStoredServerVersion()).toMatchObject({ status: "no-key", serverVersion: "0" });
    expect(mocks.refreshStoredServerVersion).not.toHaveBeenCalled();
  });
});

describe("isServerSyncPaused", () => {
  it("pauses only on a recorded, differing answer", async () => {
    stored(null);
    expect(await isServerSyncPaused()).toBe(false);
    stored("2.0");
    expect(await isServerSyncPaused()).toBe(false);
    stored("2.1");
    expect(await isServerSyncPaused()).toBe(true);
    stored("unknown");
    expect(await isServerSyncPaused()).toBe(true);
    // Settings only: no key lookup, no network.
    expect(mocks.getServerNzSetupState).not.toHaveBeenCalled();
    expect(mocks.refreshStoredServerVersion).not.toHaveBeenCalled();
  });
});
