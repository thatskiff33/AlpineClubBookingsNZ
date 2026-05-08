import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "fs";

vi.mock("child_process", () => ({
  execFileSync: vi.fn(),
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
    writeFileSync: vi.fn(),
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
  sanitizePostgresUrlForPgDump,
} from "@/lib/backup";
import logger from "@/lib/logger";

describe("backup", () => {
  const originalEnv = { ...process.env };
  const execFileSyncMock = vi.mocked(execFileSync);
  const existsSyncMock = vi.mocked(existsSync);
  const mkdirSyncMock = vi.mocked(mkdirSync);
  const readdirSyncMock = vi.mocked(readdirSync);
  const statSyncMock = vi.mocked(statSync);
  const unlinkSyncMock = vi.mocked(unlinkSync);
  const writeFileSyncMock = vi.mocked(writeFileSync);
  const loggerErrorMock = vi.mocked(logger.error);

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    existsSyncMock.mockReturnValue(true);
    readdirSyncMock.mockReturnValue([] as never);
    statSyncMock.mockReturnValue({ size: 1024, mtimeMs: Date.now() } as never);
    execFileSyncMock.mockImplementation((file, args) => {
      if (file === "psql" && Array.isArray(args) && args.includes("-At")) {
        return "3|4|5\n" as never;
      }

      if (file === "gunzip") {
        return Buffer.from("-- restored sql") as never;
      }

      return Buffer.from("-- database dump") as never;
    });
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
        minSizeBytes: 128,
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

    execFileSyncMock.mockImplementation((file) => {
      if (file === "aws") {
        throw new Error("AccessDenied");
      }

      return Buffer.from("-- database dump") as never;
    });

    await expect(runDatabaseBackup()).resolves.toMatchObject({
      success: false,
      filename: expect.stringMatching(/^tacbookings-/),
      filepath: expect.stringContaining("/tmp/tacbookings-backups/"),
      sizeBytes: 1024,
      error: expect.stringContaining("S3 upload/readback failed: AccessDenied"),
    });

    expect(loggerErrorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        err: expect.any(Error),
        job: "backup",
      }),
      "S3 upload or readback failed"
    );
    expect(execFileSyncMock).toHaveBeenCalledWith(
      "aws",
      [
        "s3",
        "cp",
        expect.stringContaining("/tmp/tacbookings-backups/"),
        expect.stringMatching(/s3:\/\/tacbookings-backups\/tacbookings_s3backup\/tacbookings-/),
        "--region",
        "ap-southeast-2",
      ],
      expect.objectContaining({
        env: expect.objectContaining(process.env),
      })
    );
    expect(mkdirSyncMock).not.toHaveBeenCalled();
    expect(unlinkSyncMock).not.toHaveBeenCalled();
  });

  it("fails closed when pg_dump produces a suspiciously tiny gzip artifact", async () => {
    process.env = {
      ...originalEnv,
      BACKUP_ENABLED: "true",
      DATABASE_URL: "postgresql://postgres:postgres@postgres:5432/tacbookings",
    };

    execFileSyncMock.mockReturnValue(Buffer.from("-- database dump") as never);
    statSyncMock.mockReturnValue({ size: 20, mtimeMs: Date.now() } as never);

    await expect(runDatabaseBackup()).resolves.toEqual({
      success: false,
      error: "Backup file is suspiciously small",
    });

    expect(unlinkSyncMock).toHaveBeenCalledTimes(1);
  });

  it("strips Prisma-only query parameters before invoking pg_dump", async () => {
    process.env = {
      ...originalEnv,
      BACKUP_ENABLED: "true",
      DATABASE_URL:
        "postgresql://postgres:postgres@postgres:5432/tacbookings?connection_limit=5&pool_timeout=10&schema=bookings&sslmode=require",
    };

    await expect(runDatabaseBackup()).resolves.toMatchObject({
      success: true,
      sizeBytes: 1024,
    });

    expect(execFileSyncMock).toHaveBeenCalledWith(
      "pg_dump",
      [
        "postgresql://postgres:postgres@postgres:5432/tacbookings?sslmode=require",
      ],
      expect.any(Object)
    );
  });

  it("returns sanitized postgres URLs for external callers", () => {
    const sanitized = sanitizePostgresUrlForPgDump(
      "postgresql://tac:password@postgres:5432/tacbookings?connection_limit=5&pool_timeout=10&pgbouncer=true&schema=public&sslmode=require"
    );

    const parsed = new URL(sanitized);
    expect(parsed.searchParams.get("connection_limit")).toBeNull();
    expect(parsed.searchParams.get("pool_timeout")).toBeNull();
    expect(parsed.searchParams.get("pgbouncer")).toBeNull();
    expect(parsed.searchParams.get("schema")).toBeNull();
    expect(parsed.searchParams.get("sslmode")).toBe("require");
  });

  it("fails closed when pg_dump exits non-zero", async () => {
    process.env = {
      ...originalEnv,
      BACKUP_ENABLED: "true",
      DATABASE_URL:
        "postgresql://postgres:postgres@postgres:5432/tacbookings?connection_limit=5&pool_timeout=10",
    };
    execFileSyncMock.mockImplementation((file) => {
      if (file === "pg_dump") {
        throw new Error('pg_dump: error: invalid URI query parameter: "connection_limit"');
      }

      return Buffer.from("") as never;
    });

    await expect(runDatabaseBackup()).resolves.toEqual({
      success: false,
      error: expect.stringContaining("pg_dump failed:"),
    });

    expect(writeFileSyncMock).not.toHaveBeenCalled();
  });

  it("verifies S3 readback after upload before declaring success", async () => {
    process.env = {
      ...originalEnv,
      BACKUP_ENABLED: "true",
      BACKUP_S3_BUCKET: "tacbookings-backups",
      BACKUP_S3_REGION: "ap-southeast-2",
      DATABASE_URL: "postgresql://postgres:postgres@postgres:5432/tacbookings",
    };

    await expect(runDatabaseBackup()).resolves.toMatchObject({
      success: true,
      uploadedToS3: true,
      s3Key: expect.stringMatching(/^tacbookings_s3backup\/tacbookings-/),
      s3ReadbackVerified: true,
      s3ReadbackSizeBytes: 1024,
    });

    expect(execFileSyncMock).toHaveBeenCalledWith(
      "aws",
      [
        "s3",
        "cp",
        expect.stringContaining("/tmp/tacbookings-backups/"),
        expect.stringMatching(/s3:\/\/tacbookings-backups\/tacbookings_s3backup\/tacbookings-/),
        "--region",
        "ap-southeast-2",
      ],
      expect.any(Object)
    );
    expect(execFileSyncMock).toHaveBeenCalledWith(
      "aws",
      [
        "s3",
        "cp",
        expect.stringMatching(/s3:\/\/tacbookings-backups\/tacbookings_s3backup\/tacbookings-/),
        expect.stringContaining(".s3-readback"),
        "--region",
        "ap-southeast-2",
      ],
      expect.any(Object)
    );
    expect(unlinkSyncMock).toHaveBeenCalledWith(
      expect.stringContaining(".s3-readback")
    );
  });

  it("validates a restored backup against a disposable shadow database", async () => {
    process.env = {
      ...originalEnv,
      BACKUP_ENABLED: "true",
      DATABASE_URL: "postgresql://postgres:postgres@postgres:5432/tacbookings",
      BACKUP_RESTORE_VALIDATION_URL:
        "postgresql://postgres:postgres@postgres:5432/tacbookings_restore?connection_limit=1",
    };

    const result = await runDatabaseBackup();

    expect(result).toMatchObject({
      success: true,
      restoreValidation: {
        source: "local-file",
        memberCount: 3,
        bookingCount: 4,
        paymentCount: 5,
      },
    });
    expect(execFileSyncMock).toHaveBeenCalledWith(
      "psql",
      [
        "postgresql://postgres:postgres@postgres:5432/tacbookings_restore",
        "-v",
        "ON_ERROR_STOP=1",
        "-c",
        "DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;",
      ],
      expect.any(Object)
    );
    expect(execFileSyncMock).toHaveBeenCalledWith(
      "gunzip",
      ["-c", expect.stringContaining("/tmp/tacbookings-backups/")],
      expect.any(Object)
    );
  });

  it("fails backup when restore validation smoke counts are empty", async () => {
    process.env = {
      ...originalEnv,
      BACKUP_ENABLED: "true",
      DATABASE_URL: "postgresql://postgres:postgres@postgres:5432/tacbookings",
      BACKUP_RESTORE_VALIDATION_URL:
        "postgresql://postgres:postgres@postgres:5432/tacbookings_restore",
    };
    execFileSyncMock.mockImplementation((file, args) => {
      if (file === "psql" && Array.isArray(args) && args.includes("-At")) {
        return "3|0|5\n" as never;
      }

      if (file === "gunzip") {
        return Buffer.from("-- restored sql") as never;
      }

      return Buffer.from("-- database dump") as never;
    });

    await expect(runDatabaseBackup()).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining("Restore validation failed:"),
    });

    expect(loggerErrorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        err: expect.any(Error),
        job: "backup",
      }),
      "Restore validation failed"
    );
  });

  it("refuses restore validation when the shadow URL points at the source database", async () => {
    process.env = {
      ...originalEnv,
      BACKUP_ENABLED: "true",
      DATABASE_URL:
        "postgresql://postgres:postgres@postgres:5432/tacbookings?connection_limit=5",
      BACKUP_RESTORE_VALIDATION_URL:
        "postgresql://postgres:postgres@postgres:5432/tacbookings",
    };

    await expect(runDatabaseBackup()).resolves.toEqual({
      success: false,
      error:
        "BACKUP_RESTORE_VALIDATION_URL must point at a disposable shadow database, not DATABASE_URL",
    });

    expect(execFileSyncMock).not.toHaveBeenCalled();
  });
});
