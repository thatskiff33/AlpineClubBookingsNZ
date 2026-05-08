/**
 * Automated PostgreSQL database backup.
 * Runs pg_dump and optionally uploads to S3.
 *
 * Environment variables:
 *   BACKUP_ENABLED=true           - Enable/disable backups
 *   BACKUP_S3_BUCKET              - S3 bucket name (optional, uploads to the tacbookings_s3backup/ prefix)
 *   BACKUP_S3_REGION              - AWS region for S3 (defaults to ap-southeast-2)
 *   BACKUP_S3_ACCESS_KEY_ID       - AWS access key for S3 uploads
 *   BACKUP_S3_SECRET_ACCESS_KEY   - AWS secret key for S3 uploads
 *   BACKUP_RETENTION_DAYS         - Number of days to keep local backups (default 7)
 *   DATABASE_URL                  - PostgreSQL connection string
 */

import { execFileSync } from "child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  unlinkSync,
  statSync,
  writeFileSync,
} from "fs";
import path from "path";
import { gzipSync } from "zlib";
import logger from "@/lib/logger";

const BACKUP_DIR = "/tmp/tacbookings-backups";
const DEFAULT_RETENTION_DAYS = 7;
const S3_BACKUP_PREFIX = "tacbookings_s3backup";
const MIN_BACKUP_SIZE_BYTES = 128;
const BACKUP_COMMAND_TIMEOUT_MS = 120_000;
const BACKUP_COMMAND_MAX_BUFFER_BYTES = 1024 * 1024 * 1024;
const PRISMA_ONLY_DATABASE_URL_PARAMS = new Set([
  "connection_limit",
  "pool_timeout",
  "pgbouncer",
  "schema",
]);

export interface BackupRestoreValidation {
  source: "local-file" | "s3-readback";
  memberCount: number;
  bookingCount: number;
  paymentCount: number;
}

export interface BackupResult {
  success: boolean;
  skipped?: boolean;
  filename?: string;
  filepath?: string;
  uploadedToS3?: boolean;
  s3Key?: string;
  s3ReadbackVerified?: boolean;
  s3ReadbackSizeBytes?: number;
  restoreValidation?: BackupRestoreValidation;
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

  const sanitizedDatabaseUrl = sanitizePostgresUrlForPgDump(databaseUrl);
  const restoreValidationDatabaseUrl = process.env.BACKUP_RESTORE_VALIDATION_URL;
  if (
    restoreValidationDatabaseUrl &&
    sanitizePostgresUrlForPgDump(restoreValidationDatabaseUrl) === sanitizedDatabaseUrl
  ) {
    return {
      success: false,
      error: "BACKUP_RESTORE_VALIDATION_URL must point at a disposable shadow database, not DATABASE_URL",
    };
  }

