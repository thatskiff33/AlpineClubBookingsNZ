import "server-only";

import { NextResponse } from "next/server";

import { requireAdmin } from "@/lib/session-guards";
import { isFullAdmin } from "@/lib/access-roles";
import { getBackupSetupState } from "@/lib/backup-config";
import { getRecentBackupRuns, getActiveBackupRun } from "@/lib/backup-run";
import {
  getLocalBackupDiskSpace,
  listLocalBackups,
  type LocalBackupDiskSpace,
  type LocalBackupFile,
} from "@/lib/backup-local";
import { detectLegacyProviderEnv } from "@/lib/xero-config";
import { BACKUP_PROVIDER } from "@/lib/backup-config";
import logger from "@/lib/logger";

// GET /api/admin/backups/status — metadata-only backup setup state + run history.
//
// Support:view (the registered area) so area admins keep status visibility.
// This route NEVER returns any secret value or the restore-validation DSN — only
// booleans, the destination bucket/region (not secret), retention, the
// needs-reentry flag, recent run metadata, and the cron schedule. Exposure
// contract (#2079).

/** Cron-leader backup timing stays env-driven (BACKUP_CRON_SCHEDULE, #2095). */
function backupCronSchedule(): string {
  return process.env.BACKUP_CRON_SCHEDULE?.trim() || "0 3 * * *";
}

export async function GET() {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  let state;
  try {
    state = await getBackupSetupState();
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.name : "unknown", job: "backup" },
      "Failed to resolve backup setup state",
    );
    return NextResponse.json(
      { error: "Could not resolve backup status." },
      { status: 500 },
    );
  }

  const [recentRuns, activeRun] = await Promise.all([
    getRecentBackupRuns(10),
    getActiveBackupRun(),
  ]);

  // Local destination detail for the admin screen. Both reads touch the
  // filesystem, so both are individually fault-tolerant: a directory that has
  // been unmounted since it was configured must still render a page that SAYS
  // so, rather than 500 the whole status endpoint and leave the operator with
  // no way to correct the setting.
  let localBackups: LocalBackupFile[] = [];
  let localDiskSpace: LocalBackupDiskSpace | null = null;
  let localError: string | null = null;
  if (state.localPath) {
    try {
      localBackups = listLocalBackups(state.localPath);
    } catch (err) {
      localError =
        err instanceof Error ? err.message : "Could not read the backup directory.";
    }
    try {
      localDiskSpace = getLocalBackupDiskSpace(state.localPath);
    } catch {
      // Leave it null — the client shows "unknown" rather than a false figure,
      // and never a reassuring one.
      localDiskSpace = null;
    }
  }

  const legacyEnvVars =
    detectLegacyProviderEnv().find((f) => f.provider === BACKUP_PROVIDER)?.vars ??
    [];

  // The dangerous migration state (#2095 MAJOR-1): legacy BACKUP_* env vars are
  // still set but the app config is disabled or not durable, so the nightly cron
  // is silently NOT producing durable backups. Surfaced as a distinct alarm
  // (not just the informational "remove these vars" notice).
  const legacyEnvUnmigrated =
    legacyEnvVars.length > 0 && (!state.enabled || !state.durable);

  return NextResponse.json({
    enabled: state.enabled,
    bucket: state.bucket,
    region: state.region,
    retentionDays: state.retentionDays,
    accessKeyIdSet: state.accessKeyIdSet,
    secretAccessKeySet: state.secretAccessKeySet,
    restoreValidationUrlSet: state.restoreValidationUrlSet,
    localEnabled: state.localEnabled,
    localPath: state.localPath,
    localPathFromEnv: state.localPathFromEnv,
    anyDestinationEnabled: state.anyDestinationEnabled,
    localBackups,
    localDiskSpace,
    localError,
    durable: state.durable,
    needsReentry: state.needsReentry,
    running: Boolean(activeRun),
    activeRun,
    recentRuns,
    legacyEnvVars,
    legacyEnvUnmigrated,
    cronSchedule: backupCronSchedule(),
    // Client uses this to gate the Full-Admin-only destination/credential
    // affordances; the write routes enforce it independently.
    canManageDestination: isFullAdmin(guard.session.user),
  });
}
