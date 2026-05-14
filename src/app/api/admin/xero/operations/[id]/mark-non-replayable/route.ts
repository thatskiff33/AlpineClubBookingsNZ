import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { createAuditLog } from "@/lib/audit";
import { prisma } from "@/lib/prisma";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { getXeroOperationRetryMeta } from "@/lib/xero-operation-retry";
import logger from "@/lib/logger";

const reviewSchema = z.object({
  reason: z.string().trim().min(3).max(500),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  const body = await request.json().catch(() => ({}));
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
    await prisma.xeroSyncOperation.update({
      where: { id },
      data: {
        replayable: false,
      },
    });

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
    });

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
