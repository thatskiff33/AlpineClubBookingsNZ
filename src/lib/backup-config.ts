/**
 * Managed backup configuration — DB-only resolution (#2095, C6).
 *
 * Every piece of backup configuration — the S3 access key/secret, the
 * restore-validation shadow DSN, the destination bucket/region, the retention
 * window, and the enabled switch — lives ONLY in the encrypted
 * IntegrationCredential store (C1, #2079). The legacy `BACKUP_ENABLED` /
 * `BACKUP_S3_*` / `BACKUP_RETENTION_DAYS` / `BACKUP_RESTORE_VALIDATION_URL` env
 * vars are no longer read for operation — they are detected and flagged for
 * removal (see `detectLegacyProviderEnv` in xero-config.ts). Resolution is async
 * (a DB fetch, cache-backed by integration-credentials.ts).
 *
 * The ONE exception is `BACKUP_CRON_SCHEDULE`: it is cron-leader infrastructure
 * timing (when the nightly job fires), not club configuration, so it stays in
 * the environment and is read by instrumentation.node.ts / admin-cron-health.ts.
 *
 * Exposure contract (#2079): the S3 secret access key, access key id, and the
 * restore-validation DSN are NEVER returned to a client, logged, or put in an
 * audit row. The bucket name and region are the destination (not secret) and
 * may be shown to operators; even so, writing them is Full-Admin only because
 * repointing the destination exfiltrates the entire pg_dump.
 */

import type { IntegrationCredentialNamespace } from "@/lib/integration-credential-namespaces";
import { prisma } from "@/lib/prisma";
import {
  getIntegrationCredentialValue,
  providerNeedsReentry,
} from "@/lib/integration-credentials";

export const BACKUP_PROVIDER = "backup" satisfies IntegrationCredentialNamespace;

export const DEFAULT_BACKUP_REGION = "ap-southeast-2";
import {
  DEFAULT_BACKUP_RETENTION_DAYS,
  MIN_BACKUP_RETENTION_DAYS,
  MAX_BACKUP_RETENTION_DAYS,
} from "./backup-config-shared";
export {
  DEFAULT_BACKUP_RETENTION_DAYS,
  MIN_BACKUP_RETENTION_DAYS,
  MAX_BACKUP_RETENTION_DAYS,
};

/**
 * All backup credential/config slots stored in the encrypted store. Split by the
 * write privilege each carries (epic decision 4; issue #2095 scope).
 */
export const BACKUP_CREDENTIAL_KEYS = {
  // Secret, write-only (Full Admin, via the shared C1 credentials route).
  accessKeyId: "access_key_id",
  secretAccessKey: "secret_access_key",
  // Shadow-database DSN for restore validation — carries a password, so it is
  // treated as a write-only secret (Full Admin, redacted, never echoed).
  restoreValidationUrl: "restore_validation_url",
  // Destination (Full Admin — repointing exfiltrates the dump).
  bucket: "bucket",
  region: "region",
  // Operational config (support:edit).
  enabled: "enabled",
  retentionDays: "retention_days",
  // Local (on-host) destination. `localEnabled` is operational (support:edit);
  // `localPath` is a DESTINATION and therefore Full-Admin only on exactly the
  // same reasoning as `bucket` above — a dump written into a web-served
  // directory is the whole database published to anyone who guesses a filename.
  localEnabled: "local_enabled",
  localPath: "local_path",
} as const;

/**
 * Write-only secret keys captured through the shared C1 credentials route
 * (`/api/admin/integrations/credentials`, Full Admin). The route's allowlist
 * imports this so a backup secret can only be written by a Full Admin.
 */
export const BACKUP_SECRET_CREDENTIAL_KEYS = [
  BACKUP_CREDENTIAL_KEYS.accessKeyId,
  BACKUP_CREDENTIAL_KEYS.secretAccessKey,
  BACKUP_CREDENTIAL_KEYS.restoreValidationUrl,
] as const;

// The destination (bucket/region) and operational (enabled/retention) key
// groupings are enforced inline in the backups config route rather than via
// exported arrays; keep this file's exported surface to what is actually used.

// ---------------------------------------------------------------------------
// Validation for admin-editable strings interpolated into CLI calls
// ---------------------------------------------------------------------------

// S3 bucket naming rules (3–63 chars, lowercase letters/digits/hyphens/dots,
// must start and end alphanumeric). execFileSync array-args are injection-safe,
// but a strict regex keeps a malformed destination from silently breaking every
// backup and rejects anything shell-surprising up front.
const S3_BUCKET_REGEX = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
// AWS region tokens are lowercase letters, digits and hyphens.
const S3_REGION_REGEX = /^[a-z0-9-]+$/;

