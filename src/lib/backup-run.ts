/**
 * Managed database backup runner with a cross-process lock (#2095, C6).
 *
 * Both the nightly cron (cron-leader container) and the /admin/backups "run
 * backup now" action route through `runManagedBackup`. It CLAIMS a run under a
 * brief `pg_advisory_xact_lock` before creating a RUNNING `BackupRun` row, so
 * two containers (blue/green web slots + cron-leader, docker-compose.yml) can
 * never start overlapping pg_dumps — an in-memory guard cannot see another
 * process's run. A RUNNING row whose heartbeat has aged past the staleness
 * window is reaped to FAILURE on the next claim, so a container that died
 * mid-dump never wedges the lock.
 *
 * The actual dump/upload happens OUTSIDE the claim transaction: the advisory
 * lock is held only for the milliseconds of the check-and-insert, never for the
 * whole (potentially minutes-long) backup.
 */

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import logger from "@/lib/logger";
import { runDatabaseBackup, type BackupResult } from "@/lib/backup";
import { redactSensitiveText } from "@/lib/redact-sensitive-json";

export type BackupRunTrigger = "scheduled" | "manual";
export type BackupRunStatus = "RUNNING" | "SUCCESS" | "FAILURE" | "SKIPPED";

/**
 * A RUNNING row older than this (by `heartbeatAt`) is considered dead — the
 * container that owned it restarted or the process was killed mid-dump — and is
 * reaped to FAILURE on the next claim.
 *
 * `heartbeatAt` is written at claim and again at finalize ONLY; it is NOT
 * refreshed at intermediate stages. The staleness window therefore has to cover
 * a whole healthy run in one go, which is the load-bearing invariant here:
 * BACKUP_STALE_AFTER_MS (30 min) MUST exceed the worst-case cumulative command
 * time — BACKUP_COMMAND_TIMEOUT_MS (120s per command in src/lib/backup.ts) times
 * the number of pg_dump/psql/aws stages a run executes — so a slow-but-healthy
 * run is never reaped out from under itself. Today a durable + restore-validated
 * run is a handful of ~120s stages, comfortably under 30 min; if the per-command
 * timeout or the stage count grows materially, raise this window in step.
 */
export const BACKUP_STALE_AFTER_MS = 30 * 60 * 1000;

/** Stable advisory-lock key string, hashed by hashtext() inside the claim. */
const BACKUP_ADVISORY_LOCK_KEY = "backup:run-lock";

export interface ManagedBackupOutcome {
  /** False when another process already holds an active run (no dump ran). */
  claimed: boolean;
  /** Present only when claimed: the backup engine result. */
  result?: BackupResult;
  /** The BackupRun row id, when a run was claimed. */
  runId?: string;
}

/**
 * Metadata-only projection of a BackupRun for the admin status surface — never
 * carries any secret (the row's resultSummary is already metadata-only).
 */
export interface BackupRunSummary {
  id: string;
  status: BackupRunStatus;
  trigger: BackupRunTrigger;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  error: string | null;
  resultSummary: unknown;
  triggeredByMemberId: string | null;
}

function toSummary(row: {
  id: string;
  status: string;
  trigger: string;
  startedAt: Date;
  completedAt: Date | null;
  durationMs: number | null;
  error: string | null;
  resultSummary: Prisma.JsonValue | null;
  triggeredByMemberId: string | null;
}): BackupRunSummary {
  return {
    id: row.id,
    status: row.status as BackupRunStatus,
    trigger: row.trigger as BackupRunTrigger,
    startedAt: row.startedAt.toISOString(),
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
    durationMs: row.durationMs,
    error: row.error,
    resultSummary: row.resultSummary ?? null,
    triggeredByMemberId: row.triggeredByMemberId,
  };
}

interface ClaimResult {
  claimed: boolean;
  runId?: string;
}

/**
 * Atomically claim a backup run. Serialised across processes by
 * `pg_advisory_xact_lock`: within one transaction we take the lock, reap any
 * stale RUNNING rows, refuse if a fresh RUNNING row exists, else insert a new
 * RUNNING row. The lock releases at COMMIT (a few ms later).
 */
async function claimBackupRun(params: {
  trigger: BackupRunTrigger;
  triggeredByMemberId?: string | null;
  now: Date;
}): Promise<ClaimResult> {
  const staleCutoff = new Date(params.now.getTime() - BACKUP_STALE_AFTER_MS);

  return prisma.$transaction(async (tx) => {
    // Serialise the claim across every container.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${BACKUP_ADVISORY_LOCK_KEY}))`;

    // Reap dead RUNNING rows (heartbeat older than the staleness window).
    await tx.backupRun.updateMany({
      where: { status: "RUNNING", heartbeatAt: { lt: staleCutoff } },
      data: {
        status: "FAILURE",
        completedAt: params.now,
        error:
          "Backup did not report completion within the expected window (container restarted or process died mid-run).",
      },
    });

    // A live RUNNING row means another process owns the current run.
    const active = await tx.backupRun.findFirst({
      where: { status: "RUNNING", heartbeatAt: { gte: staleCutoff } },
      select: { id: true },
    });
    if (active) {
      return { claimed: false };
    }

    const created = await tx.backupRun.create({
      data: {
        status: "RUNNING",
        trigger: params.trigger,
        startedAt: params.now,
        heartbeatAt: params.now,
        triggeredByMemberId: params.triggeredByMemberId ?? null,
      },
      select: { id: true },
    });
    return { claimed: true, runId: created.id };
  });
}

