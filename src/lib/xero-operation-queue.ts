import type { XeroSyncOperation } from "@prisma/client";
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { claimXeroSyncOperationToRunning } from "@/lib/xero-operation-claim";
import { asRecord } from "@/lib/xero-json";
import {
  buildXeroIdempotencyKey,
  completeXeroSyncOperation,
  failXeroSyncOperation,
  startXeroSyncOperation,
} from "@/lib/xero-sync";
import {
  getXeroOperationRetryMeta,
  refuseRetryIfResolvedInXero,
  retryXeroSyncOperation,
  XeroOperationResolvedInXeroError,
  XeroOperationRetryError,
} from "@/lib/xero-operation-retry";
import type { ClubFormat } from "@/lib/club-format";
import { STALE_RUNNING_XERO_OPERATION_MINUTES } from "@/lib/xero-stale-operations";

// test seam
export const XERO_OPERATION_REQUEUE_TYPE = "REQUEUE";

// The requeue correlation key is `${REQUEUE_CORRELATION_KEY_PREFIX}${originalOperationId}`.
// Operation IDs are cuids, so the key stays well under the idempotency-key
// length cap and is never hashed. A round-trip test guards against drift.
const REQUEUE_CORRELATION_KEY_PREFIX = "xero-operation:requeue:";
const REDACTED_SECRET = "[REDACTED]";

interface QueuedRetryPayload {
  originalOperationId?: string;
  originalOperationType?: string;
  originalStatus?: string;
}

function readQueuedRetryPayload(value: unknown): QueuedRetryPayload | null {
  const payload = asRecord(value);
  if (!payload) {
    return null;
  }

  return {
    originalOperationId:
      typeof payload.originalOperationId === "string" ? payload.originalOperationId : undefined,
    originalOperationType:
      typeof payload.originalOperationType === "string" ? payload.originalOperationType : undefined,
    originalStatus: typeof payload.originalStatus === "string" ? payload.originalStatus : undefined,
  };
}

// test seam
export function buildXeroOperationRequeueCorrelationKey(operationId: string) {
  return buildXeroIdempotencyKey("xero-operation", "requeue", operationId);
}

/**
 * Recover the original operation id a requeue points at from its correlation
 * key. The correlation key is stored verbatim (it is never run through the
 * secrets/PII redactor), so it remains the authoritative source even when the
 * requestPayload copy of `originalOperationId` has been redacted.
 */
export function parseXeroOperationRequeueOriginalId(
  correlationKey: string | null | undefined
): string | null {
  if (!correlationKey || !correlationKey.startsWith(REQUEUE_CORRELATION_KEY_PREFIX)) {
    return null;
  }

  const originalOperationId = correlationKey.slice(REQUEUE_CORRELATION_KEY_PREFIX.length);
  return originalOperationId.trim() ? originalOperationId : null;
}

async function claimQueuedRetryOperation(operationId: string) {
  // Delegates to the shared claim-to-RUNNING single-flight (#1272). The guard
  // is the REQUEUE predicate; combined with the helper's `status: "PENDING"`
  // precondition the resulting WHERE is identical to the pre-consolidation
  // inline claim.
  return claimXeroSyncOperationToRunning(operationId, {
    operationType: XERO_OPERATION_REQUEUE_TYPE,
  });
}

export async function enqueueXeroSyncOperationRetry(
  operationId: string,
  options?: { createdByMemberId?: string }
) {
  const operation = await prisma.xeroSyncOperation.findUnique({
    where: { id: operationId },
  });

  if (!operation) {
    throw new XeroOperationRetryError("Xero operation not found.", 404);
  }

  // #3635 (`INV-INT-025`): an operation an officer resolved in Xero is done,
  // so the retry and requeue routes answer 409 rather than queue it.
  refuseRetryIfResolvedInXero(operation);
  const retryMeta = getXeroOperationRetryMeta(operation);
  if (!retryMeta.supported) {
    throw new XeroOperationRetryError(
      retryMeta.reason ?? "This Xero operation cannot be queued for retry."
    );
  }

  const correlationKey = buildXeroOperationRequeueCorrelationKey(operationId);
  const existingQueuedRetry = await prisma.xeroSyncOperation.findFirst({
    where: {
      correlationKey,
      operationType: XERO_OPERATION_REQUEUE_TYPE,
      status: {
        in: ["PENDING", "RUNNING"],
      },
    },
    orderBy: {
      createdAt: "desc",
    },
  });

  if (existingQueuedRetry) {
    throw new XeroOperationRetryError(
      "A queued retry is already pending for this Xero operation.",
      409
    );
  }

  const queuedOperation = await startXeroSyncOperation({
    direction: operation.direction,
    entityType: operation.entityType,
    operationType: XERO_OPERATION_REQUEUE_TYPE,
    localModel: operation.localModel ?? undefined,
    localId: operation.localId ?? undefined,
    status: "PENDING",
    correlationKey,
    replayable: false,
    requestPayload: {
      originalOperationId: operation.id,
      originalOperationType: operation.operationType,
      originalStatus: operation.status,
    },
    createdByMemberId:
      options?.createdByMemberId ?? operation.createdByMemberId ?? undefined,
  });

  return {
    queueOperationId: queuedOperation.id,
    message: "Xero operation queued for background retry.",
  };
}

