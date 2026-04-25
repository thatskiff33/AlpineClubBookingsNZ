import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execSync } from "child_process";
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "fs";

vi.mock("child_process", () => ({
  execSync: vi.fn(),
}));

vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof import("fs")>("fs");
  return {
    ...actual,
    existsSync: vi.fn(),
    mkdirSync: vi.fn(),
    readdirSync: vi.fn(),
    statSync: vi.fn(),
    unlinkSync: vi.fn(),
  };
});

vi.mock("@/lib/logger", () => ({
  default: {
    error: vi.fn(),
    info: vi.fn(),
  },
}));

import {
  buildBackupCronOutcome,
  runDatabaseBackup,
} from "@/lib/backup";
import logger from "@/lib/logger";

describe("backup", () => {
  const originalEnv = { ...process.env };
  const execSyncMock = vi.mocked(execSync);
  const existsSyncMock = vi.mocked(existsSync);
  const mkdirSyncMock = vi.mocked(mkdirSync);
  const readdirSyncMock = vi.mocked(readdirSync);
  const statSyncMock = vi.mocked(statSync);
  const unlinkSyncMock = vi.mocked(unlinkSync);
  const loggerErrorMock = vi.mocked(logger.error);

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    existsSyncMock.mockReturnValue(true);
    readdirSyncMock.mockReturnValue([] as never);
    statSyncMock.mockReturnValue({ size: 1024, mtimeMs: Date.now() } as never);
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns a skipped result when backups are disabled", async () => {
    process.env = {
      ...originalEnv,
      BACKUP_ENABLED: "false",
    };

    await expect(runDatabaseBackup()).resolves.toEqual({
      success: false,
      skipped: true,
      reason: "Backups are disabled. Set BACKUP_ENABLED=true.",
    });
  });

  it("classifies a successful backup as SUCCESS", () => {
    expect(
      buildBackupCronOutcome({
        success: true,
        filename: "backup.sql.gz",
        sizeBytes: 1024,
        uploadedToS3: true,
      })
    ).toEqual({
      status: "SUCCESS",
      resultSummary: {
        filename: "backup.sql.gz",
        sizeBytes: 1024,
        s3: true,
      },
    });
  });

  it("classifies a skipped backup as SKIPPED", () => {
    expect(
      buildBackupCronOutcome({
        success: false,
        skipped: true,
        reason: "Backups are disabled. Set BACKUP_ENABLED=true.",
      })
    ).toEqual({
      status: "SKIPPED",
      resultSummary: {
        reason: "Backups are disabled. Set BACKUP_ENABLED=true.",
      },
    });
  });

  it("classifies a failed backup as FAILURE", () => {
    expect(
      buildBackupCronOutcome({
        success: false,
        error: "pg_dump failed",
      })
    ).toEqual({
      status: "FAILURE",
      error: "pg_dump failed",
    });
  });

  it("fails when an S3 upload is configured but denied", async () => {
    process.env = {
      ...originalEnv,
      BACKUP_ENABLED: "true",
      BACKUP_S3_BUCKET: "tacbookings-backups",
      BACKUP_S3_REGION: "ap-southeast-2",
      DATABASE_URL: "postgresql://postgres:postgres@postgres:5432/tacbookings",
    };

    execSyncMock.mockImplementation((command) => {
      if (String(command).includes("aws s3 cp")) {
        throw new Error("AccessDenied");
      }

      return Buffer.from("");
    });

    await expect(runDatabaseBackup()).resolves.toMatchObject({
      success: false,
      filename: expect.stringMatching(/^tacbookings-/),
      filepath: expect.stringContaining("/tmp/tacbookings-backups/"),
      sizeBytes: 1024,
      error: expect.stringContaining("S3 upload failed: AccessDenied"),
    });

    expect(loggerErrorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        err: expect.any(Error),
        job: "backup",
      }),
      "S3 upload failed"
    );
    expect(mkdirSyncMock).not.toHaveBeenCalled();
    expect(unlinkSyncMock).not.toHaveBeenCalled();
  });
});
