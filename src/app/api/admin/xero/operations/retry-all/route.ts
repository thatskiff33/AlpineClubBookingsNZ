import { after, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { requireActiveSessionUser } from "@/lib/session-guards";
import {
  enqueueXeroSyncOperationRetry,
  processQueuedXeroOperationRetries,
} from "@/lib/xero-operation-queue";
import { XeroOperationRetryError } from "@/lib/xero-operation-retry";

function scheduleAfterResponse(task: () => Promise<void>) {
  try {
    after(task);
  } catch {
    queueMicrotask(() => {
      void task();
    });
  }
}

export async function POST() {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  try {
    const failedOperations = await prisma.xeroSyncOperation.findMany({
      where: {
        status: "FAILED",
        replayable: true,
      },
      select: {
        id: true,
      },
      orderBy: { createdAt: "desc" },
      take: 200,
    });

    if (failedOperations.length === 0) {
      return NextResponse.json({
        ok: true,
        found: 0,
        queued: 0,
        skipped: 0,
        message: "No failed replayable Xero operations found.",
      });
    }

    let queued = 0;
    let skipped = 0;
    const queuedOperationIds: string[] = [];
    const skippedOperations: Array<{ id: string; reason: string }> = [];

    for (const operation of failedOperations) {
      try {
        const result = await enqueueXeroSyncOperationRetry(operation.id, {
          createdByMemberId: session.user.id,
        });
        queued += 1;
        queuedOperationIds.push(result.queueOperationId);
      } catch (error) {
        if (error instanceof XeroOperationRetryError) {
          skipped += 1;
          skippedOperations.push({ id: operation.id, reason: error.message });
          continue;
        }
        throw error;
      }
    }

    if (queuedOperationIds.length > 0) {
      scheduleAfterResponse(async () => {
        try {
          await processQueuedXeroOperationRetries({ limit: queuedOperationIds.length });
        } catch (error) {
          logger.error(
            { err: error, queuedOperationIds },
            "Failed to kick queued Xero retry worker"
          );
        }
      });
    }

    logAudit({
      action: "XERO_OPERATION_RETRY_ALL",
      memberId: session.user.id,
      details: `Queued ${queued} Xero retries (${skipped} skipped)`,
    });

    return NextResponse.json(
      {
        ok: true,
        found: failedOperations.length,
        queued,
        skipped,
        skippedOperations,
        message:
          queued > 0
            ? `Queued ${queued} failed Xero operation${queued === 1 ? "" : "s"} for background retry.`
            : "No failed Xero operations could be queued for retry.",
      },
      { status: queued > 0 ? 202 : 200 }
    );
  } catch (error) {
    logger.error({ err: error }, "Failed to queue all failed Xero operations");
    return NextResponse.json(
      { error: "Failed to queue all failed Xero operations" },
      { status: 500 }
    );
  }
}
