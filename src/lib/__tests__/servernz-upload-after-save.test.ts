import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Uploading the club's own lodge straight after "Edit my Lodge" saves it
 * (server onboarding, B4): under the sync claim, never failing the save, and
 * audited as the Upload button is.
 */

const mocks = vi.hoisted(() => ({
  loadServerNzSettings: vi.fn(),
  assertStoredServerVersionMatches: vi.fn(),
  upload: vi.fn(),
  claim: vi.fn(),
  audit: vi.fn(),
  auditFailure: vi.fn(),
  NotConfigured: class NotConfigured extends Error {},
  Paused: class Paused extends Error {},
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/servernz-settings", () => ({ loadServerNzSettings: mocks.loadServerNzSettings }));
vi.mock("@/lib/servernz-api", () => ({
  assertStoredServerVersionMatches: mocks.assertStoredServerVersionMatches,
  ServerNzNotConfiguredError: mocks.NotConfigured,
  ServerNzVersionMismatchError: mocks.Paused,
}));
vi.mock("@/lib/servernz-other-lodges-sync", () => ({ uploadOtherClubsToServer: mocks.upload }));
vi.mock("@/lib/servernz-sync-claim", () => ({ withOtherLodgesSyncClaim: mocks.claim }));
vi.mock("@/lib/servernz-sync-response", () => ({ auditSyncFailure: mocks.auditFailure, auditUpload: mocks.audit }));
vi.mock("@/lib/logger", () => ({ default: { warn: vi.fn() } }));

import { uploadOtherClubsAfterSave } from "@/lib/servernz-upload-after-save";

const SENT = { created: 0, updated: 1, unchanged: 0, skipped: 0, results: [], sent: 1 };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.loadServerNzSettings.mockResolvedValue({ otherLodgesEnabled: true, baseUrl: "https://acs.example.nz", serverVersion: "2.4" });
  mocks.claim.mockImplementation(async (fn: () => Promise<unknown>) => fn());
  mocks.upload.mockResolvedValue(SENT);
});

describe("uploadOtherClubsAfterSave", () => {
  it("uploads under the sync claim and audits it for the saving administrator", async () => {
    await expect(uploadOtherClubsAfterSave("admin-1")).resolves.toEqual({ status: "uploaded", sent: 1 });
    expect(mocks.claim).toHaveBeenCalledTimes(1);
    expect(mocks.audit).toHaveBeenCalledWith(SENT, "admin-1", expect.stringContaining("after the lodge was saved"));
  });

  it("sends nothing while sharing is off", async () => {
    mocks.loadServerNzSettings.mockResolvedValue({ otherLodgesEnabled: false, baseUrl: null, serverVersion: null });
    await expect(uploadOtherClubsAfterSave("admin-1")).resolves.toEqual({ status: "sharing-off" });
    expect(mocks.claim).not.toHaveBeenCalled();
  });

  it("leaves it to the running pass when another holds the claim", async () => {
    mocks.claim.mockResolvedValue(null);
    await expect(uploadOtherClubsAfterSave("admin-1")).resolves.toEqual({ status: "running" });
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("reports a version pause before taking the claim, audited", async () => {
    mocks.assertStoredServerVersionMatches.mockImplementationOnce(() => {
      throw new mocks.Paused("paused");
    });
    await expect(uploadOtherClubsAfterSave("admin-1")).resolves.toEqual({ status: "paused" });
    expect(mocks.claim).not.toHaveBeenCalled();
    expect(mocks.auditFailure).toHaveBeenCalledWith(expect.any(mocks.Paused), "admin-1", "upload");
  });

  it("never throws: a failed upload is reported, and an unconfigured site is not audited", async () => {
    mocks.upload.mockRejectedValueOnce(new Error("unreachable"));
    await expect(uploadOtherClubsAfterSave("admin-1")).resolves.toEqual({ status: "failed" });
    expect(mocks.auditFailure).toHaveBeenCalledTimes(1);

    mocks.upload.mockRejectedValueOnce(new mocks.NotConfigured("no key"));
    await expect(uploadOtherClubsAfterSave("admin-1")).resolves.toEqual({ status: "not-configured" });
    expect(mocks.auditFailure).toHaveBeenCalledTimes(1);

    mocks.upload.mockRejectedValueOnce(new Error("unreachable"));
    mocks.auditFailure.mockRejectedValueOnce(new Error("audit down"));
    await expect(uploadOtherClubsAfterSave("admin-1")).resolves.toEqual({ status: "failed" });
  });

  it("reports an unknown owned list without auditing an upload that sent nothing", async () => {
    mocks.upload.mockResolvedValue({ ...SENT, sent: 0, ownedUnknown: true });
    await expect(uploadOtherClubsAfterSave("admin-1")).resolves.toEqual({ status: "owned-unknown" });
    expect(mocks.audit).not.toHaveBeenCalled();
  });
});
