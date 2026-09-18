import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/**
 * The run-now refusal, and specifically WHICH switch it reads.
 *
 * This suite exists because the local-backup feature shipped with the engine
 * updated and this route not: a club with local backups enabled pressed
 * "Manual Backup" and was told "Backups are disabled. Enable them before
 * running a backup." by the very button that would have worked. The engine's
 * gate had been widened to either destination; the route's up-front refusal
 * still read the S3 switch alone.
 *
 * So what is pinned here is not "a disabled club is refused" — that always
 * worked — but that the refusal and the engine agree about what "enabled"
 * means.
 */

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  resolveBackupConfig: vi.fn(),
  getActiveBackupRun: vi.fn(),
  runManagedBackup: vi.fn(),
  createAuditLog: vi.fn(),
  loggerError: vi.fn(),
}));

vi.mock("@/lib/session-guards", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/lib/backup-config", async (importOriginal) => {
  // `isAnyBackupDestinationEnabled` stays REAL — it is the thing under test.
  const actual = (await importOriginal()) as typeof import("@/lib/backup-config");
  return { ...actual, resolveBackupConfig: mocks.resolveBackupConfig };
});
vi.mock("@/lib/backup-run", () => ({
  getActiveBackupRun: mocks.getActiveBackupRun,
  runManagedBackup: mocks.runManagedBackup,
}));
vi.mock("@/lib/audit", () => ({
  createAuditLog: mocks.createAuditLog,
  getAuditRequestContext: () => ({ id: null, ipAddress: "1.2.3.4", userAgent: "t" }),
}));
vi.mock("@/lib/logger", () => ({ default: { error: mocks.loggerError } }));

import { POST } from "../route";

function makeRequest() {
  return new Request("https://club.example.com/api/admin/backups/run", {
    method: "POST",
  });
}

function config(overrides: Record<string, unknown> = {}) {
  return {
    enabled: false,
    bucket: null,
    region: "ap-southeast-2",
    retentionDays: 7,
    accessKeyId: null,
    secretAccessKey: null,
    restoreValidationUrl: null,
    localEnabled: false,
    localPath: null,
    needsReentry: false,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAdmin.mockResolvedValue({
    ok: true,
    session: { user: { id: "admin-1", accessRoles: ["ADMIN"] } },
  });
  mocks.getActiveBackupRun.mockResolvedValue(null);
  mocks.runManagedBackup.mockResolvedValue({ status: "SUCCESS" });
});

describe("POST /api/admin/backups/run", () => {
  it("runs for a club whose ONLY destination is a local directory", async () => {
    mocks.resolveBackupConfig.mockResolvedValue(
      config({ localEnabled: true, localPath: "/var/backups/tacbookings" }),
    );

    const res = await POST(makeRequest());

    // 202: the run is accepted and executes in the background, which is what
    // "not refused" looks like on this route.
    expect(res.status).toBe(202);
  });

  it("runs for a club with the S3 switch on", async () => {
    mocks.resolveBackupConfig.mockResolvedValue(config({ enabled: true }));

    const res = await POST(makeRequest());

    expect(res.status).toBe(202);
  });

  it("refuses when NEITHER destination is enabled", async () => {
    mocks.resolveBackupConfig.mockResolvedValue(config());

    const res = await POST(makeRequest());

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({
      error: expect.stringContaining("disabled"),
    });
  });

  it("still refuses when credentials cannot be decrypted", async () => {
    // The louder failure wins over the enabled check, whichever destination is on.
    mocks.resolveBackupConfig.mockResolvedValue(
      config({ localEnabled: true, localPath: "/var/backups", needsReentry: true }),
    );

    const res = await POST(makeRequest());

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({
      error: expect.stringContaining("could not be decrypted"),
    });
  });
});
