// #3635 (`INV-INT-025`, orchestrator decision 3): what the "resolved in Xero"
// route must check before its mark may stand. Kept out of the route so the
// route stays a thin handler and the reads have one home.
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { buildXeroOperationRequeueCorrelationKey } from "@/lib/xero-operation-queue";
import { XERO_REQUEUE_OPERATION_TYPE } from "@/lib/xero-hardening-shared";
import { isStaleRunningXeroOperation } from "@/lib/xero-stale-operations";

type OperationReader = Pick<Prisma.TransactionClient, "xeroSyncOperation">;

export interface ConflictingRetry {
  id: string;
  status: string;
  startedAt: Date | null;
}

/**
 * A queued retry of this operation that ran, or may have run, alongside a mark
 * written at `markAt`: one still RUNNING, or one that started at or before the
 * mark and completed at or after it (review N4) - a retry that read the row
 * before the mark and finished in the moments before this check. A retry that
 * stood down CANCELLED after the mark ran nothing, so it is not a conflict
 * unless it is still RUNNING.
 *
 * The one window left is clock skew between the instance that wrote the mark
 * and the one that stamped the retry's `startedAt`/`completedAt`.
 */
export async function findRetryOverlappingMark(
  operationId: string,
  markAt: Date,
  db: OperationReader = prisma,
): Promise<ConflictingRetry | null> {
  return db.xeroSyncOperation.findFirst({
    where: {
      correlationKey: buildXeroOperationRequeueCorrelationKey(operationId),
      operationType: XERO_REQUEUE_OPERATION_TYPE,
      OR: [
        { status: "RUNNING" },
        {
          status: { not: "CANCELLED" },
          startedAt: { lte: markAt },
          completedAt: { gte: markAt },
        },
      ],
    },
    select: { id: true, status: true, startedAt: true },
  });
}

/**
 * A live copy of the same document queued beside this operation (review N3):
 * same correlation key, still PENDING, RUNNING or WAITING_PAYMENT. Resolving
 * now would leave that copy to mint a second document. The outbox also
 * cancels such a copy after a resolve (`findResolvedSiblingSince`); this is the
 * cheap, earlier answer.
 */
export async function findQueuedLiveCopy(
  operation: { id: string; correlationKey: string | null; entityType: string; operationType: string },
  db: OperationReader = prisma,
): Promise<{ id: string } | null> {
  if (!operation.correlationKey) return null;
  return db.xeroSyncOperation.findFirst({
    where: {
      id: { not: operation.id },
      correlationKey: operation.correlationKey,
      entityType: operation.entityType,
      operationType: operation.operationType,
      status: { in: ["PENDING", "RUNNING", "WAITING_PAYMENT"] },
    },
    select: { id: true },
  });
}

/**
 * The officer-facing refusal while a retry is running (reviews N6, N7). It says
 * the mark was not kept, what to do if the retry stood down because of it, and
 * - when the retry looks stuck - where to reset it.
 */
export function retryRunningRefusal(
  retry: { status: string; startedAt: Date | null } | null,
  now: Date = new Date(),
): string {
  if (retry && isStaleRunningXeroOperation(retry, now)) {
    return "A retry of this Xero operation has been running for a long time and looks stuck. Use Reset stale running operations on the Xero operations screen, then check Xero before resolving it.";
  }
  return "A retry of this Xero operation is running, so it was not marked resolved. Wait for the retry to finish, then check Xero: if the retry stood down because of this attempt, nothing ran and you can resolve it again.";
}