  try {
    // Ensure backup directory exists
    if (!existsSync(BACKUP_DIR)) {
      mkdirSync(BACKUP_DIR, { recursive: true });
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `tacbookings-${timestamp}.sql.gz`;
    const filepath = path.join(BACKUP_DIR, filename);

    runPgDump(filepath, sanitizedDatabaseUrl);

    // Verify the file was created and has content
    if (!existsSync(filepath)) {
      return { success: false, error: "Backup file was not created" };
    }

    const stats = statSync(filepath);
    if (stats.size === 0) {
      unlinkSync(filepath);
      return { success: false, error: "Backup file is empty" };
    }
    if (stats.size < MIN_BACKUP_SIZE_BYTES) {
      unlinkSync(filepath);
      return { success: false, error: "Backup file is suspiciously small" };
    }

    let uploadedToS3 = false;
    let s3Key: string | undefined;
    let s3ReadbackVerified = false;
    let s3ReadbackSizeBytes: number | undefined;
    let s3ReadbackPath: string | undefined;
    let restoreValidation: BackupRestoreValidation | undefined;

    // Upload to S3 if configured
    const s3Bucket = process.env.BACKUP_S3_BUCKET;
    if (s3Bucket) {
      try {
        const s3Region = process.env.BACKUP_S3_REGION || "ap-southeast-2";
        s3Key = `${S3_BACKUP_PREFIX}/${filename}`;

        const readback = uploadAndVerifyS3Readback({
          filepath,
          filename,
          expectedSizeBytes: stats.size,
          s3Bucket,
          s3Key,
          s3Region,
        });

        uploadedToS3 = true;
        s3ReadbackVerified = true;
        s3ReadbackSizeBytes = readback.sizeBytes;
        s3ReadbackPath = readback.filepath;
      } catch (s3Err) {
        const message = s3Err instanceof Error ? s3Err.message : String(s3Err);
        logger.error({ err: s3Err, job: "backup" }, "S3 upload or readback failed");
        return {
          success: false,
          filename,
          filepath,
          sizeBytes: stats.size,
          uploadedToS3,
          s3Key,
          s3ReadbackVerified,
          error: `S3 upload/readback failed: ${message}`,
        };
      }
    }

    if (restoreValidationDatabaseUrl) {
      const sourcePath = s3ReadbackPath ?? filepath;
      try {
        restoreValidation = validateBackupRestore(
          sourcePath,
          restoreValidationDatabaseUrl,
          s3ReadbackPath ? "s3-readback" : "local-file"
        );
      } catch (restoreErr) {
        const message =
          restoreErr instanceof Error ? restoreErr.message : String(restoreErr);
        logger.error({ err: restoreErr, job: "backup" }, "Restore validation failed");
        cleanupS3Readback(s3ReadbackPath);
        return {
          success: false,
          filename,
          filepath,
          uploadedToS3,
          s3Key,
          s3ReadbackVerified,
          s3ReadbackSizeBytes,
          sizeBytes: stats.size,
          error: `Restore validation failed: ${message}`,
        };
      }
    }

    cleanupS3Readback(s3ReadbackPath);

    // Clean up old local backups
    cleanupOldBackups();

    return {
      success: true,
      filename,
      filepath,
      uploadedToS3,
      s3Key,
      s3ReadbackVerified,
      s3ReadbackSizeBytes,
      restoreValidation,
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
    const resultSummary: Record<string, unknown> = {
      filename: result.filename,
      sizeBytes: result.sizeBytes,
      minSizeBytes: MIN_BACKUP_SIZE_BYTES,
      s3: result.uploadedToS3,
    };

    if (result.s3Key) {
      resultSummary.s3Key = result.s3Key;
      resultSummary.s3ReadbackVerified = result.s3ReadbackVerified;
      resultSummary.s3ReadbackSizeBytes = result.s3ReadbackSizeBytes;
    }

    if (result.restoreValidation) {
      resultSummary.restoreValidation = result.restoreValidation;
    }

    return {
      status: "SUCCESS",
      resultSummary,
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

export function sanitizePostgresUrlForPgDump(databaseUrl: string): string {
  try {
    const parsed = new URL(databaseUrl);
    for (const param of PRISMA_ONLY_DATABASE_URL_PARAMS) {
      parsed.searchParams.delete(param);
    }
    return parsed.toString();
  } catch {
    return databaseUrl;
  }
}

function runPgDump(filepath: string, sanitizedDatabaseUrl: string) {
  const dump = execFileSync("pg_dump", [sanitizedDatabaseUrl], {
    timeout: BACKUP_COMMAND_TIMEOUT_MS,
    maxBuffer: BACKUP_COMMAND_MAX_BUFFER_BYTES,
    stdio: ["ignore", "pipe", "pipe"],
  });

  writeFileSync(filepath, gzipSync(dump));
}

function buildAwsEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (process.env.BACKUP_S3_ACCESS_KEY_ID) {
    env.AWS_ACCESS_KEY_ID = process.env.BACKUP_S3_ACCESS_KEY_ID;
  }
  if (process.env.BACKUP_S3_SECRET_ACCESS_KEY) {
    env.AWS_SECRET_ACCESS_KEY = process.env.BACKUP_S3_SECRET_ACCESS_KEY;
  }
  return env;
}

function uploadAndVerifyS3Readback({
  filepath,
  filename,
  expectedSizeBytes,
  s3Bucket,
  s3Key,
  s3Region,
}: {
  filepath: string;
  filename: string;
  expectedSizeBytes: number;
  s3Bucket: string;
  s3Key: string;
  s3Region: string;
}) {
  const s3Uri = `s3://${s3Bucket}/${s3Key}`;
  const readbackPath = path.join(BACKUP_DIR, `${filename}.s3-readback`);
  const env = buildAwsEnvironment();

  execFileSync("aws", ["s3", "cp", filepath, s3Uri, "--region", s3Region], {
    timeout: BACKUP_COMMAND_TIMEOUT_MS,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  execFileSync("aws", ["s3", "cp", s3Uri, readbackPath, "--region", s3Region], {
    timeout: BACKUP_COMMAND_TIMEOUT_MS,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const readbackStats = statSync(readbackPath);
  if (readbackStats.size !== expectedSizeBytes) {
    throw new Error(
      `S3 readback size mismatch: expected ${expectedSizeBytes} bytes, got ${readbackStats.size}`
    );
  }

  return { filepath: readbackPath, sizeBytes: readbackStats.size };
}

function cleanupS3Readback(readbackPath?: string) {
  if (readbackPath && existsSync(readbackPath)) {
    unlinkSync(readbackPath);
  }
}

function validateBackupRestore(
  sourcePath: string,
  restoreValidationDatabaseUrl: string,
  source: BackupRestoreValidation["source"]
): BackupRestoreValidation {
  const sanitizedRestoreUrl = sanitizePostgresUrlForPgDump(
    restoreValidationDatabaseUrl
  );

  execFileSync(
    "psql",
    [
      sanitizedRestoreUrl,
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      "DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;",
    ],
    {
      timeout: BACKUP_COMMAND_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "pipe"],
    }
  );

  const sql = execFileSync("gunzip", ["-c", sourcePath], {
    timeout: BACKUP_COMMAND_TIMEOUT_MS,
    maxBuffer: BACKUP_COMMAND_MAX_BUFFER_BYTES,
    stdio: ["ignore", "pipe", "pipe"],
  });

  execFileSync("psql", [sanitizedRestoreUrl, "-v", "ON_ERROR_STOP=1"], {
    input: sql,
    timeout: BACKUP_COMMAND_TIMEOUT_MS,
    maxBuffer: BACKUP_COMMAND_MAX_BUFFER_BYTES,
    stdio: ["pipe", "pipe", "pipe"],
  });

  const counts = execFileSync(
    "psql",
    [
      sanitizedRestoreUrl,
      "-v",
      "ON_ERROR_STOP=1",
      "-At",
      "-F",
      "|",
      "-c",
      'SELECT (SELECT count(*) FROM "Member"), (SELECT count(*) FROM "Booking"), (SELECT count(*) FROM "Payment");',
    ],
    {
      encoding: "utf8",
      timeout: BACKUP_COMMAND_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "pipe"],
    }
  );

  const [memberCount, bookingCount, paymentCount] = counts
    .trim()
    .split("|")
    .map((value) => Number.parseInt(value, 10));

  if (
    !Number.isFinite(memberCount) ||
    !Number.isFinite(bookingCount) ||
    !Number.isFinite(paymentCount)
  ) {
    throw new Error(`Could not parse restore validation counts: ${counts.trim()}`);
  }

  if (memberCount <= 0 || bookingCount <= 0 || paymentCount <= 0) {
    throw new Error(
      `Restore validation returned empty smoke counts: Member=${memberCount}, Booking=${bookingCount}, Payment=${paymentCount}`
    );
  }

  return {
    source,
    memberCount,
    bookingCount,
    paymentCount,
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
