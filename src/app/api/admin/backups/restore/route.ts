import "server-only";

import { NextResponse } from "next/server";
import { z } from "zod";

import { parseJsonRequestBody } from "@/lib/api-json";
import { createAuditLog, getAuditRequestContext } from "@/lib/audit";
import { isFullAdmin } from "@/lib/access-roles";
import { requireAdmin } from "@/lib/session-guards";
import { resolveBackupConfig } from "@/lib/backup-config";
import { LocalBackupPathError } from "@/lib/backup-local";
import { restoreLocalBackup } from "@/lib/backup-restore";
import { getActiveBackupRun } from "@/lib/backup-run";
import logger from "@/lib/logger";

// POST /api/admin/backups/restore — restore a local backup over the LIVE database.
//
// This is the most destructive endpoint in the application. Everything written
// since the chosen dump is gone the moment it succeeds, and there is no undo, so
// the gates are deliberately heavier than the rest of the backups area:
//
//   * FULL ADMIN, not support:edit. Running a backup is an operational action a
//     support admin should be able to take; overwriting production is not the
//     same privilege, and `requireAdmin`'s area check alone would grant it.
//   * AN EXPLICIT CONFIRMATION FIELD in the body. A restore must never be one
//     stray click or one replayed request — the caller has to say what it is
//     doing, so a CSRF-shaped or mistaken POST that happens to carry a filename
//     still does nothing.
//   * A FILENAME, NEVER A PATH. `restoreLocalBackup` re-derives the directory
//     from stored config and requires the name to appear in that directory's own
//     listing. A `.sql` file is executable SQL, so accepting a path here would
//     be arbitrary statement execution behind a dropdown.
//   * NOT WHILE A BACKUP IS RUNNING, so a dump and a restore can never interleave
//     on the same database.
//
// It runs IN-REQUEST rather than as a background job, unlike run-now: the
// operator is standing in front of it and must be told whether their database
// came back, and a restore that reports "started" and then fails silently is
// the worst possible outcome for the one operation with no undo.

const bodySchema = z
  .object({
    filename: z.string().min(1).max(255),
    /** Must be exactly "RESTORE" — see the note above about stray clicks. */
    confirm: z.literal("RESTORE"),
  })
  .strict();

export async function POST(request: Request) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  if (!isFullAdmin(guard.session.user)) {
    return NextResponse.json(
      {
        error:
          "Restoring a backup over the live database requires Full Admin access.",
      },
      { status: 403 },
    );
  }

  const json = await parseJsonRequestBody(request);
  if (!json.ok) return json.response;
  const parsed = bodySchema.safeParse(json.body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const config = await resolveBackupConfig().catch(() => null);
  if (!config) {
    return NextResponse.json(
      { error: "Could not resolve backup configuration." },
      { status: 500 },
    );
  }
  if (!config.localPath) {
    return NextResponse.json(
      { error: "No local backup directory is configured." },
      { status: 400 },
    );
  }

  const active = await getActiveBackupRun().catch(() => null);
  if (active) {
    return NextResponse.json(
      { error: "A backup is running. Wait for it to finish before restoring." },
      { status: 409 },
    );
  }

  const auditContext = getAuditRequestContext(request);
  const auditRequestFields = {
    requestId: auditContext?.id ?? undefined,
    ipAddress: auditContext?.ipAddress ?? undefined,
    userAgent: auditContext?.userAgent ?? undefined,
  };

  // Audited BEFORE the attempt, not only after. A restore that kills the
  // database mid-flight must still leave a record of who asked for it and
  // which file — an audit row written only on success is missing for exactly
  // the incident someone will need to reconstruct.
  await createAuditLog({
    action: "backup.restore.started",
    category: "security",
    severity: "critical",
    outcome: "success",
    memberId: guard.session.user.id,
    entityType: "IntegrationCredential",
    entityId: "backup:restore",
    summary: `Started restoring the database from local backup ${parsed.data.filename}`,
    metadata: { filename: parsed.data.filename },
    ...auditRequestFields,
  });

  try {
    const result = await restoreLocalBackup(parsed.data.filename);

    await createAuditLog({
      action: "backup.restore.completed",
      category: "security",
      severity: "critical",
      outcome: "success",
      memberId: guard.session.user.id,
      entityType: "IntegrationCredential",
      entityId: "backup:restore",
      summary: `Restored the database from local backup ${result.filename}`,
      metadata: {
        filename: result.filename,
        memberCount: result.memberCount,
        bookingCount: result.bookingCount,
        paymentCount: result.paymentCount,
      },
      ...auditRequestFields,
    });

    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof LocalBackupPathError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    // The message can carry psql output, which may name the database host, so
    // it is logged rather than returned verbatim.
    logger.error(
      { err: err instanceof Error ? err.name : "unknown", job: "backup" },
      "Database restore failed",
    );
    await createAuditLog({
      action: "backup.restore.failed",
      category: "security",
      severity: "critical",
      outcome: "failure",
      memberId: guard.session.user.id,
      entityType: "IntegrationCredential",
      entityId: "backup:restore",
      summary: `Restore from local backup ${parsed.data.filename} failed`,
      metadata: { filename: parsed.data.filename },
      ...auditRequestFields,
    });
    return NextResponse.json(
      {
        error:
          "The restore failed. The database may be partly restored — check the server logs before using the site.",
      },
      { status: 500 },
    );
  }
}
