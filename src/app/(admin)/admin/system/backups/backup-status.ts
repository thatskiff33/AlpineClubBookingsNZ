/**
 * The backups screen's API paths and the status payload they return, shared by
 * `backups-client.tsx` and `local-backup-card.tsx`. A leaf so the two cards
 * import it rather than each other (#4930, INV-SSOT-008: no import loop).
 */

export interface BackupRunSummary {
  id: string;
  status: "RUNNING" | "SUCCESS" | "FAILURE" | "SKIPPED";
  trigger: "scheduled" | "manual";
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  error: string | null;
  resultSummary: unknown;
  triggeredByMemberId: string | null;
}

interface LocalBackupFileSummary {
  filename: string;
  sizeBytes: number;
  modifiedAt: string;
}

interface LocalBackupDiskSpaceSummary {
  availableBytes: number;
  totalBytes: number;
  level: "ok" | "warning" | "critical";
}

export interface BackupStatus {
  enabled: boolean;
  bucket: string | null;
  region: string;
  retentionDays: number;
  accessKeyIdSet: boolean;
  secretAccessKeySet: boolean;
  restoreValidationUrlSet: boolean;
  localEnabled: boolean;
  localPath: string | null;
  /** The path came from the deployment's mount rather than a saved value. */
  localPathFromEnv: boolean;
  /** Either destination switched on — what actually decides whether a run happens. */
  anyDestinationEnabled: boolean;
  localBackups: LocalBackupFileSummary[];
  /** Null when the directory could not be measured — shown as unknown, never as fine. */
  localDiskSpace: LocalBackupDiskSpaceSummary | null;
  localError: string | null;
  durable: boolean;
  needsReentry: boolean;
  running: boolean;
  activeRun: BackupRunSummary | null;
  recentRuns: BackupRunSummary[];
  legacyEnvVars: string[];
  legacyEnvUnmigrated: boolean;
  cronSchedule: string;
  canManageDestination: boolean;
}

export const STATUS_URL = "/api/admin/backups/status";
export const CONFIG_URL = "/api/admin/backups/config";
export const RUN_URL = "/api/admin/backups/run";
