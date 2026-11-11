import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { recentAuthRefusalBody } from "@/lib/recent-auth";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  requireAdmin: vi.fn(),
  isFullAdmin: vi.fn(),
  actorIsFullAdmin: vi.fn(),
  requireFullAdminForConfigTransfer: vi.fn(),
  readBundleUpload: vi.fn(),
  resolveBackupConfig: vi.fn(),
  getActiveBackupRun: vi.fn(),
  restoreLocalBackup: vi.fn(),
  createAuditLog: vi.fn(),
  setIntegrationCredential: vi.fn(),
  deleteIntegrationCredential: vi.fn(),
  executeMemberMerge: vi.fn(),
  applyConfigImport: vi.fn(),
  processRefund: vi.fn(),
  refundPaymentTransactions: vi.fn(),
  escapeCsvCell: vi.fn((value: unknown) => String(value ?? "")),
}));

vi.mock("@/lib/officer-sign-in-switch", () => ({ OFFICER_SIGN_IN_ENFORCED: true }));
vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/session-guards", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/lib/access-roles", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...(actual as Record<string, unknown>), isFullAdmin: mocks.isFullAdmin };
});
vi.mock("@/lib/admin-account-guards", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...(actual as Record<string, unknown>), actorIsFullAdmin: mocks.actorIsFullAdmin };
});
vi.mock("@/lib/config-transfer/route-helpers", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...(actual as Record<string, unknown>),
    requireFullAdminForConfigTransfer: mocks.requireFullAdminForConfigTransfer,
    readBundleUpload: mocks.readBundleUpload,
  };
});
vi.mock("@/lib/backup-config", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...(actual as Record<string, unknown>), resolveBackupConfig: mocks.resolveBackupConfig };
});
vi.mock("@/lib/backup-run", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...(actual as Record<string, unknown>), getActiveBackupRun: mocks.getActiveBackupRun };
});
vi.mock("@/lib/backup-restore", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...(actual as Record<string, unknown>), restoreLocalBackup: mocks.restoreLocalBackup };
});
vi.mock("@/lib/audit", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...(actual as Record<string, unknown>), createAuditLog: mocks.createAuditLog };
});
vi.mock("@/lib/integration-credentials", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...(actual as Record<string, unknown>),
    setIntegrationCredential: mocks.setIntegrationCredential,
    deleteIntegrationCredential: mocks.deleteIntegrationCredential,
  };
});
vi.mock("@/lib/member-merge", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...(actual as Record<string, unknown>), executeMemberMerge: mocks.executeMemberMerge };
});
vi.mock("@/lib/config-transfer/apply", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...(actual as Record<string, unknown>), applyConfigImport: mocks.applyConfigImport };
});
vi.mock("@/lib/stripe", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...(actual as Record<string, unknown>), processRefund: mocks.processRefund };
});
vi.mock("@/lib/payment-transactions", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...(actual as Record<string, unknown>),
    refundPaymentTransactions: mocks.refundPaymentTransactions,
  };
});
vi.mock("@/lib/csv", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...(actual as Record<string, unknown>), escapeCsvCell: mocks.escapeCsvCell };
});

import { POST as restore } from "@/app/api/admin/backups/restore/route";
import { POST as backupConfig } from "@/app/api/admin/backups/config/route";
import { POST as createAccessRole } from "@/app/api/admin/access-roles/route";
import { POST as mergeMember } from "@/app/api/admin/members/[id]/merge/route";
import { POST as decideDeletion } from "@/app/api/admin/deletion-requests/[id]/route";
import { POST as applyConfig } from "@/app/api/admin/config-transfer/apply/route";
import { PUT as savePasswordPolicy } from "@/app/api/admin/security/password-policy/route";
import { PUT as decideRefund } from "@/app/api/admin/refund-requests/[id]/route";
import { GET as exportMembers } from "@/app/api/admin/members/export/route";

const admin = {
  ok: true as const,
  session: { user: { id: "admin-1", accessRoles: ["ADMIN"] } },
};

function unread() {
  const request = new Request("https://club.example/api/admin/step-up", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ filename: "nightly.sql", confirm: "RESTORE" }),
  });
  const read = vi.spyOn(request, "json");
  return { request, read };
}

function withParams(request: Request) {
  return [request, { params: Promise.resolve({ id: "row-1" }) }] as const;
}

