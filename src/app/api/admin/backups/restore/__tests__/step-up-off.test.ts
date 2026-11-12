import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  isFullAdmin: vi.fn(),
  resolveBackupConfig: vi.fn(),
  getActiveBackupRun: vi.fn(),
  restoreLocalBackup: vi.fn(),
  createAuditLog: vi.fn(),
}));

vi.mock("@/lib/session-guards", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/lib/access-roles", () => ({ isFullAdmin: mocks.isFullAdmin }));
vi.mock("@/lib/backup-config", () => ({ resolveBackupConfig: mocks.resolveBackupConfig }));
vi.mock("@/lib/backup-run", () => ({ getActiveBackupRun: mocks.getActiveBackupRun }));
vi.mock("@/lib/backup-restore", () => ({ restoreLocalBackup: mocks.restoreLocalBackup }));
vi.mock("@/lib/backup-local", () => ({
  LocalBackupPathError: class LocalBackupPathError extends Error {},
}));
vi.mock("@/lib/audit", () => ({
  createAuditLog: mocks.createAuditLog,
  getAuditRequestContext: () => null,
}));
vi.mock("@/lib/logger", () => ({ default: { error: vi.fn() } }));

import { POST } from "@/app/api/admin/backups/restore/route";

function restoreRequest() {
  return new Request("https://club.example/api/admin/backups/restore", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ filename: "nightly.sql", confirm: "RESTORE" }),
  });
}

describe("restore while officer sign-in is off (#4619)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAdmin.mockResolvedValue({
      ok: true,
      session: { user: { id: "admin-1" } },
    });
    mocks.isFullAdmin.mockReturnValue(true);
    mocks.resolveBackupConfig.mockResolvedValue({ localPath: "/var/backups" });
    mocks.getActiveBackupRun.mockResolvedValue(null);
    mocks.createAuditLog.mockResolvedValue(undefined);
    mocks.restoreLocalBackup.mockResolvedValue({
      filename: "nightly.sql",
      memberCount: 1,
      bookingCount: 2,
      paymentCount: 3,
    });
  });

  it("still restores for a Full Admin with no recent-auth stamp", async () => {
    const response = await POST(restoreRequest());
    expect(response.status).toBe(200);
    expect(mocks.restoreLocalBackup).toHaveBeenCalledTimes(1);
    expect(mocks.restoreLocalBackup).toHaveBeenCalledWith("nightly.sql");
    await expect(response.json()).resolves.toMatchObject({ ok: true, filename: "nightly.sql" });
  });
});
