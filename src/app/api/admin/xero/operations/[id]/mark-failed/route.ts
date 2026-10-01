import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createAuditLog } from "@/lib/audit";
import { requireAdmin } from "@/lib/session-guards";
import {
  markStaleRunningXeroOperationFailed,
  STALE_RUNNING_XERO_OPERATION_MINUTES,
} from "@/lib/xero-stale-operations";
import logger from "@/lib/logger";

const markFailedSchema = z.object({
  reason: z.string().trim().min(3).max(500),
});

/**
 * #3462: **Mark failed** on one stale RUNNING Xero operation - the runbook's
 * hand `UPDATE`, as a guarded, audited button. Finance edit, like every other
 * write on the operations panel. The write and its guard live in
 * `markStaleRunningXeroOperationFailed`, which runs this route's audit inside
 * the write's transaction; this route only authorises, audits and answers.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireAdmin({
    permission: { area: "finance", level: "edit" },
  });
  if (!guard.ok) return guard.response;
  const session = guard.session;
  const body = await request.json().catch(() => ({}));
  const parsed = markFailedSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid mark-failed payload", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const { id } = await params;

  try {
    // The audit row is written in the same transaction as the state change,
    // so a failed audit rolls the row back rather than leaving an
    // unattributed override behind a 500.
    const result = await markStaleRunningXeroOperationFailed(id, (tx, operation) =>
      createAuditLog(
        {
          action: "xero.operation.marked_failed",
          memberId: session.user.id,
          actorMemberId: session.user.id,
          targetId: operation.id,
          entityType: "XeroSyncOperation",
          entityId: operation.id,
          category: "xero",
          severity: "critical",
          outcome: "success",
          summary: "Stale running Xero operation marked failed",
          details: parsed.data.reason,
          metadata: {
            operationId: operation.id,
            entityType: operation.entityType,
            operationType: operation.operationType,
            localModel: operation.localModel,
            localId: operation.localId,
            startedAt: operation.startedAt.toISOString(),
            previousErrorCode: operation.previousErrorCode,
            previousErrorMessage: operation.previousErrorMessage,
          },
        },
        tx,
      ),
    );
    if (result.outcome === "not-found") {
      return NextResponse.json({ error: "Xero operation not found." }, { status: 404 });
    }
    if (result.outcome === "not-stale") {
      return NextResponse.json(
        {
          error:
            result.status === "RUNNING"
              ? `This Xero operation has not been running for ${STALE_RUNNING_XERO_OPERATION_MINUTES} minutes yet, so it may still be in progress. Try again later.`
              : `This Xero operation is ${result.status}, not stuck running, so there is nothing to mark failed. Refresh the list.`,
        },
        { status: 409 }
      );
    }

    return NextResponse.json({
      ok: true,
      message:
        "Xero operation marked failed with an audit record. Fix the cause, then retry or requeue it.",
    });
  } catch (error) {
    logger.error({ err: error, operationId: id }, "Failed to mark stale Xero operation failed");
    return NextResponse.json(
      { error: "Failed to mark Xero operation failed" },
      { status: 500 }
    );
  }
}