export function isValidS3Bucket(value: string): boolean {
  const trimmed = value.trim();
  if (!S3_BUCKET_REGEX.test(trimmed)) return false;
  // Reject consecutive dots and IP-address-shaped names, per AWS rules.
  if (trimmed.includes("..")) return false;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(trimmed)) return false;
  return true;
}

export function isValidS3Region(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 40 && S3_REGION_REGEX.test(trimmed);
}

/**
 * Whether a submitted restore-validation DSN is a parseable postgres URI.
 *
 * Capture-time gate (#2095 MAJOR-2): the DSN carries a password and is passed to
 * psql. It MUST be a `postgres://` / `postgresql://` URI so `new URL()` (and
 * therefore `splitPostgresPassword`) can lift the password off argv into
 * PGPASSWORD. A libpq keyword-form conninfo (`host=… password=…`) or a
 * malformed URI that URL parsing rejects would otherwise keep the password on
 * the psql command line — and in any persisted error — so it is refused here.
 */
export function isValidRestoreValidationUrl(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0) return false;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === "postgres:" || parsed.protocol === "postgresql:";
  } catch {
    return false;
  }
}

/**
 * Parse a stored/submitted retention-days value, clamped to a sane range.
 * Returns the default when the value is missing or unparseable.
 */
export function parseRetentionDays(value: string | null | undefined): number {
  const parsed = Number.parseInt((value ?? "").trim(), 10);
  if (!Number.isFinite(parsed)) return DEFAULT_BACKUP_RETENTION_DAYS;
  if (parsed < MIN_BACKUP_RETENTION_DAYS) return MIN_BACKUP_RETENTION_DAYS;
  if (parsed > MAX_BACKUP_RETENTION_DAYS) return MAX_BACKUP_RETENTION_DAYS;
  return parsed;
}

// ---------------------------------------------------------------------------
// Operational resolver (async DB fetch, C1 cache-backed)
// ---------------------------------------------------------------------------

export interface ResolvedBackupConfig {
  enabled: boolean;
  bucket: string | null;
  region: string;
  retentionDays: number;
  accessKeyId: string | null;
  secretAccessKey: string | null;
  restoreValidationUrl: string | null;
  /** Local on-host destination: the switch, and the directory it writes to. */
  localEnabled: boolean;
  localPath: string | null;
  /**
   * True when the provider has stored credentials that fail to decrypt (the app
   * auth secret changed). The backup engine treats this as a LOUD failure, never
   * a silent skip — an unattended cron run must alert, not quietly disable the
   * disaster-recovery path.
   */
  needsReentry: boolean;
}

/**
 * Resolve the full operational backup config from the encrypted store. A DB
 * error propagates to the caller. When any stored backup credential fails GCM,
 * `needsReentry` is true and the value fields are whatever still decrypts (the
 * engine short-circuits to a failure before using them).
 */
export async function resolveBackupConfig(): Promise<ResolvedBackupConfig> {
  const needsReentry = await providerNeedsReentry(BACKUP_PROVIDER);

  const [
    enabledRaw,
    bucketRaw,
    regionRaw,
    retentionRaw,
    accessKeyId,
    secretAccessKey,
    restoreValidationUrl,
    localEnabledRaw,
    localPathRaw,
  ] = await Promise.all([
    getIntegrationCredentialValue(BACKUP_PROVIDER, BACKUP_CREDENTIAL_KEYS.enabled),
    getIntegrationCredentialValue(BACKUP_PROVIDER, BACKUP_CREDENTIAL_KEYS.bucket),
    getIntegrationCredentialValue(BACKUP_PROVIDER, BACKUP_CREDENTIAL_KEYS.region),
    getIntegrationCredentialValue(
      BACKUP_PROVIDER,
      BACKUP_CREDENTIAL_KEYS.retentionDays,
    ),
    getIntegrationCredentialValue(
      BACKUP_PROVIDER,
      BACKUP_CREDENTIAL_KEYS.accessKeyId,
    ),
    getIntegrationCredentialValue(
      BACKUP_PROVIDER,
      BACKUP_CREDENTIAL_KEYS.secretAccessKey,
    ),
    getIntegrationCredentialValue(
      BACKUP_PROVIDER,
      BACKUP_CREDENTIAL_KEYS.restoreValidationUrl,
    ),
    getIntegrationCredentialValue(
      BACKUP_PROVIDER,
      BACKUP_CREDENTIAL_KEYS.localEnabled,
    ),
    getIntegrationCredentialValue(BACKUP_PROVIDER, BACKUP_CREDENTIAL_KEYS.localPath),
  ]);

  const bucket = bucketRaw?.trim() ? bucketRaw.trim() : null;
  const region = regionRaw?.trim() ? regionRaw.trim() : DEFAULT_BACKUP_REGION;

  return {
    enabled: enabledRaw?.trim().toLowerCase() === "true",
    bucket,
    region,
    retentionDays: parseRetentionDays(retentionRaw),
    accessKeyId: accessKeyId?.trim() ? accessKeyId.trim() : null,
    secretAccessKey: secretAccessKey?.trim() ? secretAccessKey.trim() : null,
    restoreValidationUrl: restoreValidationUrl?.trim()
      ? restoreValidationUrl.trim()
      : null,
    localEnabled: localEnabledRaw?.trim().toLowerCase() === "true",
    // The stored path wins; the deployment's mount is the DEFAULT.
    //
    // `BACKUP_LOCAL_DIR` is where the compose stack mounts the backup volume
    // INSIDE the container, so it is deployment infrastructure rather than club
    // configuration — the same reasoning that keeps `BACKUP_CRON_SCHEDULE` in
    // the environment while everything else moved into the encrypted store
    // (#2095, C6). Falling back to it means an operator who has set the mount
    // does not then have to retype the path into the admin screen, and cannot
    // typo it into somewhere unmounted.
    localPath:
      localPathRaw?.trim() ||
      process.env.BACKUP_LOCAL_DIR?.trim() ||
      null,
    needsReentry,
  };
}

