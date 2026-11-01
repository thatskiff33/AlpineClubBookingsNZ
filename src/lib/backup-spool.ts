import { existsSync, readdirSync, statSync, unlinkSync } from "fs";
import path from "path";
import { PARTIAL_SUFFIX } from "@/lib/backup-dump";
import logger from "@/lib/logger";

/**
 * Working space for dumps on their way to a destination (#4487). It persists
 * across restarts but is never a destination itself.
 */
export const BACKUP_DIR = "/tmp/tacbookings-backups";
/** The S3 copy downloaded back to check its size. */
export const S3_READBACK_SUFFIX = ".s3-readback";

/** Dumps, S3 readbacks and interrupted partial writes. */
const SPOOL_FILE_ENDINGS = [".sql.gz", `.sql.gz${S3_READBACK_SUFFIX}`, `.sql.gz${PARTIAL_SUFFIX}`];
const isSpoolFile = (file: string) =>
  file.startsWith("tacbookings-") && SPOOL_FILE_ENDINGS.some((ending) => file.endsWith(ending));

/**
 * Another run's spool files are left alone until this old, because a config
 * import runs a backup outside the BackupRun claim, alongside the cron one.
 * Twice BACKUP_STALE_AFTER_MS (backup-run.ts), which already bounds a whole run;
 * raise the two together. A local copy to a hung mount has no timeout, so a run
 * stuck past this window can lose its spool dump and then fails loudly.
 */
const SPOOL_FOREIGN_FILE_GRACE_MS = 60 * 60 * 1000;

/**
 * Remove this run's spool files except `keep`, the dump no destination
 * received, and any other run's spool file once it is past the grace window.
 * `own` is set only once this run's dump completed under that name, so a run
 * that lost a same-millisecond name collision never claims the winner's files.
 * Destination retention lives with each destination.
 */
export function pruneBackupSpool(own: string | undefined, keep: string | undefined) {
  const foreignCutoff = Date.now() - SPOOL_FOREIGN_FILE_GRACE_MS;
  try {
    if (!existsSync(BACKUP_DIR)) return;
    for (const file of readdirSync(BACKUP_DIR)) {
      if (file === keep || !isSpoolFile(file)) continue;
      const filepath = path.join(BACKUP_DIR, file);
      try {
        const ownFile = own !== undefined && file.startsWith(own);
        if (!ownFile && statSync(filepath).mtimeMs >= foreignCutoff) continue;
        unlinkSync(filepath);
        logger.info({ file, job: "backup" }, "Removed backup spool file");
      } catch (err) {
        logger.error({ err, file, job: "backup" }, "Backup spool cleanup error");
      }
    }
  } catch (err) {
    logger.error({ err, job: "backup" }, "Backup spool cleanup error");
  }
}
