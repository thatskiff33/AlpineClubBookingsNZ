import "server-only";

import { NextResponse } from "next/server";

import { createAuditLog, getAuditRequestContext } from "@/lib/audit";
import { requireAdmin } from "@/lib/session-guards";
import {
  isAnyBackupDestinationEnabled,
  resolveBackupConfig,
} from "@/lib/backup-config";
import {
  getActiveBackupRun,
  runManagedBackup,
} from "@/lib/backup-run";
import logger from "@/lib/logger";
import {
  BACKUP_STARTED_CONNECTION_SHAPE,
  type BackupStartedAnswer,
} from "@/lib/connection-shapes/support-system";
import { connectionJson } from "@/lib/mcp-connection-request";

// POST /api/admin/backups/run — "run backup now" (support:edit).
//
// The backup runs OFF the request path: the API returns immediately and the
// backup executes as a background job (the process is a long-lived Node server
// with in-process cron, not serverless), guarded by the SAME DB-level
// cross-process claim the nightly cron honours. The page polls
// /api/admin/backups/status for live job status and terminal states.
//
// pg_dump against the live database is long-running (the pipeline uses a 1 GiB
// maxBuffer and a 120s per-command timeout), so it must never run in-request —
// doing so would freeze the serving process for the whole dump+gzip+upload.

export async function POST(request: Request) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  // Best-effort friendly refusal; the authoritative cross-process guard is the
  // claim inside runManagedBackup (a racing second press just no-ops there).
  const active = await getActiveBackupRun().catch(() => null);
  if (active) {
    return NextResponse.json(
      {
        error: "A backup is already running.",
        running: true,
        activeRun: active,
      },
      { status: 409 },
    );
  }

  // Surface an obviously-unrunnable configuration up front rather than starting
  // a background job that immediately fails. Never returns any secret.
  let config;
  try {
    config = await resolveBackupConfig();
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.name : "unknown", job: "backup" },
      "Failed to resolve backup config for run-now",
    );
    return NextResponse.json(
      { error: "Could not resolve backup configuration." },
      { status: 500 },
    );
  }
  if (config.needsReentry) {
    return NextResponse.json(
      {
        error:
          "Backup credentials could not be decrypted (the app auth secret changed). Re-enter the S3 credentials first.",
      },
      { status: 409 },
    );
  }
  // EITHER destination, not just the S3 switch: a club backing up only to a
  // local directory never turns `enabled` on, and refusing here told them
  // "Backups are disabled" from the button that would have worked.
  if (!isAnyBackupDestinationEnabled(config)) {
    return NextResponse.json(
      { error: "Backups are disabled. Enable them before running a backup." },
      { status: 409 },
    );
  }

  // Capture the request context NOW (the request object is not available inside
  // the background task once the response returns).
  const ctx = getAuditRequestContext(request);
  const auditRequestFields = {
    requestId: ctx?.id ?? undefined,
    ipAddress: ctx?.ipAddress ?? undefined,
    userAgent: ctx?.userAgent ?? undefined,
  };
  const memberId = guard.session.user.id;

  // Fire-and-forget: the claim + dump run in the background; the response
  // returns immediately. The audit entry is written only AFTER a successful
  // claim (#2095 MINOR-8): if this press lost the cross-process claim to a
  // racing run, no backup actually started here, so recording "Started a manual
  // database backup" would be false provenance. Errors are finalized onto the
  // BackupRun row inside runManagedBackup and logged here as a backstop.
  void runManagedBackup({
    trigger: "manual",
    triggeredByMemberId: memberId,
  })
    .then(async (outcome) => {
      if (!outcome.claimed) {
        // Lost the claim to a concurrent run — nothing started, nothing to audit.
        return;
      }
      await createAuditLog({
        action: "backup.run.now",
        category: "security",
        severity: "important",
        outcome: "success",
        memberId,
        entityType: "BackupRun",
        entityId: outcome.runId ?? "manual",
        summary: "Started a manual database backup",
        metadata: { trigger: "manual", runId: outcome.runId ?? null },
        ...auditRequestFields,
      });
    })
    .catch((err) => {
      logger.error(
        { err, job: "backup" },
        "Background manual backup failed after dispatch",
      );
    });

  const answer: BackupStartedAnswer = { ok: true, started: true };
  return connectionJson(request, answer, BACKUP_STARTED_CONNECTION_SHAPE, { status: 202 });
}
