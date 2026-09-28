import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createAuditLog } from "@/lib/audit";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session-guards";
import logger from "@/lib/logger";
import { isResolvedInXero } from "@/lib/xero-operation-resolution";
import { isAppliedCreditLedgerOperation } from "@/lib/xero-applied-credit-operation-serialization";
import {
  buildXeroOperationRequeueCorrelationKey,
  XERO_OPERATION_REQUEUE_TYPE,
} from "@/lib/xero-operation-queue";

function alreadyResolved() {
  return NextResponse.json({ ok: true, message: "Xero operation was already resolved." });
}

function retryRunning() {
  return NextResponse.json(
    {
      error:
        "A retry of this Xero operation is running. Wait for it to finish, then check Xero before resolving it.",
    },
    { status: 409 }
  );
}

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
      return alreadyResolved();
    }

    if (operation.status === "RUNNING") {
      // #3635 decision 3: a retry that claimed the operation itself.
      return retryRunning();
    }

    if (operation.status !== "FAILED" && operation.status !== "PARTIAL") {
      return NextResponse.json(
        { error: "Only failed or partially-completed Xero operations can be resolved." },
        { status: 409 }
      );
    }

    // #3635 decision 1 (`INV-INT-025`): resolving does not converge the local
    // credit ledger, and a resolved deallocation would fence the booking's
    // cancel and credit writes for good.
    if (isAppliedCreditLedgerOperation(operation)) {
      return NextResponse.json(
        {
          error:
            "An applied-credit allocation or deallocation cannot be marked resolved in Xero, because fixing Xero by hand does not bring the club's own credit ledger back in line. Retry it instead.",
        },
        { status: 409 }
      );
    }

    // #3635 (`INV-INT-025`): status-guarded, the mirror of the retry claims'
    // `manuallyResolvedAt: null` guard, so a retry that claimed the row after
    // the read above wins.
    const resolvedAt = new Date();
    const resolved = await prisma.xeroSyncOperation.updateMany({
      where: {
        id,
        status: { in: ["FAILED", "PARTIAL"] },
        manuallyResolvedAt: null,
      },
      data: {
        manuallyResolvedAt: resolvedAt,
        manuallyResolvedReason: parsed.data.reason,
        manuallyResolvedById: session.user.id,
      },
    });
    if (resolved.count !== 1) {
      const current = await prisma.xeroSyncOperation.findUnique({
        where: { id },
        select: { manuallyResolvedAt: true, status: true },
      });
      if (current && isResolvedInXero(current)) return alreadyResolved();
      if (current?.status === "RUNNING") return retryRunning();
      return NextResponse.json(
        {
          error:
            "This Xero operation changed while it was being resolved. Reload it and check before resolving.",
        },
        { status: 409 }
      );
    }

    // #3635 decision 3: a queued retry of this operation that the drain has
    // claimed runs while the operation row still reads FAILED. Checked AFTER
    // the mark is written: a drain that read the row before the mark landed
    // had already claimed its queued row, so this read sees it RUNNING and the
    // mark is withdrawn; a drain that reads after the mark refuses to run.
    const runningRetry = await prisma.xeroSyncOperation.findFirst({
      where: {
        correlationKey: buildXeroOperationRequeueCorrelationKey(id),
        operationType: XERO_OPERATION_REQUEUE_TYPE,
        status: "RUNNING",
      },
      select: { id: true },
    });
    if (runningRetry) {
      await prisma.xeroSyncOperation.updateMany({
        where: { id, manuallyResolvedAt: resolvedAt },
        data: {
          manuallyResolvedAt: null,
          manuallyResolvedReason: null,
          manuallyResolvedById: null,
        },
      });
      return retryRunning();
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
