/**
 * Automated PostgreSQL database backup.
 * Runs pg_dump and optionally uploads to S3.
 *
 * Configuration is DB-only (#2095, C6): the enabled switch, S3 destination
 * (bucket/region), access key/secret, retention window and restore-validation
 * shadow DSN all resolve from the encrypted IntegrationCredential store via
 * `resolveBackupConfig()` (src/lib/backup-config.ts). The legacy `BACKUP_ENABLED`
 * / `BACKUP_S3_*` / `BACKUP_RETENTION_DAYS` / `BACKUP_RESTORE_VALIDATION_URL`
 * env vars are no longer read — they are detected and flagged for in-app
 * re-entry. Only `DATABASE_URL` (the source database, bootstrap config) and
 * `BACKUP_CRON_SCHEDULE` (cron-leader timing) remain environment-driven.
 *
 * The postgres connection password is passed to pg_dump/psql via `PGPASSWORD`
 * in the child environment, never on the command line, so it cannot leak into a
 * process listing (`ps`) on the host.
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
import {
  isAnyBackupDestinationEnabled,
  resolveBackupConfig,
} from "@/lib/backup-config";
import { pruneLocalBackups, storeLocalBackup } from "@/lib/backup-local";

const BACKUP_DIR = "/tmp/tacbookings-backups";
const S3_BACKUP_PREFIX = "tacbookings_s3backup";
const MIN_BACKUP_SIZE_BYTES = 128;
export const BACKUP_COMMAND_TIMEOUT_MS = 120_000;
export const BACKUP_COMMAND_MAX_BUFFER_BYTES = 1024 * 1024 * 1024;
const PRISMA_ONLY_DATABASE_URL_PARAMS = new Set([
  "connection_limit",
  "pool_timeout",
  "pgbouncer",
  "schema",
]);

interface BackupRestoreValidation {
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
  /** Local destination (on-host directory), when the club has one enabled. */
  storedLocally?: boolean;
  localPath?: string;
  localPruned?: string[];
  s3Key?: string;
  s3ReadbackVerified?: boolean;
  s3ReadbackSizeBytes?: number;
  restoreValidation?: BackupRestoreValidation;
  error?: string;
  reason?: string;
  sizeBytes?: number;
  minSizeBytes?: number;
  healthSignal?:
    | "backup-empty"
    | "backup-suspiciously-small"
    | "backup-not-durable";
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
  const config = await resolveBackupConfig();

  // A stored-but-undecryptable credential (the app auth secret changed) is a
  // LOUD failure, never a silent skip: backups run unattended from cron, so the
  // disaster-recovery path must alert rather than quietly disable itself.
  if (config.needsReentry) {
    return {
      success: false,
      error:
        "Backup credentials could not be decrypted (the app auth secret changed). Re-enter the S3 credentials on Admin → Backups.",
    };
  }

  // Either destination being on is enough to run. A club that backs up only to
  // a local directory never enabled the S3 switch, and refusing to run for them
  // would make the local feature inert (owner instruction: the existing cron
  // performs the backup when the local option is ticked).
  if (!isAnyBackupDestinationEnabled(config)) {
    return {
      success: false,
      skipped: true,
      reason: "Backups are disabled. Enable them on Admin → Backups.",
    };
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    return { success: false, error: "DATABASE_URL is not set" };
  }

  const sanitizedDatabaseUrl = sanitizePostgresUrlForPgDump(databaseUrl);
  const restoreValidationDatabaseUrl = config.restoreValidationUrl ?? undefined;
  if (
    restoreValidationDatabaseUrl &&
    sanitizePostgresUrlForPgDump(restoreValidationDatabaseUrl) === sanitizedDatabaseUrl
  ) {
    return {
      success: false,
      error:
        "The restore-validation URL must point at a disposable shadow database, not the live DATABASE_URL",
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
      return {
        success: false,
        filename,
        filepath,
        sizeBytes: stats.size,
        minSizeBytes: MIN_BACKUP_SIZE_BYTES,
        healthSignal: "backup-empty",
        error: "Backup file is empty",
      };
    }
    if (stats.size < MIN_BACKUP_SIZE_BYTES) {
      unlinkSync(filepath);
      return {
        success: false,
        filename,
        filepath,
        sizeBytes: stats.size,
        minSizeBytes: MIN_BACKUP_SIZE_BYTES,
        healthSignal: "backup-suspiciously-small",
        error: "Backup file is suspiciously small",
      };
    }

    // The local destination, written from the SAME verified dump the S3 upload
    // uses — after the empty/too-small checks above, so a corrupt dump is never
    // copied into the directory an operator would restore from.
    let storedLocally = false;
    let localPath: string | undefined;
    let localPruned: string[] | undefined;
    if (config.localEnabled && config.localPath) {
      try {
        localPath = storeLocalBackup(filepath, config.localPath);
        storedLocally = true;
        // Same retention window as S3, by owner instruction — one number for the
        // whole feature.
        localPruned = pruneLocalBackups(config.localPath, config.retentionDays);
      } catch (localErr) {
        const message =
          localErr instanceof Error ? localErr.message : String(localErr);
        logger.error({ err: localErr, job: "backup" }, "Local backup copy failed");
        return {
          success: false,
          filename,
          filepath,
          sizeBytes: stats.size,
          error: `Local backup failed: ${message}`,
        };
      }
    }

    let uploadedToS3 = false;
    let s3Key: string | undefined;
    let s3ReadbackVerified = false;
    let s3ReadbackSizeBytes: number | undefined;
    let s3ReadbackPath: string | undefined;
    let restoreValidation: BackupRestoreValidation | undefined;

    // Upload to S3 if configured
    const s3Bucket = config.bucket;
    if (s3Bucket) {
      try {
        const s3Region = config.region;
        s3Key = `${S3_BACKUP_PREFIX}/${filename}`;

        const readback = uploadAndVerifyS3Readback({
          filepath,
          filename,
          expectedSizeBytes: stats.size,
          s3Bucket,
          s3Key,
          s3Region,
          accessKeyId: config.accessKeyId,
          secretAccessKey: config.secretAccessKey,
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
          storedLocally,
          localPath,
          localPruned,
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
    cleanupOldBackups(config.retentionDays);

    return {
      success: true,
      filename,
      filepath,
      storedLocally,
      localPath,
      localPruned,
      uploadedToS3,
      s3Key,
      s3ReadbackVerified,
      s3ReadbackSizeBytes,
      restoreValidation,
      sizeBytes: stats.size,
    };
  } catch (err) {
    const missing = describeMissingCommand(err);
    if (missing) {
      logger.error({ err, job: "backup" }, "Backup command is not installed");
      return { success: false, error: missing };
    }
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

    if (result.storedLocally) {
      resultSummary.local = true;
      if (result.localPruned?.length) {
        resultSummary.localPruned = result.localPruned.length;
      }
    }

    // "Not durable" means the dump exists ONLY in the container's ephemeral
    // /tmp, which a restart discards. A club that has deliberately configured a
    // local directory has a destination, so this no longer fails their nightly
    // run — but a local directory sits on the same host as the database, so it
    // is not off-site, and the operator guide says so rather than this pretending
    // the two destinations are equivalent.
    if (!result.uploadedToS3 && !result.storedLocally) {
      return {
        status: "FAILURE",
        error:
          "Backup completed only to local ephemeral storage; configure an S3 destination on Admin → Backups for durable backups",
        resultSummary: {
          ...resultSummary,
          healthSignal: "backup-not-durable",
        },
      };
    }

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

  const failure: BackupCronOutcome = {
    status: "FAILURE",
    error: result.error ?? "Unknown backup failure",
  };

  if (result.healthSignal || result.sizeBytes !== undefined) {
    failure.resultSummary = {
      healthSignal: result.healthSignal,
      filename: result.filename,
      sizeBytes: result.sizeBytes,
      minSizeBytes: result.minSizeBytes ?? MIN_BACKUP_SIZE_BYTES,
    };
  }

  return failure;
}

/**
 * Operator-facing message for the legacy-env migration hazard (#2095 MAJOR-1).
 */
export const LEGACY_BACKUP_ENV_UNMIGRATED_MESSAGE =
  "Legacy BACKUP_* environment variables are set but backups are disabled or " +
  "not configured for durable (S3) storage in the app. The old env config is " +
  "no longer read — migrate it at Admin → Backups so nightly backups resume. " +
  "Backups are NOT running.";

/**
 * Guard the scheduled cron outcome against the silent-stop migration hazard
 * (#2095 MAJOR-1).
 *
 * A live install that configured backups through the old `BACKUP_*` env vars
 * upgrades to the DB-only store empty: `resolveBackupConfig()` returns
 * `enabled:false`, the nightly run records SKIPPED, and the Sentry monitor stays
 * green — so backups cease unnoticed. When legacy backup env vars are still
 * present AND the run did not run durably (it was SKIPPED because disabled, or
 * would only be local-only), upgrade the SKIPPED outcome to a LOUD FAILURE that
 * tells the operator to migrate config. An enabled-but-not-durable run is
 * already a FAILURE via `buildBackupCronOutcome`, and a fully-migrated install
 * (SUCCESS, durable) is left untouched even if a stale env var lingers — that
 * lingering var is surfaced as a warning on the status payload, not a failure.
 *
 * Installs with NO legacy env and backups off stay quiet (SKIPPED): a
 * deliberately-disabled backup is not an incident.
 */
export function applyLegacyBackupEnvGate(
  outcome: BackupCronOutcome,
  options: { legacyEnvPresent: boolean },
): BackupCronOutcome {
  if (!options.legacyEnvPresent) return outcome;
  if (outcome.status !== "SKIPPED") return outcome;
  return {
    status: "FAILURE",
    error: LEGACY_BACKUP_ENV_UNMIGRATED_MESSAGE,
    resultSummary: {
      ...(outcome.resultSummary ?? {}),
      healthSignal: "backup-legacy-env-unmigrated",
    },
  };
}

// test seam
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

/**
 * Strip any embedded password out of a connection string that `new URL()` could
 * not parse — a libpq keyword-form conninfo (`host=… password=…`) or a URI whose
 * port is out of range so URL parsing throws. Defence in depth for #2095
 * MAJOR-2: such a string is never handed to psql/pg_dump on argv (where it would
 * show in a process listing) OR persisted verbatim, so the password cannot leak
 * even when the value bypasses the capture-time validation.
 *
 * The recovered password is intentionally NOT re-supplied via PGPASSWORD: the
 * only strings that legitimately reach here are `postgres://` URLs (parsed by
 * the branch above), so an unparseable value is already a misconfiguration and
 * failing the connection closed is safer than trying to reconstruct it.
 */
function stripUnparseablePassword(conninfo: string): string {
  return (
    conninfo
      // libpq keyword form: password=<token>, quoted or bare.
      .replace(/(\bpassword\s*=\s*)('[^']*'|"[^"]*"|[^\s]+)/gi, "$1")
      // URI userinfo form //user:secret@host that URL() rejected (e.g. bad
      // port). Username may be empty (`//:secret@host`), so `*` not `+`.
      .replace(/(:\/\/[^/:@\s]*):[^@/\s]+@/g, "$1@")
  );
}

/**
 * Split a postgres connection URL into a command-line-safe URL (password
 * removed) and the decoded password, so pg_dump/psql receive the password via
 * `PGPASSWORD` in the child env rather than on argv where it is visible in a
 * process listing. Returns the URL unchanged (no password) when it carries no
 * password. When the value is NOT a parseable URL, any embedded password token
 * is stripped as defence in depth so a live secret is never returned verbatim
 * (#2095 MAJOR-2). test seam.
 */
export function splitPostgresPassword(url: string): {
  argvUrl: string;
  password?: string;
} {
  try {
    const parsed = new URL(url);
    if (!parsed.password) return { argvUrl: url };
    const password = decodeURIComponent(parsed.password);
    parsed.password = "";
    return { argvUrl: parsed.toString(), password };
  } catch {
    return { argvUrl: stripUnparseablePassword(url) };
  }
}

/** Child env with `PGPASSWORD` set when a password was split out of the URL. */
export function buildPostgresEnvironment(password?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (password) {
    env.PGPASSWORD = password;
  } else {
    // Never inherit an ambient PGPASSWORD that does not match this URL.
    delete env.PGPASSWORD;
  }
  return env;
}

/**
 * Turn a "command not found" spawn failure into a message that says what is
 * missing and where it comes from.
 *
 * Backups shell out to four external tools — `pg_dump`, `psql`, `gunzip` and
 * `aws`. When one is absent Node reports `spawnSync pg_dump ENOENT`, which tells
 * an operator nothing: it names no tool an admin would recognise, suggests a
 * code fault rather than a missing package, and arrives on the one screen whose
 * job is disaster recovery. The application's own Docker image installs
 * `postgresql16-client` and `aws-cli`, so in a normal deployment this never
 * fires; it fires on a hand-rolled host or a developer machine, which is exactly
 * where the person reading it needs to be told what to install.
 *
 * Returns null for anything that is NOT a missing executable, so a genuine
 * ENOENT on a backup FILE keeps its own error rather than being mislabelled.
 */
export function describeMissingCommand(err: unknown): string | null {
  const error = err as NodeJS.ErrnoException & { syscall?: string; path?: string };
  if (error?.code !== "ENOENT") return null;
  // `spawnSync <cmd>` is the syscall on a failed LAUNCH; a missing file reports
  // `open` or `copyfile` instead. That distinction is the whole guard.
  if (!error.syscall?.startsWith("spawnSync")) return null;

  const command = error.path ?? error.syscall.replace("spawnSync ", "").trim();
  const provider =
    command === "aws"
      ? "the AWS CLI"
      : "the PostgreSQL client tools (pg_dump, psql)";
  return (
    `${command} is not installed on the server, so the backup could not run. ` +
    `This needs ${provider}. The application's Docker image includes them — a ` +
    `server or development machine running outside that image needs them ` +
    `installed and on PATH.`
  );
}

function runPgDump(filepath: string, sanitizedDatabaseUrl: string) {
  const { argvUrl, password } = splitPostgresPassword(sanitizedDatabaseUrl);
  const dump = execFileSync("pg_dump", [argvUrl], {
    timeout: BACKUP_COMMAND_TIMEOUT_MS,
    maxBuffer: BACKUP_COMMAND_MAX_BUFFER_BYTES,
    env: buildPostgresEnvironment(password),
    stdio: ["ignore", "pipe", "pipe"],
  });

  writeFileSync(filepath, gzipSync(dump));
}

function buildAwsEnvironment(
  accessKeyId: string | null,
  secretAccessKey: string | null,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (accessKeyId) {
    env.AWS_ACCESS_KEY_ID = accessKeyId;
  }
  if (secretAccessKey) {
    env.AWS_SECRET_ACCESS_KEY = secretAccessKey;
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
  accessKeyId,
  secretAccessKey,
}: {
  filepath: string;
  filename: string;
  expectedSizeBytes: number;
  s3Bucket: string;
  s3Key: string;
  s3Region: string;
  accessKeyId: string | null;
  secretAccessKey: string | null;
}) {
  const s3Uri = `s3://${s3Bucket}/${s3Key}`;
  const readbackPath = path.join(BACKUP_DIR, `${filename}.s3-readback`);
  const env = buildAwsEnvironment(accessKeyId, secretAccessKey);

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
  const { argvUrl: sanitizedRestoreUrl, password: restorePassword } =
    splitPostgresPassword(
      sanitizePostgresUrlForPgDump(restoreValidationDatabaseUrl),
    );
  const restoreEnv = buildPostgresEnvironment(restorePassword);

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
      env: restoreEnv,
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
    env: restoreEnv,
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
      env: restoreEnv,
      stdio: ["ignore", "pipe", "pipe"],
    }
  );

  const [memberCount, bookingCount, paymentCount] = counts
    .trim()
    .split("|")
    .map((value) => Number.parseInt(value, 10));

  if (
    memberCount === undefined ||
    bookingCount === undefined ||
    paymentCount === undefined ||
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
 * Remove backup files older than the configured retention window.
 */
function cleanupOldBackups(retentionDays: number) {
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
