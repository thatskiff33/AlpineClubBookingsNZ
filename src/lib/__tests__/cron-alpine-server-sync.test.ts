import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadEffectiveModuleFlags: vi.fn(),
  loadServerNzSettings: vi.fn(),
  upload: vi.fn(),
  download: vi.fn(),
  withClaim: vi.fn(),
  checkServerVersion: vi.fn(),
}));

// #49: the version check runs first, before the claim; the service itself is
// pinned in servernz-version-check.test.ts.
vi.mock("@/lib/servernz-version-check", () => ({
  checkServerVersion: mocks.checkServerVersion,
}));

vi.mock("@/lib/module-settings", () => ({
  loadEffectiveModuleFlags: mocks.loadEffectiveModuleFlags,
}));

vi.mock("@/lib/servernz-settings", () => ({
  loadServerNzSettings: mocks.loadServerNzSettings,
  // The widened module graph now reads this constant through the sync claim.
  SERVERNZ_SETTINGS_ID: "default",
}));

// The claim is exercised on its own in servernz-sync-claim.test.ts; here it is a
// pass-through so these tests stay about the cron's own decisions. `withClaim`
// records that the pass ran INSIDE it.
vi.mock("@/lib/servernz-sync-claim", () => ({
  withOtherLodgesSyncClaim: mocks.withClaim,
}));

vi.mock("@/lib/servernz-other-lodges-sync", () => ({
  uploadOtherClubsToServer: mocks.upload,
  downloadOtherClubsFromServer: mocks.download,
}));

vi.mock("@/lib/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { syncOtherClubsWithServer } from "@/lib/cron-alpine-server-sync";
import {
  ServerNzNotConfiguredError,
  ServerNzVersionMismatchError,
} from "@/lib/servernz-api";

const VERSION_OK = {
  status: "match",
  serverVersion: "2.0",
  expected: "2.0",
  checkedAt: "2026-07-01T00:00:00.000Z",
  couldNotCheck: false,
};

const CONNECTED = {
  baseUrl: "https://central.test",
  otherLodgesEnabled: true,
  otherLodgesLastUploadAt: null,
  otherLodgesLastDownloadAt: null,
  otherLodgesCursor: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.loadEffectiveModuleFlags.mockResolvedValue({ alpineCentralServer: true });
  mocks.loadServerNzSettings.mockResolvedValue({ ...CONNECTED });
  mocks.withClaim.mockImplementation(async (fn: () => Promise<unknown>) => fn());
  mocks.checkServerVersion.mockResolvedValue(VERSION_OK);
  mocks.upload.mockResolvedValue({
    created: 1, updated: 0, unchanged: 0, skipped: 0, results: [], sent: 1,
  });
  mocks.download.mockResolvedValue({
    fetched: 2, created: 1, updated: 1, unchanged: 0, keptLocal: 0, dropped: 0,
  });
});

