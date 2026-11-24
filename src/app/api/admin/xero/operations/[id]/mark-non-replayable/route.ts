import { NextRequest, NextResponse } from "next/server";
import { parseJsonRequestBody } from "@/lib/api-json";
import { z } from "zod";
import { XERO_OPERATION_REASON_MAX, XERO_OPERATION_REASON_MIN } from "@/lib/xero-operation-resolution";
import { createAuditLog } from "@/lib/audit";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session-guards";
import { getXeroOperationRetryMeta } from "@/lib/xero-operation-retry";
import logger from "@/lib/logger";

const reviewSchema = z.object({
  reason: z.string().trim().min(XERO_OPERATION_REASON_MIN).max(XERO_OPERATION_REASON_MAX),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireAdmin({
    permission: { area: "finance", level: "edit" },
  });
  if (!guard.ok) return guard.response;
  const session = guard.session;
  const jsonBody = await parseJsonRequestBody(request);
  if (!jsonBody.ok) return jsonBody.response;
  const body = jsonBody.body;
  const parsed = reviewSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid review payload", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const { id } = await params;

  try {
    const operation = await prisma.xeroSyncOperation.findUnique({
      where: { id },
    });

    if (!operation) {
      return NextResponse.json({ error: "Xero operation not found." }, { status: 404 });
    }

    if (operation.status !== "FAILED" && operation.status !== "PARTIAL") {
      return NextResponse.json(
        { error: "Only failed or partially-completed Xero operations can be marked non-replayable." },
        { status: 409 }
      );
    }

    const retryMeta = getXeroOperationRetryMeta(operation);
    // #3462: the flag and its audit row commit together or not at all, so a
    // failed audit never leaves an unattributed override behind a 500.
    // #4256: guarded on the status read, so a retry that claimed the row
    // (RUNNING) after that read is never marked under it, and no audit is written.
    const marked = await prisma.$transaction(async (tx) => {
      const flagged = await tx.xeroSyncOperation.updateMany({
        where: { id, status: { in: ["FAILED", "PARTIAL"] } },
        data: {
          replayable: false,
        },
      });
      if (flagged.count !== 1) return false;

      await createAuditLog({
        action: "xero.operation.marked_non_replayable",
        memberId: session.user.id,
        actorMemberId: session.user.id,
        targetId: operation.id,
        entityType: "XeroSyncOperation",
        entityId: operation.id,
        category: "xero",
        severity: "critical",
        outcome: "success",
        summary: "Xero operation marked non-replayable",
        details: parsed.data.reason,
        metadata: {
          operationId: operation.id,
          direction: operation.direction,
          entityType: operation.entityType,
          operationType: operation.operationType,
          localModel: operation.localModel,
          localId: operation.localId,
          previousReplayable: operation.replayable,
          retrySupportedBeforeReview: retryMeta.supported,
          retryReasonBeforeReview: retryMeta.reason,
        },
      }, tx);
      return true;
    });
    if (!marked) {
      return NextResponse.json(
        { error: "A retry is running on this operation; try again when it finishes." },
        { status: 409 }
      );
    }

    return NextResponse.json({
      ok: true,
      message: "Xero operation marked non-replayable with an audit record.",
    });
  } catch (error) {
    logger.error({ err: error, operationId: id }, "Failed to mark Xero operation non-replayable");
    return NextResponse.json(
      { error: "Failed to mark Xero operation non-replayable" },
      { status: 500 }
    );
  }
}
