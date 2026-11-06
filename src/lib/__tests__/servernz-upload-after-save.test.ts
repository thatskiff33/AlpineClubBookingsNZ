import { readFileSync } from "node:fs";
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

import { OTHER_LODGES_UPLOAD_PERMISSION, uploadOtherClubsAfterSave } from "@/lib/servernz-upload-after-save";

const SENT = { created: 0, updated: 1, unchanged: 0, skipped: 0, results: [], sent: 1, accepted: 1 };

// Saved by an administrator who may also press Upload (Finance edit), and by
// one who holds Lodges edit only (#4720 review).
const FINANCE = { id: "admin-1", canLogin: true, adminPermissionMatrix: { lodge: "edit", finance: "edit" } };
const LODGES_ONLY = { id: "admin-2", canLogin: true, adminPermissionMatrix: { lodge: "edit", finance: "view" } };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.loadServerNzSettings.mockResolvedValue({ otherLodgesEnabled: true, baseUrl: "https://acs.example.nz", serverVersion: "2.4" });
  mocks.claim.mockImplementation(async (fn: () => Promise<unknown>) => fn());
  mocks.upload.mockResolvedValue(SENT);
});

describe("uploadOtherClubsAfterSave", () => {
  it("uploads under the sync claim and audits it for the saving administrator", async () => {
    await expect(uploadOtherClubsAfterSave(FINANCE)).resolves.toEqual({ status: "uploaded", sent: 1, accepted: 1 });
    expect(mocks.claim).toHaveBeenCalledTimes(1);
    expect(mocks.audit).toHaveBeenCalledWith(SENT, "admin-1", expect.stringContaining("after the lodge was saved"));
  });

  it("sends nothing while sharing is off", async () => {
    mocks.loadServerNzSettings.mockResolvedValue({ otherLodgesEnabled: false, baseUrl: null, serverVersion: null });
    await expect(uploadOtherClubsAfterSave(FINANCE)).resolves.toEqual({ status: "sharing-off" });
    expect(mocks.claim).not.toHaveBeenCalled();
  });

  it("leaves it to the running pass when another holds the claim", async () => {
    mocks.claim.mockResolvedValue(null);
    await expect(uploadOtherClubsAfterSave(FINANCE)).resolves.toEqual({ status: "running" });
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("reports a version pause before taking the claim, audited", async () => {
    mocks.assertStoredServerVersionMatches.mockImplementationOnce(() => {
      throw new mocks.Paused("paused");
    });
    await expect(uploadOtherClubsAfterSave(FINANCE)).resolves.toEqual({ status: "paused" });
    expect(mocks.claim).not.toHaveBeenCalled();
    expect(mocks.auditFailure).toHaveBeenCalledWith(expect.any(mocks.Paused), "admin-1", "upload");
  });

  it("never throws: a failed upload is reported, and an unconfigured site is not audited", async () => {
    mocks.upload.mockRejectedValueOnce(new Error("unreachable"));
    await expect(uploadOtherClubsAfterSave(FINANCE)).resolves.toEqual({ status: "failed" });
    expect(mocks.auditFailure).toHaveBeenCalledTimes(1);

    mocks.upload.mockRejectedValueOnce(new mocks.NotConfigured("no key"));
    await expect(uploadOtherClubsAfterSave(FINANCE)).resolves.toEqual({ status: "not-configured" });
    expect(mocks.auditFailure).toHaveBeenCalledTimes(1);

    mocks.upload.mockRejectedValueOnce(new Error("unreachable"));
    mocks.auditFailure.mockRejectedValueOnce(new Error("audit down"));
    await expect(uploadOtherClubsAfterSave(FINANCE)).resolves.toEqual({ status: "failed" });
  });

  it("reports an unknown owned list without auditing an upload that sent nothing", async () => {
    mocks.upload.mockResolvedValue({ ...SENT, sent: 0, ownedUnknown: true });
    await expect(uploadOtherClubsAfterSave(FINANCE)).resolves.toEqual({ status: "owned-unknown" });
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("leaves the change to the nightly sync for an administrator without Finance edit", async () => {
    await expect(uploadOtherClubsAfterSave(LODGES_ONLY)).resolves.toEqual({ status: "no-upload-permission" });
    expect(mocks.loadServerNzSettings).not.toHaveBeenCalled();
    expect(mocks.claim).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
    expect(mocks.auditFailure).not.toHaveBeenCalled();
  });

  it("carries a refused lodge into the outcome, so the panel does not say sent", async () => {
    mocks.upload.mockResolvedValue({ ...SENT, updated: 0, skipped: 1, accepted: 0 });
    await expect(uploadOtherClubsAfterSave(FINANCE)).resolves.toEqual({ status: "uploaded", sent: 1, accepted: 0 });
    expect(mocks.audit).toHaveBeenCalledTimes(1);
  });

  it("writes no upload audit row when nothing was sent", async () => {
    mocks.upload.mockResolvedValue({ ...SENT, updated: 0, sent: 0, accepted: 0 });
    await expect(uploadOtherClubsAfterSave(FINANCE)).resolves.toEqual({ status: "uploaded", sent: 0, accepted: 0 });
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("reports an unreadable owned list as its own outcome, not as already sent", async () => {
    mocks.upload.mockResolvedValue({ ...SENT, updated: 0, sent: 0, accepted: 0, ownedUnreadable: true });
    await expect(uploadOtherClubsAfterSave(FINANCE)).resolves.toEqual({ status: "owned-unreadable" });
    expect(mocks.audit).not.toHaveBeenCalled();
  });
});

describe("OTHER_LODGES_UPLOAD_PERMISSION", () => {
  it("is the Upload button's gate, which that route writes out for the authorization proof", () => {
    expect(OTHER_LODGES_UPLOAD_PERMISSION).toEqual({ area: "finance", level: "edit" });
    const route = readFileSync("src/app/api/admin/alpine-server/other-lodges/upload/route.ts", "utf8");
    expect(route).toContain('permission: { area: "finance", level: "edit" }');
  });
});
