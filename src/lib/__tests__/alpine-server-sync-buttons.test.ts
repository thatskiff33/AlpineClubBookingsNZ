import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Alpine Central Server Upload and Download buttons take the SAME sync
 * claim as the nightly pass (#66): a press while another pass holds it sends
 * nothing and answers 409 with `sync-already-running`; a free claim runs the
 * sync and is released afterwards, even when the sync throws. The real claim
 * module runs against a faked settings row.
 */

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  requireActiveSessionUser: vi.fn(),
  claimUpdateMany: vi.fn(),
  loadServerNzSettings: vi.fn(),
  upload: vi.fn(),
  download: vi.fn(),
  createAuditLog: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/session-guards", async () => ({
  requireAdmin: (await import("./helpers/require-admin-mock")).evaluateRequireAdminMock,
  requireActiveSessionUser: mocks.requireActiveSessionUser,
}));
vi.mock("@/lib/prisma", () => ({
  prisma: { serverNzSettings: { updateMany: mocks.claimUpdateMany } },
}));
vi.mock("@/lib/servernz-settings", () => ({
  SERVERNZ_SETTINGS_ID: "default",
  loadServerNzSettings: mocks.loadServerNzSettings,
}));
vi.mock("@/lib/servernz-other-lodges-sync", () => ({
  uploadOtherClubsToServer: mocks.upload,
  downloadOtherClubsFromServer: mocks.download,
}));
vi.mock("@/lib/audit", () => ({ createAuditLog: mocks.createAuditLog }));
vi.mock("@/lib/logger", () => ({ default: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { POST as uploadPOST } from "@/app/api/admin/alpine-server/other-lodges/upload/route";
import { POST as downloadPOST } from "@/app/api/admin/alpine-server/other-lodges/download/route";
import { ServerNzApiError } from "@/lib/servernz-api";

const adminSession = { user: { id: "admin-1", role: "ADMIN", accessRoles: ["ADMIN"] } };

const UPLOADED = { created: 0, updated: 1, unchanged: 0, skipped: 0, results: [], sent: 1 };
const DOWNLOADED = {
  fetched: 1,
  created: 0,
  updated: 1,
  unchanged: 0,
  keptLocal: 0,
  renamed: 0,
  nameConflicts: [],
  hiddenLodges: [],
  dropped: 0,
};

const buttons = [
  ["Upload", uploadPOST, mocks.upload, UPLOADED],
  ["Download", downloadPOST, mocks.download, DOWNLOADED],
] as const;

/** The claim's first updateMany is the claim; the second is the release. */
function claimHeldElsewhere() {
  mocks.claimUpdateMany.mockResolvedValueOnce({ count: 0 });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue(adminSession);
  mocks.requireActiveSessionUser.mockResolvedValue(null);
  mocks.loadServerNzSettings.mockResolvedValue({ otherLodgesEnabled: true });
  mocks.claimUpdateMany.mockResolvedValue({ count: 1 });
  mocks.upload.mockResolvedValue(UPLOADED);
  mocks.download.mockResolvedValue(DOWNLOADED);
  mocks.createAuditLog.mockResolvedValue(undefined);
});

describe.each(buttons)("the %s button and the sync claim (#66)", (_label, POST, sync, answer) => {
  it("runs the sync while holding the claim, then releases it", async () => {
    const response = await POST();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(answer);
    expect(sync).toHaveBeenCalledTimes(1);
    const [claim, release] = mocks.claimUpdateMany.mock.calls;
    expect(claim[0].where.OR).toBeDefined();
    expect(release[0].data).toEqual({ otherLodgesSyncStartedAt: null });
    // The claim was taken before the sync ran.
    expect(mocks.claimUpdateMany.mock.invocationCallOrder[0]).toBeLessThan(
      sync.mock.invocationCallOrder[0],
    );
  });

  it("answers 409 with sync-already-running and sends NOTHING while another pass holds the claim", async () => {
    claimHeldElsewhere();

    const response = await POST();

    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.code).toBe("sync-already-running");
    expect(body.error).toMatch(/another sync with the alpine central server is running/i);
    expect(body.error).toMatch(/try again in a minute/i);
    expect(body.error).toMatch(/clears within 15 minutes/i);
    expect(sync).not.toHaveBeenCalled();
    // Nothing was attempted, so nothing is audited and nothing is released.
    expect(mocks.createAuditLog).not.toHaveBeenCalled();
    expect(mocks.claimUpdateMany).toHaveBeenCalledTimes(1);
  });

  it("releases the claim when the sync fails, and still answers the failure as before", async () => {
    sync.mockRejectedValueOnce(new ServerNzApiError(503, "Service unavailable"));

    const response = await POST();

    expect(response.status).toBe(502);
    expect(mocks.claimUpdateMany).toHaveBeenCalledTimes(2);
    expect(mocks.claimUpdateMany.mock.calls[1][0].data).toEqual({ otherLodgesSyncStartedAt: null });
    expect(mocks.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "failure" }),
    );
  });

  it("answers a recorded version pause as a pause, BEFORE taking the claim", async () => {
    mocks.loadServerNzSettings.mockResolvedValue({
      otherLodgesEnabled: true,
      baseUrl: "https://central.test",
      serverVersion: "9.9",
    });

    const response = await POST();

    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.code).toBe("server-version-mismatch");
    expect(body.serverVersion).toBe("9.9");
    expect(mocks.claimUpdateMany).not.toHaveBeenCalled();
    expect(sync).not.toHaveBeenCalled();
    // Audited as a paused press, as before #66.
    expect(mocks.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "failure", summary: expect.stringMatching(/paused/) }),
    );
  });

  it("leaves a site with no server address to the sync's own 'not configured' answer", async () => {
    mocks.loadServerNzSettings.mockResolvedValue({ otherLodgesEnabled: true, baseUrl: null, serverVersion: "9.9" });

    await POST();

    // Not refused as a version pause: the sync ran (and would say "not configured").
    expect(sync).toHaveBeenCalledTimes(1);
  });

  it("does not take the claim at all while sharing is switched off", async () => {
    mocks.loadServerNzSettings.mockResolvedValue({ otherLodgesEnabled: false });

    const response = await POST();

    expect(response.status).toBe(409);
    expect(mocks.claimUpdateMany).not.toHaveBeenCalled();
    expect(sync).not.toHaveBeenCalled();
  });
});
