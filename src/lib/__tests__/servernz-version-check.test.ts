import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #49: the version check as a service. The fetch-and-record path is pinned in
 * servernz-api-version-gate.test.ts; here it is a seam, so these tests are
 * about what the service reports and when it makes no call at all.
 *
 * Clock frozen at 2026-07-01T00:00:00.000Z; the throttle fixtures are built
 * relative to that instant.
 */

const mocks = vi.hoisted(() => {
  class FakeNotConfigured extends Error {
    constructor() {
      super("The Alpine Central Server base URL is not set.");
      this.name = "ServerNzNotConfiguredError";
    }
  }
  return {
    FakeNotConfigured,
    refreshStoredServerVersion: vi.fn(),
    getServerNzSetupState: vi.fn(),
    loadServerNzSettings: vi.fn(),
  };
});

vi.mock("@/lib/servernz-api", () => ({
  ServerNzNotConfiguredError: mocks.FakeNotConfigured,
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
import { SERVER_VERSION_RECHECK_INTERVAL_MS } from "@/lib/servernz-api-version";

const NOW = new Date("2026-07-01T00:00:00.000Z");
const CHECKED_AT = "2026-06-30T23:00:00.000Z";

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
    expect(result).toMatchObject({ status: "no-key", serverVersion: "0", expected: "2.1", couldNotCheck: false, missingBaseUrl: false });
  });

  it("asks, then reports the freshly stored answer as match or mismatch", async () => {
    mocks.refreshStoredServerVersion.mockResolvedValue("2.1");
    stored("2.1");
    expect(await checkServerVersion()).toMatchObject({ status: "match", serverVersion: "2.1", checkedAt: CHECKED_AT });

    mocks.refreshStoredServerVersion.mockResolvedValue("unknown");
    stored("unknown");
    expect(await checkServerVersion()).toMatchObject({ status: "mismatch", serverVersion: "unknown", couldNotCheck: false });
  });

  it("keeps the last known answer and says couldNotCheck when the call fails", async () => {
    mocks.refreshStoredServerVersion.mockResolvedValue(null);
    stored("2.1");
    const result = await checkServerVersion();
    // Still a match on the stored answer: a failed check is not a mismatch.
    expect(result).toMatchObject({ status: "match", serverVersion: "2.1", couldNotCheck: true });
  });

  it("reports unchecked, and allows, when a failed first check leaves the row NULL", async () => {
    mocks.refreshStoredServerVersion.mockResolvedValue(null);
    stored(null, null);
    const result = await checkServerVersion();
    expect(result).toMatchObject({ status: "unchecked", serverVersion: "0", couldNotCheck: true, checkedAt: null });
  });

  it("reports a key without a usable address as missingBaseUrl, not as could-not-check (item 9)", async () => {
    mocks.refreshStoredServerVersion.mockRejectedValue(new mocks.FakeNotConfigured());
    stored(null, null);
    const result = await checkServerVersion();
    expect(result).toMatchObject({ status: "unchecked", couldNotCheck: false, missingBaseUrl: true });
  });

  it("lets a failure to record propagate (item 2)", async () => {
    mocks.refreshStoredServerVersion.mockRejectedValue(new Error("database unavailable"));
    stored("2.1");
    await expect(checkServerVersion()).rejects.toThrow(/database unavailable/);
  });

  describe("throttled (the setup page's route, item 5)", () => {
    it("returns the stored answer without a call when it was recorded inside the interval", async () => {
      stored("2.2", new Date(NOW.getTime() - SERVER_VERSION_RECHECK_INTERVAL_MS + 1000).toISOString());
      const result = await checkServerVersion({ throttle: true, now: NOW });
      expect(mocks.refreshStoredServerVersion).not.toHaveBeenCalled();
      expect(result).toMatchObject({ status: "mismatch", serverVersion: "2.2", couldNotCheck: false });
    });

    it("asks again once the interval has passed, or when never asked", async () => {
      mocks.refreshStoredServerVersion.mockResolvedValue("2.1");
      stored("2.1", new Date(NOW.getTime() - SERVER_VERSION_RECHECK_INTERVAL_MS).toISOString());
      await checkServerVersion({ throttle: true, now: NOW });
      stored(null, null);
      await checkServerVersion({ throttle: true, now: NOW });
      expect(mocks.refreshStoredServerVersion).toHaveBeenCalledTimes(2);
    });

    it("never throttles the untouched (cron/mirror) call", async () => {
      mocks.refreshStoredServerVersion.mockResolvedValue("2.1");
      stored("2.1", NOW.toISOString());
      await checkServerVersion();
      expect(mocks.refreshStoredServerVersion).toHaveBeenCalledTimes(1);
    });
  });
});

describe("readStoredServerVersion (no network)", () => {
  it("never refreshes, and reads the stored answer against the key state", async () => {
    stored("2.2");
    expect(await readStoredServerVersion()).toMatchObject({ status: "mismatch", serverVersion: "2.2" });
    mocks.getServerNzSetupState.mockResolvedValue({ apiKeySet: false, apiKeyUpdatedAt: null });
    expect(await readStoredServerVersion()).toMatchObject({ status: "no-key", serverVersion: "0" });
    expect(mocks.refreshStoredServerVersion).not.toHaveBeenCalled();
  });
});

describe("isServerSyncPaused", () => {
  it("pauses only on a recorded, differing answer", async () => {
    stored(null);
    expect(await isServerSyncPaused()).toBe(false);
    stored("2.1");
    expect(await isServerSyncPaused()).toBe(false);
    stored("2.2");
    expect(await isServerSyncPaused()).toBe(true);
    stored("unknown");
    expect(await isServerSyncPaused()).toBe(true);
    // Settings only: no key lookup, no network.
    expect(mocks.getServerNzSetupState).not.toHaveBeenCalled();
    expect(mocks.refreshStoredServerVersion).not.toHaveBeenCalled();
  });
});