/**
 * Whether ANY destination is switched on — the one predicate that decides
 * whether a backup runs at all.
 *
 * It exists as a shared function rather than an inline `a || b` because the
 * question is asked in four places that must agree: the engine, the run-now
 * route's up-front refusal, the run button's disabled state, and the status
 * pill. Local backups shipped with the engine updated and the other three still
 * reading `enabled` alone, so a club with local backups on was told "Backups are
 * disabled" by the very button that would have worked.
 */
export function isAnyBackupDestinationEnabled(config: {
  enabled: boolean;
  localEnabled: boolean;
}): boolean {
  return config.enabled || config.localEnabled;
}

// ---------------------------------------------------------------------------
// Metadata-only setup state (status surfaces + readiness) — NO secret values
// ---------------------------------------------------------------------------

export interface BackupSetupState {
  enabled: boolean;
  /** Destination bucket name (not secret) or null when local-only. */
  bucket: string | null;
  region: string;
  retentionDays: number;
  /** Whether each write-only secret is stored — never the value. */
  accessKeyIdSet: boolean;
  secretAccessKeySet: boolean;
  restoreValidationUrlSet: boolean;
  /** Local destination: the switch and the configured directory (not secret). */
  localEnabled: boolean;
  localPath: string | null;
  /**
   * True when `localPath` came from the deployment's `BACKUP_LOCAL_DIR` mount
   * rather than from a value an admin saved. The screen says so, because a
   * pre-filled path an operator did not type is otherwise indistinguishable from
   * one they set months ago and forgot.
   */
  localPathFromEnv: boolean;
  /** True when EITHER destination is switched on — see isAnyBackupDestinationEnabled. */
  anyDestinationEnabled: boolean;
  /**
   * True when backups reach a destination that survives a container restart —
   * a configured S3 bucket with both secrets, OR an enabled local directory.
   * False means the dump exists only in the container's ephemeral /tmp.
   */
  durable: boolean;
  /** Any stored backup credential fails to decrypt (the auth secret changed). */
  needsReentry: boolean;
}

/**
 * Metadata-only backup setup state for the status API, hub card and readiness.
 * NEVER returns any secret value or the restore-validation DSN. A DB error
 * propagates to the caller (which decides how to degrade).
 */
export async function getBackupSetupState(): Promise<BackupSetupState> {
  const rows = await prisma.integrationCredential.findMany({
    where: { provider: BACKUP_PROVIDER },
    select: { key: true },
  });
  const present = new Set(rows.map((row) => row.key));

  const config = await resolveBackupConfig();

  const accessKeyIdSet = present.has(BACKUP_CREDENTIAL_KEYS.accessKeyId);
  const secretAccessKeySet = present.has(BACKUP_CREDENTIAL_KEYS.secretAccessKey);

  return {
    enabled: config.enabled,
    bucket: config.bucket,
    region: config.region,
    retentionDays: config.retentionDays,
    accessKeyIdSet,
    secretAccessKeySet,
    restoreValidationUrlSet: present.has(
      BACKUP_CREDENTIAL_KEYS.restoreValidationUrl,
    ),
    localEnabled: config.localEnabled,
    localPath: config.localPath,
    localPathFromEnv:
      !present.has(BACKUP_CREDENTIAL_KEYS.localPath) && Boolean(config.localPath),
    anyDestinationEnabled: isAnyBackupDestinationEnabled(config),
    durable:
      (Boolean(config.bucket) && accessKeyIdSet && secretAccessKeySet) ||
      (config.localEnabled && Boolean(config.localPath)),
    needsReentry: config.needsReentry,
  };
}