/** Serialisable, metadata-only summary for the row's resultSummary column. */
function backupResultSummary(result: BackupResult): Prisma.InputJsonValue {
  const summary: Record<string, unknown> = {
    success: result.success,
    uploadedToS3: result.uploadedToS3 ?? false,
  };
  if (result.filename) summary.filename = result.filename;
  if (result.sizeBytes !== undefined) summary.sizeBytes = result.sizeBytes;
  if (result.s3Key) summary.s3Key = result.s3Key;
  if (result.s3ReadbackVerified !== undefined) {
    summary.s3ReadbackVerified = result.s3ReadbackVerified;
  }
  if (result.restoreValidation) {
    summary.restoreValidation = result.restoreValidation;
  }
  if (result.reason) summary.reason = result.reason;
  if (result.healthSignal) summary.healthSignal = result.healthSignal;
  return summary as Prisma.InputJsonValue;
}

async function finalizeBackupRun(
  runId: string,
  status: BackupRunStatus,
  fields: { error?: string | null; result?: BackupResult },
): Promise<void> {
  const completedAt = new Date();
  const row = await prisma.backupRun.findUnique({
    where: { id: runId },
    select: { startedAt: true },
  });
  const durationMs = row
    ? completedAt.getTime() - row.startedAt.getTime()
    : null;
  // Defence in depth (#2095 MAJOR-2): a backup command error message can embed
  // the full psql/pg_dump command line, which for a malformed DSN could carry a
  // password. This row is rendered by the support:view status route and the
  // backups client, so redact any secret before it is persisted — regardless of
  // the DSN shape that produced it.
  const redactedError =
    fields.error != null ? redactSensitiveText(fields.error) : null;
  await prisma.backupRun.update({
    where: { id: runId },
    data: {
      status,
      completedAt,
      heartbeatAt: completedAt,
      durationMs,
      error: redactedError,
      resultSummary: fields.result
        ? backupResultSummary(fields.result)
        : undefined,
    },
  });
}

/**
 * Claim + run a managed backup. Returns `claimed: false` without running when
 * another process already holds an active run. On any thrown error the run row
 * is finalized to FAILURE and the error re-thrown to the caller.
 */
export async function runManagedBackup(params: {
  trigger: BackupRunTrigger;
  triggeredByMemberId?: string | null;
}): Promise<ManagedBackupOutcome> {
  const now = new Date();
  const claim = await claimBackupRun({
    trigger: params.trigger,
    triggeredByMemberId: params.triggeredByMemberId,
    now,
  });

  if (!claim.claimed || !claim.runId) {
    return { claimed: false };
  }
  const runId = claim.runId;

  try {
    const result = await runDatabaseBackup();
    const status: BackupRunStatus = result.success
      ? "SUCCESS"
      : result.skipped
        ? "SKIPPED"
        : "FAILURE";
    await finalizeBackupRun(runId, status, {
      error: result.success ? null : result.error ?? result.reason ?? null,
      result,
    });
    return { claimed: true, result, runId };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err, job: "backup", runId }, "Managed backup threw");
    await finalizeBackupRun(runId, "FAILURE", {
      error: `Backup run failed: ${message}`,
    }).catch((finalizeErr) => {
      logger.error(
        { err: finalizeErr, job: "backup", runId },
        "Failed to finalize backup run after error",
      );
    });
    throw err;
  }
}

/** Latest backup runs (most recent first) for the admin status surface. */
export async function getRecentBackupRuns(
  limit = 10,
): Promise<BackupRunSummary[]> {
  const rows = await prisma.backupRun.findMany({
    orderBy: { startedAt: "desc" },
    take: limit,
  });
  return rows.map(toSummary);
}

/**
 * Retention for the BackupRun history table, matching CronJobRun's policy
 * (src/lib/cron-job-run.ts `pruneCronRuns`). Without this the run history grows
 * unbounded (one nightly row forever, plus every manual run). Called from the
 * daily data-pruning cron.
 */
export const BACKUP_RUN_RETENTION_DAYS = 90;

const MILLISECONDS_PER_DAY = 86_400_000;

/** Auto-prune old BackupRun records (older than the retention window). */
export async function pruneBackupRuns(): Promise<{ count: number }> {
  // A retention window is a DURATION, not a calendar span, so it is measured
  // in milliseconds rather than by stepping a host-local clock face
  // (INV-DATE-014, CT-6 #2991). `setDate(getDate() - n)` moved n LOCAL days,
  // which is n x 24h except across a daylight-saving transition, where it is an
  // hour out — and it answered in whichever zone the container ran in.
  const cutoff = new Date(
    Date.now() - BACKUP_RUN_RETENTION_DAYS * MILLISECONDS_PER_DAY
  );
  const { count } = await prisma.backupRun.deleteMany({
    where: { startedAt: { lt: cutoff } },
  });
  if (count > 0) {
    logger.info(
      { job: "backup-run-prune", deletedCount: count },
      "Pruned old backup runs",
    );
  }
  return { count };
}

/** The currently active (RUNNING, not stale) backup run, or null. */
export async function getActiveBackupRun(
  now: Date = new Date(),
): Promise<BackupRunSummary | null> {
  const staleCutoff = new Date(now.getTime() - BACKUP_STALE_AFTER_MS);
  const row = await prisma.backupRun.findFirst({
    where: { status: "RUNNING", heartbeatAt: { gte: staleCutoff } },
    orderBy: { startedAt: "desc" },
  });
  return row ? toSummary(row) : null;
}