function getQueuedRetryOperationId(
  operation: Pick<XeroSyncOperation, "requestPayload" | "correlationKey">
) {
  // Prefer the correlation key: it is never redacted, unlike the requestPayload
  // copy, whose value can be rewritten to "[REDACTED]" when an operation id
  // contains a phone-like run of digits.
  const fromCorrelationKey = parseXeroOperationRequeueOriginalId(operation.correlationKey);
  if (fromCorrelationKey) {
    return fromCorrelationKey;
  }

  const fromPayload =
    readQueuedRetryPayload(operation.requestPayload)?.originalOperationId ?? null;
  return fromPayload && fromPayload !== REDACTED_SECRET ? fromPayload : null;
}

export interface ProcessQueuedXeroOperationRetriesResult {
  found: number;
  processed: number;
  succeeded: number;
  failed: number;
  skipped: number;
}

export async function processQueuedXeroOperationRetries(
  options: { limit?: number } | undefined,
  /** The club's format (#3565), resolved once by the caller — never per queued row. */
  format: ClubFormat,
): Promise<ProcessQueuedXeroOperationRetriesResult> {
  const limit = Math.min(Math.max(options?.limit ?? 10, 1), 50);
  const queuedOperations = await prisma.xeroSyncOperation.findMany({
    where: {
      status: "PENDING",
      operationType: XERO_OPERATION_REQUEUE_TYPE,
    },
    orderBy: {
      createdAt: "asc",
    },
    take: limit,
  });

  const result: ProcessQueuedXeroOperationRetriesResult = {
    found: queuedOperations.length,
    processed: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
  };

  for (const queuedOperation of queuedOperations) {
    const claimed = await claimQueuedRetryOperation(queuedOperation.id);
    if (!claimed) {
      result.skipped += 1;
      continue;
    }

    result.processed += 1;

    const originalOperationId = getQueuedRetryOperationId(queuedOperation);
    if (!originalOperationId) {
      await failXeroSyncOperation(
        queuedOperation.id,
        new XeroOperationRetryError(
          "Queued retry payload is missing the original operation id."
        )
      );
      result.failed += 1;
      continue;
    }

    try {
      const replayResult = await retryXeroSyncOperation(originalOperationId, format, {
        createdByMemberId: queuedOperation.createdByMemberId ?? undefined,
      });

      await completeXeroSyncOperation(queuedOperation.id, {
        status: "SUCCEEDED",
        responsePayload: {
          originalOperationId,
          result: replayResult,
        },
      });

      result.succeeded += 1;
    } catch (error) {
      if (error instanceof XeroOperationResolvedInXeroError) {
        // #3635 (`INV-INT-025`): a retry queued before an officer resolved the
        // operation in Xero. `retryXeroSyncOperation` re-read the row and
        // refused it, so nothing ran; the queued row is closed as skipped, not
        // failed, because nothing went wrong and nothing is left to do.
        // Recorded as what this retry SAW (review N6): the mark it read may
        // have been withdrawn afterwards, because this very retry was running
        // when the resolve checked - in which case the operation is unresolved
        // and nothing ran.
        await completeXeroSyncOperation(queuedOperation.id, {
          status: "CANCELLED",
          responsePayload: {
            originalOperationId,
            skipped: "resolved-in-xero",
            reason: error.message,
            note: "Nothing ran. The operation read as resolved in Xero when this retry started; if that mark was then withdrawn because this retry was running, the operation is unresolved and can be retried or resolved again.",
          },
        });
        result.skipped += 1;
        continue;
      }
      logger.error(
        {
          err: error,
          queueOperationId: queuedOperation.id,
          originalOperationId,
        },
        "Failed queued Xero operation retry"
      );
      await failXeroSyncOperation(queuedOperation.id, error, undefined, {
        lastErrorMessage: await describeQueuedRetryFailure(originalOperationId, error),
      });
      result.failed += 1;
    }
  }

  return result;
}

/**
 * #3462: what the REQUEUE row's failure says. The REQUEUE row is never
 * replayable itself (replaying a replay compounds the state), so its message
 * has to send the operator to the row that IS: it names the original
 * operation and reads that row's status AFTER the attempt, so it says where
 * the original actually stands rather than where it should.
 */
async function describeQueuedRetryFailure(
  originalOperationId: string,
  error: unknown,
): Promise<string> {
  const cause = (
    error instanceof Error ? error.message : typeof error === "string" ? error : "Unknown error"
  ).replace(/\.\s*$/, "");
  const original = await prisma.xeroSyncOperation
    .findUnique({
      where: { id: originalOperationId },
      select: { status: true, entityType: true, operationType: true },
    })
    .catch(() => null);
  const head = `Retry of Xero operation ${originalOperationId}${
    original ? ` (${original.entityType} ${original.operationType})` : ""
  } failed: ${cause}.`;
  if (!original) {
    return `${head} The original operation could not be read; find it in the operations list before requeueing.`;
  }
  if (original.status === "FAILED") {
    return `${head} The original operation is back to FAILED — fix the cause and requeue it again.`;
  }
  if (original.status === "PARTIAL") {
    return `${head} The original operation is still PARTIAL — fix the cause and requeue it again.`;
  }
  if (original.status === "RUNNING") {
    return `${head} The original operation is still RUNNING; if it stays RUNNING past ${STALE_RUNNING_XERO_OPERATION_MINUTES} minutes, use Mark failed on it, fix the cause and requeue it again.`;
  }
  return `${head} The original operation is now ${original.status}.`;
}
