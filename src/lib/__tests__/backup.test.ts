import { afterEach, describe, expect, it } from "vitest";
import {
  buildBackupCronOutcome,
  runDatabaseBackup,
} from "@/lib/backup";

describe("backup", () => {
  const originalEnv = { ...process.env };

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
});
