/**
 * Automated PostgreSQL database backup.
 * Runs pg_dump and optionally uploads to S3.
 *
 * Environment variables:
 *   BACKUP_ENABLED=true           - Enable/disable backups
 *   BACKUP_S3_BUCKET              - S3 bucket name (optional, if not set dumps to /tmp)
 *   BACKUP_S3_REGION              - AWS region for S3 (defaults to ap-southeast-2)
 *   BACKUP_S3_ACCESS_KEY_ID       - AWS access key for S3 uploads
 *   BACKUP_S3_SECRET_ACCESS_KEY   - AWS secret key for S3 uploads
 *   BACKUP_RETENTION_DAYS         - Number of days to keep local backups (default 7)
 *   DATABASE_URL                  - PostgreSQL connection string
 */

import { execSync } from "child_process";
import { existsSync, mkdirSync, readdirSync, unlinkSync, statSync } from "fs";
import path from "path";
import logger from "@/lib/logger";

const BACKUP_DIR = "/tmp/tacbookings-backups";
const DEFAULT_RETENTION_DAYS = 7;

export interface BackupResult {
  success: boolean;
  skipped?: boolean;
  filename?: string;
  filepath?: string;
  uploadedToS3?: boolean;
  error?: string;
  reason?: string;
  sizeBytes?: number;
}

export interface BackupCronOutcome {
  status: "SUCCESS" | "FAILURE" | "SKIPPED";
  error?: string;
  resultSummary?: Record<string, unknown>;
}

/**
 * Run a database backup using pg_dump.
 */
export async function runDatabaseBackup(): Promise<BackupResult> {
  if (process.env.BACKUP_ENABLED !== "true") {
    return {
      success: false,
      skipped: true,
      reason: "Backups are disabled. Set BACKUP_ENABLED=true.",
    };
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    return { success: false, error: "DATABASE_URL is not set" };
  }

  try {
    // Ensure backup directory exists
    if (!existsSync(BACKUP_DIR)) {
      mkdirSync(BACKUP_DIR, { recursive: true });
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `tacbookings-${timestamp}.sql.gz`;
    const filepath = path.join(BACKUP_DIR, filename);

    // Run pg_dump with gzip compression
    execSync(
      `pg_dump "${databaseUrl}" | gzip > "${filepath}"`,
      {
        timeout: 120_000, // 2 minute timeout
        stdio: ["pipe", "pipe", "pipe"],
      }
    );

    // Verify the file was created and has content
    if (!existsSync(filepath)) {
      return { success: false, error: "Backup file was not created" };
    }

    const stats = statSync(filepath);
    if (stats.size === 0) {
      unlinkSync(filepath);
      return { success: false, error: "Backup file is empty" };
    }

    let uploadedToS3 = false;

    // Upload to S3 if configured
    const s3Bucket = process.env.BACKUP_S3_BUCKET;
    if (s3Bucket) {
      try {
        const s3Region = process.env.BACKUP_S3_REGION || "ap-southeast-2";
        const s3Key = `backups/${filename}`;

        // Use AWS CLI for upload (simpler than SDK for this use case)
        const envVars: Record<string, string> = {};
        if (process.env.BACKUP_S3_ACCESS_KEY_ID) {
          envVars.AWS_ACCESS_KEY_ID = process.env.BACKUP_S3_ACCESS_KEY_ID;
        }
        if (process.env.BACKUP_S3_SECRET_ACCESS_KEY) {
          envVars.AWS_SECRET_ACCESS_KEY = process.env.BACKUP_S3_SECRET_ACCESS_KEY;
        }

        execSync(
          `aws s3 cp "${filepath}" "s3://${s3Bucket}/${s3Key}" --region "${s3Region}"`,
          {
            timeout: 120_000,
            env: { ...process.env, ...envVars },
            stdio: ["pipe", "pipe", "pipe"],
          }
        );
        uploadedToS3 = true;
      } catch (s3Err) {
        const message = s3Err instanceof Error ? s3Err.message : String(s3Err);
        logger.error({ err: s3Err, job: "backup" }, "S3 upload failed");
        return {
          success: false,
          filename,
          filepath,
          sizeBytes: stats.size,
          error: `S3 upload failed: ${message}`,
        };
      }
    }

    // Clean up old local backups
    cleanupOldBackups();

    return {
      success: true,
      filename,
      filepath,
      uploadedToS3,
      sizeBytes: stats.size,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err, job: "backup" }, "pg_dump failed");
    return { success: false, error: `pg_dump failed: ${message}` };
  }
}

export function buildBackupCronOutcome(result: BackupResult): BackupCronOutcome {
  if (result.success) {
    return {
      status: "SUCCESS",
      resultSummary: {
        filename: result.filename,
        sizeBytes: result.sizeBytes,
        s3: result.uploadedToS3,
      },
    };
  }

  if (result.skipped) {
    return {
      status: "SKIPPED",
      resultSummary: {
        reason: result.reason ?? "Backup skipped",
      },
    };
  }

  return {
    status: "FAILURE",
    error: result.error ?? "Unknown backup failure",
  };
}

/**
 * Remove backup files older than BACKUP_RETENTION_DAYS.
 */
function cleanupOldBackups() {
  const retentionDays = parseInt(process.env.BACKUP_RETENTION_DAYS || "") || DEFAULT_RETENTION_DAYS;
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;

  if (!existsSync(BACKUP_DIR)) return;

  try {
    const files = readdirSync(BACKUP_DIR);
    for (const file of files) {
      if (!file.startsWith("tacbookings-") || !file.endsWith(".sql.gz")) continue;
      const filepath = path.join(BACKUP_DIR, file);
      const stats = statSync(filepath);
      if (stats.mtimeMs < cutoff) {
        unlinkSync(filepath);
        logger.info({ file, job: "backup" }, "Cleaned up old backup");
      }
    }
  } catch (err) {
    logger.error({ err, job: "backup" }, "Backup cleanup error");
  }
}
