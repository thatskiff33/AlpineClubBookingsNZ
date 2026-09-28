import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createAuditLog } from "@/lib/audit";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session-guards";
import logger from "@/lib/logger";
import { isResolvedInXero } from "@/lib/xero-operation-resolution";

const resolveSchema = z.object({
  reason: z.string().trim().min(3).max(500),
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
  const body = await request.json().catch(() => ({}));
  const parsed = resolveSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid resolve payload", details: parsed.error.flatten() },
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

    if (isResolvedInXero(operation)) {
      return NextResponse.json({
        ok: true,
        message: "Xero operation was already resolved.",
      });
    }

    if (operation.status !== "FAILED" && operation.status !== "PARTIAL") {
      return NextResponse.json(
        { error: "Only failed or partially-completed Xero operations can be resolved." },
        { status: 409 }
      );
    }

    // #3635 (`INV-INT-025`): status-guarded, the mirror of the retry claims'
    // `manuallyResolvedAt: null` guard. A retry that claimed the row after the
    // read above (FAILED -> RUNNING/PENDING) wins, and the officer is told to
    // look again rather than stamping "done" on an operation now re-running.
    const resolved = await prisma.xeroSyncOperation.updateMany({
      where: {
        id,
        status: { in: ["FAILED", "PARTIAL"] },
        manuallyResolvedAt: null,
      },
      data: {
        manuallyResolvedAt: new Date(),
        manuallyResolvedReason: parsed.data.reason,
        manuallyResolvedById: session.user.id,
      },
    });
    if (resolved.count !== 1) {
      return NextResponse.json(
        {
          error:
            "This Xero operation changed while it was being resolved (a retry may have started). Reload it and check before resolving.",
        },
        { status: 409 }
      );
    }

    await createAuditLog({
      action: "xero.operation.manually_resolved",
      memberId: session.user.id,
      actorMemberId: session.user.id,
      targetId: operation.id,
      entityType: "XeroSyncOperation",
      entityId: operation.id,
      category: "xero",
      severity: "important",
      outcome: "success",
      summary: "Xero operation marked resolved in Xero",
      details: parsed.data.reason,
      metadata: {
        operationId: operation.id,
        direction: operation.direction,
        entityType: operation.entityType,
        operationType: operation.operationType,
        localModel: operation.localModel,
        localId: operation.localId,
        previousStatus: operation.status,
      },
    });

    return NextResponse.json({
      ok: true,
      message: "Xero operation marked resolved; it will drop off the active failure list.",
    });
  } catch (error) {
    logger.error({ err: error, operationId: id }, "Failed to resolve Xero operation");
    return NextResponse.json(
      { error: "Failed to resolve Xero operation" },
      { status: 500 }
    );
  }
}