describe("step-up on listed admin routes (#4619)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAdmin.mockResolvedValue(admin);
    mocks.requireFullAdminForConfigTransfer.mockResolvedValue(admin);
    mocks.isFullAdmin.mockReturnValue(true);
    mocks.actorIsFullAdmin.mockResolvedValue(true);
    mocks.auth.mockResolvedValue({ user: { id: "admin-1" } });
    mocks.readBundleUpload.mockRejectedValue(new Error("body read"));
    mocks.resolveBackupConfig.mockResolvedValue({ localPath: "/var/backups" });
    mocks.getActiveBackupRun.mockResolvedValue(null);
    mocks.createAuditLog.mockResolvedValue(undefined);
    mocks.restoreLocalBackup.mockResolvedValue({
      filename: "nightly.sql",
      memberCount: 1,
      bookingCount: 0,
      paymentCount: 0,
    });
  });

  it("answers an anonymous restore with the authorisation refusal and does not read the body", async () => {
    mocks.requireAdmin.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: "Unauthorised" }, { status: 401 }),
    });
    const { request, read } = unread();
    const response = await restore(request);
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Unauthorised" });
    expect(read).not.toHaveBeenCalled();
    expect(mocks.auth).not.toHaveBeenCalled();
    expect(mocks.restoreLocalBackup).not.toHaveBeenCalled();
  });

  it("answers a signed-in non-Full-Admin restore with the Full Admin refusal", async () => {
    mocks.isFullAdmin.mockReturnValue(false);
    const { request, read } = unread();
    const response = await restore(request);
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.code).toBeUndefined();
    expect(body).not.toEqual(recentAuthRefusalBody());
    expect(read).not.toHaveBeenCalled();
    expect(mocks.auth).not.toHaveBeenCalled();
    expect(mocks.restoreLocalBackup).not.toHaveBeenCalled();
  });

  it("refuses a stale Full Admin before restore, and does not read the body", async () => {
    const { request, read } = unread();
    const response = await restore(request);
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual(recentAuthRefusalBody());
    expect(read).not.toHaveBeenCalled();
    expect(mocks.restoreLocalBackup).not.toHaveBeenCalled();
  });

  it("restores once after a fresh stamp", async () => {
    mocks.auth.mockResolvedValue({
      user: { id: "admin-1", lastAuthenticatedAt: Date.now() },
    });
    const response = await restore(
      new Request("https://club.example/api/admin/backups/restore", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ filename: "nightly.sql", confirm: "RESTORE" }),
      }),
    );
    expect(response.status).toBe(200);
    expect(mocks.restoreLocalBackup).toHaveBeenCalledTimes(1);
  });

  it("refuses a credential write before the credential store", async () => {
    const { request, read } = unread();
    const response = await backupConfig(request);
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual(recentAuthRefusalBody());
    expect(read).not.toHaveBeenCalled();
    expect(mocks.setIntegrationCredential).not.toHaveBeenCalled();
    expect(mocks.deleteIntegrationCredential).not.toHaveBeenCalled();
  });

  it("refuses a role grant before the body", async () => {
    const { request, read } = unread();
    const response = await createAccessRole(request);
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual(recentAuthRefusalBody());
    expect(read).not.toHaveBeenCalled();
  });

  it("refuses a member merge before executeMemberMerge", async () => {
    const { request, read } = unread();
    const response = await mergeMember(...withParams(request));
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual(recentAuthRefusalBody());
    expect(read).not.toHaveBeenCalled();
    expect(mocks.executeMemberMerge).not.toHaveBeenCalled();
  });

  it("refuses an erasure before the body", async () => {
    const { request, read } = unread();
    const response = await decideDeletion(...withParams(request));
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual(recentAuthRefusalBody());
    expect(read).not.toHaveBeenCalled();
    expect(mocks.processRefund).not.toHaveBeenCalled();
    expect(mocks.refundPaymentTransactions).not.toHaveBeenCalled();
  });

  it("refuses a config import before the upload is read", async () => {
    const response = await applyConfig(unread().request);
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual(recentAuthRefusalBody());
    expect(mocks.readBundleUpload).not.toHaveBeenCalled();
    expect(mocks.applyConfigImport).not.toHaveBeenCalled();
  });

  it("refuses a security setting before the body", async () => {
    const { request, read } = unread();
    const response = await savePasswordPolicy(request);
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual(recentAuthRefusalBody());
    expect(read).not.toHaveBeenCalled();
  });

  it("refuses a refund before any refund function", async () => {
    const { request, read } = unread();
    const response = await decideRefund(...withParams(request));
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual(recentAuthRefusalBody());
    expect(read).not.toHaveBeenCalled();
    expect(mocks.processRefund).not.toHaveBeenCalled();
    expect(mocks.refundPaymentTransactions).not.toHaveBeenCalled();
  });

  it("refuses a member export for a session with no stamp", async () => {
    const response = await exportMembers(new NextRequest("https://club.example/api/admin/members/export"));
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual(recentAuthRefusalBody());
    expect(mocks.escapeCsvCell).not.toHaveBeenCalled();
  });
});