describe("syncOtherClubsWithServer", () => {
  it("does nothing at all when the module is switched off", async () => {
    // The module flag is the operator's off switch for OUTBOUND DATA SHARING, and
    // this cron path never passes through the route-feature gate — it is
    // authenticated with CRON_SECRET, not a session. Without this check, turning
    // the module off would 404 the setup page while the nightly upload continued.
    mocks.loadEffectiveModuleFlags.mockResolvedValue({ alpineCentralServer: false });

    const result = await syncOtherClubsWithServer();

    expect(result).toEqual({ status: "skipped", reason: "module-disabled" });
    expect(mocks.upload).not.toHaveBeenCalled();
    expect(mocks.download).not.toHaveBeenCalled();
    // Not even the settings are read: nothing about this club leaves the process.
    expect(mocks.loadServerNzSettings).not.toHaveBeenCalled();
  });

  it("skips when the club has not enabled the shared item", async () => {
    mocks.loadServerNzSettings.mockResolvedValue({
      ...CONNECTED,
      otherLodgesEnabled: false,
    });

    const result = await syncOtherClubsWithServer();

    expect(result).toEqual({ status: "skipped", reason: "other-lodges-sync-disabled" });
    expect(mocks.upload).not.toHaveBeenCalled();
  });

  it("skips when no central server has been configured", async () => {
    mocks.loadServerNzSettings.mockResolvedValue({ ...CONNECTED, baseUrl: null });

    const result = await syncOtherClubsWithServer();

    expect(result).toEqual({ status: "skipped", reason: "central-server-not-configured" });
    expect(mocks.upload).not.toHaveBeenCalled();
  });

  it("uploads BEFORE downloading, so local edits land before the merged set returns", async () => {
    const order: string[] = [];
    mocks.upload.mockImplementation(async () => {
      order.push("upload");
      return { created: 0, updated: 0, unchanged: 0, skipped: 0, results: [], sent: 0 };
    });
    mocks.download.mockImplementation(async () => {
      order.push("download");
      return { fetched: 0, created: 0, updated: 0, unchanged: 0, keptLocal: 0, dropped: 0 };
    });

    const result = await syncOtherClubsWithServer();

    expect(order).toEqual(["upload", "download"]);
    expect(result.status).toBe("synced");
  });

  it("reports an unconfigured connection as skipped rather than failing the job", async () => {
    // A missing API key surfaces from the API layer, not from settings — the job
    // should report SKIPPED so cron health shows an honest reason rather than a
    // red failure an operator cannot act on differently.
    mocks.upload.mockRejectedValue(
      new ServerNzNotConfiguredError("No Alpine Central Server API key is stored."),
    );

    const result = await syncOtherClubsWithServer();

    expect(result).toEqual({ status: "skipped", reason: "central-server-not-configured" });
  });

  it("lets a real transport failure propagate so the run is recorded as FAILURE", async () => {
    mocks.upload.mockRejectedValue(new Error("connection reset"));
    await expect(syncOtherClubsWithServer()).rejects.toThrow("connection reset");
  });
  it("checks the version FIRST and skips, before any claim, when the server differs (#49)", async () => {
    const order: string[] = [];
    mocks.checkServerVersion.mockImplementation(async () => {
      order.push("version");
      return { ...VERSION_OK, status: "mismatch", serverVersion: "2.1" };
    });
    mocks.withClaim.mockImplementation(async (fn: () => Promise<unknown>) => {
      order.push("claim");
      return fn();
    });

    const result = await syncOtherClubsWithServer();

    expect(result).toEqual({ status: "skipped", reason: "server-version-mismatch" });
    // No claim taken, nothing sent or pulled.
    expect(order).toEqual(["version"]);
    expect(mocks.upload).not.toHaveBeenCalled();
    expect(mocks.download).not.toHaveBeenCalled();
  });

  it("checks the version before the claim on a matching night too, and then syncs", async () => {
    const order: string[] = [];
    mocks.checkServerVersion.mockImplementation(async () => {
      order.push("version");
      return VERSION_OK;
    });
    mocks.withClaim.mockImplementation(async (fn: () => Promise<unknown>) => {
      order.push("claim");
      return fn();
    });
    expect((await syncOtherClubsWithServer()).status).toBe("synced");
    expect(order).toEqual(["version", "claim"]);
  });

  it("runs the check even when the Other Clubs item is disabled (default 2): the board rides the same version", async () => {
    mocks.loadServerNzSettings.mockResolvedValue({ ...CONNECTED, otherLodgesEnabled: false });
    const result = await syncOtherClubsWithServer();
    expect(mocks.checkServerVersion).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ status: "skipped", reason: "other-lodges-sync-disabled" });
  });

  it("does not pause on a check that could not reach the server", async () => {
    mocks.checkServerVersion.mockResolvedValue({ ...VERSION_OK, couldNotCheck: true });
    expect((await syncOtherClubsWithServer()).status).toBe("synced");
  });

  it("reports the gate's own refusal as the same skip, never a red run", async () => {
    // The pre-check allowed (a never-asked row); the inline self-heal inside
    // resolveConnection then recorded a differing answer and refused.
    mocks.checkServerVersion.mockResolvedValue({ ...VERSION_OK, status: "unchecked", serverVersion: "0" });
    mocks.upload.mockRejectedValue(new ServerNzVersionMismatchError("2.0", "2.1"));
    expect(await syncOtherClubsWithServer()).toEqual({
      status: "skipped",
      reason: "server-version-mismatch",
    });
  });

  it("skips without touching the server when another pass already holds the claim", async () => {
    // Cron and the admin buttons drive the same writers across containers; the
    // in-process boolean in instrumentation.node.ts sees neither.
    mocks.withClaim.mockResolvedValue(null);

    const result = await syncOtherClubsWithServer();

    expect(result).toEqual({ status: "skipped", reason: "sync-already-running" });
    expect(mocks.upload).not.toHaveBeenCalled();
    expect(mocks.download).not.toHaveBeenCalled();
  });
});
